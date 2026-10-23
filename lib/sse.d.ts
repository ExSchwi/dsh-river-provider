/**
 * SSE parsing for river.ai's chat-completions stream.
 *
 * river follows the OpenAI wire: `data: {json}` per event, terminated by
 * `data: [DONE]`, with `: comment` keep-alives. The parser below is a real
 * incremental frame splitter rather than a `split('\n')` on each chunk, because
 * a network chunk can cut a JSON payload in half — an event is only decoded once
 * its blank-line terminator arrives.
 *
 * @module dsh-river-provider/sse
 */
/** One decoded SSE event. `data` is the concatenated data lines. */
export interface SseEvent {
    event?: string;
    data: string;
}
/**
 * Incremental server-sent-events decoder.
 *
 * Feed raw text with {@link push}; it returns the events completed by that
 * text and buffers any partial frame for the next call. Multi-line `data:`
 * payloads are joined with `\n` per the SSE spec.
 */
export declare class SseDecoder {
    private buffer;
    /** Feed one decoded chunk; returns the events it completed. */
    push(chunk: string): SseEvent[];
    /**
     * Flush a trailing unterminated frame.
     *
     * A provider that closes the connection without a final blank line still
     * delivered content; dropping it would lose the last token of every answer.
     */
    flush(): SseEvent[];
    private nextSeparator;
}
