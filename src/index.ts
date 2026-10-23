/**
 * The river.ai provider plugin.
 *
 * Split of responsibilities:
 *
 * - {@link RiverAccountPool} decides WHICH account serves an attempt and
 *   remembers why one stopped being usable.
 * - {@link RiverAdapter} owns one HTTP attempt's protocol.
 * - this file wires both into the harness: config schema, credential refs,
 *   settings namespace, model visibility, and the provider registration.
 *
 * Everything account-scoped is resolved per attempt rather than per turn, so a
 * single turn can walk through several keys without the harness noticing.
 *
 * @module dsh-river-provider
 */

import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  DEFAULT_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER,
  RiverAdapter,
  type RiverConnection,
} from './adapter.ts'
import {
  accountUsable,
  AllAccountsUnusableError,
  normalizeKey,
  RiverAccountPool,
  type AccountSlot,
  type ResolvedAccount,
} from './accounts.ts'
import { configuredEffort } from './capabilities.ts'
import { RiverPriceBook } from './model-prices.ts'
import { AttachmentImageResolver } from './images.ts'
import { markVolatileFields } from './config-volatile.ts'

export const name = 'llm-river'
export const inject = ['llm']

/** Settings namespace for this provider. */
const NS = 'llm-river'

/** Default env var holding the first river.ai key. */
const DEFAULT_API_KEY_ENV = 'RIVERAI_API_KEY'

export { PROVIDER }

/** One configured account. */
export interface RiverAccountConfig {
  /** Shown in the status list and in rotation errors. */
  label?: string
  /** Name of the env var / credential ref holding this key. */
  apiKeyEnv?: string
  /** Literal key; kept out of cached config snapshots. */
  apiKey?: string
}

/** One "these models prefer this account" rule. */
export interface RiverModelAccountRule {
  /** Glob patterns, matched against the model id. */
  models: string[]
  /** Account label or slot id. */
  account: string
}

/** The resolved plugin configuration. */
export interface RiverConfig {
  apiBase?: string
  apiKeyEnv?: string
  apiKey?: string
  accounts?: RiverAccountConfig[]
  /** Pins an account; `undefined` means "rotate". */
  activeAccount?: string
  modelAccountRules?: RiverModelAccountRule[]
  requestTimeoutMs?: number
  streamIdleTimeoutMs?: number
  maxOutputTokens?: number
  /** Ceiling for the advertised context window; absent uses the model's own. */
  contextWindowLimit?: number
  /**
   * Per-model default reasoning effort, e.g. `{"zai-org/GLM-*": "max"}`.
   *
   * Values are translated to the model's own whitelist, so a level it does not
   * accept is snapped rather than sent. `auto` means "the model's own default".
   */
  defaultReasoningEffort?: Record<string, string>
  /** Models the picker may show. Empty = catalog-driven. */
  visibleModels?: string[]
  /** Per-model visibility overrides, applied after `visibleModels`. */
  modelVisibility?: Record<string, boolean>
}

