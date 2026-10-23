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

import { ReasoningEffortId, type LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'

/**
 * Everything the plugin knows about one model, as a static snapshot.
 *
 * `efforts` is the exact whitelist river documents PER MODEL: DeepSeek accepts
 * `none|high|max` and rejects `low`, GLM accepts `low|high|max` and must reason,
 * so a plugin-wide effort list produces 400s on one family or the other.
 */
export interface RiverModelFacts {
  contextWindow: number
  maxOutputTokens: number
  /** Whether the model accepts images. */
  vision: boolean
  /** The exact `reasoning_effort` values river accepts for this model. */
  efforts: readonly string[]
  /** The effort used when a call does not specify one. */
  defaultEffort?: string | undefined
  price: { input: number; cachedInput: number; output: number }
  /**
   * How the model interleaves reasoning with its answer.
   *
   * `leading` models reason once and then answer; `interleaved` models reason
   * between tool calls. Only the display differs — both arrive on
   * `reasoning_content` — but a caller that replays reasoning must not, and
   * this is what the settings page shows to explain the output budget.
   */
  reasoningStyle: 'leading' | 'interleaved'
}

/**
 * Context window shared by every model river currently serves.
 *
 * One constant rather than a per-model field: river documents 1,048,576 for the
 * whole catalog, and a per-model copy would drift on the first model that
 * differs. A model with a smaller window is an explicit override below.
 */
export const RIVER_CONTEXT_WINDOW = 1_048_576

/**
 * The static snapshot of river's catalog.
 *
 * Reasoning efforts are NOT uniform and this is the bug the upstream plugin
 * shipped: DeepSeek-V4.1-Flash accepts `none|high|max` and rejects `low`, while
 * GLM-5.3-Flash accepts `low|high|max` and rejects `none`. Forwarding a harness
 * effort verbatim across that boundary is an instant 400.
 */
export const KNOWN_MODELS: Readonly<Record<string, RiverModelFacts>> = {
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': {
    contextWindow: RIVER_CONTEXT_WINDOW,
    maxOutputTokens: 384_000,
    vision: true,
    efforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    price: { input: 0.12, cachedInput: 0.0024, output: 0.48 },
    reasoningStyle: 'leading',
  },
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    contextWindow: RIVER_CONTEXT_WINDOW,
    maxOutputTokens: 384_000,
    vision: true,
    efforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    price: { input: 0.12, cachedInput: 0.0024, output: 0.48 },
    reasoningStyle: 'leading',
  },
  'zai-org/GLM-5.3-Flash': {
    contextWindow: RIVER_CONTEXT_WINDOW,
    maxOutputTokens: 128_000,
    vision: true,
    // GLM reasons unconditionally: `none` is not an accepted value at all.
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    price: { input: 0.12, cachedInput: 0.024, output: 0.4 },
    reasoningStyle: 'interleaved',
  },
  'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4': {
    contextWindow: RIVER_CONTEXT_WINDOW,
    maxOutputTokens: 128_000,
    vision: true,
    // The docs publish no reasoning effort table for the Nemotron family, so
    // nothing is offered here rather than guessing a level it may not accept.
    // Offering a level river rejects is a 400 the caller cannot see coming; an
    // empty list simply sends no `reasoning_effort`.
    efforts: [],
    price: { input: 0.07, cachedInput: 0.024, output: 0.37 },
    reasoningStyle: 'leading',
  },
}

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
export const UNKNOWN_MODEL_FACTS: RiverModelFacts = {
  contextWindow: RIVER_CONTEXT_WINDOW,
  maxOutputTokens: 32_768,
  vision: true,
  efforts: [],
  price: { input: 0, cachedInput: 0, output: 0 },
  reasoningStyle: 'leading',
}

/** Facts for one model id, falling back to the conservative defaults. */
export function modelFacts(model: string): RiverModelFacts {
  const exact = KNOWN_MODELS[model]
  if (exact !== undefined) return exact
  // A vendor prefix can change while the model behind it does not; matching the
  // last path segment keeps prices and limits attached across such a rename.
  const tail = model.slice(model.lastIndexOf('/') + 1)
  for (const [id, facts] of Object.entries(KNOWN_MODELS)) {
    if (id.slice(id.lastIndexOf('/') + 1) === tail) return facts
  }
  return UNKNOWN_MODEL_FACTS
}

/** A display name for the model picker. */
export function displayName(model: string): string {
  const facts = KNOWN_MODELS[model]
  if (facts !== undefined) return model.slice(model.lastIndexOf('/') + 1)
  void facts
  const tail = model.slice(model.lastIndexOf('/') + 1)
  return tail === '' ? model : tail
}

/** The reasoning efforts to offer for one model, in harness order. */
export function reasoningEffortsFor(model: string): LlmReasoningEffortInfo[] {
  const facts = modelFacts(model)
  return facts.efforts.map((id) => {
    const effort: LlmReasoningEffortInfo = { id: ReasoningEffortId(id), name: effortName(id) }
    const description = effortDescription(id)
    if (description !== undefined) effort.description = description
    return effort
  })
}

/** Human names for effort levels. */
function effortName(id: string): string {
  switch (id) {
    case 'none': return 'No reasoning'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'max': return 'Maximum'
    default: return id
  }
}

/** Explanations shown next to each effort. */
function effortDescription(id: string): string | undefined {
  switch (id) {
    case 'none': return 'Answer directly; reasoning tokens are not generated.'
    case 'low': return 'Short reasoning pass.'
    case 'high': return 'Default reasoning budget.'
    case 'max': return 'Longest reasoning budget; billed as output.'
    default: return undefined
  }
}

