/**
 * Tests for the multi-account pool — the reason this provider exists.
 *
 * The pool is pure state plus an injected clock, so every scenario here is
 * deterministic: no sleeping, no network, no key. What is being pinned down is
 * the rotation contract, because each of these failures is silent in production
 * — a turn simply dies on the wrong key while every other account sits idle.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AllAccountsUnusableError,
  RETRY_MAX_DELAY_MS,
  RiverAccountPool,
  STATE_TTL_MS,
  accountUsable,
  normalizeKey,
  resolveAccounts,
  selectAccountForModel,
  type AccountPoolOptions,
  type AccountSlot,
} from '../src/accounts.ts'

const THREE: AccountSlot[] = [
  { id: 'default', label: 'Default', ref: 'RIVERAI_API_KEY' },
  { id: 'RIVERAI_API_KEY_2', label: 'Account 2', ref: 'RIVERAI_API_KEY_2' },
  { id: 'RIVERAI_API_KEY_3', label: 'Account 3', ref: 'RIVERAI_API_KEY_3' },
]

/** A pool over a mutable clock and a mutable env, so tests can travel in time. */
function build(
  env: Record<string, string | undefined>,
  extra: Partial<AccountPoolOptions> = {},
): { pool: RiverAccountPool; clock: { at: number; advance(ms: number): void }; env: typeof env } {
  const clock = {
    at: 1_000_000,
    advance(ms: number) {
      this.at += ms
    },
  }
  const pool = new RiverAccountPool({
    slots: () => THREE,
    resolveRef: (ref) => env[ref],
    now: () => clock.at,
    ...extra,
  })
  return { pool, clock, env }
}

const KEYS = {
  RIVERAI_API_KEY: 'rv_one',
  RIVERAI_API_KEY_2: 'rv_two',
  RIVERAI_API_KEY_3: 'rv_three',
}

test('missing and blank credentials are not accounts', async () => {
  const { pool } = build({ RIVERAI_API_KEY: 'rv_one', RIVERAI_API_KEY_2: '   ', RIVERAI_API_KEY_3: undefined })
  const accounts = await pool.describeAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.key, 'rv_one')
})

test('two slots pointing at one key are one account', async () => {
  // A settings edit can leave both slots resolving to the same env var; counting
  // it twice would make "all accounts exhausted" wrong and waste a rotation.
  const { pool } = build({ RIVERAI_API_KEY: 'rv_same', RIVERAI_API_KEY_2: '  rv_same  ' })
  const accounts = await pool.describeAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.key, 'rv_same')
})

test('an asynchronous credential seam resolves like a synchronous one', async () => {
  // The real seam is a keyring read; the pool must await it rather than treat
  // the Promise as a key.
  const { pool } = build(KEYS, { resolveRef: async (ref) => Promise.resolve(KEYS[ref as keyof typeof KEYS]) })
  const accounts = await pool.resolveKey({})
  assert.equal(accounts.key, 'rv_one')
})

test('rotation spreads attempts across idle accounts and skips tried ones', async () => {
  const { pool } = build(KEYS)
  const first = await pool.resolveKey({})
  assert.equal(first.key, 'rv_one')
  // The adapter reports the rejection, then asks again for the same turn.
  pool.markRejected(first.key, 'throttled')
  const second = await pool.resolveKey({ tried: [first.key] })
  assert.equal(second.key, 'rv_two')
  pool.markRejected(second.key, 'throttled')
  const third = await pool.resolveKey({ tried: [first.key, second.key] })
  assert.equal(third.key, 'rv_three')
})

test('the least-used account goes first, not the first configured', async () => {
  const { pool } = build(KEYS)
  // Two attempts spread over the first two accounts: rv_one once, rv_two once.
  const a = await pool.resolveKey({})
  const b = await pool.resolveKey({})
  assert.deepEqual([a.key, b.key], ['rv_one', 'rv_two'], 'ties resolve to the earliest configured slot')
  // rv_three has never been used, so it wins outright rather than waiting for
  // the rotation to arrive at it by position.
  const c = await pool.resolveKey({})
  assert.equal(c.key, 'rv_three')
})

test('a pinned account wins while it is healthy and is skipped once it is not', async () => {
  const { pool } = build(KEYS, { preferredId: () => 'RIVERAI_API_KEY_2' })
  const pinned = await pool.resolveKey({})
  assert.equal(pinned.key, 'rv_two')
  pool.markRejected('rv_two', 'throttled')
  const fallback = await pool.resolveKey({})
  assert.equal(fallback.key, 'rv_one')
})

