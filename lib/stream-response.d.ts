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
export declare function ownedResponseStream<T>(callerSignal: AbortSignal | undefined, run: (signal: AbortSignal) => AsyncIterable<T>): AsyncIterable<T>;
