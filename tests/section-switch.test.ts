/**
 * Tests for the settings-page switch.
 *
 * The switch exists because the nav entry is optional: the provider card already
 * manages accounts, so a dedicated page is a preference rather than a necessity.
 * Two things can silently break it — the edit never reaching the patch file, and
 * the client not receiving the value — so both boundaries are pinned here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { patchFor } from '../src/remote-edit.ts'
import { parseEdit, parseSnapshot } from '../src/remote-wire.ts'

/** A snapshot the host could really emit, trimmed to the fields under test. */
function snapshot(showSettingsSection: boolean): unknown {
  return {
    provider: 'river',
    apiBase: 'https://api.river.ai/v1',
    accounts: [],
    models: [],
    defaults: {
      contextWindowLimit: 1_048_576,
      maxOutputTokens: 384_000,
      activeAccount: '',
      defaultReasoningEffort: {},
    },
    modelAccountRules: [],
    ui: { showSettingsSection },
  }
}

test('the switch travels as a real patch field', () => {
  assert.deepEqual(patchFor({ field: 'showSettingsSection', value: true }), { showSettingsSection: true })
  assert.deepEqual(patchFor({ field: 'showSettingsSection', value: false }), { showSettingsSection: false })
})

test('a non-boolean switch value is refused, not coerced', () => {
  // "true" would land in the patch as a string and fail schema validation on the
  // next start, stranding the profile — so the write has to be refused up front.
  for (const value of ['true', 1, null, {}]) {
    // The boundary types say boolean; the test feeds what a hand-written Remote
    // call or a stale client could really send.
    const wrong = value as unknown as boolean
    assert.throws(() => patchFor({ field: 'showSettingsSection', value: wrong }), /must be true or false/)
  }
})

test('the wire accepts the switch and rejects unknown fields', () => {
  assert.deepEqual(parseEdit({ field: 'showSettingsSection', value: true }), {
    field: 'showSettingsSection',
    value: true,
  })
  assert.throws(() => parseEdit({ field: 'settingsSection', value: true }), /unknown/i)
})

test('the client receives the switch value', () => {
  // A missing `ui` block must fail loudly rather than default to "hidden": a
  // silent default is how the nav entry would never come back.
  assert.equal(parseSnapshot(snapshot(true)).ui.showSettingsSection, true)
  assert.equal(parseSnapshot(snapshot(false)).ui.showSettingsSection, false)
  const full = snapshot(true) as Record<string, unknown>
  const { ui: _dropped, ...withoutUi } = full
  assert.throws(() => parseSnapshot(withoutUi), /invalid ui/)
  assert.throws(() => parseSnapshot({ ...full, ui: { showSettingsSection: 'yes' } }), /invalid/)
})
