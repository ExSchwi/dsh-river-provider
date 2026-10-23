/**
 * Multi-account rotation against the real river.ai API.
 *
 * This is the whole reason the plugin exists: one person, several river.ai
 * accounts, one provider entry. The unit tests prove the pool's *decisions*;
 * this proves that the keys the pool hands out are keys river actually accepts,
 * and that rejecting one really moves traffic to the other instead of failing
 * the turn.
 *
 *   RIVERAI_API_KEY=<key A> RIVERAI_API_KEY_2=<key B> \
 *     node --import tsx tools/live-accounts.ts
 *
 * Exits non-zero if any check fails, so it can gate a release by hand.
 */

import process from 'node:process'
import { RiverAccountPool } from '../src/accounts.ts'
import { RiverAdapter } from '../src/adapter.ts'
import { RiverPriceBook } from '../src/model-prices.ts'
import { AttachmentImageResolver } from '../src/images.ts'
import type { AccountSlot } from '../src/accounts.ts'

const keys: Record<string, string> = {
  RIVERAI_API_KEY: process.env.RIVERAI_API_KEY?.trim() ?? '',
  RIVERAI_API_KEY_2: process.env.RIVERAI_API_KEY_2?.trim() ?? '',
}

let failed = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failed += 1
}

const slots: AccountSlot[] = [
  { id: 'default', label: 'Account A', ref: 'RIVERAI_API_KEY', allowAuthFile: false },
  { id: 'RIVERAI_API_KEY_2', label: 'Account B', ref: 'RIVERAI_API_KEY_2', allowAuthFile: false },
]

const present = slots.filter((slot) => (keys[slot.ref] ?? '') !== '')
if (present.length < 2) {
  console.error('Need two distinct keys: set RIVERAI_API_KEY and RIVERAI_API_KEY_2.')
  process.exit(2)
}
if (keys.RIVERAI_API_KEY === keys.RIVERAI_API_KEY_2) {
  console.error('Both slots hold the same key; rotation cannot be observed.')
  process.exit(2)
}

/** Ask river to authenticate a key, and report whether it did. */
async function asks(key: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch('https://api.river.ai/v1/models', {
    headers: { authorization: `Bearer ${key}` },
  })
  return { ok: response.ok, status: response.status }
}

const pool = new RiverAccountPool({
  slots: () => slots,
  resolveRef: async (ref: string) => keys[ref],
  authFileKey: 'none',
})

// 1. Both keys are real, so a rotation test means something.
for (const slot of present) {
  const result = await asks(keys[slot.ref]!)
  check(`${slot.label} authenticates with river`, result.ok, result.status)
}

// 2. The first key handed out is one of the two configured keys.
const first = await pool.resolveKey({})
check('first allocation is a configured key', Object.values(keys).includes(first.key))
const firstLabel = first.slot.label
console.log(`  first: ${firstLabel}`)

// 3. Rejecting that key must route the next allocation to the other slot.
pool.markRejected(first.key, 'rate-limit', Date.now() + 60_000)
const second = await pool.resolveKey({ tried: [first.key] })
check('after rejection the other account is used', second.key !== first.key, {
  from: firstLabel,
  to: second.slot.label,
})
check('allocations cover both accounts', new Set([first.key, second.key]).size === 2)

// 4. `tried` alone (a mid-turn retry) also excludes without a mark.
pool.reset()
const a = await pool.resolveKey({})
const b = await pool.resolveKey({ tried: [a.key] })
check('tried list rotates without a mark', a.key !== b.key)

// 5. With both keys rejected, the pool reports why instead of silently reusing.
pool.reset()
for (const key of Object.values(keys)) pool.markRejected(key, 'invalid-credential')
let thr: { name?: string; code?: string } | undefined
try {
  await pool.resolveKey({})
} catch (error) {
  thr = error as { name?: string; code?: string }
}
check('exhausted pool throws rather than reusing a rejected key', thr !== undefined, thr?.name)

// 6. A rate-limit mark must reach the harness as a wait it can honour. The
//    assertion runs through a real adapter `stream()` call, because the number
//    is only useful after the adapter's translation — the pool's own error field
//    is invisible to `dsh-llm-retry`, which reads `LlmError.failure`.
pool.reset()
for (const key of Object.values(keys)) pool.markRejected(key, 'rate-limit', Date.now() + 30_000)
const adapter = new RiverAdapter({
  connection: () => ({ apiBase: 'https://api.river.ai/v1', apiKeyEnv: 'RIVERAI_API_KEY', timeoutMs: 30_000 }),
  images: new AttachmentImageResolver(),
  prices: new RiverPriceBook(),
  isVisible: () => true,
  async resolveApiKey(model: string) {
    const account = await pool.resolveKey(model === '' ? {} : { model })
    return { key: account.key, accountId: account.slot.id }
  },
  markRejected: (key, rejection, resetAt) => pool.markRejected(key, rejection, resetAt),
  markHealthy: (key) => pool.markHealthy(key),
})
let rateFailure: { code?: string; providerRetryAfterMs?: number } | undefined
try {
  for await (const _chunk of adapter.stream({
    provider: 'river',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    messages: [{ role: 'user', content: 'hi' }],
  } as never)) {
    // Nothing should arrive: the pool is fully rate limited.
  }
  check('rate-limited pool refuses to start a turn', false, 'stream produced chunks')
} catch (error) {
  rateFailure = (error as { failure?: { code?: string; providerRetryAfterMs?: number } }).failure
    ?? (error as { code?: string; providerRetryAfterMs?: number })
}
check(
  'rate-limited pool surfaces a retry wait the harness can honour',
  rateFailure?.providerRetryAfterMs !== undefined && rateFailure.providerRetryAfterMs > 0,
  { code: rateFailure?.code, wait: rateFailure?.providerRetryAfterMs },
)

console.log(failed === 0 ? '\nALL ACCOUNT CHECKS PASSED' : `\n${failed} ACCOUNT CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
