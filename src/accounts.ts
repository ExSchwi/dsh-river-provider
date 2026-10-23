/**
 * The multi-account pool — the reason this plugin exists.
 *
 * One river.ai key is one balance, and a person with several keys was, until
 * now, editing a provider entry per key and switching by hand. This pool makes
 * the accounts a single provider: it picks a key per attempt, remembers which
 * key is cooling down and why, and rotates when an attempt is rejected for a
 * reason another account can fix.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 *  1. Marks are keyed by the TRIMMED key. A mark recorded against an untrimmed
 *     key never matches the lookup, so rotation silently stops working and the
 *     session just fails.
 *  2. A rejected account is not banned forever. Once its cooldown expires it is
 *     probed again — river's limits are rolling and a balance can be topped up
 *     mid-session, so a permanently disabled pool would strand the user.
 *
 * @module dsh-river-provider/accounts
 */

/** Why an attempt was refused, at the granularity that decides the remedy. */
export type AccountRejection = 'rate-limit' | 'throttled' | 'invalid-credential'

/**
 * How long the retry layer will wait for a single retry.
 *
 * MUST equal the adapter's `backoff.maxDelayMs`: a longer `Retry-After` is
 * discarded by the harness's retry layer, which then hammers a throttled
 * account instead of honouring river's advice. Kept here because the pool is
 * what computes the wait.
 */
export const RETRY_MAX_DELAY_MS = 900_000

/** How long a key must stay clean before a NEW mark is overwritten. */
export const STATE_TTL_MS = 24 * 60 * 60_000

/**
 * Attempts one request may make before the pool gives up.
 *
 * Each attempt burns one account rejection, so this must stay comfortably above
 * the number of configured accounts — otherwise a request dies one rotation
 * short of trying a healthy key.
 */
export const MAX_ACCOUNT_ROTATIONS = 16

/** A configured account slot, resolved to its current key on demand. */
export interface AccountSlot {
  /** Stable identifier: the env-var name, or `account-N` as a fallback. */
  id: string
  /** Human label shown in the settings UI and error messages. */
  label: string
  /** Credential reference (env var name) this slot reads. */
  ref: string
  /** A literal key configured directly in the settings file. */
  literal?: string | undefined
}

/** The current health of one key. */
export interface AccountState {
  kind: 'cooldown' | 'disabled'
  cause: 'window' | 'throttle' | 'auth'
  reason: string
  /** Epoch ms when the cooldown ends; 0 for `disabled`. */
  until: number
}

/** One slot with its current key and health. */
export interface ResolvedAccount {
  slot: AccountSlot
  key: string
  state: AccountState | undefined
}

/** A routing rule: these models prefer this account. */
export interface ModelAccountRule {
  models: readonly string[]
  account: string
}

/** Everything the pool needs from its owner. */
export interface AccountPoolOptions {
  /** Configured slots, read fresh on every call so a settings edit applies now. */
  slots: () => readonly AccountSlot[]
  /**
   * Resolve one credential reference to its value.
   *
   * Asynchronous because the credential seam is (`credentials.resolve()` may
   * touch a keyring or an encrypted store). Synchronous implementations stay
   * valid: the pool awaits whatever this returns.
   */
  resolveRef: (ref: string) => string | undefined | Promise<string | undefined>
  /** A user-pinned account id, tried first when healthy. */
  preferredId?: (() => string | undefined) | undefined
  /** Model→account routing. */
  modelAccountRules?: (() => readonly ModelAccountRule[]) | undefined
  /** Clock seam, so tests do not sleep. */
  now?: (() => number) | undefined
}

/** The error raised when every account is unusable. */
export class AllAccountsUnusableError extends Error {
  constructor(
    message: string,
    readonly code: 'RATE_LIMIT' | 'THROTTLED' | 'INVALID_CREDENTIAL',
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
    this.name = 'AllAccountsUnusableError'
  }
}

/** Whether a key may be attempted now. */
export function accountUsable(state: AccountState | undefined, now = Date.now()): boolean {
  if (state === undefined) return true
  if (state.kind === 'cooldown') return state.until > 0 && now >= state.until
  return false
}

/** Trim a key for use as a map key; empty becomes undefined. */
export function normalizeKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve configured slots to keys.
 *
 * Two slots may point at the same env var after a settings edit; the pool
 * deduplicates by key so one physical account is never counted twice (which
 * would make "all accounts exhausted" wrong and waste a rotation).
 */
