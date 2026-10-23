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
import { Context } from '@deepseek-ai/cordis';
import { PROVIDER } from './adapter.ts';
import { AllAccountsUnusableError } from './accounts.ts';
export declare const name = "llm-river";
export declare const inject: string[];
export { PROVIDER };
/** One configured account. */
export interface RiverAccountConfig {
    /** Shown in the status list and in rotation errors. */
    label?: string;
    /** Name of the env var / credential ref holding this key. */
    apiKeyEnv?: string;
    /** Literal key; kept out of cached config snapshots. */
    apiKey?: string;
}
/** One "these models prefer this account" rule. */
export interface RiverModelAccountRule {
    /** Glob patterns, matched against the model id. */
    models: string[];
    /** Account label or slot id. */
    account: string;
}
/** The resolved plugin configuration. */
export interface RiverConfig {
    apiBase?: string;
    apiKeyEnv?: string;
    apiKey?: string;
    accounts?: RiverAccountConfig[];
    /** Pins an account; `undefined` means "rotate". */
    activeAccount?: string;
    modelAccountRules?: RiverModelAccountRule[];
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    maxOutputTokens?: number;
    /** Ceiling for the advertised context window; absent uses the model's own. */
    contextWindowLimit?: number;
    /**
     * Per-model default reasoning effort, e.g. `{"zai-org/GLM-*": "max"}`.
     *
     * Values are translated to the model's own whitelist, so a level it does not
     * accept is snapped rather than sent. `auto` means "the model's own default".
     */
    defaultReasoningEffort?: Record<string, string>;
    /** Models the picker may show. Empty = catalog-driven. */
    visibleModels?: string[];
    /** Per-model visibility overrides, applied after `visibleModels`. */
    modelVisibility?: Record<string, boolean>;
    /**
     * Whether the settings navigation shows a dedicated river.ai page.
     *
     * Off by default: the provider card already carries everything the page does,
     * and a nav entry nobody asked for is clutter. The page is the better home for
     * the account table, so it stays one switch away.
     */
    showSettingsSection?: boolean;
}
declare const RiverConfigSchema: Record<string, unknown>;
export { RiverConfigSchema };
/** Model ids that carry vision, from the bundled snapshot. */
export declare function apply(ctx: Context, config: RiverConfig): Promise<void>;
/** True for the pool's "nothing can be attempted" error. */
export declare function isPoolExhausted(error: unknown): error is AllAccountsUnusableError;