const Config = Schema.object({
  apiBase: Schema.string()
    .description('Base URL of the river.ai API, e.g. https://api.river.ai/v1')
    .default(DEFAULT_API_BASE),
  apiKeyEnv: Schema.string()
    .role('credential-ref')
    .description(`Environment variable holding the first river.ai key.`)
    .default(DEFAULT_API_KEY_ENV),
  apiKey: Schema.string()
    .role('secret')
    .description('Literal river.ai key for the first account. Prefer the env var.'),
  accounts: Schema.array(Schema.object({
    label: Schema.string().description('Name shown in rotation status and errors.'),
    apiKeyEnv: Schema.string().role('credential-ref').description('Environment variable holding this key.'),
    apiKey: Schema.string().role('secret').description('Literal key for this account.'),
  }))
    .description('Additional river.ai accounts. Requests rotate across all of them.')
    .default([]),
  activeAccount: Schema.string()
    .description('Pin every request to one account by label or slot id. Leave empty to rotate.'),
  modelAccountRules: Schema.array(Schema.object({
    models: Schema.array(Schema.string()).description('Model id or glob pattern.'),
    account: Schema.string().description('Account label or slot id.'),
  }))
    .description('Route matching models to a fixed account.')
    .default([]),
  requestTimeoutMs: Schema.number()
    .description('Whole-request budget. river.ai documents 15 minutes per response.')
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  streamIdleTimeoutMs: Schema.number()
    .description('Longest silence tolerated mid-stream. river.ai documents 10 minutes of prefill.')
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxOutputTokens: Schema.number()
    .description('Global output ceiling. Omitted means each model uses its own maximum.'),
  contextWindowLimit: Schema.number()
    .description(
      'Cap the advertised context window. Leave empty for the model\'s own capacity (the 1M river publishes). '
      + 'Keep it above maxOutputTokens plus the compaction headroom, or pressure compaction cannot run.',
    ),
  defaultReasoningEffort: Schema.dict(Schema.string())
    .description(
      'Default reasoning effort per model id or glob, e.g. {"zai-org/GLM-*": "max"}. '
      + 'Only levels river documents for that model are accepted: DeepSeek none|high|max, GLM low|high|max. '
      + 'Anything else is reported as a configuration error instead of being silently changed. "auto" keeps the model\'s own default.',
    )
    .default({}),
  visibleModels: Schema.array(Schema.string())
    .description('Only show these models in the picker. Empty means the whole catalog.')
    .default([]),
  modelVisibility: Schema.dict(Schema.boolean())
    .description('Per-model visibility overrides, e.g. {"zai-org/GLM-5.3-Flash": false}.')
    .default({}),
})

// Every editable field is volatile: the settings form writes them live, and the
// loader hands them back as references read fresh on each call. Literal keys
// are marked too — no surface writes a secret literal, but marking them costs
// nothing and keeps one rule for the whole schema.
const RiverConfigSchema = markVolatileFields(Config as unknown as Record<string, unknown>)

export { RiverConfigSchema }

