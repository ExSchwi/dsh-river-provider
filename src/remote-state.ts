/**
 * The settings page's data source, on the Host.
 *
 * The browser never calls river.ai: a page that did would need the raw key in
 * the browser and would leak a 401/429 policy into the Client. Everything the
 * page renders is assembled here from the same objects the adapter uses, so what
 * the form shows and what a request does cannot disagree.
 *
 * @module dsh-river-provider/remote-state
 */

import { KNOWN_MODELS, displayName, modelFacts, reasoningEffortsFor } from './capabilities.ts'
import type { AccountSlot, ResolvedAccount, RiverAccountPool } from './accounts.ts'
import { accountUsable } from './accounts.ts'
import type {} from '@deepseek-ai/dsh-credentials'
import type { RiverConfig } from './remote-types.ts'
import type { AccountView, ModelView, RiverSnapshot } from './remote-wire.ts'

/** What the snapshot builder needs from the plugin. */
export interface SnapshotDeps {
  provider: string
  config: () => RiverConfig
  defaults: () => {
    apiBase: string
    contextWindowLimit: number
    maxOutputTokens: number
    showSettingsSection: boolean
  }
  pool: RiverAccountPool
  slots: () => readonly AccountSlot[]
  isVisible: (model: string) => boolean
  /** Whether a key currently resolves for one reference. */
  isConfigured: (ref: string) => Promise<boolean>
}

/** Build one account row: configured, active, and why it is not usable. */
function accountView(
  account: ResolvedAccount | undefined,
  slot: AccountSlot,
  activeId: string,
  now: number,
  configured: boolean,
): AccountView {
  const state = account?.state
  let status: AccountView['status'] = 'ready'
  let reason = ''
  if (!configured) {
    status = 'unconfigured'
    reason = slot.literal === undefined || slot.literal === ''
      ? `No value for ${slot.ref}.`
      : 'The literal key in this account is empty.'
  } else if (state !== undefined && !accountUsable(state, now)) {
    status = state.kind === 'disabled' ? 'disabled' : 'cooldown'
    reason = state.reason
  } else if (state !== undefined && accountUsable(state, now)) {
    // A cooldown that has elapsed: report the state, not a stale reason.
    status = 'ready'
    reason = ''
  }
  return {
    id: slot.id,
    label: slot.label,
    ref: slot.ref,
    configured,
    active: slot.id === activeId,
    status,
    reason,
    cooldownUntil: status === 'cooldown' ? (state?.until ?? 0) : 0,
  }
}

/** The current model list, with the capacities and efforts the picker uses. */
function modelViews(deps: SnapshotDeps): ModelView[] {
  return Object.keys(KNOWN_MODELS).map((id) => {
    const facts = modelFacts(id)
    const price = facts.price
    return {
      id,
      // The display name comes from the effort/vision facts table, which does
      // not carry one: the id's own tail is the closest thing river publishes.
      name: displayName(id),
      contextWindow: facts.contextWindow,
      maxOutputTokens: facts.maxOutputTokens,
      vision: facts.vision,
      // Already harness vocabulary: `reasoningEffortsFor` maps ids onto the
      // ladder the picker and this form both label.
      efforts: reasoningEffortsFor(id).map((effort) => String(effort.id)),
      defaultEffort: facts.defaultEffort ?? '',
      visible: deps.isVisible(id),
      price: { input: price.input, cachedInput: price.cachedInput, output: price.output },
    }
  })
}

/**
 * Assemble the page snapshot.
 *
 * `activeId` is resolved from the pool rather than recomputed here: the pool is
 * the only thing that knows which account a request would take right now, and a
 * second implementation of that rule would eventually pick a different one.
 */
export async function buildSnapshot(deps: SnapshotDeps): Promise<RiverSnapshot> {
  const raw = deps.config()
  const defaults = deps.defaults()
  const now = Date.now()

  const resolved = await deps.pool.describeAccounts()
  const active = await deps.pool.activeAccount().catch(() => undefined)
  const activeId = active?.slot.id ?? ''

  // Describe from the CONFIGURED slots, not from the resolved ones: a slot whose
  // key does not resolve must still appear, or the page hides the very row a
  // user needs to see to fix the problem.
  const byId = new Map<string, ResolvedAccount>()
  for (const account of resolved) byId.set(account.slot.id, account)

  // `configured` comes from the credential seam, not from whether a key landed
  // in `resolved`: a slot with no value is absent from that list, and the row a
  // user must see to fix it would otherwise vanish.
  const slots = deps.slots()
  const configured = await Promise.all(slots.map(async (slot) => {
    if ((slot.literal ?? '') !== '') return true
    return deps.isConfigured(slot.ref)
  }))

  return {
    provider: deps.provider,
    apiBase: defaults.apiBase,
    accounts: slots.map((slot, index) => accountView(byId.get(slot.id), slot, activeId, now, configured[index] ?? false)),
    models: modelViews(deps),
    defaults: {
      contextWindowLimit: defaults.contextWindowLimit,
      maxOutputTokens: defaults.maxOutputTokens,
      activeAccount: raw.activeAccount ?? '',
      defaultReasoningEffort: { ...(raw.defaultReasoningEffort ?? {}) },
    },
    modelAccountRules: (raw.modelAccountRules ?? []).map((rule) => ({
      models: [...rule.models],
      account: rule.account,
    })),
    ui: {
      // Read from the resolved config rather than from `raw`: the config value
      // is optional on disk, and the page needs the effective answer.
      showSettingsSection: defaults.showSettingsSection,
    },
  }
}
