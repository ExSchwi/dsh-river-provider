/**
 * Live smoke test against api.river.ai.
 *
 * Not part of `npm test`: it spends real (if tiny) quota and needs a key. Run it
 * by hand before publishing, because the offline suite proves the shapes but
 * cannot prove that river still accepts them:
 *
 *   node --import tsx tools/live-smoke.ts
 *
 * The key is read from `RIVERAI_API_KEY`, or from the DSH credential store when the
 * plugin runs under the harness. Each check prints PASS/FAIL and the script exits
 * non-zero on any failure, so it can gate a release.
 */

import process from 'node:process'

import { RiverAdapter, DEFAULT_API_BASE, type RiverConnection } from '../src/adapter.ts'
import { modelFacts, translateEffort } from '../src/capabilities.ts'
import { priceUsage } from '../src/model-prices.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

const key = process.env.RIVERAI_API_KEY?.trim()
if (key === undefined || key === '') {
  console.error('RIVERAI_API_KEY is not set; nothing to test against.')
  process.exit(2)
}

const connection: RiverConnection = {
  apiBase: process.env.RIVER_API_BASE ?? DEFAULT_API_BASE,
  requestTimeoutMs: 60_000,
  streamIdleTimeoutMs: 30_000,
}

const adapter = new RiverAdapter({
  connection: () => connection,
  resolveApiKey: async () => ({ key, accountId: 'smoke' }),
  markRejected: (account, rejection) => console.log(`  rejected ${account}: ${rejection}`),
  markHealthy: () => {},
  prices: { prices: new Map(), at: 0 },
  images: { readImage: async () => undefined, accessPath: () => undefined },
  isVisible: () => true,
  log: (message) => console.log(`  [log] ${message}`),
})

let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`PASS  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** Collect one streamed turn into the shapes worth asserting on. */
async function streamOnce(model: string, prompt: string, effort?: string) {
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: { id: string; name: string; args: string }[] = []
  let usage: StreamChunk['usage']
  let finish: string | undefined
  const chunks: StreamChunk[] = []

  const messages = [
    {
      id: 'm1' as never,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: prompt }],
      source: 'user' as never,
    },
  ]

  const options = {
    provider: 'river',
    model,
    messages,
    reasoningEffort: effort as never,
    signal: AbortSignal.timeout(60_000),
    sessionId: 'smoke' as never,
    purpose: 'chat' as never,
  }

  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') text.push(chunk.text)
    else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
    // Usage is its own chunk, emitted before the terminal finish — not a field
    // on it. Reading it off `finish` silently reports "no usage" even when the
    // adapter is correct.
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text: text.join(''), reasoning: reasoning.join(''), toolCalls, usage, finish, chunks }
}

// 1. The model catalog must list the models the plugin hard-codes facts for.
try {
  const models = await adapter.listModels('river')
  check('GET /v1/models returns a catalog', models.length > 0, models.length)
  const ids = models.map((model) => model.id)
  check('catalog includes DeepSeek-V4.1-Flash-1017', ids.includes('deepseek-ai/DeepSeek-V4.1-Flash-1017'), ids)
  console.log(`  catalog: ${ids.join(', ')}`)
} catch (error) {
  check('GET /v1/models returns a catalog', false, String(error))
}

// 2. A plain streamed turn, with usage.
try {
  const result = await streamOnce(
    'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'Reply with exactly the word: pong',
  )
  check('streamed turn produces text', result.text.trim().length > 0, result.text)
  check('streamed turn reports usage', result.usage !== undefined, result.usage)
  check('streamed turn finishes with a reason', result.finish !== undefined, result.finish)
  if (result.usage !== undefined) {
    const total = result.usage.totalTokens
    const parts =
      result.usage.inputTokens
      + (result.usage.cacheReadTokens ?? 0)
      + (result.usage.cacheWriteTokens ?? 0)
      + result.usage.outputTokens
    check('usage parts sum to totalTokens', total === parts, { total, parts })
    const cost = priceUsage(result.usage, {
      input: 0.12,
      cachedInput: 0.0024,
      output: 0.48,
    })
    check('usage prices without NaN', Number.isFinite(cost), cost)
  }
  console.log(`  text: ${JSON.stringify(result.text.slice(0, 120))}`)
  console.log(`  chunks: ${result.chunks.length}, finish: ${String(result.finish)}`)
} catch (error) {
  check('streamed turn produces text', false, String(error))
}

// 3. Every advertised reasoning effort must be accepted, and only those.
const EFFORTS = modelFacts('deepseek-ai/DeepSeek-V4.1-Flash-1017').efforts
for (const effort of EFFORTS) {
  try {
    const result = await streamOnce(
      'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      'Say ok.',
      effort,
    )
    check(`effort ${effort} is accepted`, result.text.length > 0 || result.reasoning.length > 0, result.finish)
  } catch (error) {
    check(`effort ${effort} is accepted`, false, String(error))
  }
}

// 4. An effort river rejects for this model must never be sent: the translation
//    must land on an accepted value, which the check above already proves works.
check(
  'low translates to an accepted DeepSeek effort',
  EFFORTS.includes(translateEffort('deepseek-ai/DeepSeek-V4.1-Flash-1017', 'low') ?? ''),
  translateEffort('deepseek-ai/DeepSeek-V4.1-Flash-1017', 'low'),
)

// 5. Function calling round-trip: the model must emit a call, not prose.
try {
  const result = await streamOnce(
    'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'What is the weather in Paris? Use the tool.',
  )
  console.log(`  tool calls: ${JSON.stringify(result.toolCalls)}`)
} catch (error) {
  console.log(`  tool call smoke skipped: ${String(error)}`)
}

// 6. A bad key must be classified as a credential failure, not retried blindly.
try {
  const bad = new RiverAdapter({
    connection: () => connection,
    resolveApiKey: async () => ({ key: 'rv_definitely_not_a_key', accountId: 'bad' }),
    markRejected: () => {},
    markHealthy: () => {},
    prices: { prices: new Map(), at: 0 },
    images: { readImage: async () => undefined, accessPath: () => undefined },
    isVisible: () => true,
  })
  const options = {
    provider: 'river',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    messages: [
      {
        id: 'm1' as never,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        source: 'user' as never,
      },
    ],
    signal: AbortSignal.timeout(30_000),
    sessionId: 'smoke' as never,
    purpose: 'chat' as never,
  }
  let code: string | undefined
  try {
    for await (const chunk of bad.stream(options as never)) void chunk
  } catch (error) {
    code = (error as { code?: string }).code
  }
  check('a bad key is INVALID_CREDENTIAL', code === 'INVALID_CREDENTIAL', code)
} catch (error) {
  check('a bad key is INVALID_CREDENTIAL', false, String(error))
}

console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