/** Model ids that carry vision, from the bundled snapshot. */
export async function apply(ctx: Context, config: RiverConfig): Promise<void> {
  const current = (): RiverConfig => (config ?? {}) as RiverConfig
  const prices = new RiverPriceBook()
  const images = new AttachmentImageResolver()

  /**
   * Resolve a credential ref to its value.
   *
   * Per call, never cached: the credential seam is the one place a key edited in
   * the settings panel becomes visible, and caching would freeze a rotated key
   * for the life of the process. The process environment is the fallback for a
   * `.env`-style setup with no credentials provider registered.
   */
  const resolveRef = async (ref: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials') as CredentialProvider | undefined
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    }
    const ambient = process.env[ref]
    return ambient === undefined || ambient.trim() === '' ? undefined : ambient
  }

  /** Build the account slots for the current config. */
  const slots = (raw: RiverConfig): AccountSlot[] => {
    const primaryRef = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    const primary: AccountSlot = {
      id: 'default',
      label: 'Default',
      ref: primaryRef,
      literal: raw.apiKey,
    }
    const extra: AccountSlot[] = []
    for (const [index, account] of (raw.accounts ?? []).entries()) {
      const ref = account.apiKeyEnv ?? account.apiKey
      if (ref === undefined || ref === '') continue
      extra.push({
        // The env var name is the natural stable id: two entries pointing at the
        // same variable are the same account and must not rotate apart.
        id: account.apiKeyEnv ?? `account-${index + 2}`,
        label: account.label ?? account.apiKeyEnv ?? `Account ${index + 2}`,
        // `resolveAccounts` prefers the literal key, so `ref` only ever names
        // the variable a slot falls back to.
        ref: account.apiKeyEnv ?? `RIVERAI_API_KEY_${index + 2}`,
        literal: account.apiKey,
      })
    }
    return [primary, ...extra]
  }

  const pool = new RiverAccountPool({
    slots: () => slots(current()),
    resolveRef,
    preferredId: () => current().activeAccount,
    modelAccountRules: () => current().modelAccountRules ?? [],
  })

  const connection = (): RiverConnection => {
    const raw = current()
    return {
      apiBase: raw.apiBase ?? DEFAULT_API_BASE,
      requestTimeoutMs: raw.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
      ...(raw.contextWindowLimit === undefined ? {} : { contextWindowLimit: raw.contextWindowLimit }),
    }
  }

  /**
   * The configured reasoning effort for one model, validated against the
   * model's own whitelist.
   *
   * Resolved per call from the live config so an edit applies to the next turn
   * without a reload, and `auto`/empty both answer `undefined` — "no opinion",
   * which leaves the model's own default standing.
   *
   * A configured value the model does not accept is a configuration mistake and
   * is reported as one: {@link configuredEffort} throws, which surfaces as a
   * failed `resolveModel` instead of a silently different (and differently
   * priced) reasoning level. Nothing is snapped here — snapping is for requests
   * the harness generates at runtime, where producing nothing is worse.
   */
  const defaultEffort = (model: string): string | undefined =>
    configuredEffort(model, current().defaultReasoningEffort)

  const isVisible = (model: string): boolean => {
    const raw = current()
    const override = raw.modelVisibility?.[model]
    if (override !== undefined) return override
    const allow = raw.visibleModels ?? []
    if (allow.length === 0) return true
    return allow.includes(model)
  }

  const adapter = new RiverAdapter({
    connection,
    images,
    prices,
    isVisible,
    defaultEffort,
    async resolveApiKey(model) {
      // `model === ''` is the catalog probe: no routing rule can apply to it.
      const account = model === '' ? await pool.resolveKey({}) : await pool.resolveKey({ model })
      return { key: account.key, accountId: account.slot.id }
    },
    markRejected: (key, rejection, resetAt) => pool.markRejected(normalizeKey(key) ?? key, rejection, resetAt),
    markHealthy: (key) => pool.markHealthy(normalizeKey(key) ?? key),
    log: (message) => ctx.logger.debug?.(`[llm-river] ${message}`),
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'river.ai', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Settings: the panel edits the same object the adapter reads, so a base URL
  // change takes effect on the next attempt without a plugin reload. The
  // namespace is the plugin's own profile entry id, which is what the generated
  // form addresses; no extra registration is needed for the page to exist.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings')
    settings?.configure({ auto: true }, ctx.fiber)
  })

  // Account status for the sidebar: which key is active, which is cooling down.
  // Nothing is registered when the profile has no command surface — a status
  // command is a convenience, never a precondition for serving requests.
  ctx.inject(['commands'], (commandsCtx) => {
    const commands = (commandsCtx as unknown as {
      commands?: {
        register(command: {
          name: string
          description: string
          run(): Promise<string>
        }): void
      }
    }).commands
    commands?.register({
      name: 'river-accounts',
      description: 'Show river.ai account rotation status.',
      async run() {
        const rows = (await pool.describeAccounts()).map((account) => {
          const status = describeState(account)
          return `- ${account.slot.label} (${account.slot.id}) — ${status}`
        })
        return rows.length === 0 ? 'No river.ai accounts configured.' : rows.join('\n')
      },
    })
  })
}

/** One account's health, as shown to a human. */
function describeState(account: ResolvedAccount): string {
  const state = account.state
  if (state === undefined) return 'ready'
  if (accountUsable(state)) return 'ready (cooldown elapsed)'
  if (state.kind === 'disabled') return `disabled: ${state.reason}`
  const seconds = Math.max(0, Math.ceil((state.until - Date.now()) / 1000))
  return `cooling down ${seconds}s: ${state.reason}`
}

/** True for the pool's "nothing can be attempted" error. */
export function isPoolExhausted(error: unknown): error is AllAccountsUnusableError {
  return error instanceof AllAccountsUnusableError
}
