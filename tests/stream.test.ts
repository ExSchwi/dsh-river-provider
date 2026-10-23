/**
 * Stream-shape tests for the decoder.
 *
 * These pin the two things that a live run proved were wrong on river's actual
 * wire format and that no static reading of the API docs would have caught:
 *
 *  1. river sends the reply and `finish_reason` BEFORE the usage frame, so a
 *     decoder that reads usage after completing loses it on every turn.
 *  2. the harness allows nothing after the terminal `finish`, and requires
 *     usage to arrive before it.
 *
 * Both failures are silent — the turn still answers, only cost and token
 * accounting go to zero — which is why they need a test rather than a review.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StreamDecoder } from '../src/stream-decoder.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/** Feed raw SSE `data:` payloads through one decoder and collect the chunks. */
function run(frames: readonly string[]): StreamChunk[] {
  const decoder = new StreamDecoder(4096)
  const out: StreamChunk[] = []
  for (const frame of frames) out.push(...decoder.accept(frame))
  return out
}

/** The chunk sequence as a compact shape list, for order assertions. */
function shape(chunks: readonly StreamChunk[]): string[] {
  return chunks.map((chunk) => chunk.type)
}

function textOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

function usageOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'usage' }>['usage'] | undefined {
  return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage')?.usage
}

test('a plain turn keeps usage before the terminal finish', () => {
  const chunks = run([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'pong' } }] }),
    // river's actual shape: finish_reason here, billing on the same frame.
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    }),
  ])
  assert.equal(textOf(chunks), 'pong')
  assert.deepEqual(shape(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  const usage = usageOf(chunks)
  assert.equal(usage?.inputTokens, 12)
  assert.equal(usage?.outputTokens, 1)
})

test('usage on a separate trailing frame is not lost and not emitted late', () => {
  // This is the case that broke live: the turn completes on the choice frame,
  // and river bills on the next one. Reading usage after `complete()` never sees
  // it; emitting it after `finish` would violate the chunk contract. Capturing
  // first and reporting at completion satisfies both.
  const decoder = new StreamDecoder(4096)
  const chunks: StreamChunk[] = [
    ...decoder.accept(JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })),
    ...decoder.accept(
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
    ),
    // A billing frame after completion must not produce a chunk after `finish`.
    ...decoder.accept(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
    ),
  ]
  assert.deepEqual(shape(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(usageOf(chunks)?.outputTokens, 2)
  assert.equal(chunks.at(-1)?.type, 'finish', 'nothing may follow the terminal finish')
})

test('usage is reported exactly once even when river repeats it', () => {
  const chunks = run([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
  ])
  assert.equal(shape(chunks).filter((type) => type === 'usage').length, 1)
})

test('[DONE] without a finish_reason still completes with the cost it saw', () => {
  const chunks = run([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
    '[DONE]',
  ])
  // Blocks close first, then usage, then the terminal finish.
  assert.deepEqual(shape(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(usageOf(chunks)?.outputTokens, 1)
})

test('a dropped stream still reports partial text and its usage', () => {
  const decoder = new StreamDecoder(4096)
  const chunks: StreamChunk[] = [
    ...decoder.accept(JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] })),
    ...decoder.accept(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })),
    ...decoder.finish(),
  ]
  assert.equal(textOf(chunks), 'partial')
  assert.deepEqual(shape(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
})

test('an empty answer is retryable rather than silently successful', () => {
  const decoder = new StreamDecoder(4096)
  decoder.accept(JSON.stringify({ choices: [{ index: 0, delta: {} }] }))
  assert.throws(() => [...decoder.accept(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))], {
    code: 'EMPTY_RESPONSE',
  })
})

test('reasoning arrives as its own block, closed before the answer', () => {
  const chunks = run([
    JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'answer' } }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
  ])
  assert.deepEqual(shape(chunks), [
    'block-start',
    'reasoning-delta',
    'block-end',
    'block-start',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ])
  assert.equal(textOf(chunks), 'answer')
})

test('a tool call is addressable from its first frame', () => {
  const chunks = run([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }],
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
  ])
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(end !== undefined)
  if (end !== undefined && end.type === 'block-end' && end.block.type === 'tool-call') {
    assert.equal(end.block.name, 'get_weather')
    assert.equal(end.block.arguments, '{"city":"Paris"}')
  }
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.deepEqual(finish !== undefined && finish.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
})

test('an in-band error frame is classified, not turned into an empty answer', () => {
  const decoder = new StreamDecoder(4096)
  assert.throws(
    () => [...decoder.accept(JSON.stringify({ error: { message: 'rate limit exceeded', status: 429 } }))],
    { code: 'RATE_LIMIT' },
  )
})
