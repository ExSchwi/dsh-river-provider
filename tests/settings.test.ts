/**
 * Tests for the two settings a user can use to bound what a model costs:
 * a per-model default reasoning effort and a context-window ceiling.
 *
 * Both are capacity decisions rather than protocol ones, so the assertions are
 * about the NUMBERS the adapter advertises — those numbers are what the harness's
 * meter, compaction policy and reference budget all read.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampCeiling,
  configuredEffort,
  contextWindowFor,
  modelFacts,
  outputBudgetFor,
} from '../src/capabilities.ts'

const DEEPSEEK = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const GLM = 'zai-org/GLM-5.3-Flash'

test('a ceiling only ever lowers a capacity', () => {
  assert.equal(clampCeiling(384_000, 65_536), 65_536)
  // Asking for more than the model offers cannot raise it: river would 400 on
  // an over-large max_tokens and silently truncate an over-large context.
  assert.equal(clampCeiling(384_000, 999_999_999), 384_000)
  // Absent, zero and negative all mean "no opinion" — a cleared form field.
  assert.equal(clampCeiling(384_000, undefined), 384_000)
  assert.equal(clampCeiling(384_000, 0), 384_000)
  assert.equal(clampCeiling(384_000, -1), 384_000)
})

test('the context ceiling reaches the advertised window', () => {
  assert.equal(contextWindowFor(DEEPSEEK, undefined), 1_048_576)
  assert.equal(contextWindowFor(DEEPSEEK, 262_144), 262_144)
  // An unknown model still has a ceiling applied, because the ceiling is the
  // operator's budget rather than a model fact.
  assert.equal(contextWindowFor('vendor/unknown-model', 32_000), 32_000)
})

test('the output budget stays under the model maximum', () => {
  assert.equal(outputBudgetFor(DEEPSEEK, undefined), 384_000)
  assert.equal(outputBudgetFor(DEEPSEEK, 65_536), 65_536)
  // GLM's own maximum is 128K; a 384K pin must not escape it.
  assert.equal(outputBudgetFor(GLM, 384_000), 128_000)
})

test('a configured effort the model rejects is an error, not a silent snap', () => {
  // DeepSeek accepts only off|high|max. A `low` here would have snapped down to
  // `off`, quietly changing both behaviour and cost on every turn.
  assert.throws(
    () => configuredEffort(DEEPSEEK, { [DEEPSEEK]: 'low' }),
    /accepts only off\|high\|max for reasoning_effort, not "low"/,
  )
  // GLM accepts only low|high|max; `off` is not a cheaper GLM, it is invalid.
  assert.throws(
    () => configuredEffort(GLM, { [GLM]: 'off' }),
    /accepts only low\|high\|max for reasoning_effort, not "off"/,
  )
  // No river model accepts `medium` — documented for both families.
  assert.throws(() => configuredEffort(DEEPSEEK, { [DEEPSEEK]: 'medium' }), RangeError)
  // Naming a model that has no reasoning at all is equally a mistake.
  assert.throws(() => configuredEffort('river/mystery-model', { 'river/*': 'high' }), /no reasoning support/)
})

test('an accepted configured effort is returned verbatim', () => {
  assert.equal(configuredEffort(DEEPSEEK, { [DEEPSEEK]: 'high' }), 'high')
  assert.equal(configuredEffort(DEEPSEEK, { [DEEPSEEK]: 'off' }), 'off')
  assert.equal(configuredEffort(GLM, { [GLM]: 'low' }), 'low')
  assert.equal(configuredEffort(GLM, { [GLM]: 'max' }), 'max')
})

test('auto and empty mean "the model decides"', () => {
  assert.equal(configuredEffort(DEEPSEEK, { [DEEPSEEK]: 'auto' }), undefined)
  assert.equal(configuredEffort(DEEPSEEK, { [DEEPSEEK]: '' }), undefined)
  assert.equal(configuredEffort(DEEPSEEK, undefined), undefined)
  // A model nobody named keeps its own default, not some other model's.
  assert.equal(configuredEffort(GLM, { [DEEPSEEK]: 'max' }), undefined)
})

test('an override map matches a glob but prefers an exact id', () => {
  assert.equal(configuredEffort(GLM, { 'zai-org/GLM-*': 'max' }), 'max')
  // A model river has not shipped yet has no known facts, so a configured effort
  // for it is rejected instead of being forwarded to a 400 — the snapshot has to
  // name a model before that model can be tuned.
  assert.throws(
    () => configuredEffort('zai-org/GLM-5.4-Flash', { 'zai-org/GLM-*': 'low' }),
    /no reasoning support/,
  )
  assert.equal(
    configuredEffort(GLM, { 'zai-org/GLM-*': 'low', [GLM]: 'max' }),
    'max',
  )
  // `*` never crosses a `/`, so a vendor pattern cannot capture another vendor.
  assert.equal(configuredEffort(GLM, { 'deepseek-ai/*': 'max' }), undefined)
})

test('a context ceiling above the output budget leaves room for compaction', () => {
  // What dsh-compaction-basic requires: contextWindow > maxTokens + headroom.
  const headroom = 8_000
  const contextWindow = contextWindowFor(DEEPSEEK, 262_144)
  const reserved = outputBudgetFor(DEEPSEEK, 65_536)
  assert.ok(
    contextWindow - reserved - headroom > 0,
    `context ${contextWindow} must exceed reserved ${reserved} plus headroom ${headroom}`,
  )
  // The documented maximums DO collide, which is why the settings exist.
  const facts = modelFacts(DEEPSEEK)
  assert.ok(facts.contextWindow - facts.maxOutputTokens < 700_000)
})
