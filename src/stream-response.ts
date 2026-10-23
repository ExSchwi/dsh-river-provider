/**
 * A caller-abortable wrapper around a provider response stream.
 *
 * Async generators queue `return()` BEHIND a pending `next()`, so a consumer
 * that wants to stop (the harness aborts a turn) would wait for the next
 * network chunk before the generator observes anything. Aborting the request's
 * own `AbortController` is what actually wakes the pending read; `return()` is
 * then just cleanup.
 *
 * Both signals are honoured: the caller's (turn cancelled) and the consumer's
 * (`for await` broke out). Owned cleanup runs exactly once, on either path.
 *
 * @module dsh-river-provider/stream-response
 */

/** Either abort signal may be absent; both are wired when present. */
export function ownedResponseStream<T>(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => AsyncIterable<T>,
): AsyncIterable<T> {
  const owned = new AbortController()
  const signal = callerSignal === undefined ? owned.signal : AbortSignal.any([callerSignal, owned.signal])
  const source = run(signal)
  const iterator = source[Symbol.asyncIterator]()
  let closed = false

  const self: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return self
    },
    async next() {
      if (closed) return { done: true as const, value: undefined }
      try {
        const step = await iterator.next()
        if (step.done === true) closed = true
        return step
      } catch (error) {
        closed = true
        throw error
      }
    },
    async return() {
      if (closed) return { done: true as const, value: undefined }
      closed = true
      // Abort FIRST: a pending `next()` inside the source only settles once the
      // underlying fetch rejects, and a queued `return()` would never get to run.
      owned.abort(new Error('stream closed by consumer'))
      try {
        await iterator.return?.(undefined)
      } catch {
        // The source is already settling from the abort; its own error wins.
      }
      return { done: true as const, value: undefined }
    },
    async throw(error?: unknown) {
      closed = true
      owned.abort(error instanceof Error ? error : new Error('stream aborted'))
      try {
        await iterator.return?.(undefined)
      } catch {
        // See `return`.
      }
      throw error
    },
  }
  return self
}
