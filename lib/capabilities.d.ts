/**
 * Adapts river's model catalog to the shapes a request needs.
 *
 * Every number here is documented in river's model pages; the static table is a
 * snapshot, not a guess, and `KNOWN_MODELS` is the single place to edit when
 * river ships a model. Anything river serves that this table has not learned yet
 * still works: the unknown-model fallback keeps the full documented context
 * window, offers no reasoning effort it cannot verify, and uses a small output
 * budget, so an unknown model produces a correct request instead of a 400.
 *
 * @module dsh-river-provider/capabilities
 */
import { type LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm';
/**
 * Everything the plugin knows about one model, as a static snapshot.
 *
 * `efforts` is the exact whitelist river documents PER MODEL: DeepSeek accepts
 * `none|high|max` and rejects `low`, GLM accepts `low|high|max` and must reason,
 * so a plugin-wide effort list produces 400s on one family or the other.
 */
export interface RiverModelFacts {
    contextWindow: number;
    maxOutputTokens: number;
    /** Whether the model accepts images. */
    vision: boolean;
    /** The exact `reasoning_effort` values river accepts for this model. */
    efforts: readonly string[];
    /** The effort used when a call does not specify one. */
    defaultEffort?: string | undefined;
    price: {
        input: number;
        cachedInput: number;
        output: number;
    };
    /**
     * How the model interleaves reasoning with its answer.
     *
     * `leading` models reason once and then answer; `interleaved` models reason
     * between tool calls. Only the display differs — both arrive on
     * `reasoning_content` — but a caller that replays reasoning must not, and
     * this is what the settings page shows to explain the output budget.
     */
    reasoningStyle: 'leading' | 'interleaved';
}
/**
 * Context window shared by every model river currently serves.
 *
 * One constant rather than a per-model field: river documents 1,048,576 for the
 * whole catalog, and a per-model copy would drift on the first model that
 * differs. A model with a smaller window is an explicit override below.
 */
export declare const RIVER_CONTEXT_WINDOW = 1048576;
/**
 * The static snapshot of river's catalog.
 *
 * Reasoning efforts are NOT uniform and this is the bug the upstream plugin
 * shipped: DeepSeek-V4.1-Flash accepts `none|high|max` and rejects `low`, while
 * GLM-5.3-Flash accepts `low|high|max` and rejects `none`. Forwarding a harness
 * effort verbatim across that boundary is an instant 400.
 */
export declare const KNOWN_MODELS: Readonly<Record<string, RiverModelFacts>>;
/**
 * Facts for a model the snapshot has not seen.
 *
 * `contextWindow` is the full 1M every river model publishes, not a smaller
 * placeholder: the harness derives its usage meter, compaction thresholds and
 * reference-file budget from this number, and under-reporting it makes the
 * assistant compact early and throw away room the operator already paid for.
 * A model that genuinely ships a smaller window only needs its entry added
 * below.
 *
 * The output ceiling stays conservative: an over-large `max_tokens` is a hard
 * 400 that no retry fixes, while a small one is raised by configuration. No
 * reasoning means no `reasoning_effort` is sent, which every river model
 * accepts.
 */
export declare const UNKNOWN_MODEL_FACTS: RiverModelFacts;
/** Facts for one model id, falling back to the conservative defaults. */
export declare function modelFacts(model: string): RiverModelFacts;
/** A display name for the model picker. */
export declare function displayName(model: string): string;
/**
 * The largest output budget any snapshot model allows.
 *
 * The settings form needs one number to show when nothing is configured. It is
 * the ceiling rather than a conservative middle: a configured budget is a
 * REQUEST, and river rejects one above a model's limit, so the honest default is
 * the highest figure the catalog states — with the per-model table beside it
 * holding the rest of the truth.
 */
export declare function knownMaxOutputTokens(): number;
/** The reasoning efforts to offer for one model, in harness order. */
export declare function reasoningEffortsFor(model: string): LlmReasoningEffortInfo[];
/**
 * Normalize a requested effort onto the harness's own level ids.
 *
 * The ids this reports are the HARNESS vocabulary (`off|minimal|low|medium|
 * high|xhigh|max`), not river's wire values, because the ids travel to the
 * model picker and the settings form: an id outside that list has no label
 * there, so the UI falls back to printing the raw id. Older harness spellings
 * and river's own words are accepted on input and folded onto the ladder.
 */
export declare function canonicalEffort(requested: string): string;
/**
 * Translate a requested effort into one the model actually accepts.
 *
 * An accepted value passes through untouched. Anything else moves to the
 * nearest supported level, choosing the CHEAPER direction on a tie.
 *
 * The tie-break is a cost decision, not cosmetics: a caller asking for `low` on
 * a DeepSeek model (which accepts only `off|high|max`) is one step from both
 * `off` and `high`, and rounding UP spends real reasoning tokens on a level the
 * caller did not ask for. Rounded down, the request is cheaper and still close.
 * Ties compare rank on {@link EFFORT_LADDER}, which orders the vocabulary from
 * least to most expensive.
 *
 * @returns an accepted effort, or undefined when the model has none.
 */
export declare function translateEffort(model: string, requested: string | undefined): string | undefined;
/**
 * The `reasoning_effort` value to put on the wire, or undefined for none.
 *
 * `off` means "do not reason", and the field is then OMITTED rather than sent as
 * the string `"none"`: river spells that choice per model (DeepSeek accepts
 * `none`), and an ABSENT field is understood identically by every route and by
 * any OpenAI-compatible gateway in front of it.
 */
export declare function wireEffort(model: string, requested: string | undefined): string | undefined;
/**
 * Clamp a provider capacity to a configured ceiling.
 *
 * A ceiling may only LOWER a capacity: river would answer 400 for a
 * `max_tokens` above the model's own maximum, so a configured 400000 on a
 * 128000-output model must resolve to 128000 rather than fail every turn.
 *
 * `undefined`, zero and negative ceilings mean "no ceiling": the settings form
 * shows an empty number field as absent, and a `0` typed into it reads as
 * "leave this alone" rather than "disable the model".
 */
export declare function clampCeiling(offered: number, ceiling: number | undefined): number;
/**
 * The configured default effort for one model, validated against the model's
 * own whitelist.
 *
 * The per-model map is deliberately the only source (no global default): a
 * model river ships tomorrow keeps ITS OWN default until someone names it,
 * instead of silently inheriting a choice made for a different model.
 *
 * A configured value is NEVER snapped. Snapping is right for a request the
 * harness generates at runtime (it must produce something), but wrong for a
 * setting: a mistyped `low` on a DeepSeek model would silently become `none` or
 * `high` and change both what the model does and what it costs, every turn,
 * with nothing to notice. A rejected value surfaces instead, and configuration
 * is a slow variable that gets corrected once.
 *
 * @throws RangeError when the configured value is not one the model accepts.
 * @returns an accepted effort, or undefined when the model has no reasoning.
 */
export declare function configuredEffort(model: string, overrides: Readonly<Record<string, string | undefined>> | undefined): string | undefined;
/**
 * The cheapest effort a model accepts.
 *
 * Used for machine-shaped calls (session titles, compaction) where reasoning
 * would be paid for and never read. A model with no `none` (GLM) gets its
 * lowest level instead of an invalid `none`.
 */
export declare function titleEffort(model: string): string | undefined;
/** Whether the model accepts images. */
export declare function modelSupportsVision(model: string): boolean;
/**
 * The context window to report for one model, optionally capped by settings.
 *
 * Only the ADVERTISED capacity is capped. The request body never carries a
 * context window, so this number reaches exactly three consumers: the harness's
 * usage meter, compaction pressure thresholds, and the reference-file budget.
 * Lowering it is how a 1M-token route is kept to a budget the operator actually
 * wants to pay for; raising it is impossible, because the model would truncate
 * what the meter believed fitted.
 */
export declare function contextWindowFor(model: string, ceiling: number | undefined): number;
/**
 * The output budget to report and request for one model.
 *
 * `min(configured, model)` and never above the model: this value becomes the
 * request's `max_tokens`, and river rejects an over-large one with a 400. It is
 * also the harness's `reservedCompletionTokens` during compaction, which is why
 * the reported context window must stay above it — see the settings docs.
 */
export declare function outputBudgetFor(model: string, ceiling: number | undefined): number;