export async function resolveAccounts(options: AccountPoolOptions): Promise<ResolvedAccount[]> {
  const seen = new Set<string>()
  const accounts: ResolvedAccount[] = []
  for (const slot of options.slots()) {
    const literal = normalizeKey(slot.literal)
    const key = literal ?? normalizeKey(await options.resolveRef(slot.ref))
    if (key === undefined) continue
    if (seen.has(key)) continue
    seen.add(key)
    accounts.push({ slot, key, state: undefined })
  }
  return accounts
}

/**
 * The account a model is routed to, if a rule matches.
 *
 * The rule's target is resolved by id first and by credential ref second, so a
 * rule survives a user renaming the label but keeps working when the rules were
 * written against the env var (which is the id for a non-default slot).
 *
 * @param usable - accounts that may be attempted right now.
 * @param excluded - accounts already rejected during this turn.
 */
export function selectAccountForModel(
  usable: readonly ResolvedAccount[],
  all: readonly ResolvedAccount[],
  model: string,
  rules: readonly ModelAccountRule[],
  excluded: ReadonlySet<string> = new Set(),
): ResolvedAccount | undefined {
  for (const rule of rules) {
    const hit = rule.models.some((pattern) => matchesModel(pattern, model))
    if (!hit) continue
    const named = all.find((entry) => entry.slot.id === rule.account || entry.slot.ref === rule.account)
    if (named === undefined) continue
    const candidate = usable.find((entry) => entry.key === named.key)
    if (candidate !== undefined && !excluded.has(candidate.key)) return candidate
  }
  return undefined
}

