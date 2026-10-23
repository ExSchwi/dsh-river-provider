/**
 * The browser half of the settings page.
 *
 * This bundle runs INSIDE the web client, not in the Host: it may only touch
 * what the client's own module graph exposes (`react`, the locale service, the
 * slot registry, and the Remote gateway). Everything it displays is fetched
 * through the `river` Remote namespace, which is why no key or model list is
 * ever computed here.
 *
 * Two faces are registered:
 *
 * - `settings.models.provider-card` — the river card in Settings → Models,
 *   replacing the "edit cordis.patch.yml" placeholder the kernel shows for a
 *   provider whose layout it does not know.
 * - `settings.section` — a page holding the account list, routing rules and the
 *   per-model capacity table, which do not fit in a provider row.
 *
 * @module dsh-river-provider/client
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

/** What a component here may return: React's own node union, kept narrow. */
type Node = ReactNode

/**
 * The subset of the shared wire contract this bundle needs.
 *
 * Duplicated from `remote-wire.ts` on purpose: the client bundle must not
 * import a module that reaches into Host packages. See that file for the
 * authoritative shapes and the parsing rules they are validated against.
 */
type AccountView = {
  id: string
  label: string
  ref: string
  configured: boolean
  active: boolean
  status: 'ready' | 'cooldown' | 'disabled' | 'unconfigured'
  reason: string
  cooldownUntil: number
}

type ModelView = {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
  efforts: string[]
  defaultEffort: string
  visible: boolean
  price: { input: number; cachedInput: number; output: number }
}

type RiverSnapshot = {
  provider: string
  apiBase: string
  accounts: AccountView[]
  models: ModelView[]
  defaults: {
    contextWindowLimit: number
    maxOutputTokens: number
    activeAccount: string
    defaultReasoningEffort: Record<string, string>
  }
  modelAccountRules: { models: string[]; account: string }[]
  ui: {
    showSettingsSection: boolean
  }
}

type EditField =
  | 'apiBase'
  | 'apiKeyEnv'
  | 'activeAccount'
  | 'contextWindowLimit'
  | 'maxOutputTokens'
  | 'defaultReasoningEffort'
  | 'modelVisibility'
  | 'visibleModels'
  | 'accounts'
  | 'modelAccountRules'
  | 'showSettingsSection'

type EditOutcome = { ok: boolean; snapshot?: RiverSnapshot; error?: string }
type CredentialOutcome = { ok: boolean; error?: string }

const REMOTE_NAMESPACE = 'river'
const REMOTE_SERVICE = 'riverAccounts'
const REMOTE_PACKAGE = '@mars-sea/dsh-river-provider'

/** The `river` Remote namespace once mounted. */
interface RiverRemote {
  state(signal?: AbortSignal): Promise<{ ok: boolean; value?: RiverSnapshot; error?: { message: string } }>
  refresh(signal?: AbortSignal): Promise<{ ok: boolean; value?: RiverSnapshot; error?: { message: string } }>
  edit(edit: { field: EditField; value: unknown }, signal?: AbortSignal): Promise<{ ok: boolean; value?: EditOutcome; error?: { message: string } }>
  setAccountKey(target: { ref: string; key: string }, signal?: AbortSignal): Promise<{ ok: boolean; value?: CredentialOutcome; error?: { message: string } }>
}

interface ClientContext {
  logger: { warn(message: string): void }
  slots: {
    inject(name: string, register: () => void): void
    register(slot: unknown, component: unknown): unknown
  }
  locale: {
    bind(namespace: string): (key: string) => string
  }
  effect(setup: () => () => void, label: string): void
  inject(deps: string[], callback: (ctx: ClientContext) => void): void
  remote: {
    $mount(contribution: { package: string; descriptors: unknown[] }): Promise<() => void>
    [namespace: string]: unknown
  }
  get(key: string): unknown
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

class WireError extends TypeError {}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError(`invalid ${field}`)
  return value as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new WireError(`invalid ${field}`)
  return value
}

function count(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WireError(`invalid ${field}`)
  return value
}

function flag(source: Record<string, unknown>, key: string, field: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') throw new WireError(`invalid ${field}`)
  return value
}