/** The harness's ordered effort ladder, used to snap an unsupported value. */
const EFFORT_LADDER: readonly string[] = ['none', 'low', 'medium', 'high', 'max']

/**
 * Normalize harness spellings onto river's vocabulary.
 *
 * The harness has grown aliases over time (`off`, `minimal`, `xhigh`, `ultra`);
 * river knows five words, so a direct forward of `ultra` would be a 400.
 */
export function canonicalEffort(requested: string): string {
  switch (requested) {
    case 'off': return 'none'
    case 'minimal': return 'low'
    case 'xhigh':
    case 'extra-high': return 'high'
    case 'ultra':
    case 'maximum': return 'max'
    default: return requested
  }
}

/**
 * Translate a requested effort into one the model actually accepts.
 *
 * An accepted value passes through untouched. Anything else moves to the
 * nearest supported level, choosing the CHEAPER direction on a tie.
 *
 * The tie-break is a cost decision, not cosmetics: a caller asking for `low` on
 * a DeepSeek model (which accepts only `none|high|max`) is one step from both
 * `none` and `high`, and rounding UP spends real reasoning tokens on a level the
 * caller did not ask for. Rounded down, the request is cheaper and still close.
 * Ties compare rank on {@link EFFORT_LADDER}, which orders the vocabulary from
 * least to most expensive.
 *
 * @returns an accepted effort, or undefined when the model has none.
 */
export function translateEffort(model: string, requested: string | undefined): string | undefined {
  const facts = modelFacts(model)
  if (facts.efforts.length === 0) return undefined
  if (requested === undefined) return facts.defaultEffort
  const wanted = canonicalEffort(requested)
  if (facts.efforts.includes(wanted)) return wanted
  const targetRank = EFFORT_LADDER.indexOf(wanted)
  if (targetRank < 0) return facts.defaultEffort
  let best: { effort: string; distance: number; rank: number } | undefined
  for (const effort of facts.efforts) {
    const rank = EFFORT_LADDER.indexOf(effort)
    if (rank < 0) continue
    const distance = Math.abs(rank - targetRank)
    if (
      best === undefined
      || distance < best.distance
      // Tie-break downward: `high` over `max` for a `medium` request.
      || (distance === best.distance && rank < best.rank)
    ) {
      best = { effort, distance, rank }
    }
  }
  return best?.effort ?? facts.defaultEffort
}

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
export function clampCeiling(offered: number, ceiling: number | undefined): number {
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return offered
  return Math.min(Math.floor(ceiling), offered)
}

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
export function configuredEffort(
  model: string,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  const wanted = overrideFor(model, overrides)
  if (wanted === undefined) return undefined
  // `auto` (and an empty string from a cleared form field) means "the provider's
  // own default", which is exactly what leaving it absent already does.
  if (wanted === '' || wanted === 'auto') return undefined
  const facts = modelFacts(model)
  if (facts.efforts.length === 0) {
    throw new RangeError(
      `${model} has no reasoning support, but defaultReasoningEffort sets "${wanted}".`,
    )
  }
  if (!facts.efforts.includes(wanted)) {
    throw new RangeError(
      `${model} accepts only ${facts.efforts.join('|')} for reasoning_effort, not "${wanted}".`,
    )
  }
  return wanted
}

/**
 * Look one model up in an override map, accepting a glob on the model id.
 *
 * An exact id wins over a pattern, so a specific pin cannot be shadowed by a
 * family wildcard. Patterns are matched segment-wise (`*` and `?`), which is
 * how a model id is spelled: `zai-org/GLM-*` names one family without also
 * matching an unrelated id that merely contains the text.
 */
function overrideFor(
  model: string,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (overrides === undefined) return undefined
  const exact = overrides[model]
  if (exact !== undefined) return exact
  for (const [pattern, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    if (pattern.includes('*') || pattern.includes('?')) {
      if (matchesPattern(model, pattern)) return value
      continue
    }
  }
  return undefined
}

/** Segment-wise glob match, where `*` and `?` never cross a `/`. */
function matchesPattern(model: string, pattern: string): boolean {
  const regex = pattern
    .split('/')
    .map((segment) => segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))
    .join('/')
  return new RegExp(`^${regex}$`).test(model)
}

/**
 * The cheapest effort a model accepts.
 *
 * Used for machine-shaped calls (session titles, compaction) where reasoning
 * would be paid for and never read. A model with no `none` (GLM) gets its
 * lowest level instead of an invalid `none`.
 */
export function titleEffort(model: string): string | undefined {
  const facts = modelFacts(model)
  if (facts.efforts.length === 0) return undefined
  if (facts.efforts.includes('none')) return 'none'
  return facts.efforts[0]
}

/** Whether the model accepts images. */
export function modelSupportsVision(model: string): boolean {
  return modelFacts(model).vision
}

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
export function contextWindowFor(model: string, ceiling: number | undefined): number {
  return clampCeiling(modelFacts(model).contextWindow, ceiling)
}

/**
 * The output budget to report and request for one model.
 *
 * `min(configured, model)` and never above the model: this value becomes the
 * request's `max_tokens`, and river rejects an over-large one with a 400. It is
 * also the harness's `reservedCompletionTokens` during compaction, which is why
 * the reported context window must stay above it — see the settings docs.
 */
export function outputBudgetFor(model: string, ceiling: number | undefined): number {
  return clampCeiling(modelFacts(model).maxOutputTokens, ceiling)
}
