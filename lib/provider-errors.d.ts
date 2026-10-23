/**
 * Bilingual provider errors.
 *
 * Every failure the user can act on is raised as a `LlmError` whose message
 * carries BOTH languages separated by `；` — the harness renders `message`
 * verbatim, and this plugin's users are mixed-language. `code` is the stable
 * machine-readable half: the retry policy, the rotation logic and the settings
 * page all branch on it, never on the message text.
 *
 * The classification order matters and is deliberate:
 *   1. output-ceiling rejections (a rejection that retrying cannot fix),
 *   2. context overflow (must become CONTEXT_WINDOW_EXCEEDED, not a retry),
 *   3. quota / balance (rotating accounts is the fix),
 *   4. rate limiting (rotating accounts is the fix),
 *   5. everything else, by HTTP status.
 *
 * @module dsh-river-provider/provider-errors
 */
import { LlmError, type LlmFailure } from '@deepseek-ai/dsh-llm';
/** Codes this plugin raises. Shared with the adapter's retry policy. */
export declare const RATE_LIMIT_CODE = "RATE_LIMIT";
export declare const THROTTLED_CODE = "THROTTLED";
export declare const SERVER_CODE = "SERVER";
export declare const TIMEOUT_CODE = "TIMEOUT";
export declare const TRANSPORT_CODE = "TRANSPORT";
export declare const UNSUPPORTED_OPTION_CODE = "UNSUPPORTED_OPTION";
export declare const OUTPUT_TOKEN_LIMIT_CODE = "OUTPUT_TOKEN_LIMIT";
export declare const CONTENT_FILTER_CODE = "CONTENT_FILTER";
export declare const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
export declare const BAD_REQUEST_CODE = "BAD_REQUEST";
/**
 * Optional structured facts for one failure.
 *
 * `requestId` stays a plain string here and is branded on the way in: the value
 * arrives from an HTTP header, where no compile-time branding is possible.
 */
export interface FailureFacts {
    status?: number;
    providerRetryAfterMs?: number;
    requestId?: string;
    offloadImages?: number;
    cause?: unknown;
}
/** Build a bilingual `LlmError`. */
export declare function bilingual(code: string, en: string, zh: string, facts?: FailureFacts): LlmError;
/** Whether a detail text is an output-ceiling rejection. */
export declare function isOutputLimitDetail(detail: string): boolean;
/** Whether a detail means the prompt overflowed the model's context window. */
export declare function isContextOverflowDetail(detail: string): boolean;
/** Read the numeric value of a `Retry-After` style header or payload field. */
export declare function retryAfterMs(value: unknown, now?: number): number | undefined;
/**
 * Extract `{ message, type, code, param }` from an OpenAI-shaped error body.
 *
 * river returns `{"error":{"message":"Invalid API key","type":"invalid_request_error","code":null}}`
 * on `/models` with a bogus key, so the body is trusted for CLASSIFICATION
 * only — the key itself never appears in a message surfaced to the user.
 */
export interface WireErrorDetail {
    message: string;
    type?: string;
    code?: string;
    param?: string;
}
/** Pull the error detail out of a decoded response body or an SSE `error` event. */
export declare function wireErrorDetail(value: unknown): WireErrorDetail | undefined;
/**
 * Turn a non-OK HTTP response into an `LlmError`.
 *
 * `status` drives the code because it is the one field river documents as
 * stable: 401/403 credential, 402 balance, 404 model, 413 body, 429/503
 * throttle, 5xx transient. The body refines the message only.
 */
export declare function responseError(status: number, body: unknown, requestId: string | undefined, retryAfterHeader: string | undefined): LlmError;
/**
 * Convert an in-stream `error` event into an `LlmError`.
 *
 * river's SSE can carry `data: {"error":{...}}` after a 200. Without this the
 * turn would end in `EMPTY_RESPONSE` and be retried, hiding the real cause and
 * burning another account's quota.
 */
export declare function streamErrorToLlmError(value: unknown, fallbackMessage?: string): LlmError;
/**
 * Whether a failure is worth another account instead of another attempt.
 *
 * Rotating accounts fixes a throttle, a balance and a bad key; it cannot fix a
 * malformed request, so those stop immediately rather than cycling the pool.
 */
export declare function isAccountScopedFailure(failure: LlmFailure): boolean;