/** Glob-ish model matching: `*` wildcards, a bare suffix matches any prefix. */
function matchesModel(pattern: string, model: string): boolean {
  if (pattern === model) return true
  if (!pattern.includes('*')) {
    return model.endsWith(`/${pattern}`) || model === pattern
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(model)
}

/**
 * The account pool.
 *
 * Instances are cheap: the pool holds no connection state of its own, so the
 * plugin can scope it per API base and share health across turns.
 */
export class RiverAccountPool {
  private readonly marks = new Map<string, AccountState>()
  /** How many times each key has been handed out, for even distribution. */
  private readonly uses = new Map<string, number>()

  constructor(private readonly options: AccountPoolOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Every configured account with its current health. */
  async describeAccounts(): Promise<ResolvedAccount[]> {
    return (await resolveAccounts(this.options)).map((account) => ({
      ...account,
      state: this.marks.get(account.key),
    }))
  }

  /**
   * Reserve the next key for one attempt.
   *
   * Order: model route → pinned account → least-recently-used healthy account →
   * (only if everything is cooling down) the account that frees up soonest, so
   * a single-account setup waits instead of failing outright.
   *
   * @param tried - keys already rejected during this turn.
   * @param model - the model being called, for routing rules.
   */
  async resolveKey(input: { tried?: readonly string[]; model?: string } = {}): Promise<ResolvedAccount> {
    const accounts = await this.describeAccounts()
    if (accounts.length === 0) {
      throw new AllAccountsUnusableError(
        'No river.ai API key is configured: add one under Settings → Models → river.ai.',
        'INVALID_CREDENTIAL',
        undefined,
      )
    }
    const tried = new Set(input.tried ?? [])
    const now = this.now()
    const usable = accounts.filter((account) => !tried.has(account.key) && accountUsable(account.state, now))

    if (input.model !== undefined) {
      const rules = this.options.modelAccountRules?.() ?? []
      const routed = selectAccountForModel(usable, accounts, input.model, rules)
      if (routed !== undefined) {
        this.recordUse(routed.key)
        return routed
      }
    }

    const preferredId = this.options.preferredId?.()
    if (preferredId !== undefined) {
      const pinned = usable.find(
        (account) => account.slot.id === preferredId || account.slot.ref === preferredId,
      )
      if (pinned !== undefined) {
        this.recordUse(pinned.key)
        return pinned
      }
    }

    if (usable.length > 0) {
      // Least-used wins; on a tie the earlier slot wins, so a fresh session
      // starts at the first account instead of drifting between equal ones.
      let pick = usable[0] as ResolvedAccount
      for (const candidate of usable) {
        if ((this.uses.get(candidate.key) ?? 0) < (this.uses.get(pick.key) ?? 0)) pick = candidate
      }
      this.recordUse(pick.key)
      return pick
    }

    throw this.exhausted(accounts, tried, now)
  }

  /** The account to show in the sidebar: the next one that would be tried. */
  async activeAccount(): Promise<ResolvedAccount | undefined> {
    try {
      const accounts = await this.describeAccounts()
      const now = this.now()
      const preferredId = this.options.preferredId?.()
      const pinned = preferredId === undefined
        ? undefined
        : accounts.find(
            (account) =>
              (account.slot.id === preferredId || account.slot.ref === preferredId)
              && accountUsable(account.state, now),
          )
      return pinned ?? accounts.find((account) => accountUsable(account.state, now)) ?? accounts[0]
    } catch {
      return undefined
    }
  }

  /**
   * Record that a key was refused.
   *
   * `resetAtMs` comes from river's `Retry-After` when present; otherwise the
   * cooldown is a conservative default that still lets the account return
   * within the session.
   */
  markRejected(key: string, rejection: AccountRejection, resetAtMs?: number): void {
    const normalized = normalizeKey(key)
    if (normalized === undefined) return
    const now = this.now()
    const state: AccountState = rejection === 'invalid-credential'
      ? { kind: 'disabled', cause: 'auth', reason: 'river.ai rejected this API key', until: 0 }
      : {
          kind: 'cooldown',
          cause: rejection === 'throttled' ? 'throttle' : 'window',
          reason: rejection === 'throttled'
            ? 'river.ai rate limited this account'
            : 'river.ai reported the account is out of balance',
          until: resetAtMs !== undefined && resetAtMs > now ? resetAtMs : now + defaultCooldownMs(rejection),
        }
    const previous = this.marks.get(normalized)
    // Never shorten an existing cooldown: two failures in flight race, and the
    // later one usually carries less information than the earlier one.
    if (previous !== undefined && previous.kind === 'cooldown' && previous.until > state.until) return
    this.marks.set(normalized, state)
    if (state.kind === 'cooldown' && state.until - now > STATE_TTL_MS) {
      this.marks.set(normalized, { ...state, until: now + STATE_TTL_MS })
    }
  }

  /** Record a successful attempt, clearing any stale cooldown. */
  markHealthy(key: string): void {
    const normalized = normalizeKey(key)
    if (normalized === undefined) return
    const state = this.marks.get(normalized)
    // An auth failure is NOT cleared by a later success: the same key cannot
    // both be invalid and working, and clearing it would loop forever.
    if (state !== undefined && state.cause === 'auth') return
    this.marks.delete(normalized)
  }

  /** Forget every mark; used when credentials are edited. */
  reset(): void {
    this.marks.clear()
    this.uses.clear()
  }

  private recordUse(key: string): void {
    this.uses.set(key, (this.uses.get(key) ?? 0) + 1)
  }

  /** Build the error raised when nothing can be attempted. */
  private exhausted(
    accounts: readonly ResolvedAccount[],
    tried: ReadonlySet<string>,
    now: number,
  ): AllAccountsUnusableError {
    const allTried = accounts.every((account) => tried.has(account.key))
    const states = accounts.map((account) => account.state)
    const everyAuth = states.length > 0 && states.every((state) => state?.cause === 'auth')
    if (everyAuth) {
      return new AllAccountsUnusableError(
        `All ${accounts.length} river.ai accounts were rejected (invalid API key).`,
        'INVALID_CREDENTIAL',
        undefined,
      )
    }
    const cooldowns = accounts
      .map((account) => account.state)
      .filter((state): state is AccountState => state !== undefined && state.kind === 'cooldown')
      .map((state) => state.until)
    const soonest = cooldowns.length > 0 ? Math.min(...cooldowns) : 0
    const wait = soonest > now ? Math.min(soonest - now, RETRY_MAX_DELAY_MS) : undefined
    const suffix = allTried ? 'every account was already tried this turn' : 'all accounts are cooling down'
    const message = wait === undefined
      ? `All ${accounts.length} river.ai accounts are unavailable (${suffix}).`
      : `All ${accounts.length} river.ai accounts are busy; the next one frees up in ${Math.ceil(wait / 1000)}s.`
    const code = cooldowns.length > 0 ? 'RATE_LIMIT' : 'THROTTLED'
    return new AllAccountsUnusableError(message, code, wait)
  }
}

/** A conservative cooldown when river gives no `Retry-After`. */
function defaultCooldownMs(rejection: AccountRejection): number {
  return rejection === 'throttled' ? 60_000 : 5 * 60_000
}
