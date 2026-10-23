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
/** USD per 1M tokens, the unit river publishes. */
export interface RiverPrice {
    input: number;
    cachedInput: number;
    output: number;
}
/** One entry of the console's public pricing JSON. */
export interface RiverLivePrice extends RiverPrice {
    model: string;
}
/** The console's public pricing endpoint (no auth, live). */
export declare const LIVE_PRICE_URL = "https://console.river.ai/api/public/pricing";
/** How long a live-price fetch stays authoritative before it is refreshed. */
export declare const LIVE_PRICE_TTL_MS: number;
/**
 * The token buckets one call is billed in.
 *
 * `inputTokens` from the harness EXCLUDES cached input, so these four buckets
 * are disjoint and sum to (almost) the billed prompt. `cacheWriteTokens` has no
 * separate river rate — river's catalog exposes `cached_input` only — and is
 * billed at the fresh-input rate, which is the conservative choice.
 */
export interface BillableUsage {
    inputTokens: number;
    /** Absent when the provider reported no prompt-cache reads. */
    cacheReadTokens?: number | undefined;
    /** Absent when the provider reported no prompt-cache writes. */
    cacheWriteTokens?: number | undefined;
    outputTokens: number;
}
/** The static price for one model, or zeros for a model river has not priced. */
export declare function staticPrice(model: string): RiverPrice;
/** Price a call in USD. */
export declare function priceUsage(usage: BillableUsage, price: RiverPrice): number;
/**
 * The percentage saved by hitting the prompt cache, for one call.
 *
 * Reported as a 0..100 number because the harness renders a savings badge; a
 * call with no cache reads returns 0 rather than a division by zero.
 */
export declare function cacheSavingsPercent(usage: BillableUsage, price: RiverPrice): number;
/** Look one model up in a live price list, tolerating vendor-prefix differences. */
export declare function findLivePrice(prices: readonly RiverLivePrice[], model: string): RiverLivePrice | undefined;
/**
 * Parse the console pricing payload.
 *
 * The endpoint returns `{ inference: [{ model, input, cached_input, output }] }`
 * but the harness must keep working if river reshapes it, so every field is
 * read defensively and a non-numeric entry is skipped rather than priced at
 * `NaN`.
 */
export declare function parseLivePrices(payload: unknown): RiverLivePrice[];
/**
 * The price table the plugin uses for a model, preferring a fresh live value.
 *
 * A live price is authoritative while it is fresh; otherwise the snapshot in
 * `capabilities.ts` answers immediately, so a cost badge never blocks on the
 * network.
 */
export declare class RiverPriceBook {
    private prices;
    private fetchedAt;
    private inFlight;
    /** Refresh from the console if the current table is stale. Never throws. */
    refresh(fetchImpl?: typeof fetch): Promise<void>;
    /** The best known price for a model. */
    priceFor(model: string): RiverPrice;
}
/**
 * The attribution header value every river request carries.
 *
 * The harness's adapter contract requires every provider request to identify
 * the client; river logs it for support, and the console pricing endpoint is
 * the one place this module calls out on its own.
 */
export declare function attributionUserAgent(): string;
/**
 * Format a USD amount the way the sidebar shows it.
 *
 * Sub-cent amounts keep two significant digits instead of rounding to `$0.00`,
 * because a single cached compaction turn can legitimately cost $0.0004 and a
 * badge reading `$0.00` looks broken.
 */
export declare function formatUsd(amount: number): string;
