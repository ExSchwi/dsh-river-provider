/**
 * The river.ai adapter.
 *
 * The adapter owns one HTTP attempt's worth of protocol: it builds the body,
 * streams it, and maps river's wire vocabulary onto the harness's `StreamChunk`
 * vocabulary. Account selection and rotation happen ABOVE it, injected through
 * `resolveApiKey` / `markRejected`, so the adapter stays a function of
 * (options, key) and is testable without a server.
 *
 * Model facts come from `GET {apiBase}/models` when the catalog is reachable;
 * the static snapshot in `capabilities.ts` is the fallback. That split is
 * deliberate — a new river release becomes usable without a plugin upgrade, and
 * a catalog outage never breaks a turn.
 *
 * @module dsh-river-provider/adapter
 */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type AccountRejection } from './accounts.ts';
import { type RiverPriceBook } from './model-prices.ts';
import { type WireImageResolver } from './wire.ts';
/**
 * The fixed provider id this plugin registers.
 *
 * Not `riverai`: that id already belongs to the pi-ai row in the stock profile,
 * and two plugins claiming one id makes the model picker and the default-model
 * pointer ambiguous about which implementation a request runs through.
 */
export declare const PROVIDER = "river";
/** Default API base; every request path hangs off it. */
export declare const DEFAULT_API_BASE = "https://api.river.ai/v1";
/**
 * Timeouts, matching river's documented ceilings.
 *
 * river documents prefill at 10 minutes and a non-streaming response at 15, so
 * the whole-request budget is 15 and the silence budget is 10: a stream that
 * goes quiet for longer than the prefill window is dead even though the socket
 * may still be open.
 */
export declare const DEFAULT_REQUEST_TIMEOUT_MS: number;
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS: number;
/** How long a `GET /models` result is trusted. */
export declare const CATALOG_TTL_MS: number;
/** One attempt's resolved connection settings. */
export interface RiverConnection {
    apiBase: string;
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
    /** A user-pinned `max_tokens` ceiling, or absent for "per model". */
    maxOutputTokens?: number;
    /** A user-pinned advertised context window, or absent for "the model's own". */
    contextWindowLimit?: number;
}
/** What the adapter needs from the plugin. */
export interface RiverAdapterDeps {
    /** The frozen connection settings for this call. */
    connection: () => RiverConnection;
    /** Reserve a key for this attempt. */
    resolveApiKey: (model: string) => Promise<{
        key: string;
        accountId: string;
    }>;
    /** Record a rejection so the next attempt picks another account. */
    markRejected: (key: string, rejection: AccountRejection, resetAtMs?: number) => void;
    /** Record success, clearing a stale cooldown. */
    markHealthy: (key: string) => void;
    /** Live pricing, used for the harness's cost display. */
    prices: RiverPriceBook;
    /** Image variants, resolved per request. */
    images: WireImageResolver;
    /** Whether a model should appear in the picker. */
    isVisible: (model: string) => boolean;
    /**
     * The configured default reasoning effort for one model, already translated
     * to a value the model accepts.
     *
     * Consulted only when the caller omits an effort; absent leaves the model's
     * own default, which is the honest behaviour for a model nobody configured.
     */
    defaultEffort?: ((model: string) => string | undefined) | undefined;
    /** Optional diagnostic log. */
    log?: ((message: string) => void) | undefined;
}
/**
 * The river.ai adapter.
 *
 * `stream()` performs exactly one HTTP attempt. Retries and rotation above the
 * request lifetime are the harness's job; the only state this class keeps is
 * the model catalog.
 */
export declare class RiverAdapter extends LlmAdapter {
    private readonly deps;
    private catalog;
    private catalogInFlight;
    constructor(deps: RiverAdapterDeps);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Retry policy: many attempts, long ceiling.
     *
     * `maxDelayMs` MUST equal {@link RETRY_MAX_DELAY_MS}: a `providerRetryAfterMs`
     * longer than the ceiling is discarded by the retry layer, which would turn a
     * well-behaved `Retry-After: 600` into a hammering loop.
     */
    providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined;
    /** Every model this provider can serve. */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** Resolve one model id, falling back to the static snapshot. */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * One HTTP attempt.
     *
     * The connection is frozen at CALL time, not at construction: a settings edit
     * during a turn must not change the base URL halfway through an attempt.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Pick an account, translating pool exhaustion into a retry-aware error.
     *
     * The pool already knows how long the soonest account stays cooling down, but
     * it reports that as `retryAfterMs` on its own error type. Letting that escape
     * unwrapped loses the number: `dsh-llm-retry` only honours a wait it can read
     * off `providerRetryAfterMs`, so the harness would fall back to its generic
     * backoff and give up long before an account actually frees up.
     */
    private resolveAccount;
    /** Run the request and stream its chunks. */
    private runAttempt;
    /** Decode the SSE body into harness chunks. */
    private streamChunks;
    /** Run a decoder step, classifying an account-scoped failure on the way out. */
    private guard;
    /**
     * Accept a non-streamed completion.
     *
     * Some proxies strip `stream: true`; parsing the JSON body keeps the turn
     * working instead of surfacing "no frames received".
     */
    private nonStreamingChunks;
    /** `max_tokens` for this call: the caller's budget, capped by the model. */
    private requestMaxTokens;
    /** The model's own ceiling, or the configured override when lower. */
    private outputCeiling;
    /** Build the detached metadata for one model id. */
    private describe;
    /**
     * Refresh the model catalog, at most once per {@link CATALOG_TTL_MS}.
     *
     * Failure is silent by design: the snapshot answers, so a catalog outage must
     * never become a failed turn.
     */
    private refreshCatalog;
    /** Record an account-scoped rejection learned from an HTTP status. */
    private rejectFromStatus;
    /** Mark an error's key when the error is account-scoped. */
    private reclassifyThrow;
    /** Wrap a fetch throw into a classified `LlmError`. */
    private transportError;
}
