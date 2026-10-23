/**
 * Building river's chat-completions request body.
 *
 * This module is pure: it takes harness request state and returns the JSON body.
 * Keeping it separate is what makes the wire protocol testable without a server
 * — the tests assert on the body river will actually receive, including the
 * cases the upstream plugin got wrong:
 *
 *  - `reasoning_effort` is per-model, and DeepSeek has no `low`. An unknown
 *    effort is snapped to the nearest accepted one instead of being forwarded
 *    verbatim (river answers 400 for an out-of-whitelist value), and `off` is
 *    sent by OMITTING the field rather than as a literal enum member.
 *  - Cached prompt tokens are reported separately by river, so the harness's
 *    `inputTokens` must be `prompt_tokens - cached`; that happens on the way
 *    back, in `stream-decoder.ts`.
 *  - Images are limited to JPEG/PNG. Other formats are re-encoded by the
 *    attachment layer, and a format it cannot encode degrades to a text handle
 *    instead of failing the turn.
 *
 * @module dsh-river-provider/wire
 */
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
import { isRecord } from './wire-guards.ts';
/** river's documented request-body ceiling, including base64 image payloads. */
export declare const MAX_REQUEST_BYTES: number;
/**
 * Image request target for river.
 *
 * 1568 is the long edge above which vision encoders in this model family stop
 * gaining accuracy, and 1 MiB keeps a single request well under the 50 MiB body
 * limit even with a full history of images carrying base64 (~4/3 expansion).
 */
export declare const REQUEST_IMAGE_MAX_LONG_EDGE = 1568;
export declare const REQUEST_IMAGE_MAX_ENCODED_BYTES: number;
/** What the body builder needs from the plugin to resolve images. */
export interface WireImageResolver {
    /** Read the request variant of one image, honouring the target. */
    readImage: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>;
    /** Resolve a tool-readable path for one image, when the backend has one. */
    accessPath: (ref: ImageAttachmentRef) => {
        readonlyPath: string;
    } | undefined;
    /** Bind this request's attachment source; absent for a resolver-free turn. */
    bind?: ((access: unknown) => void) | undefined;
}
/** Input to {@link buildRequest}. */
export interface RequestInput {
    model: string;
    messages: GenerateOptions['messages'];
    system?: string | undefined;
    tools: readonly ToolSchema[] | undefined;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    topP?: number | undefined;
    stop?: readonly string[] | undefined;
    reasoningEffort?: string | undefined;
    /** Resolves images; when absent, images degrade to text handles. */
    images?: WireImageResolver | undefined;
}
/** river's `content` part for one image. */
interface ImagePart {
    type: 'image_url';
    image_url: {
        url: string;
    };
}
/** Any wire content part. */
type WirePart = {
    type: 'text';
    text: string;
} | ImagePart;
interface WireMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | WirePart[];
    tool_call_id?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }[];
    name?: string;
}
/** The JSON body river receives. */
export interface ChatCompletionsBody {
    model: string;
    messages: WireMessage[];
    stream: true;
    stream_options: {
        include_usage: true;
    };
    [key: string]: unknown;
}
/**
 * Build the request body.
 *
 * Async because image variants are produced on demand; a text-only turn never
 * touches the attachment layer.
 */
export declare function buildRequest(input: RequestInput): Promise<ChatCompletionsBody>;
/**
 * Reject a body that river would refuse with 413.
 *
 * Failing locally yields a precise message naming the limit; failing remotely
 * yields an opaque 413 after uploading 50 MiB.
 */
export declare function assertBodySize(bytes: number): void;
/**
 * True when a rejection names `max_tokens`, so the caller can retry with the
 * model's own ceiling instead of failing the turn.
 */
export declare function isMaxTokensRejection(detail: string): boolean;
/** Narrow a decoded JSON value to a record. */
export { isRecord };
