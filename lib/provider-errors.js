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
import { LlmError, ProviderRequestId, } from '@deepseek-ai/dsh-llm';
import { isRecord, numberValue, stringValue } from "./wire-guards.js";
/** Codes this plugin raises. Shared with the adapter's retry policy. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT';
export const THROTTLED_CODE = 'THROTTLED';
export const SERVER_CODE = 'SERVER';
export const TIMEOUT_CODE = 'TIMEOUT';
export const TRANSPORT_CODE = 'TRANSPORT';
export const UNSUPPORTED_OPTION_CODE = 'UNSUPPORTED_OPTION';
export const OUTPUT_TOKEN_LIMIT_CODE = 'OUTPUT_TOKEN_LIMIT';
export const CONTENT_FILTER_CODE = 'CONTENT_FILTER';
export const MODEL_NOT_FOUND_CODE = 'MODEL_NOT_FOUND';
export const BAD_REQUEST_CODE = 'BAD_REQUEST';
/** Build a bilingual `LlmError`. */
export function bilingual(code, en, zh, facts) {
    return new LlmError(`${en}；${zh}`, code, toErrorOptions(facts));
}
/**
 * Convert plain facts into the branded option bag `LlmError` accepts.
 *
 * Every field is added only when present: `exactOptionalPropertyTypes` forbids
 * writing `undefined` into an optional slot, and an absent field is what the
 * harness reads as "no fact".
 */
function toErrorOptions(facts) {
    if (facts === undefined)
        return undefined;
    const options = {};
    if (facts.status !== undefined)
        options.status = facts.status;
    if (facts.providerRetryAfterMs !== undefined)
        options.providerRetryAfterMs = facts.providerRetryAfterMs;
    if (facts.requestId !== undefined && facts.requestId !== '')
        options.requestId = ProviderRequestId(facts.requestId);
    if (facts.offloadImages !== undefined)
        options.offloadImages = facts.offloadImages;
    if (facts.cause !== undefined)
        options.cause = facts.cause;
    return options;
}
/**
 * `LlmError` counts as an output-ceiling rejection when the provider refused
 * the request because `max_tokens` exceeded the model's ceiling.
 *
 * river answers that with 400/422 and a message naming the limit; retrying the
 * same request would fail identically, so these must be terminal.
 */
const OUTPUT_LIMIT_REJECTION = /max_tokens|max output|maximum context|output limit|too many tokens|token limit|exceeds? (?:the )?(?:maximum|limit)/i;
/** Whether a detail text is an output-ceiling rejection. */
export function isOutputLimitDetail(detail) {
    return OUTPUT_LIMIT_REJECTION.test(detail);
}
/**
 * Whether a detail text means the prompt exceeded the model's context window.
 *
 * Kept separate from {@link isOutputLimitDetail} because the remedies differ:
 * overflow shrinks the prompt (harness compaction), a ceiling rejection
 * changes `max_tokens`.
 */
const CONTEXT_OVERFLOW = /context (?:window|length)|context_length_exceeded|prompt is too long|input is too long|maximum context|too many input tokens|reduce (?:the )?(?:length|number) of/i;
/** Whether a detail means the prompt overflowed the model's context window. */
export function isContextOverflowDetail(detail) {
    return CONTEXT_OVERFLOW.test(detail);
}
/** Whether a detail means the account is out of money (not out of rate). */
const QUOTA_DETAIL = /insufficient (?:balance|funds|credit|quota)|no credit|out of (?:credit|funds)|payment required|billing|spend limit|usage limit/i;
/** Whether a detail means the account is throttled for now. */
const THROTTLE_DETAIL = /rate limit|too many requests|throttl|concurren|requests per|tokens per/i;
/** Read the numeric value of a `Retry-After` style header or payload field. */
export function retryAfterMs(value, now = Date.now()) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        // A bare number in a JSON body is seconds; river also echoes milliseconds in
        // a `*_ms` field, which callers convert before reaching here.
        return Math.round(value * 1000);
    }
    const text = stringValue(value);
    if (text === undefined)
        return undefined;
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.round(seconds * 1000);
    const at = Date.parse(text);
    if (!Number.isNaN(at))
        return Math.max(0, at - now);
    return undefined;
}
/** Pull the error detail out of a decoded response body or an SSE `error` event. */
export function wireErrorDetail(value) {
    if (!isRecord(value))
        return undefined;
    const error = isRecord(value.error) ? value.error : undefined;
    if (error !== undefined) {
        const message = stringValue(error.message) ?? stringValue(value.message) ?? '';
        const detail = { message };
        const type = stringValue(error.type);
        if (type !== undefined)
            detail.type = type;
        const code = stringValue(error.code);
        if (code !== undefined)
            detail.code = code;
        const param = stringValue(error.param);
        if (param !== undefined)
            detail.param = param;
        return detail;
    }
    const message = stringValue(value.message);
    if (message !== undefined) {
        const detail = { message };
        const type = stringValue(value.type);
        if (type !== undefined)
            detail.type = type;
        const code = stringValue(value.code);
        if (code !== undefined)
            detail.code = code;
        return detail;
    }
    return undefined;
}
/** Join the useful parts of a wire error into one classification string. */
function detailText(detail) {
    return [detail.message, detail.type, detail.code, detail.param].filter((part) => part !== undefined).join(' ');
}
/**
 * Turn a non-OK HTTP response into an `LlmError`.
 *
 * `status` drives the code because it is the one field river documents as
 * stable: 401/403 credential, 402 balance, 404 model, 413 body, 429/503
 * throttle, 5xx transient. The body refines the message only.
 */