function labels(source: Record<string, unknown>, key: string, field: string): string[] {
  const value = source[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new WireError(`invalid ${field}`)
  return value as string[]
}

function effortMap(source: Record<string, unknown>, key: string, field: string): Record<string, string> {
  const value = source[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError(`invalid ${field}`)
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new WireError(`invalid ${field}`)
    result[name] = entry
  }
  return result
}

const STATUSES = new Set(['ready', 'cooldown', 'disabled', 'unconfigured'])

/** Parse the untrusted `river/state` result. */
function parseSnapshot(value: unknown): RiverSnapshot {
  const source = record(value, 'snapshot')
  const accounts = source.accounts
  const models = source.models
  const rules = source.modelAccountRules
  if (!Array.isArray(accounts)) throw new WireError('invalid accounts')
  if (!Array.isArray(models)) throw new WireError('invalid models')
  if (!Array.isArray(rules)) throw new WireError('invalid modelAccountRules')
  const defaults = record(source.defaults, 'defaults')

  return {
    provider: text(source, 'provider', 'provider'),
    apiBase: text(source, 'apiBase', 'apiBase'),
    accounts: accounts.map((entry) => {
      const account = record(entry, 'account')
      const status = text(account, 'status', 'account.status')
      if (!STATUSES.has(status)) throw new WireError('invalid account.status')
      return {
        id: text(account, 'id', 'account.id'),
        label: text(account, 'label', 'account.label'),
        ref: text(account, 'ref', 'account.ref'),
        configured: flag(account, 'configured', 'account.configured'),
        active: flag(account, 'active', 'account.active'),
        status: status as AccountView['status'],
        reason: text(account, 'reason', 'account.reason'),
        cooldownUntil: count(account, 'cooldownUntil', 'account.cooldownUntil'),
      }
    }),
    models: models.map((entry) => {
      const model = record(entry, 'model')
      const price = record(model.price, 'model.price')
      return {
        id: text(model, 'id', 'model.id'),
        name: text(model, 'name', 'model.name'),
        contextWindow: count(model, 'contextWindow', 'model.contextWindow'),
        maxOutputTokens: count(model, 'maxOutputTokens', 'model.maxOutputTokens'),
        vision: flag(model, 'vision', 'model.vision'),
        efforts: labels(model, 'efforts', 'model.efforts'),
        defaultEffort: text(model, 'defaultEffort', 'model.defaultEffort'),
        visible: flag(model, 'visible', 'model.visible'),
        price: {
          input: count(price, 'input', 'model.price.input'),
          cachedInput: count(price, 'cachedInput', 'model.price.cachedInput'),
          output: count(price, 'output', 'model.price.output'),
        },
      }
    }),
    defaults: {
      contextWindowLimit: count(defaults, 'contextWindowLimit', 'defaults.contextWindowLimit'),
      maxOutputTokens: count(defaults, 'maxOutputTokens', 'defaults.maxOutputTokens'),
      activeAccount: text(defaults, 'activeAccount', 'defaults.activeAccount'),
      defaultReasoningEffort: effortMap(defaults, 'defaultReasoningEffort', 'defaults.defaultReasoningEffort'),
    },
    modelAccountRules: rules.map((entry) => {
      const rule = record(entry, 'rule')
      return { models: labels(rule, 'models', 'rule.models'), account: text(rule, 'account', 'rule.account') }
    }),
    ui: {
      showSettingsSection: flag(record(source.ui, 'ui'), 'showSettingsSection', 'ui.showSettingsSection'),
    },
  }
}

function parseEditOutcome(value: unknown): EditOutcome {
  const source = record(value, 'edit outcome')
  if (!flag(source, 'ok', 'ok')) return { ok: false, error: text(source, 'error', 'error') }
  return { ok: true, snapshot: parseSnapshot(source.snapshot) }
}

function parseCredentialOutcome(value: unknown): CredentialOutcome {
  const source = record(value, 'credential outcome')
  if (!flag(source, 'ok', 'ok')) return { ok: false, error: text(source, 'error', 'error') }
  return { ok: true }
}

/** The strict codec shape every descriptor here declares. */
function codec(typeSymbol: string, parse: (value: unknown) => unknown): unknown {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

/**
 * One invocation descriptor.
 *
 * The Gateway validates `parameters` against the arguments the carrier sends, so
 * a method that takes an edit declares exactly one wire field named `edit`; the
 * Client calls `river.edit({ field, value })` and the carrier wraps it.
 */
function descriptor(
  method: string,
  typeSymbol: string,
  resultParse: (value: unknown) => unknown,
  parameter?: { name: string; parse: (value: unknown) => unknown },
): unknown {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameter === undefined
      ? []
      : [{ name: parameter.name, wire: parameter.name, source: 'json', codec: codec(`${typeSymbol}Input`, parameter.parse) }],
    result: codec(typeSymbol, resultParse),
  }
}

function remoteDescriptors(): unknown[] {
  return [
    descriptor('state', `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
    descriptor('refresh', `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
    descriptor('edit', `${REMOTE_PACKAGE}#RiverEditOutcome`, parseEditOutcome, {
      name: 'edit',
      parse: (value) => {
        const source = record(value, 'edit')
        if (typeof source.field !== 'string') throw new WireError('invalid edit.field')
        return { field: source.field, value: source.value }
      },
    }),
    descriptor('setAccountKey', `${REMOTE_PACKAGE}#RiverCredentialOutcome`, parseCredentialOutcome, {
      name: 'target',
      parse: (value) => {
        const source = record(value, 'target')
        return { ref: text(source, 'ref', 'target.ref'), key: text(source, 'key', 'target.key') }
      },
    }),
  ]
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface State {
  status: Status
  snapshot?: RiverSnapshot
  error: string
  /** The outcome of the last write, shown next to the field that caused it. */
  notice?: string
  noticeOk: boolean
  saving: boolean
}

const INITIAL: State = { status: 'idle', error: '', notice: '', noticeOk: true, saving: false }

/** One shared store, so the card and the page show the same numbers. */
class RiverStore {
  private readonly listeners = new Set<() => void>()
  private current: State = INITIAL
  private generation = 0
  private inFlight = false
  private remote: RiverRemote | undefined
  private disposed = false

  attach(remote: RiverRemote): void {
    this.remote = remote
    void this.refresh()
  }

  detach(): void {
    this.disposed = true
    this.remote = undefined
    this.listeners.clear()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(): State {
    return this.current
  }

  private publish(next: State): void {
    if (this.disposed) return
    this.current = next
    for (const listener of this.listeners) listener()
  }

  private message(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }

  /** Fetch the snapshot; concurrent calls collapse onto the newest request. */
  async refresh(): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.inFlight) return
    const generation = ++this.generation
    this.inFlight = true
    this.publish({ ...this.current, status: 'loading', error: '' })
    try {
      const response = await remote.state()
      if (this.disposed || generation !== this.generation) return
      if (response.ok && response.value !== undefined) {
        this.publish({ ...this.current, status: 'ready', snapshot: response.value, error: '' })
      } else {
        this.publish({ ...this.current, status: 'error', error: response.error?.message ?? 'the host did not answer' })
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.publish({ ...this.current, status: 'error', error: this.message(error) })
    } finally {
      if (generation === this.generation) this.inFlight = false
    }
  }

  /** Write one setting. The Host answers with the state after the write. */
  async edit(field: EditField, value: unknown): Promise<boolean> {
    return this.write(async (remote) => remote.edit({ field, value }))
  }

  /** Store one account's key. */
  async setAccountKey(ref: string, key: string): Promise<boolean> {
    return this.write(async (remote) => remote.setAccountKey({ ref, key }))
  }

  private async write(
    call: (remote: RiverRemote) => Promise<{ ok: boolean; value?: { ok: boolean; error?: string; snapshot?: RiverSnapshot }; error?: { message: string } }>,
  ): Promise<boolean> {
    const remote = this.remote
    if (remote === undefined) return false
    this.publish({ ...this.current, saving: true, notice: '', noticeOk: true })
    try {
      const response = await call(remote)
      if (this.disposed) return false
      if (!response.ok || response.value === undefined) {
        this.publish({ ...this.current, saving: false, noticeOk: false, notice: response.error?.message ?? 'the host refused the write' })
        return false
      }
      if (!response.value.ok) {
        this.publish({ ...this.current, saving: false, noticeOk: false, notice: response.value.error ?? 'the host refused the write' })
        return false
      }
      this.publish({
        ...this.current,
        saving: false,
        noticeOk: true,
        notice: '',
        ...(response.value.snapshot === undefined ? {} : { snapshot: response.value.snapshot, status: 'ready' as Status }),
      })
      if (response.value.snapshot === undefined) await this.refresh()
      return true
    } catch (error) {
      if (!this.disposed) this.publish({ ...this.current, saving: false, noticeOk: false, notice: this.message(error) })
      return false
    }
  }
}

const store = new RiverStore()

/** Subscribe a component to the store, with React's tearing-safe snapshot. */
function useRiver(): State {
  const [, force] = useState(0)
  useEffect(() => {
    let active = true
    const unsubscribe = store.subscribe(() => {
      if (active) force((value) => value + 1)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return store.state()
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 1048576 → "1M" — the unit a capacity row is scanned in. */
function compact(value: number): string {
  if (value >= 1_048_576) {
    const millions = value / 1_048_576
    return `${million(millions)}M`
  }
  if (value >= 1024) return `${Math.round(value / 1024)}K`
  return String(value)
}

function million(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** A UTC time as the viewer's clock, in the 24-hour form a cooldown needs. */
function clock(epoch: number): string {
  const date = new Date(epoch)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS_ID = 'dsh-river-provider:card'

const CSS = `
.rv-card { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.rv-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rv-title { font-weight: 600; font-size: 14px; }
.rv-sub { color: var(--dsh-text-secondary, #8b8b8b); font-size: 12px; }
.rv-row { display: flex; gap: 10px; align-items: flex-start; }
.rv-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 0; min-width: 0; }
.rv-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsh-text-secondary, #8b8b8b); }
.rv-input, .rv-select { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; font: inherit;
  border: 1px solid var(--dsh-border, #3a3a3a); background: var(--dsh-input-background, #1f1f1f);
  color: var(--dsh-text, #e6e6e6); }
.rv-input:disabled, .rv-select:disabled { opacity: .55; }
.rv-hint { margin: 0; font-size: 11.5px; color: var(--dsh-text-secondary, #8b8b8b); }
.rv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rv-table th { text-align: left; font-weight: 500; color: var(--dsh-text-secondary, #8b8b8b); padding: 4px 6px; }
.rv-table td { padding: 4px 6px; border-top: 1px solid var(--dsh-border, #2e2e2e); vertical-align: middle; }
.rv-table td.rv-num { text-align: right; font-variant-numeric: tabular-nums; }
.rv-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; line-height: 18px; border: 1px solid transparent; white-space: nowrap; }
.rv-ok { color: var(--dsh-success, #4ec9a0); border-color: var(--dsh-success, #4ec9a0); }
.rv-bad { color: var(--dsh-danger, #e06c75); border-color: var(--dsh-danger, #e06c75); }
.rv-muted { color: var(--dsh-text-secondary, #8b8b8b); border-color: var(--dsh-border, #3a3a3a); }
.rv-warn { color: var(--dsh-warning, #e5c07b); border-color: var(--dsh-warning, #e5c07b); }
.rv-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: currentColor; }
.rv-notice { margin: 0; font-size: 12px; }
.rv-notice-ok { color: var(--dsh-success, #4ec9a0); }
.rv-notice-bad { color: var(--dsh-danger, #e06c75); }
.rv-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rv-switchRow { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px; border: 1px solid var(--dsh-border, #2e2e2e); border-radius: 7px; }
.rv-switchText { display: flex; flex-direction: column; gap: 2px; }
.rv-switch { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsh-border, #3a3a3a); background: transparent;
  color: var(--dsh-text-secondary, #8b8b8b); }
.rv-switchOn { border-color: var(--dsh-accent, #4a9eff); color: var(--dsh-accent, #4a9eff);
  background: color-mix(in srgb, var(--dsh-accent, #4a9eff) 14%, transparent); }
.rv-switch:disabled { cursor: default; opacity: .5; }
.rv-button { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsh-border, #3a3a3a); background: var(--dsh-button-background, #2a2a2a);
  color: var(--dsh-text, #e6e6e6); }
.rv-button:hover:not(:disabled) { border-color: var(--dsh-accent, #4a9eff); }
.rv-button:disabled { cursor: default; opacity: .5; }
.rv-primary { border-color: var(--dsh-accent, #4a9eff); color: var(--dsh-accent, #4a9eff); }
.rv-mono { font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.rv-section { display: flex; flex-direction: column; gap: 8px; padding-top: 12px;
  border-top: 1px solid var(--dsh-border, #2e2e2e); }
.rv-sectionTitle { font-weight: 600; font-size: 12.5px; }
.rv-empty { font-size: 12px; color: var(--dsh-text-secondary, #8b8b8b); }
`

/** Inject the stylesheet once per document. */
function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CSS_ID) !== null) return
  const style = document.createElement('style')
  style.id = CSS_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function Pill({ kind, children }: { kind: 'ok' | 'bad' | 'muted' | 'warn'; children?: Node }): Node {
  return h('span', { className: `rv-badge rv-${kind}` }, h('span', { className: 'rv-dot' }), children)
}

/** An on/off row. The value comes from the host, so a click is a write. */
function SwitchRow(props: {
  label: string
  hint: string
  value: boolean
  disabled: boolean
  onCommit: (value: boolean) => void
}): Node {
  return h('div', { className: 'rv-switchRow' },
    h('div', { className: 'rv-switchText' },
      h('span', { className: 'rv-label' }, props.label),
      h('span', { className: 'rv-sub' }, props.hint),
    ),
    h('button', {
      type: 'button',
      className: `rv-switch${props.value ? ' rv-switchOn' : ''}`,
      role: 'switch',
      'aria-checked': props.value ? 'true' : 'false',
      disabled: props.disabled,
      onClick: () => props.onCommit(!props.value),
    }, props.value ? '已开启' : '已关闭'),
  )
}

function AccountStatus({ account }: { account: AccountView }): Node {
  switch (account.status) {
    case 'ready':
      return h(Pill, { kind: 'ok' }, '可用')
    case 'cooldown':
      return h(Pill, { kind: 'warn' }, `冷却至 ${clock(account.cooldownUntil)}`)
    case 'disabled':
      return h(Pill, { kind: 'bad' }, '已停用')
    default:
      return h(Pill, { kind: 'muted' }, '未配置')
  }
}

/** One labelled text input that writes on blur, so typing never spams the host. */
function Field(props: {
  label: string
  value: string
  placeholder?: string
  mono?: boolean
  disabled: boolean
  hint?: string
  onCommit: (value: string) => void
}): Node {
  const [draft, setDraft] = useState(props.value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(props.value)
  }, [props.value])
  return h('div', { className: 'rv-field' },
    h('label', { className: 'rv-label' }, props.label),
    h('input', {
      className: `rv-input${props.mono === true ? ' rv-mono' : ''}`,
      value: draft,
      disabled: props.disabled,
      spellCheck: false,
      placeholder: props.placeholder,
      onFocus: () => { focused.current = true },
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      onBlur: () => {
        focused.current = false
        const next = draft.trim()
        if (next !== props.value) props.onCommit(next)
      },
      onKeyDown: (event: { key: string; currentTarget: { blur(): void } }) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      },
    }),
    props.hint === undefined ? null : h('p', { className: 'rv-hint' }, props.hint),
  )
}

// ---------------------------------------------------------------------------
// Provider card (Settings → Models)
// ---------------------------------------------------------------------------

/**
 * The river card, rendered inside the provider row.
 *
 * The Models page renders this INSTEAD of its generic "edit the patch file"
 * editor for a provider with `llm-river` as its settings namespace, so the row
 * carries real controls: the base URL, the active account, the capacity
 * defaults, and a per-model reasoning default.
 */
function RiverProviderCard(): Node {
  const state = useRiver()
  const disabled = state.saving || state.status === 'loading'

  if (state.status === 'error') {
    return h('div', { className: 'rv-card' },
      h('div', { className: 'rv-head' },
        h('span', { className: 'rv-title' }, 'river.ai'),
        h(Pill, { kind: 'bad' }, '无法读取宿主状态'),
      ),
      h('p', { className: 'rv-notice rv-notice-bad' }, state.error ?? '未知错误'),
      h('div', { className: 'rv-actions' },
        h('button', {
          type: 'button',
          className: 'rv-button',
          onClick: () => void store.refresh(),
        }, '重试'),
      ),
    )
  }

  if (state.snapshot === undefined) {
    return h('div', { className: 'rv-card' },
      h('div', { className: 'rv-head' },
        h('span', { className: 'rv-title' }, 'river.ai'),
        h('span', { className: 'rv-sub' }, '读取中…'),
      ),
    )
  }

  const snapshot = state.snapshot
  const active = snapshot.accounts.find((account) => account.active)
  const ready = snapshot.accounts.filter((account) => account.status === 'ready').length
  const primary = snapshot.models[0]

  return h('div', { className: 'rv-card' },
    h('div', { className: 'rv-head' },
      h('span', { className: 'rv-title' }, 'river.ai'),
      h(Pill, { kind: ready > 0 ? 'ok' : 'bad' }, `${ready}/${snapshot.accounts.length} 个账号可用`),
      active === undefined ? null : h(Pill, { kind: 'muted' }, `当前 ${active.label}`),
      h('span', { className: 'rv-sub' }, `${snapshot.models.length} 个模型`),
    ),

    h('div', { className: 'rv-row' },
      h(Field, {
        label: '接口地址',
        value: snapshot.apiBase,
        mono: true,
        disabled,
        hint: '留空使用 https://api.river.ai/v1',
        onCommit: (value: string) => void store.edit('apiBase', value),
      }),
      h(Field, {
        label: '当前账号',
        value: snapshot.defaults.activeAccount,
        placeholder: '留空自动选择',
        disabled,
        hint: '固定用某个账号，留空按健康度轮转',
        onCommit: (value: string) => void store.edit('activeAccount', value),
      }),
    ),

    h('div', { className: 'rv-row' },
      h(CapacityField, {
        label: '上下文窗口',
        value: snapshot.defaults.contextWindowLimit,
        ceiling: primary?.contextWindow ?? 0,
        disabled,
        onCommit: (value: number) => void store.edit('contextWindowLimit', value),
      }),
      h(CapacityField, {
        label: '输出预算',
        value: snapshot.defaults.maxOutputTokens,
        ceiling: primary?.maxOutputTokens ?? 0,
        disabled,
        onCommit: (value: number) => void store.edit('maxOutputTokens', value),
      }),
    ),

    h('div', { className: 'rv-section' },
      h('span', { className: 'rv-sectionTitle' }, '各模型推理强度'),
      h('table', { className: 'rv-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, '模型'),
            h('th', {}, '上下文'),
            h('th', {}, '输出'),
            h('th', {}, '推理'),
          )),
        h('tbody', {},
          snapshot.models.map((model) => h(ModelEffortRow, { key: model.id, model, disabled })),
        ),
      ),
      h('p', { className: 'rv-hint' }, '这里只列出 river 每个模型真正接受的档位；「自动」表示不干预，交给模型默认值。'),
    ),

    h('div', { className: 'rv-section' },
      h('span', { className: 'rv-sectionTitle' }, '账号'),
      h('table', { className: 'rv-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, '账号'),
            h('th', {}, '凭据引用'),
            h('th', {}, '状态'),
            h('th', {}, ''),
          )),
        h('tbody', {},
          snapshot.accounts.map((account) => h(AccountRow, { key: account.id, account, disabled })),
        ),
      ),
    ),

    h(SwitchRow, {
      label: '设置侧栏页面',
      hint: '在设置导航里加一个 river.ai 页（还包含模型可见性与路由）；关掉后本卡片仍可管理账号',
      value: snapshot.ui.showSettingsSection,
      disabled,
      onCommit: (value: boolean) => void store.edit('showSettingsSection', value),
    }),

    state.notice === '' ? null : h('p', { className: `rv-notice ${state.noticeOk ? 'rv-notice-ok' : 'rv-notice-bad'}` }, state.notice),

    h('div', { className: 'rv-actions' },
      h('button', {
        type: 'button',
        className: 'rv-button',
        disabled,
        onClick: () => void store.refresh(),
      }, state.status === 'loading' ? '刷新中…' : '刷新'),
      h('span', { className: 'rv-sub' }, snapshot.ui.showSettingsSection
        ? '模型可见性与路由规则在「设置 → river.ai」页'
        : '模型可见性与路由规则写在 cordis.patch.yml 的 llm-river 段'),
    ),
  )
}

/** A capacity input with the model ceiling it cannot exceed. */
function CapacityField(props: {
  label: string
  value: number
  ceiling: number
  disabled: boolean
  onCommit: (value: number) => void
}): Node {
  const [draft, setDraft] = useState(String(props.value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(props.value))
  }, [props.value])
  return h('div', { className: 'rv-field' },
    h('label', { className: 'rv-label' },
      props.label,
      h('span', { className: 'rv-sub' }, `上限 ${compact(props.ceiling)}`),
    ),
    h('input', {
      className: 'rv-input rv-mono',
      value: draft,
      disabled: props.disabled,
      inputMode: 'numeric',
      onFocus: () => { focused.current = true },
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      onBlur: () => {
        focused.current = false
        const parsed = Number(draft.replace(/[^0-9]/g, ''))
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setDraft(String(props.value))
          return
        }
        const clamped = props.ceiling > 0 ? Math.min(parsed, props.ceiling) : parsed
        setDraft(String(clamped))
        if (clamped !== props.value) props.onCommit(clamped)
      },
      onKeyDown: (event: { key: string; currentTarget: { blur(): void } }) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      },
    }),
  )
}

/** One model's row: the effort select lists only what river accepts. */
function ModelEffortRow({ model, disabled }: { model: ModelView; disabled: boolean }): Node {
  const configured = matchEffort(model.id)
  return h('tr', {},
    h('td', {},
      h('div', {}, model.name),
      h('div', { className: 'rv-hint rv-mono' }, model.id),
    ),
    h('td', { className: 'rv-num' }, compact(model.contextWindow)),
    h('td', { className: 'rv-num' }, compact(model.maxOutputTokens)),
    h('td', {},
      model.efforts.length === 0
        ? h('span', { className: 'rv-hint' }, '不支持推理档位')
        : h('select', {
          className: 'rv-select',
          value: configured,
          disabled,
          onChange: (event: { target: { value: string } }) => {
            void store.edit('defaultReasoningEffort', { ...currentEffortMap(), [model.id]: event.target.value })
          },
        },
        h('option', { value: 'auto' }, '自动'),
        model.efforts.map((effort) => h('option', { key: effort, value: effort }, effortLabel(effort))),
        ),
    ),
  )
}

// The select needs the whole map, which lives in the store: read it live rather
// than through props so a change to one row never rewrites another's value.
function currentEffortMap(): Record<string, string> {
  return store.state().snapshot?.defaults.defaultReasoningEffort ?? {}
}

/** The configured effort for one model, honouring the glob rules by precedence. */
function matchEffort(model: string): string {
  const map = currentEffortMap()
  if (map[model] !== undefined) return map[model]
  for (const [pattern, level] of Object.entries(map)) {
    if (globMatch(pattern, model)) return level
  }
  return 'auto'
}

function globMatch(pattern: string, model: string): boolean {
  if (pattern === model) return true
  if (!pattern.includes('*')) return false
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(model)
}

/** Harness vocabulary, spelled the way the picker spells it. */
function effortLabel(effort: string): string {
  switch (effort) {
    case 'off': return '关闭 (off)'
    case 'minimal': return '极少 (minimal)'
    case 'low': return '低 (low)'
    case 'medium': return '中 (medium)'
    case 'high': return '高 (high)'
    case 'xhigh': return '很高 (xhigh)'
    case 'max': return '最大 (max)'
    default: return effort
  }
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

/**
 * The full page: accounts, their keys, routing rules.
 *
 * Kept separate from the card because these are lists the Models page has no
 * room for, and because the card is rendered once per provider row while this
 * page is rendered once.
 */
function RiverSettingsPage(): Node {
  const state = useRiver()
  const disabled = state.saving || state.status === 'loading'

  if (state.snapshot === undefined) {
    return h('div', { className: 'rv-card' },
      h('div', { className: 'rv-head' },
        h('span', { className: 'rv-title' }, 'river.ai'),
        h('span', { className: 'rv-sub' }, state.status === 'error' ? (state.error ?? '读取失败') : '读取中…'),
      ),
      state.status === 'error'
        ? h('div', { className: 'rv-actions' }, h('button', { type: 'button', className: 'rv-button', onClick: () => void store.refresh() }, '重试'))
        : null,
    );
  }

  const snapshot = state.snapshot
  return h('div', { className: 'rv-card' },
    h('div', { className: 'rv-head' },
      h('span', { className: 'rv-title' }, 'river.ai 账号'),
      h('span', { className: 'rv-sub' }, '多个 key 自动轮转：429 冷却、401 停用，任一恢复后自动重新参与'),
    ),

    h('table', { className: 'rv-table' },
      h('thead', {},
        h('tr', {},
          h('th', {}, '账号'),
          h('th', {}, '凭据引用'),
          h('th', {}, '状态'),
          h('th', {}, ''),
        )),
      h('tbody', {},
        snapshot.accounts.map((account) => h(AccountRow, { key: account.id, account, disabled })),
      ),
    ),

    h('div', { className: 'rv-section' },
      h('span', { className: 'rv-sectionTitle' }, '模型可见性'),
      h('p', { className: 'rv-hint' }, '取消勾选后该模型不出现在模型选择器里；一个都不勾表示全部可见。'),
      h('div', { className: 'rv-actions' },
        snapshot.models.map((model) => h('label', {
          key: model.id,
          className: 'rv-label',
          style: { marginRight: '12px' },
        },
        h('input', {
          type: 'checkbox',
          checked: model.visible,
          disabled,
          onChange: (event: { target: { checked: boolean } }) => {
            const next: Record<string, boolean> = {}
            for (const entry of snapshot.models) next[entry.id] = entry.visible
            next[model.id] = event.target.checked
            void store.edit('modelVisibility', next)
          },
        }),
        model.name,
        )),
      ),
    ),

    snapshot.modelAccountRules.length === 0
      ? null
      : h('div', { className: 'rv-section' },
        h('span', { className: 'rv-sectionTitle' }, '模型路由'),
        h('table', { className: 'rv-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '模型'), h('th', {}, '优先账号'))),
          h('tbody', {},
            snapshot.modelAccountRules.map((rule, index) => h('tr', { key: `${index}` },
              h('td', { className: 'rv-mono' }, rule.models.join(', ')),
              h('td', { className: 'rv-mono' }, rule.account),
            )),
          ),
        ),
      ),

    state.notice === '' ? null : h('p', { className: `rv-notice ${state.noticeOk ? 'rv-notice-ok' : 'rv-notice-bad'}` }, state.notice),
  )
}

/** One account row: its health, and a field to (re)store its key. */
function AccountRow({ account, disabled }: { account: AccountView; disabled: boolean }): Node {
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const commit = useCallback(() => {
    const trimmed = key.trim()
    if (trimmed === '') return
    void store.setAccountKey(account.ref, trimmed).then((ok) => {
      if (ok) setKey('')
    })
  }, [account.ref, key])

  return h('tr', {},
    h('td', {},
      h('div', {}, account.label),
      account.active ? h('span', { className: 'rv-hint' }, '当前生效') : null,
      account.reason === '' ? null : h('div', { className: 'rv-hint' }, account.reason),
    ),
    h('td', { className: 'rv-mono' }, account.ref),
    h('td', {}, h(AccountStatus, { account })),
    h('td', {},
      h('div', { className: 'rv-actions' },
        h('input', {
          className: 'rv-input rv-mono',
          type: visible ? 'text' : 'password',
          value: key,
          disabled,
          spellCheck: false,
          autoComplete: 'new-password',
          placeholder: account.configured ? '已配置，粘贴可覆盖' : '粘贴 rv_... 密钥',
          style: { width: '190px' },
          onChange: (event: { target: { value: string } }) => setKey(event.target.value),
          onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') commit() },
        }),
        h('button', {
          type: 'button',
          className: 'rv-button',
          disabled,
          onClick: () => setVisible((value) => !value),
        }, visible ? '隐藏' : '显示'),
        h('button', {
          type: 'button',
          className: 'rv-button rv-primary',
          disabled: disabled || key.trim() === '',
          onClick: commit,
        }, '保存'),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** Mount the Remote contribution and publish the namespace to the store. */
function connectRemote(ctx: ClientContext): () => void {
  let cancelled = false
  let unmount: (() => void) | undefined
  void ctx.remote.$mount({ package: REMOTE_PACKAGE, descriptors: remoteDescriptors() })
    .then((dispose) => {
      if (cancelled) {
        dispose()
        return
      }
      unmount = dispose
      ctx.inject([`remote.${REMOTE_NAMESPACE}`], (namespaceCtx) => {
        const remote = namespaceCtx.get(`remote.${REMOTE_NAMESPACE}`) as RiverRemote | undefined
        if (remote !== undefined) store.attach(remote)
      })
    })
    .catch((error: unknown) => {
      ctx.logger.warn(`river: could not mount the settings Remote: ${String(error)}`)
    })
  return () => {
    cancelled = true
    store.detach()
    if (unmount !== undefined) unmount()
  }
}

/**
 * Publish the settings page only while the switch is on.
 *
 * The switch is a host setting, so its value is unknown at load time and the
 * registration cannot be unconditional. `slots.inject` is still used for the
 * first registration because registering into a slot nobody declared yet
 * throws; after that the slot exists and the disposer lets the nav entry come
 * and go with the switch.
 */
function attachSettingsSection(ctx: ClientContext): void {
  let dispose: (() => void) | undefined
  let declared = false
  let wanted = false

  const sync = (): void => {
    if (wanted && declared && dispose === undefined) {
      dispose = ctx.slots.register({
        name: 'settings.section',
        id: 'river',
        order: 13,
        label: () => 'river.ai',
      }, RiverSettingsPage) as () => void
      return
    }
    if (!wanted && dispose !== undefined) {
      dispose()
      dispose = undefined
    }
  }

  ctx.effect(() => {
    const unsubscribe = store.subscribe(() => {
      const enabled = store.state().snapshot?.ui.showSettingsSection ?? false
      if (enabled === wanted) return
      wanted = enabled
      sync()
    })
    return () => {
      unsubscribe()
      if (dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
  }, 'dsh-river-provider: settings page switch')

  try {
    ctx.slots.inject('settings.section', () => {
      declared = true
      sync()
    })
  } catch (error) {
    ctx.logger.warn(`river: could not watch the settings section slot: ${String(error)}`)
  }
}

export function apply(ctx: ClientContext): void {
  injectCss()
  ctx.effect(() => connectRemote(ctx), 'dsh-river-provider: settings Remote')
  ctx.effect(() => () => {
    const style = typeof document === 'undefined' ? null : document.getElementById(CSS_ID)
    style?.remove()
  }, 'dsh-river-provider: styles')

  try {
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key: 'llm-river',
    }, RiverProviderCard))
  } catch (error) {
    ctx.logger.warn(`river: could not register the provider card: ${String(error)}`)
  }

  attachSettingsSection(ctx)
}

export const inject = ['slots', 'remote']
