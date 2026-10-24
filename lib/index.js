/**
 * The river.ai provider plugin.
 *
 * Split of responsibilities:
 *
 * - {@link RiverAccountPool} decides WHICH account serves an attempt and
 *   remembers why one stopped being usable.
 * - {@link RiverAdapter} owns one HTTP attempt's protocol.
 * - this file wires both into the harness: config schema, credential refs,
 *   settings namespace, model visibility, and the provider registration.
 *
 * Everything account-scoped is resolved per attempt rather than per turn, so a
 * single turn can walk through several keys without the harness noticing.
 *
 * @module dsh-river-provider
 */
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { DEFAULT_API_BASE, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PROVIDER, RiverAdapter, } from "./adapter.js";
import { accountUsable, AllAccountsUnusableError, normalizeKey, RiverAccountPool, } from "./accounts.js";
import { configuredEffort, knownMaxOutputTokens, RIVER_CONTEXT_WINDOW } from "./capabilities.js";
import { RiverPriceBook } from "./model-prices.js";
import { AttachmentImageResolver } from "./images.js";
import { markVolatileFields } from "./config-volatile.js";
import { buildSnapshot } from "./remote-state.js";
import { applyEdit, storeAccountKey } from "./remote-edit.js";
import { RiverRemoteService } from "./remote-service.js";
export const name = 'llm-river';
export const inject = ['llm'];
/** Settings namespace for this provider. */
const NS = 'llm-river';
/** Default env var holding the first river.ai key. */
const DEFAULT_API_KEY_ENV = 'RIVERAI_API_KEY';
export { PROVIDER };
const Config = Schema.object({
    apiBase: Schema.string()
        .description('Base URL of the river.ai API, e.g. https://api.river.ai/v1')
        .default(DEFAULT_API_BASE),
    apiKeyEnv: Schema.string()
        .role('credential-ref')
        .description(`Environment variable holding the first river.ai key.`)
        .default(DEFAULT_API_KEY_ENV),
    apiKey: Schema.string()
        .role('secret')
        .description('Literal river.ai key for the first account. Prefer the env var.'),
    accounts: Schema.array(Schema.object({
        label: Schema.string().description('Name shown in rotation status and errors.'),
        apiKeyEnv: Schema.string().role('credential-ref').description('Environment variable holding this key.'),
        apiKey: Schema.string().role('secret').description('Literal key for this account.'),
    }))
        .description('Additional river.ai accounts. Requests rotate across all of them.')
        .default([]),
    activeAccount: Schema.string()
        .description('Pin every request to one account by label or slot id. Leave empty to rotate.'),
    modelAccountRules: Schema.array(Schema.object({
        models: Schema.array(Schema.string()).description('Model id or glob pattern.'),
        account: Schema.string().description('Account label or slot id.'),
    }))
        .description('Route matching models to a fixed account.')
        .default([]),
    requestTimeoutMs: Schema.number()
        .description('Whole-request budget. river.ai documents 15 minutes per response.')
        .default(DEFAULT_REQUEST_TIMEOUT_MS),
    streamIdleTimeoutMs: Schema.number()
        .description('Longest silence tolerated mid-stream. river.ai documents 10 minutes of prefill.')
        .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    maxOutputTokens: Schema.number()
        .description('Global output ceiling. Omitted means each model uses its own maximum.'),
    contextWindowLimit: Schema.number()
        .description('Cap the advertised context window. Leave empty for the model\'s own capacity (the 1M river publishes). '
        + 'Keep it above maxOutputTokens plus the compaction headroom, or pressure compaction cannot run.'),
    defaultReasoningEffort: Schema.dict(Schema.string())
        .description('Default reasoning effort per model id or glob, e.g. {"zai-org/GLM-*": "max"}. '
        + 'Only levels river documents for that model are accepted: DeepSeek none|high|max, GLM low|high|max. '
        + 'Anything else is reported as a configuration error instead of being silently changed. "auto" keeps the model\'s own default.')
        .default({}),
    visibleModels: Schema.array(Schema.string())
        .description('Only show these models in the picker. Empty means the whole catalog.')
        .default([]),
    modelVisibility: Schema.dict(Schema.boolean())
        .description('Per-model visibility overrides, e.g. {"zai-org/GLM-5.3-Flash": false}.')
        .default({}),
    showSettingsSection: Schema.boolean()
        .description('Show a dedicated river.ai page in the settings navigation. On by default; '
        + 'turn it off to keep only the provider card in Settings > Models.')
        .default(true),
});
// Every editable field is volatile: the settings form writes them live, and the
// loader hands them back as references read fresh on each call. Literal keys
// are marked too — no surface writes a secret literal, but marking them costs
// nothing and keeps one rule for the whole schema.
const RiverConfigSchema = markVolatileFields(Config);
export { RiverConfigSchema };
/** Model ids that carry vision, from the bundled snapshot. */
export async function apply(ctx, config) {
    const current = () => (config ?? {});
    const prices = new RiverPriceBook();
    const images = new AttachmentImageResolver();
    /**
     * Resolve a credential ref to its value.
     *
     * Per call, never cached: the credential seam is the one place a key edited in
     * the settings panel becomes visible, and caching would freeze a rotated key
     * for the life of the process. The process environment is the fallback for a
     * `.env`-style setup with no credentials provider registered.
     */
    const resolveRef = async (ref) => {
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const resolved = await credentials.resolve(credentialRef(ref));
            if (resolved !== undefined && resolved.value !== '')
                return resolved.value;
        }
        const ambient = process.env[ref];
        return ambient === undefined || ambient.trim() === '' ? undefined : ambient;
    };
    /** Build the account slots for the current config. */
    const slots = (raw) => {
        const primaryRef = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
        const primary = {
            id: 'default',
            label: 'Default',
            ref: primaryRef,
            literal: raw.apiKey,
        };
        const extra = [];
        for (const [index, account] of (raw.accounts ?? []).entries()) {
            const ref = account.apiKeyEnv ?? account.apiKey;
            if (ref === undefined || ref === '')
                continue;
            extra.push({
                // The env var name is the natural stable id: two entries pointing at the
                // same variable are the same account and must not rotate apart.
                id: account.apiKeyEnv ?? `account-${index + 2}`,
                label: account.label ?? account.apiKeyEnv ?? `Account ${index + 2}`,
                // `resolveAccounts` prefers the literal key, so `ref` only ever names
                // the variable a slot falls back to.
                ref: account.apiKeyEnv ?? `RIVERAI_API_KEY_${index + 2}`,
                literal: account.apiKey,
            });
        }
        return [primary, ...extra];
    };
    const pool = new RiverAccountPool({
        slots: () => slots(current()),
        resolveRef,
        preferredId: () => current().activeAccount,
        modelAccountRules: () => current().modelAccountRules ?? [],
    });
    const connection = () => {
        const raw = current();
        return {
            apiBase: raw.apiBase ?? DEFAULT_API_BASE,
            requestTimeoutMs: raw.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
            ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
            ...(raw.contextWindowLimit === undefined ? {} : { contextWindowLimit: raw.contextWindowLimit }),
        };
    };
    /**
     * The configured reasoning effort for one model, validated against the
     * model's own whitelist.
     *
     * Resolved per call from the live config so an edit applies to the next turn
     * without a reload, and `auto`/empty both answer `undefined` — "no opinion",
     * which leaves the model's own default standing.
     *
     * A configured value the model does not accept is a configuration mistake and
     * is reported as one: {@link configuredEffort} throws, which surfaces as a
     * failed `resolveModel` instead of a silently different (and differently
     * priced) reasoning level. Nothing is snapped here — snapping is for requests
     * the harness generates at runtime, where producing nothing is worse.
     */
    const defaultEffort = (model) => configuredEffort(model, current().defaultReasoningEffort);
    /**
     * The output budget the page shows when none is configured.
     *
     * The largest figure the snapshot knows is the honest answer to "what would
     * this cost me": river's models differ (384K vs 128K) and a single global
     * default can only claim one, so the form shows the ceiling with the model
     * table beside it holding the per-model truth.
     */
    const defaultMaxOutputTokens = () => knownMaxOutputTokens();
    /**
     * Whether a key resolves for one reference, through the same seam the adapter
     * reads. A failure reads as "not configured": the row still renders, with the
     * reason a user needs to see.
     */
    const isConfigured = async (ref) => {
        try {
            const resolved = await resolveRef(ref);
            return (resolved ?? '').trim() !== '';
        }
        catch {
            return false;
        }
    };
    const isVisible = (model) => {
        const raw = current();
        const override = raw.modelVisibility?.[model];
        if (override !== undefined)
            return override;
        const allow = raw.visibleModels ?? [];
        if (allow.length === 0)
            return true;
        return allow.includes(model);
    };
    const adapter = new RiverAdapter({
        connection,
        images,
        prices,
        isVisible,
        defaultEffort,
        async resolveApiKey(model) {
            // `model === ''` is the catalog probe: no routing rule can apply to it.
            const account = model === '' ? await pool.resolveKey({}) : await pool.resolveKey({ model });
            return { key: account.key, accountId: account.slot.id };
        },
        markRejected: (key, rejection, resetAt) => pool.markRejected(normalizeKey(key) ?? key, rejection, resetAt),
        markHealthy: (key) => pool.markHealthy(normalizeKey(key) ?? key),
        log: (message) => ctx.logger.debug?.(`[llm-river] ${message}`),
    });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: 'river.ai', settingsNs: NS, settingsPath: [] },
    ]);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    // The Remote the settings page talks to. Both halves come from remote-wire.ts,
    // so the endpoint the Client calls is the one the Gateway registered.
    const remoteDeps = {
        snapshot: async () => {
            // Prices and the catalog are stale-while-revalidate: the page renders
            // immediately and a refresh lands on the next poll.
            void prices.refresh();
            return buildSnapshot({
                provider: PROVIDER,
                config: () => current(),
                defaults: () => ({
                    apiBase: current().apiBase ?? DEFAULT_API_BASE,
                    contextWindowLimit: current().contextWindowLimit ?? RIVER_CONTEXT_WINDOW,
                    maxOutputTokens: current().maxOutputTokens ?? defaultMaxOutputTokens(),
                    showSettingsSection: current().showSettingsSection ?? true,
                }),
                pool,
                slots: () => slots(current()),
                isVisible,
                isConfigured,
            });
        },
        async refresh() {
            await prices.refresh();
            return remoteDeps.snapshot();
        },
        async edit(edit) {
            const editDeps = {
                ns: NS,
                settings: () => ctx.get('settings'),
                credentials: () => ctx.get('credentials'),
            };
            try {
                await applyEdit(editDeps, edit);
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            return { ok: true, snapshot: await remoteDeps.snapshot() };
        },
        async setAccountKey(target) {
            const editDeps = {
                ns: NS,
                settings: () => ctx.get('settings'),
                credentials: () => ctx.get('credentials'),
            };
            try {
                await storeAccountKey(editDeps, target);
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            return { ok: true };
        },
    };
    // Constructing the receiver registers the Cordis service the Gateway resolves
    // and exports the methods marked on it. The same instance is the one the
    // Gateway calls, so the deps above and the served answers cannot drift.
    new RiverRemoteService(ctx, remoteDeps);
    // Settings: the panel edits the same object the adapter reads, so a base URL
    // change takes effect on the next attempt without a plugin reload. The
    // namespace is the plugin's own profile entry id, which is what the generated
    // form addresses; no extra registration is needed for the page to exist.
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        settings?.configure({ auto: true }, ctx.fiber);
    });
    // Account status for the sidebar: which key is active, which is cooling down.
    // Nothing is registered when the profile has no command surface — a status
    // command is a convenience, never a precondition for serving requests.
    ctx.inject(['commands'], (commandsCtx) => {
        const commands = commandsCtx.commands;
        commands?.register({
            name: 'river-accounts',
            description: 'Show river.ai account rotation status.',
            async run() {
                const rows = (await pool.describeAccounts()).map((account) => {
                    const status = describeState(account);
                    return `- ${account.slot.label} (${account.slot.id}) — ${status}`;
                });
                return rows.length === 0 ? 'No river.ai accounts configured.' : rows.join('\n');
            },
        });
    });
}
/** One account's health, as shown to a human. */
function describeState(account) {
    const state = account.state;
    if (state === undefined)
        return 'ready';
    if (accountUsable(state))
        return 'ready (cooldown elapsed)';
    if (state.kind === 'disabled')
        return `disabled: ${state.reason}`;
    const seconds = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
    return `cooling down ${seconds}s: ${state.reason}`;
}
/** True for the pool's "nothing can be attempted" error. */
export function isPoolExhausted(error) {
    return error instanceof AllAccountsUnusableError;
}
//# sourceMappingURL=index.js.map