export function responseError(status, body, requestId, retryAfterHeader) {
    const detail = wireErrorDetail(body);
    const text = detail === undefined ? '' : detailText(detail);
    const message = detail?.message !== undefined && detail.message !== '' ? detail.message : `HTTP ${status}`;
    const base = requestId === undefined ? {} : { requestId };
    const wait = retryAfterMs(retryAfterHeader);
    const withWait = wait === undefined ? base : { ...base, providerRetryAfterMs: wait };
    if (status === 401 || status === 403) {
        return bilingual('INVALID_CREDENTIAL', `river.ai rejected the API key (${status}): ${message}`, `river.ai 拒绝了该 API Key（${status}）：${message}`, withWait);
    }
    if (status === 402 || QUOTA_DETAIL.test(text)) {
        return bilingual('QUOTA', `river.ai account is out of balance: ${message}`, `river.ai 账号余额不足：${message}`, { status, ...withWait });
    }
    if (status === 404) {
        return bilingual(MODEL_NOT_FOUND_CODE, `river.ai could not find the model or endpoint: ${message}`, `river.ai 找不到该模型或端点：${message}`, { status, ...withWait });
    }
    if (status === 413) {
        return bilingual(BAD_REQUEST_CODE, `river.ai refused the request size (413): ${message}`, `river.ai 拒绝了请求体积（413）：${message}。单次请求上限 50 MiB，图片请先压缩。`, { status, ...withWait });
    }
    if (status === 429 || THROTTLE_DETAIL.test(text)) {
        return bilingual(RATE_LIMIT_CODE, `river.ai rate limited this account: ${message}`, `river.ai 对这个账号限流了：${message}`, { status, ...withWait });
    }
    if (status >= 500) {
        return bilingual(SERVER_CODE, `river.ai returned ${status}: ${message}`, `river.ai 返回 ${status}：${message}`, { status, ...withWait });
    }
    if (isContextOverflowDetail(text)) {
        return bilingual('CONTEXT_WINDOW_EXCEEDED', `river.ai rejected the prompt as too long: ${message}`, `river.ai 认为提示词过长：${message}`, { status, ...withWait });
    }
    if (isOutputLimitDetail(text)) {
        return bilingual(OUTPUT_TOKEN_LIMIT_CODE, `river.ai rejected max_tokens: ${message}`, `river.ai 拒绝了 max_tokens：${message}`, { status, ...withWait });
    }
    return bilingual(BAD_REQUEST_CODE, `river.ai rejected the request (${status}): ${message}`, `river.ai 拒绝了请求（${status}）：${message}`, { status, ...withWait });
}
/**
 * Convert an in-stream `error` event into an `LlmError`.
 *
 * river's SSE can carry `data: {"error":{...}}` after a 200. Without this the
 * turn would end in `EMPTY_RESPONSE` and be retried, hiding the real cause and
 * burning another account's quota.
 */
export function streamErrorToLlmError(value, fallbackMessage) {
    const detail = wireErrorDetail(value);
    const text = detail === undefined ? (fallbackMessage ?? '') : detailText(detail);
    const status = isRecord(value) ? numberValue(value.status) : undefined;
    const requestId = isRecord(value) ? stringValue(value.request_id) : undefined;
    const options = requestId === undefined ? {} : { requestId };
    if (isContextOverflowDetail(text)) {
        return bilingual('CONTEXT_WINDOW_EXCEEDED', `river.ai rejected the prompt as too long: ${text}`, `river.ai 认为提示词过长：${text}`, options);
    }
    if (QUOTA_DETAIL.test(text)) {
        return bilingual('QUOTA', `river.ai account is out of balance: ${text}`, `river.ai 账号余额不足：${text}`, options);
    }
    if (THROTTLE_DETAIL.test(text)) {
        return bilingual(RATE_LIMIT_CODE, `river.ai rate limited: ${text}`, `river.ai 限流：${text}`, options);
    }
    return bilingual(status !== undefined && status >= 500 ? SERVER_CODE : BAD_REQUEST_CODE, `river.ai stream failed: ${text === '' ? 'unknown error' : text}`, `river.ai 流式响应失败：${text === '' ? '未知错误' : text}`, status === undefined ? options : { status, ...options });
}
/**
 * Whether a failure is worth another account instead of another attempt.
 *
 * Rotating accounts fixes a throttle, a balance and a bad key; it cannot fix a
 * malformed request, so those stop immediately rather than cycling the pool.
 */
export function isAccountScopedFailure(failure) {
    return failure.code === RATE_LIMIT_CODE
        || failure.code === THROTTLED_CODE
        || failure.code === 'QUOTA'
        || failure.code === 'INVALID_CREDENTIAL'
        || failure.status === 429
        || failure.status === 402
        || failure.status === 401
        || failure.status === 403;
}
//# sourceMappingURL=provider-errors.js.map