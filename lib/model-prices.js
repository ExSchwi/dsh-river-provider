/**
 * river.ai pricing, cost estimation and the live-price catalogue.
 *
 * Token accounting is the part multi-account operation gets wrong most often:
 * river bills cached input at a different rate (up to 5× below fresh input on
 * DeepSeek, 5× below on GLM), so a cost figure computed from `prompt_tokens`
 * alone overstates every cached turn. The helpers here take the harness's
 * already-disjoint `TokenUsage` (fresh input / cache-read / cache-write /
 * output) and price each bucket separately.
 *
 * @module dsh-river-provider/model-prices
 */
import { modelFacts } from "./capabilities.js";
/** The console's public pricing endpoint (no auth, live). */
export const LIVE_PRICE_URL = 'https://console.river.ai/api/public/pricing';
/** How long a live-price fetch stays authoritative before it is refreshed. */
export const LIVE_PRICE_TTL_MS = 30 * 60_000;
/** The static price for one model, or zeros for a model river has not priced. */
export function staticPrice(model) {
    const facts = modelFacts(model);
    return facts.price;
}
/** Price a call in USD. */
export function priceUsage(usage, price) {
    // The cache fields are optional because most river responses omit them, so
    // they must default to 0 here — `undefined` propagates through the addition
    // and turns the whole cost into NaN, which renders as a broken price badge.
    const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const perMillion = usage.inputTokens * price.input
        + cached * price.cachedInput
        + usage.outputTokens * price.output;
    return perMillion / 1_000_000;
}
/**
 * The percentage saved by hitting the prompt cache, for one call.
 *
 * Reported as a 0..100 number because the harness renders a savings badge; a
 * call with no cache reads returns 0 rather than a division by zero.
 */
export function cacheSavingsPercent(usage, price) {
    const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (cached <= 0)
        return 0;
    const fullCost = (usage.inputTokens + cached) * price.input;
    if (fullCost <= 0)
        return 0;
    const saved = cached * (price.input - price.cachedInput);
    return Math.round((saved / fullCost) * 100);
}
/** Look one model up in a live price list, tolerating vendor-prefix differences. */
export function findLivePrice(prices, model) {
    const exact = prices.find((entry) => entry.model === model);
    if (exact !== undefined)
        return exact;
    // river occasionally publishes a bare name for a vendor-prefixed id; compare
    // on the last path segment so a prefix change does not silently zero a price.
    const tail = model.slice(model.lastIndexOf('/') + 1);
    return prices.find((entry) => entry.model.slice(entry.model.lastIndexOf('/') + 1) === tail);
}
/**
 * Parse the console pricing payload.
 *
 * The endpoint returns `{ inference: [{ model, input, cached_input, output }] }`
 * but the harness must keep working if river reshapes it, so every field is
 * read defensively and a non-numeric entry is skipped rather than priced at
 * `NaN`.
 */
export function parseLivePrices(payload) {
    if (typeof payload !== 'object' || payload === null)
        return [];
    const inference = payload.inference;
    if (!Array.isArray(inference))
        return [];
    const prices = [];
    for (const raw of inference) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const entry = raw;
        const model = entry.model;
        const input = entry.input;
        const output = entry.output;
        if (typeof model !== 'string' || typeof input !== 'number' || typeof output !== 'number')
            continue;
        const cached = typeof entry.cached_input === 'number' ? entry.cached_input : input;
        prices.push({ model, input, cachedInput: cached, output });
    }
    return prices;
}
/**
 * The price table the plugin uses for a model, preferring a fresh live value.
 *
 * A live price is authoritative while it is fresh; otherwise the snapshot in
 * `capabilities.ts` answers immediately, so a cost badge never blocks on the
 * network.
 */
export class RiverPriceBook {
    prices = [];
    fetchedAt = 0;
    inFlight;
    /** Refresh from the console if the current table is stale. Never throws. */
    async refresh(fetchImpl = fetch) {
        if (Date.now() - this.fetchedAt < LIVE_PRICE_TTL_MS)
            return;
        if (this.inFlight !== undefined)
            return this.inFlight;
        this.inFlight = (async () => {
            try {
                const response = await fetchImpl(LIVE_PRICE_URL, {
                    headers: { 'user-agent': attributionUserAgent() },
                });
                if (!response.ok)
                    return;
                const parsed = parseLivePrices(await response.json());
                if (parsed.length === 0)
                    return;
                this.prices = parsed;
                this.fetchedAt = Date.now();
            }
            catch {
                // A pricing fetch is cosmetic; a failure leaves the snapshot in place.
            }
            finally {
                this.inFlight = undefined;
            }
        })();
        return this.inFlight;
    }
    /** The best known price for a model. */
    priceFor(model) {
        const live = findLivePrice(this.prices, model);
        if (live !== undefined)
            return { input: live.input, cachedInput: live.cachedInput, output: live.output };
        return staticPrice(model);
    }
}
/**
 * The attribution header value every river request carries.
 *
 * The harness's adapter contract requires every provider request to identify
 * the client; river logs it for support, and the console pricing endpoint is
 * the one place this module calls out on its own.
 */
export function attributionUserAgent() {
    return 'dsh-river-provider/0.1.0 (+https://github.com/Mars-Sea/dsh-river-provider)';
}
/**
 * Format a USD amount the way the sidebar shows it.
 *
 * Sub-cent amounts keep two significant digits instead of rounding to `$0.00`,
 * because a single cached compaction turn can legitimately cost $0.0004 and a
 * badge reading `$0.00` looks broken.
 */
export function formatUsd(amount) {
    if (!Number.isFinite(amount) || amount <= 0)
        return '$0.00';
    if (amount >= 0.01)
        return `$${amount.toFixed(2)}`;
    if (amount >= 0.0001)
        return `$${amount.toFixed(4)}`;
    return `$${amount.toExponential(1)}`;
}
//# sourceMappingURL=model-prices.js.map