test('model routing rules beat the pin', async () => {
  const { pool } = build(KEYS, {
    preferredId: () => 'RIVERAI_API_KEY_2',
    modelAccountRules: () => [{ models: ['zai-org/GLM-5.3-Flash'], account: 'RIVERAI_API_KEY_3' }],
  })
  const routed = await pool.resolveKey({ model: 'zai-org/GLM-5.3-Flash' })
  assert.equal(routed.key, 'rv_three')
  // Any other model falls back to the pin.
  const other = await pool.resolveKey({ model: 'deepseek-ai/DeepSeek-V4.1-Flash' })
  assert.equal(other.key, 'rv_two')
})

test('routing patterns accept a wildcard and a bare model name', () => {
  const accounts = THREE.map((slot, index) => ({
    slot,
    key: `k${index}`,
    state: undefined,
  }))
  assert.equal(
    selectAccountForModel(accounts, accounts, 'zai-org/GLM-5.3-Flash', [{ models: ['*GLM*'], account: 'default' }])?.key,
    'k0',
  )
  // A pattern without a slash matches any vendor prefix.
  assert.equal(
    selectAccountForModel(accounts, accounts, 'zai-org/GLM-5.3-Flash', [
      { models: ['GLM-5.3-Flash'], account: 'default' },
    ])?.key,
    'k0',
  )
  assert.equal(
    selectAccountForModel(accounts, accounts, 'other/model', [{ models: ['GLM*'], account: 'default' }]),
    undefined,
  )
})

test('a routed account that is cooling down yields to another key', async () => {
  // The rule names account 3, but it was just throttled: silently failing the
  // turn would be worse than using a hardier key for this one request.
  const { pool, clock } = build(KEYS, {
    modelAccountRules: () => [{ models: ['zai-org/GLM-5.3-Flash'], account: 'RIVERAI_API_KEY_3' }],
  })
  pool.markRejected('rv_three', 'throttled', clock.at + 60_000)
  const picked = await pool.resolveKey({ model: 'zai-org/GLM-5.3-Flash' })
  assert.equal(picked.key, 'rv_one')
})

test('a rejected key is unusable until its cooldown ends', async () => {
  const { pool, clock } = build(KEYS)
  pool.markRejected('rv_one', 'throttled')
  const { state } = { state: (await pool.describeAccounts())[0]?.state }
  assert.equal(state?.kind, 'cooldown')
  assert.equal(state?.cause, 'throttle')
  assert.equal(accountUsable(state, clock.at), false)
  // A throttle cools for 60s; nothing else in the pool is marked.
  clock.advance(59_000)
  assert.equal(accountUsable(state, clock.at), false)
  clock.advance(1_000)
  assert.equal(accountUsable(state, clock.at), true)
})

test('an invalid key stays disabled even after a later success', async () => {
  const { pool } = build(KEYS)
  pool.markRejected('rv_one', 'invalid-credential')
  const state = (await pool.describeAccounts())[0]?.state
  assert.equal(state?.kind, 'disabled')
  assert.equal(accountUsable(state), false)
  // A success for a disabled key cannot happen, so a stray call must not revive
  // it — otherwise a bad key would loop forever.
  pool.markHealthy('rv_one')
  assert.equal((await pool.describeAccounts())[0]?.state?.kind, 'disabled')
})

test('a success clears a throttle cooldown', async () => {
  const { pool } = build(KEYS)
  pool.markRejected('rv_one', 'throttled')
  pool.markHealthy('rv_one')
  assert.equal((await pool.describeAccounts())[0]?.state, undefined)
})

test('a second failure never shortens a cooldown already in force', () => {
  const { pool, clock } = build(KEYS)
  // A rate-limit with a long Retry-After lands first; a generic throttle arrives
  // after and carries less information, so it must not cut the wait short.
  pool.markRejected('rv_one', 'rate-limit', clock.at + 600_000)
  pool.markRejected('rv_one', 'throttled')
  return pool.describeAccounts().then((accounts) => {
    assert.equal(accounts[0]?.state?.until, clock.at + 600_000)
  })
})

test('Retry-After is honoured but clamped to one day', async () => {
  const { pool, clock } = build(KEYS)
  pool.markRejected('rv_one', 'rate-limit', clock.at + 10 * STATE_TTL_MS)
  assert.equal((await pool.describeAccounts())[0]?.state?.until, clock.at + STATE_TTL_MS)
})

