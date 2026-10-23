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
export type AccountRejection = 'rate-limit' | 'throttled' | 'invalid-credential';
/**
 * How long the retry layer will wait for a single retry.
 *
 * MUST equal the adapter's `backoff.maxDelayMs`: a longer `Retry-After` is
 * discarded by the harness's retry layer, which then hammers a throttled
 * account instead of honouring river's advice. Kept here because the pool is
 * what computes the wait.
 */
export declare const RETRY_MAX_DELAY_MS = 900000;
/** How long a key must stay clean before a NEW mark is overwritten. */
export declare const STATE_TTL_MS: number;
/**
 * Attempts one request may make before the pool gives up.
 *
 * Each attempt burns one account rejection, so this must stay comfortably above
 * the number of configured accounts — otherwise a request dies one rotation
 * short of trying a healthy key.
 */
export declare const MAX_ACCOUNT_ROTATIONS = 16;
/** A configured account slot, resolved to its current key on demand. */
export interface AccountSlot {
    /** Stable identifier: the env-var name, or `account-N` as a fallback. */
    id: string;
    /** Human label shown in the settings UI and error messages. */
    label: string;
    /** Credential reference (env var name) this slot reads. */
    ref: string;
    /** A literal key configured directly in the settings file. */
    literal?: string | undefined;
}
/** The current health of one key. */
export interface AccountState {
    kind: 'cooldown' | 'disabled';
    cause: 'window' | 'throttle' | 'auth';
    reason: string;
    /** Epoch ms when the cooldown ends; 0 for `disabled`. */
    until: number;
}
/** One slot with its current key and health. */
export interface ResolvedAccount {
    slot: AccountSlot;
    key: string;
    state: AccountState | undefined;
}
/** A routing rule: these models prefer this account. */
export interface ModelAccountRule {
    models: readonly string[];
    account: string;
}
/** Everything the pool needs from its owner. */
export interface AccountPoolOptions {
    /** Configured slots, read fresh on every call so a settings edit applies now. */
    slots: () => readonly AccountSlot[];
    /**
     * Resolve one credential reference to its value.
     *
     * Asynchronous because the credential seam is (`credentials.resolve()` may
     * touch a keyring or an encrypted store). Synchronous implementations stay
     * valid: the pool awaits whatever this returns.
     */
    resolveRef: (ref: string) => string | undefined | Promise<string | undefined>;
    /** A user-pinned account id, tried first when healthy. */
    preferredId?: (() => string | undefined) | undefined;
    /** Model→account routing. */
    modelAccountRules?: (() => readonly ModelAccountRule[]) | undefined;
    /** Clock seam, so tests do not sleep. */
    now?: (() => number) | undefined;
}
/** The error raised when every account is unusable. */
export declare class AllAccountsUnusableError extends Error {
    readonly code: 'RATE_LIMIT' | 'THROTTLED' | 'INVALID_CREDENTIAL';
    readonly retryAfterMs: number | undefined;
    constructor(message: string, code: 'RATE_LIMIT' | 'THROTTLED' | 'INVALID_CREDENTIAL', retryAfterMs: number | undefined);
}
/** Whether a key may be attempted now. */
export declare function accountUsable(state: AccountState | undefined, now?: number): boolean;
/** Trim a key for use as a map key; empty becomes undefined. */
export declare function normalizeKey(value: string | undefined): string | undefined;
/**
 * Resolve configured slots to keys.
 *
 * Two slots may point at the same env var after a settings edit; the pool
 * deduplicates by key so one physical account is never counted twice (which
 * would make "all accounts exhausted" wrong and waste a rotation).
 */
export declare function resolveAccounts(options: AccountPoolOptions): Promise<ResolvedAccount[]>;
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
export declare function selectAccountForModel(usable: readonly ResolvedAccount[], all: readonly ResolvedAccount[], model: string, rules: readonly ModelAccountRule[], excluded?: ReadonlySet<string>): ResolvedAccount | undefined;
/**
 * The account pool.
 *
 * Instances are cheap: the pool holds no connection state of its own, so the
 * plugin can scope it per API base and share health across turns.
 */
export declare class RiverAccountPool {
    private readonly options;
    private readonly marks;
    /** How many times each key has been handed out, for even distribution. */
    private readonly uses;
    constructor(options: AccountPoolOptions);
    private now;
    /** Every configured account with its current health. */
    describeAccounts(): Promise<ResolvedAccount[]>;
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
    resolveKey(input?: {
        tried?: readonly string[];
        model?: string;
    }): Promise<ResolvedAccount>;
    /** The account to show in the sidebar: the next one that would be tried. */
    activeAccount(): Promise<ResolvedAccount | undefined>;
    /**
     * Record that a key was refused.
     *
     * `resetAtMs` comes from river's `Retry-After` when present; otherwise the
     * cooldown is a conservative default that still lets the account return
     * within the session.
     */
    markRejected(key: string, rejection: AccountRejection, resetAtMs?: number): void;
    /** Record a successful attempt, clearing any stale cooldown. */
    markHealthy(key: string): void;
    /** Forget every mark; used when credentials are edited. */
    reset(): void;
    private recordUse;
    /** Build the error raised when nothing can be attempted. */
    private exhausted;
}
