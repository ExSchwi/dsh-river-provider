/**
 * Price arithmetic, including the shapes river actually sends.
 *
 * `priceUsage` shipped broken once: the cache fields are optional on
 * `LlmUsage` and river omits them on uncached turns, so adding them straight
 * into the cost produced NaN for every ordinary request. The harness only
 * noticed because a live run priced a real turn. These tests keep that from
 * coming back without needing an API key.
 *
 *   node --import tsx --test tests/prices.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { cacheSavingsPercent, priceUsage } from '../src/model-prices.ts'
import type { RiverPrice } from '../src/model-prices.ts'

const FLASH: RiverPrice = { input: 0.12, cachedInput: 0.0024, output: 0.48 }

test('an uncached turn prices without NaN when cache fields are absent', () => {
  // Exactly what river returned in a live run: no cache keys at all.
  const cost = priceUsage({ inputTokens: 12, outputTokens: 3 }, FLASH)
  assert.equal(Number.isFinite(cost), true)
  // 12 * 0.12 + 3 * 0.48 = 1.44 + 1.44 = 2.88 per million.
  assert.equal(cost, 2.88 / 1_000_000)
})

test('a cached turn bills cache reads at the cached rate', () => {
  const cost = priceUsage(
    { inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 500 },
    FLASH,
  )
  // 1000*0.12 + 9000*0.0024 + 500*0.48 = 120 + 21.6 + 240 = 381.6
  assert.equal(cost, 381.6 / 1_000_000)
})

test('cache savings is 0 rather than NaN when nothing was cached', () => {
  assert.equal(cacheSavingsPercent({ inputTokens: 12, outputTokens: 3 }, FLASH), 0)
})

test('cache savings reports the discounted share of the prompt', () => {
  // 9000 of 10000 prompt tokens were cache reads at 50x off: 88% of the
  // full-price prompt cost was avoided.
  const percent = cacheSavingsPercent(
    { inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 0 },
    FLASH,
  )
  assert.equal(percent, 88)
})

test('cache savings never divides by zero on an empty prompt', () => {
  assert.equal(cacheSavingsPercent({ inputTokens: 0, outputTokens: 5 }, FLASH), 0)
})
