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
/**
 * How long the retry layer will wait for a single retry.
 *
 * MUST equal the adapter's `backoff.maxDelayMs`: a longer `Retry-After` is
 * discarded by the harness's retry layer, which then hammers a throttled
 * account instead of honouring river's advice. Kept here because the pool is
 * what computes the wait.
 */
export const RETRY_MAX_DELAY_MS = 900_000;
/** How long a key must stay clean before a NEW mark is overwritten. */
export const STATE_TTL_MS = 24 * 60 * 60_000;
/**
 * Attempts one request may make before the pool gives up.
 *
 * Each attempt burns one account rejection, so this must stay comfortably above
 * the number of configured accounts — otherwise a request dies one rotation
 * short of trying a healthy key.
 */
export const MAX_ACCOUNT_ROTATIONS = 16;
/** The error raised when every account is unusable. */
export class AllAccountsUnusableError extends Error {
    code;
    retryAfterMs;
    constructor(message, code, retryAfterMs) {
        super(message);
        this.code = code;
        this.retryAfterMs = retryAfterMs;
        this.name = 'AllAccountsUnusableError';
    }
}
/** Whether a key may be attempted now. */
export function accountUsable(state, now = Date.now()) {
    if (state === undefined)
        return true;
    if (state.kind === 'cooldown')
        return state.until > 0 && now >= state.until;
    return false;
}
/** Trim a key for use as a map key; empty becomes undefined. */
export function normalizeKey(value) {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/**
 * Resolve configured slots to keys.
 *
 * Two slots may point at the same env var after a settings edit; the pool
 * deduplicates by key so one physical account is never counted twice (which
 * would make "all accounts exhausted" wrong and waste a rotation).
 */
export async function resolveAccounts(options) {
    const seen = new Set();
    const accounts = [];
    for (const slot of options.slots()) {
        const literal = normalizeKey(slot.literal);
        const key = literal ?? normalizeKey(await options.resolveRef(slot.ref));
        if (key === undefined)
            continue;
        if (seen.has(key))
            continue;
        seen.add(key);
        accounts.push({ slot, key, state: undefined });
    }
    return accounts;
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
export function selectAccountForModel(usable, all, model, rules, excluded = new Set()) {
    for (const rule of rules) {
        const hit = rule.models.some((pattern) => matchesModel(pattern, model));
        if (!hit)
            continue;
        const named = all.find((entry) => entry.slot.id === rule.account || entry.slot.ref === rule.account);
        if (named === undefined)
            continue;
        const candidate = usable.find((entry) => entry.key === named.key);
        if (candidate !== undefined && !excluded.has(candidate.key))
            return candidate;
    }
    return undefined;
}
/** Glob-ish model matching: `*` wildcards, a bare suffix matches any prefix. */
function matchesModel(pattern, model) {
    if (pattern === model)
        return true;
    if (!pattern.includes('*')) {
        return model.endsWith(`/${pattern}`) || model === pattern;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(model);
}
/**
 * The account pool.
 *
 * Instances are cheap: the pool holds no connection state of its own, so the
 * plugin can scope it per API base and share health across turns.
 */
export class RiverAccountPool {
    options;
    marks = new Map();
    /** How many times each key has been handed out, for even distribution. */
    uses = new Map();
    constructor(options) {
        this.options = options;
    }
    now() {
        return this.options.now?.() ?? Date.now();
    }
    /** Every configured account with its current health. */
    async describeAccounts() {
        return (await resolveAccounts(this.options)).map((account) => ({
            ...account,
            state: this.marks.get(account.key),
        }));
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
    async resolveKey(input = {}) {
        const accounts = await this.describeAccounts();
        if (accounts.length === 0) {
            throw new AllAccountsUnusableError('No river.ai API key is configured: add one under Settings → Models → river.ai.', 'INVALID_CREDENTIAL', undefined);
        }
        const tried = new Set(input.tried ?? []);
        const now = this.now();
        const usable = accounts.filter((account) => !tried.has(account.key) && accountUsable(account.state, now));
        if (input.model !== undefined) {
            const rules = this.options.modelAccountRules?.() ?? [];
            const routed = selectAccountForModel(usable, accounts, input.model, rules);
            if (routed !== undefined) {
                this.recordUse(routed.key);
                return routed;
            }
        }
        const preferredId = this.options.preferredId?.();
        if (preferredId !== undefined) {
            const pinned = usable.find((account) => account.slot.id === preferredId || account.slot.ref === preferredId);
            if (pinned !== undefined) {
                this.recordUse(pinned.key);
                return pinned;
            }
        }
        if (usable.length > 0) {
            // Least-used wins; on a tie the earlier slot wins, so a fresh session
            // starts at the first account instead of drifting between equal ones.
            let pick = usable[0];
            for (const candidate of usable) {
                if ((this.uses.get(candidate.key) ?? 0) < (this.uses.get(pick.key) ?? 0))
                    pick = candidate;
            }
            this.recordUse(pick.key);
            return pick;
        }
        throw this.exhausted(accounts, tried, now);
    }
    /** The account to show in the sidebar: the next one that would be tried. */
    async activeAccount() {
        try {
            const accounts = await this.describeAccounts();
            const now = this.now();
            const preferredId = this.options.preferredId?.();
            const pinned = preferredId === undefined
                ? undefined
                : accounts.find((account) => (account.slot.id === preferredId || account.slot.ref === preferredId)
                    && accountUsable(account.state, now));
            return pinned ?? accounts.find((account) => accountUsable(account.state, now)) ?? accounts[0];
        }
        catch {
            return undefined;
        }
    }
    /**
     * Record that a key was refused.
     *
     * `resetAtMs` comes from river's `Retry-After` when present; otherwise the
     * cooldown is a conservative default that still lets the account return
     * within the session.
     */
    markRejected(key, rejection, resetAtMs) {
        const normalized = normalizeKey(key);
        if (normalized === undefined)
            return;
        const now = this.now();
        const state = rejection === 'invalid-credential'
            ? { kind: 'disabled', cause: 'auth', reason: 'river.ai rejected this API key', until: 0 }
            : {
                kind: 'cooldown',
                cause: rejection === 'throttled' ? 'throttle' : 'window',
                reason: rejection === 'throttled'
                    ? 'river.ai rate limited this account'
                    : 'river.ai reported the account is out of balance',
                until: resetAtMs !== undefined && resetAtMs > now ? resetAtMs : now + defaultCooldownMs(rejection),
            };
        const previous = this.marks.get(normalized);
        // Never shorten an existing cooldown: two failures in flight race, and the
        // later one usually carries less information than the earlier one.
        if (previous !== undefined && previous.kind === 'cooldown' && previous.until > state.until)
            return;
        this.marks.set(normalized, state);
        if (state.kind === 'cooldown' && state.until - now > STATE_TTL_MS) {
            this.marks.set(normalized, { ...state, until: now + STATE_TTL_MS });
        }
    }
    /** Record a successful attempt, clearing any stale cooldown. */
    markHealthy(key) {
        const normalized = normalizeKey(key);
        if (normalized === undefined)
            return;
        const state = this.marks.get(normalized);
        // An auth failure is NOT cleared by a later success: the same key cannot
        // both be invalid and working, and clearing it would loop forever.
        if (state !== undefined && state.cause === 'auth')
            return;
        this.marks.delete(normalized);
    }
    /** Forget every mark; used when credentials are edited. */
    reset() {
        this.marks.clear();
        this.uses.clear();
    }
    recordUse(key) {
        this.uses.set(key, (this.uses.get(key) ?? 0) + 1);
    }
    /** Build the error raised when nothing can be attempted. */
    exhausted(accounts, tried, now) {
        const allTried = accounts.every((account) => tried.has(account.key));
        const states = accounts.map((account) => account.state);
        const everyAuth = states.length > 0 && states.every((state) => state?.cause === 'auth');
        if (everyAuth) {
            return new AllAccountsUnusableError(`All ${accounts.length} river.ai accounts were rejected (invalid API key).`, 'INVALID_CREDENTIAL', undefined);
        }
        const cooldowns = accounts
            .map((account) => account.state)
            .filter((state) => state !== undefined && state.kind === 'cooldown')
            .map((state) => state.until);
        const soonest = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
        const wait = soonest > now ? Math.min(soonest - now, RETRY_MAX_DELAY_MS) : undefined;
        const suffix = allTried ? 'every account was already tried this turn' : 'all accounts are cooling down';
        const message = wait === undefined
            ? `All ${accounts.length} river.ai accounts are unavailable (${suffix}).`
            : `All ${accounts.length} river.ai accounts are busy; the next one frees up in ${Math.ceil(wait / 1000)}s.`;
        const code = cooldowns.length > 0 ? 'RATE_LIMIT' : 'THROTTLED';
        return new AllAccountsUnusableError(message, code, wait);
    }
}
/** A conservative cooldown when river gives no `Retry-After`. */
function defaultCooldownMs(rejection) {
    return rejection === 'throttled' ? 60_000 : 5 * 60_000;
}
//# sourceMappingURL=accounts.js.map