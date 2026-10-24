/**
 * Render both UI halves with a real React, on the server.
 *
 * The source scan proved the components exist and the fake-context test proved
 * they register — neither proves a component can *render*. A crash inside render
 * reaches the user as an empty Settings pane with a React boundary message,
 * which is indistinguishable from "the plugin did nothing". So both components
 * are mounted here against a snapshot the Host really emits.
 *
 * `react-dom/server` is a dev-only dependency: the shipped bundle still requires
 * only `react`, which the browser loader hands to it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import type React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as client from '../src/client.tsx'

/** A snapshot with every field the two components read. */
function snapshot(showSettingsSection: boolean): unknown {
  return {
    provider: 'river',
    apiBase: 'https://api.river.ai/v1',
    accounts: [
      { id: 'default', label: 'Default', ref: 'RIVERAI_API_KEY', active: true, status: 'ready', reason: '', hasKey: true, keyHint: 'rv_…abcd' },
      { id: 'river-2', label: 'river-2', ref: 'RIVERAI2_API_KEY', active: false, status: 'cooldown', reason: '窗口耗尽', hasKey: true, keyHint: '' },
    ],
    models: [
      {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        name: 'DeepSeek V4.1 Flash (1017)',
        visible: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 384_000,
        vision: true,
        efforts: ['none', 'high', 'max'],
        effort: 'high',
      },
    ],
    defaults: {
      contextWindowLimit: 1_048_576,
      maxOutputTokens: 384_000,
      activeAccount: '',
      defaultReasoningEffort: { 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 'high' },
    },
    modelAccountRules: [],
    ui: { showSettingsSection },
  }
}

interface Rendered {
  card: string
  page: string
}

/** Run `apply`, capture the two registered components, and render them. */
async function render(showSettingsSection: boolean): Promise<Rendered> {
  const registered = new Map<string, unknown>()
  const ctx: Record<string, unknown> = {
    logger: { warn: () => undefined },
    effect: (run: () => unknown) => run(),
    get: (key: string) => (key === 'remote.river'
      ? { state: async () => ({ ok: true, value: snapshot(showSettingsSection) }) }
      : undefined),
    inject: (_names: unknown, run: (value: unknown) => void) => run(ctx),
    remote: { $mount: async () => () => undefined },
    slots: {
      inject: (_name: string, run: () => void) => run(),
      register: (options: { name: string }, component: unknown) => {
        registered.set(options.name, component)
        return () => undefined
      },
    },
  }

  client.apply(ctx as never)
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

  const card = registered.get('settings.models.provider-card')
  const page = registered.get('settings.section')
  assert.ok(card !== undefined, 'the provider card must be registered')
  assert.ok(page !== undefined, 'the settings page must be registered')
  return {
    card: renderToStaticMarkup(createElement(card as React.ComponentType)),
    page: renderToStaticMarkup(createElement(page as React.ComponentType)),
  }
}

test('the provider card renders the controls it claims to own', async () => {
  const { card } = await render(true)
  for (const expected of ['river.ai', '接口地址', '上下文窗口', '输出预算', '各模型推理强度', 'DeepSeek V4.1 Flash (1017)', '设置侧栏页面']) {
    assert.ok(card.includes(expected), `the card must render ${expected}`)
  }
  // A cooldown account must show why, not just a red dot.
  assert.ok(card.includes('窗口耗尽'), 'the card must render the rejection reason')
})

test('the settings page renders the account table and the shared controls', async () => {
  const { page } = await render(true)
  for (const expected of ['river.ai 账号', 'RIVERAI2_API_KEY', '上下文窗口', '模型可见性', '各模型推理强度']) {
    assert.ok(page.includes(expected), `the page must render ${expected}`)
  }
})

test('the page renders even while the switch says off', async () => {
  // The entry is registered before the snapshot arrives; a page that only works
  // when enabled would blank out exactly when someone turns the switch off.
  const { page } = await render(false)
  assert.ok(page.includes('river.ai 账号'), 'the page must render regardless of the switch')
})

console.log('render: ok')
