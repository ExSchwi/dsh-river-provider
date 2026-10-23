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
  event?: string
  data: string
}

/**
 * Incremental server-sent-events decoder.
 *
 * Feed raw text with {@link push}; it returns the events completed by that
 * text and buffers any partial frame for the next call. Multi-line `data:`
 * payloads are joined with `\n` per the SSE spec.
 */
export class SseDecoder {
  private buffer = ''

  /** Feed one decoded chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    // Frames are separated by a blank line; \r\n\r\n is the other legal form.
    for (;;) {
      const separator = this.nextSeparator()
      if (separator === undefined) break
      const frame = this.buffer.slice(0, separator.index)
      this.buffer = this.buffer.slice(separator.index + separator.length)
      const event = decodeFrame(frame)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /**
   * Flush a trailing unterminated frame.
   *
   * A provider that closes the connection without a final blank line still
   * delivered content; dropping it would lose the last token of every answer.
   */
  flush(): SseEvent[] {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() === '') return []
    const event = decodeFrame(rest)
    return event === undefined ? [] : [event]
  }

  private nextSeparator(): { index: number; length: number } | undefined {
    const lf = this.buffer.indexOf('\n\n')
    const crlf = this.buffer.indexOf('\r\n\r\n')
    if (lf < 0 && crlf < 0) return undefined
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 }
    return { index: lf, length: 2 }
  }
}

/** Decode one frame body into an event, or `undefined` for comments/empty. */
function decodeFrame(frame: string): SseEvent | undefined {
  let eventName: string | undefined
  const dataLines: string[] = []
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue
    const colon = rawLine.indexOf(':')
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon)
    let value = colon < 0 ? '' : rawLine.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
  }
  if (dataLines.length === 0) return undefined
  return eventName === undefined ? { data: dataLines.join('\n') } : { event: eventName, data: dataLines.join('\n') }
}
