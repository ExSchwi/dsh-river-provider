/**
 * Contract tests for the pieces that are pure functions of the wire vocabulary.
 *
 * Everything here runs offline: no key, no network, no harness. The subjects
 * are the places where a wrong answer is invisible until production — effort
 * translation, usage accounting, error classification and the SSE framing — so
 * these are the tests that pay for themselves.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  KNOWN_MODELS,
  modelFacts,
  reasoningEffortsFor,
  titleEffort,
  translateEffort,
} from '../src/capabilities.ts'
import { mapUsage } from '../src/stream-decoder.ts'
import {
  isAccountScopedFailure,
  isContextOverflowDetail,
  isOutputLimitDetail,
  responseError,
  retryAfterMs,
  streamErrorToLlmError,
} from '../src/provider-errors.ts'
import { findLivePrice, parseLivePrices, priceUsage } from '../src/model-prices.ts'

test('every model exposes river\'s own effort whitelist', () => {
  assert.deepEqual(modelFacts('deepseek-ai/DeepSeek-V4.1-Flash-1017').efforts, ['none', 'high', 'max'])
  assert.deepEqual(modelFacts('zai-org/GLM-5.3-Flash').efforts, ['low', 'high', 'max'])
})

test('effort translation never emits a value the model rejects', () => {
  // DeepSeek has no `low`: `low` sits between `none` and `high`, and the tie
  // resolves CHEAPER, so the request degrades to `none` rather than `high`.
  assert.equal(translateEffort('deepseek-ai/DeepSeek-V4.1-Flash', 'low'), 'none')
  // `medium` is one step from `high` and two from `none`: nearest wins.
  assert.equal(translateEffort('deepseek-ai/DeepSeek-V4.1-Flash', 'medium'), 'high')
  assert.equal(translateEffort('zai-org/GLM-5.3-Flash', 'medium'), 'low')
  // A level the model serves passes through untouched.
  assert.equal(translateEffort('deepseek-ai/DeepSeek-V4.1-Flash', 'max'), 'max')
  // A model with no reasoning never receives an effort at all.
  assert.equal(translateEffort('unknown/text-only', 'high'), undefined)
})

test('GLM keeps reasoning on machine-shaped calls', () => {
  // `none` is not in GLM's whitelist, so a title call gets its lowest real level.
  assert.equal(titleEffort('zai-org/GLM-5.3-Flash'), 'low')
  assert.equal(titleEffort('deepseek-ai/DeepSeek-V4.1-Flash'), 'none')
})

test('reasoning info is branded and ordered', () => {
  const efforts = reasoningEffortsFor('deepseek-ai/DeepSeek-V4.1-Flash')
  assert.deepEqual(efforts.map((effort) => String(effort.id)), ['none', 'high', 'max'])
  assert.deepEqual(efforts.map((effort) => effort.name), ['No reasoning', 'High', 'Maximum'])
})

test('the static snapshot covers every documented model', () => {
  assert.equal(Object.keys(KNOWN_MODELS).length >= 4, true)
  for (const [id, facts] of Object.entries(KNOWN_MODELS)) {
    assert.equal(facts.contextWindow, 1_048_576, `${id} context window`)
    assert.equal(facts.maxOutputTokens > 0, true, `${id} output ceiling`)
  }
})

test('usage maps to disjoint harness counts', () => {
  // 100 prompt of which 40 were cache hits, 7 written to cache, 20 produced.
  const usage = mapUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
    cache_creation_input_tokens: 7,
    completion_tokens_details: { reasoning_tokens: 5 },
  })
  assert.equal(usage.inputTokens, 53)
  assert.equal(usage.cacheReadTokens, 40)
  assert.equal(usage.cacheWriteTokens, 7)
  assert.equal(usage.outputTokens, 20)
  assert.equal(usage.reasoningTokens, 5)
  // The harness requires totalTokens to be the sum of its own parts.
  assert.equal(
    usage.totalTokens,
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens,
  )
})

test('usage never reports a negative input count', () => {
  // A gateway that over-reports cache hits must not produce negative input.
  const usage = mapUsage({
    prompt_tokens: 10,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 25 },
  })
  assert.equal(usage.inputTokens, 0)
})

test('river\'s cost arithmetic matches the published prices', () => {
  const price = modelFacts('deepseek-ai/DeepSeek-V4.1-Flash-1017').price
  // 1M input, 1M cached, 1M output: 0.12 + 0.0024 + 0.48.
  const cost = priceUsage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 }, price)
  assert.equal(Math.round(cost * 10_000) / 10_000, 0.6024)
})

test('live pricing payloads parse and match by id', () => {
  const prices = parseLivePrices({
    inference: [
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash', input: 0.12, cached_input: 0.0024, output: 0.48 },
    ],
  })
  assert.equal(prices.length, 1)
  assert.deepEqual(findLivePrice(prices, 'deepseek-ai/DeepSeek-V4.1-Flash'), prices[0])
  assert.equal(findLivePrice(prices, 'unknown/model'), undefined)
})

test('context overflow and output ceilings stay distinguishable', () => {
  // Overflow must reach the harness as CONTEXT_WINDOW_EXCEEDED, not as a retry.
  assert.equal(isContextOverflowDetail('This model\'s maximum context length is 1048576 tokens'), true)
  assert.equal(isOutputLimitDetail('max_tokens is too large: 400000'), true)
  assert.equal(isContextOverflowDetail('Invalid API key'), false)
})

test('Retry-After accepts seconds, HTTP dates and milliseconds', () => {
  assert.equal(retryAfterMs('30'), 30_000)
  assert.equal(retryAfterMs(2), 2_000)
  const at = new Date(Date.now() + 5_000).toUTCString()
  const parsed = retryAfterMs(at)
  assert.equal(parsed !== undefined && parsed > 0 && parsed <= 5_000, true)
  assert.equal(retryAfterMs('not a date'), undefined)
})

test('a streamed error frame becomes a retryable LlmError', () => {
  const error = streamErrorToLlmError({ error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' } })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.match(error.message, /；/)
})

test('an HTTP 401 becomes an account-scoped invalid-credential failure', () => {
  // Status is the authoritative signal; the body only refines the message.
  const error = responseError(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 'req_1', '45')
  assert.equal(error.code, 'INVALID_CREDENTIAL')
  // Serializable facts live on `failure`; the Error itself carries code/message.
  assert.equal(error.failure.providerRetryAfterMs, 45_000)
  assert.equal(error.failure.requestId, 'req_1')
  assert.match(error.message, /；/)
  assert.equal(isAccountScopedFailure(error.failure), true)
})

test('a malformed request is not worth another account', () => {
  const error = responseError(400, { error: { message: 'unknown field: foo' } }, undefined, undefined)
  assert.equal(error.code, 'BAD_REQUEST')
  assert.equal(isAccountScopedFailure(error.failure), false)
})

test('a 429 waits for the server\'s own Retry-After', () => {
  const error = responseError(429, { error: { message: 'rate limit' } }, undefined, '12')
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, 12_000)
  assert.equal(isAccountScopedFailure(error.failure), true)
})
