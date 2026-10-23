import { Context } from "@deepseek-ai/cordis";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-attachment";
/** The error raised when every account is unusable. */
declare class AllAccountsUnusableError extends Error {
  readonly code: 'RATE_LIMIT' | 'THROTTLED' | 'INVALID_CREDENTIAL';
  readonly retryAfterMs: number | undefined;
  constructor(message: string, code: 'RATE_LIMIT' | 'THROTTLED' | 'INVALID_CREDENTIAL', retryAfterMs: number | undefined);
}
/**
 * The fixed provider id this plugin registers.
 *
 * Not `riverai`: that id already belongs to the pi-ai row in the stock profile,
 * and two plugins claiming one id makes the model picker and the default-model
 * pointer ambiguous about which implementation a request runs through.
 */
declare const PROVIDER = "river";
declare const name = "llm-river";
declare const inject: string[];
/** One configured account. */
interface RiverAccountConfig {
  /** Shown in the status list and in rotation errors. */
  label?: string;
  /** Name of the env var / credential ref holding this key. */
  apiKeyEnv?: string;
  /** Literal key; kept out of cached config snapshots. */
  apiKey?: string;
}
/** One "these models prefer this account" rule. */
interface RiverModelAccountRule {
  /** Glob patterns, matched against the model id. */
  models: string[];
  /** Account label or slot id. */
  account: string;
}
/** The resolved plugin configuration. */
interface RiverConfig {
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
}
declare const RiverConfigSchema: Record<string, unknown>;
/** Model ids that carry vision, from the bundled snapshot. */
declare function apply(ctx: Context, config: RiverConfig): Promise<void>;
/** True for the pool's "nothing can be attempted" error. */
declare function isPoolExhausted(error: unknown): error is AllAccountsUnusableError;
export { PROVIDER, RiverAccountConfig, RiverConfig, RiverConfigSchema, RiverModelAccountRule, apply, inject, isPoolExhausted, name };
//# sourceMappingURL=index.d.ts.map