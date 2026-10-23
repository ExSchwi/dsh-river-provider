/**
 * Mapping river's stream vocabulary onto the harness's.
 *
 * One class turns the decoded SSE payloads of a single attempt into
 * `StreamChunk`s. It exists (rather than free functions) because streaming
 * tool calls are stateful across frames: river sends `delta.tool_calls[i]` with
 * a `name` on the first frame and `arguments` fragments afterwards, and the
 * harness needs one `block-start` / `tool-call-delta`* / `block-end` triple per
 * call. Getting that wrong is the classic failure where the second tool call of
 * a turn is dropped or merged into the first.
 *
 * Reasoning is emitted as its OWN block. river puts it in `reasoning_content`;
 * it is billed as output, so it must be surfaced (the user paid for it) but
 * must never be replayed on the next request.
 *
 * @module dsh-river-provider/stream-decoder
 */
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { isContextOverflowDetail } from './provider-errors.ts';
/**
 * Converts one attempt's decoded JSON events into harness chunks.
 *
 * `done` flips once a terminal `finish` has been produced; the caller stops
 * reading at that point, which matters because river keeps the socket open for
 * a moment after the final frame.
 */
export declare class StreamDecoder {
    private readonly maxTokens;
    private nextIndex;
    private reasoningIndex;
    private reasoningText;
    private textIndex;
    private text;
    private readonly calls;
    private usage;
    private usageReported;
    private finished;
    constructor(maxTokens: number | undefined);
    /** Whether a terminal `finish` chunk has been emitted. */
    get done(): boolean;
    /**
     * Accept one SSE payload (JSON text, or `[DONE]`).
     *
     * Order inside one frame is deliberate: usage is captured FIRST, then the
     * choice is applied. river can put `finish_reason` and `usage` in the same
     * frame, and `acceptChoice` completes the stream on the spot, so capturing
     * usage afterwards would drop it on exactly the turns that matter. Because the
     * harness allows nothing after the terminal `finish`, a usage frame that
     * arrives after completion is dropped rather than emitted late.
     *
     * Yields the chunks the payload completes. Throws a classified `LlmError` for
     * an in-band error frame so the retry layer sees the real cause.
     */
    accept(data: string): Generator<StreamChunk>;
    /**
     * Emit the captured usage exactly once.
     *
     * The harness contract is "usage before the terminal finish and nothing
     * afterward", so this is called immediately before `finish` rather than after,
     * and never twice.
     */
    private reportUsage;
    /**
     * Close out an attempt whose stream ended without a `finish_reason`.
     *
     * A dropped connection still delivered a partial answer; the harness decides
     * whether a partial answer is usable (it retries on `EMPTY_RESPONSE` only).
     */
    finish(): Generator<StreamChunk>;
    /** Handle one `choices[0]` object. */
    private acceptChoice;
    /** Accumulate and stream tool-call fragments. */
    private acceptToolCalls;
    /** Emit the terminal chunks for one `finish_reason`. */
    private complete;
    /** Close the reasoning block if one is open. */
    private closeReasoning;
    /** Close every open block: answer text, then each tool call. */
    private closeBlocks;
}
/**
 * Map river's `usage` onto the harness's disjoint counts.
 *
 * river follows OpenAI: `prompt_tokens` INCLUDES cached tokens. The harness's
 * `inputTokens` is fresh input only and `totalTokens` is the sum of the parts,
 * so the cached and cache-write counts must be subtracted. Passing
 * `prompt_tokens` through unchanged inflates every cached turn, which is the
 * single most common cost-reporting bug in adapters of this shape.
 */
export declare function mapUsage(raw: Record<string, unknown>): TokenUsage;
/** Re-exported for tests that assert the classification, not the text. */
export { isContextOverflowDetail };