test('a Retry-After in the past falls back to the conservative default', async () => {
  const { pool, clock } = build(KEYS)
  pool.markRejected('rv_one', 'rate-limit', clock.at - 5_000)
  assert.equal((await pool.describeAccounts())[0]?.state?.until, clock.at + 5 * 60_000)
})

test('the error names the soonest recovery and stays within the retry window', async () => {
  const { pool, clock } = build(KEYS)
  pool.markRejected('rv_one', 'throttled', clock.at + 30_000)
  pool.markRejected('rv_two', 'throttled', clock.at + 90_000)
  pool.markRejected('rv_three', 'throttled', clock.at + 20_000)
  const error = await pool.resolveKey({}).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof AllAccountsUnusableError)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.retryAfterMs, 20_000)
  assert.match(error.message, /frees up in 20s/)
})

test('an unreachable recovery reports no wait at all', async () => {
  const { pool, clock } = build(KEYS)
  // Beyond the adapter's backoff ceiling the harness would ignore the hint, so
  // sending one is worse than sending none.
  pool.markRejected('rv_one', 'rate-limit', clock.at + RETRY_MAX_DELAY_MS * 2)
  pool.markRejected('rv_two', 'rate-limit', clock.at + RETRY_MAX_DELAY_MS * 2)
  pool.markRejected('rv_three', 'rate-limit', clock.at + RETRY_MAX_DELAY_MS * 2)
  const error = await pool.resolveKey({}).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof AllAccountsUnusableError)
  assert.equal(error.retryAfterMs, RETRY_MAX_DELAY_MS)
})

test('a pool of bad keys is a credential failure, not a rate limit', async () => {
  const { pool } = build(KEYS)
  for (const key of Object.values(KEYS)) pool.markRejected(key, 'invalid-credential')
  const error = await pool.resolveKey({}).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof AllAccountsUnusableError)
  assert.equal(error.code, 'INVALID_CREDENTIAL')
  assert.match(error.message, /All 3 river\.ai accounts were rejected/)
})

test('an empty pool explains where to add a key', async () => {
  const { pool } = build({})
  const error = await pool.resolveKey({}).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof AllAccountsUnusableError)
  assert.equal(error.code, 'INVALID_CREDENTIAL')
  assert.match(error.message, /Settings → Models/)
})

test('every account tried this turn says so instead of blaming cooldowns', async () => {
  const { pool } = build(KEYS)
  const error = await pool.resolveKey({ tried: Object.values(KEYS) }).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  assert.ok(error instanceof AllAccountsUnusableError)
  assert.match(error.message, /already tried this turn/)
})

test('a literal key in settings beats the env var for the same slot', async () => {
  const { pool } = build(
    { RIVERAI_API_KEY: 'rv_env' },
    { slots: () => [{ id: 'default', label: 'Default', ref: 'RIVERAI_API_KEY', literal: '  rv_literal ' }] },
  )
  const accounts = await pool.describeAccounts()
  assert.equal(accounts[0]?.key, 'rv_literal')
})

test('the sidebar shows the pinned account, then the first healthy one', async () => {
  const { pool } = build(KEYS, { preferredId: () => 'RIVERAI_API_KEY_3' })
  assert.equal((await pool.activeAccount())?.key, 'rv_three')
  pool.markRejected('rv_three', 'invalid-credential')
  assert.equal((await pool.activeAccount())?.key, 'rv_one')
})

test('editing credentials clears every mark', async () => {
  const { pool } = build(KEYS)
  pool.markRejected('rv_one', 'invalid-credential')
  pool.markRejected('rv_two', 'throttled')
  pool.reset()
  const accounts = await pool.describeAccounts()
  assert.deepEqual(accounts.map((account) => account.state), [undefined, undefined, undefined])
})

test('normalizeKey trims and rejects blanks', () => {
  assert.equal(normalizeKey('  rv_x  '), 'rv_x')
  assert.equal(normalizeKey('   '), undefined)
  assert.equal(normalizeKey(undefined), undefined)
})

test('resolveAccounts accepts a synchronous resolver as well as an async one', async () => {
  const sync = await resolveAccounts({ slots: () => THREE, resolveRef: (ref) => KEYS[ref as keyof typeof KEYS] })
  assert.deepEqual(sync.map((account) => account.key), ['rv_one', 'rv_two', 'rv_three'])
})
