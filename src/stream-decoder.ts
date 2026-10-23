/**
 * Mapping river's stream vocabulary onto the harness's.
 *
 * One class turns the decoded SSE payloads of a single attempt into
 * `StreamChunk`s. It exists (rather than free functions) because streaming
 * tool calls are stateful across frames: river sends `delta.tool_calls[i]` with
 * a `name` on the first frame and `arguments` fragments afterwards, and the
 * harness needs one `block-start` / `tool-call-delta`* / `block-end` triple per
 * call. Getting that wrong is the classic failure where the second tool call of
 * a turn is dropped or merged into the first.
 *
 * Reasoning is emitted as its OWN block. river puts it in `reasoning_content`;
 * it is billed as output, so it must be surfaced (the user paid for it) but
 * must never be replayed on the next request.
 *
 * @module dsh-river-provider/stream-decoder
 */

import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { bilingual, isContextOverflowDetail, isOutputLimitDetail, streamErrorToLlmError } from './provider-errors.ts'
import { isRecord, numberValue, stringValue } from './wire-guards.ts'

/** One accumulating tool call. */
interface ToolCallState {
  index: number
  id: string
  name: string
  arguments: string
  started: boolean
  blockIndex: number
}

/**
 * Converts one attempt's decoded JSON events into harness chunks.
 *
 * `done` flips once a terminal `finish` has been produced; the caller stops
 * reading at that point, which matters because river keeps the socket open for
 * a moment after the final frame.
 */
export class StreamDecoder {
  private nextIndex = 0
  private reasoningIndex: number | undefined
  private reasoningText = ''
  private textIndex: number | undefined
  private text = ''
  private readonly calls = new Map<number, ToolCallState>()
  private usage: TokenUsage | undefined
  private usageReported = false
  private finished = false

  constructor(private readonly maxTokens: number | undefined) {}

  /** Whether a terminal `finish` chunk has been emitted. */
  get done(): boolean {
    return this.finished
  }

  /**
   * Accept one SSE payload (JSON text, or `[DONE]`).
   *
   * Order inside one frame is deliberate: usage is captured FIRST, then the
   * choice is applied. river can put `finish_reason` and `usage` in the same
   * frame, and `acceptChoice` completes the stream on the spot, so capturing
   * usage afterwards would drop it on exactly the turns that matter. Because the
   * harness allows nothing after the terminal `finish`, a usage frame that
   * arrives after completion is dropped rather than emitted late.
   *
   * Yields the chunks the payload completes. Throws a classified `LlmError` for
   * an in-band error frame so the retry layer sees the real cause.
   */
  *accept(data: string): Generator<StreamChunk> {
    if (data === '[DONE]') {
      yield* this.finish()
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      // A malformed frame is not fatal: river has been known to send partial
      // keep-alive JSON during long prefill. Ignoring it keeps the turn alive.
      return
    }
    const record = isRecord(payload) ? payload : undefined
    if (record === undefined) return
    if (record.error !== undefined && record.error !== null) {
      throw streamErrorToLlmError(record.error, stringValue(record.message))
    }

    const usage = isRecord(record.usage) ? record.usage : undefined
    if (usage !== undefined) this.usage = mapUsage(usage)

    const choices = record.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = isRecord(choices[0]) ? choices[0] : undefined
      if (choice !== undefined) yield* this.acceptChoice(choice)
    }
  }

  /**
   * Emit the captured usage exactly once.
   *
   * The harness contract is "usage before the terminal finish and nothing
   * afterward", so this is called immediately before `finish` rather than after,
   * and never twice.
   */
  private *reportUsage(): Generator<StreamChunk> {
    if (this.usage === undefined || this.usageReported) return
    this.usageReported = true
    yield { type: 'usage', usage: this.usage }
  }

  /**
   * Close out an attempt whose stream ended without a `finish_reason`.
   *
   * A dropped connection still delivered a partial answer; the harness decides
   * whether a partial answer is usable (it retries on `EMPTY_RESPONSE` only).
   */
  *finish(): Generator<StreamChunk> {
    if (this.finished) return
    const calls = [...this.calls.values()].sort((a, b) => a.index - b.index)
    const hasBody = this.text !== '' || calls.length > 0
    if (!hasBody) {
      if (this.reasoningText !== '') {
        throw bilingual(
          'EMPTY_RESPONSE',
          'river.ai spent the whole output budget on reasoning and produced no answer. Raise max_tokens.',
          'river.ai 把整份输出预算都用在了思考上，没有产出正文。请提高 max_tokens。',
        )
      }
      throw bilingual('EMPTY_RESPONSE', 'river.ai returned an empty answer.', 'river.ai 返回了空回答。')
    }
    yield* this.closeBlocks()
    yield* this.reportUsage()
    this.finished = true
    const reason: FinishReason = { kind: calls.length > 0 ? 'tool-calls' : 'stop' }
    yield { type: 'finish', reason }
  }

  /** Handle one `choices[0]` object. */
  private *acceptChoice(choice: Record<string, unknown>): Generator<StreamChunk> {
    const delta = isRecord(choice.delta) ? choice.delta : undefined
    if (delta !== undefined) {
      const reasoning = readReasoning(delta)
      if (reasoning !== undefined && reasoning !== '') {
        if (this.reasoningIndex === undefined) {
          const index = this.nextIndex++
          this.reasoningIndex = index
          yield { type: 'block-start', index, blockType: 'reasoning' }
        }
        this.reasoningText += reasoning
        yield { type: 'reasoning-delta', index: this.reasoningIndex, text: reasoning }
      }

      const content = stringValue(delta.content)
      if (content !== undefined && content !== '') {
        // Reasoning ends the moment the answer starts; the harness rejects a
        // reasoning delta after a text block has opened.
        yield* this.closeReasoning()
        if (this.textIndex === undefined) {
          const index = this.nextIndex++
          this.textIndex = index
          yield { type: 'block-start', index, blockType: 'text' }
        }
        this.text += content
        yield { type: 'text-delta', index: this.textIndex, text: content }
      }

      const toolCalls = delta.tool_calls
      if (Array.isArray(toolCalls)) yield* this.acceptToolCalls(toolCalls)
    }

    const finishReason = stringValue(choice.finish_reason)
    if (finishReason !== undefined) yield* this.complete(finishReason)
  }

  /** Accumulate and stream tool-call fragments. */
  private *acceptToolCalls(raw: readonly unknown[]): Generator<StreamChunk> {
    yield* this.closeReasoning()
    for (const entry of raw) {
      const call = isRecord(entry) ? entry : undefined
      if (call === undefined) continue
      const index = numberValue(call.index) ?? this.calls.size
      let state = this.calls.get(index)
      if (state === undefined) {
        state = { index, id: '', name: '', arguments: '', started: false, blockIndex: -1 }
        this.calls.set(index, state)
      }
      const id = stringValue(call.id)
      if (id !== undefined && id !== '') state.id = id
      const fn = isRecord(call.function) ? call.function : undefined
      const name = fn === undefined ? undefined : stringValue(fn.name)
      if (name !== undefined && name !== '') state.name = name
      const args = fn === undefined ? undefined : stringValue(fn.arguments)

      // A call cannot start until its name is known; river sends the name on
      // the first fragment, but a gateway may split the name across frames.
      if (!state.started && state.name !== '') {
        state.blockIndex = this.nextIndex++
        state.started = true
        // river normally issues an id; a gateway that splits frames may send it
        // on a later fragment, so a synthetic one keeps the block addressable
        // from the moment it opens — the id a caller receives never changes
        // afterwards because `block-end` reports the same value.
        if (state.id === '') state.id = fallbackCallId(state.index)
        yield { type: 'block-start', index: state.blockIndex, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: state.blockIndex,
          id: ToolCallId(state.id),
          name: state.name,
          argumentsDelta: '',
        }
      }
      if (args !== undefined && args !== '' && state.started) {
        state.arguments += args
        yield { type: 'tool-call-delta', index: state.blockIndex, id: ToolCallId(state.id), argumentsDelta: args }
      }
    }
  }

  /** Emit the terminal chunks for one `finish_reason`. */
  private *complete(finishReason: string): Generator<StreamChunk> {
    if (this.finished) return
    const calls = [...this.calls.values()].sort((a, b) => a.index - b.index)
    const hasBody = this.text !== '' || calls.length > 0

    if (!hasBody) {
      // The refusal cases are terminal: retrying the same budget reproduces
      // them. A plain empty answer is retryable and stays EMPTY_RESPONSE.
      if (isOutputLimitDetail(finishReason) || finishReason === 'length' || finishReason === 'max_tokens') {
        throw bilingual(
          'OUTPUT_TOKEN_LIMIT',
          `river.ai stopped at max_tokens (${this.maxTokens ?? 'model default'}) before writing an answer.`,
          `river.ai 触到 max_tokens（${this.maxTokens ?? '模型默认'}）时就停了，没有写出正文。`,
        )
      }
      if (this.reasoningText !== '') {
        throw bilingual(
          'EMPTY_RESPONSE',
          'river.ai spent the whole output budget on reasoning and produced no answer. Raise max_tokens.',
          'river.ai 把整份输出预算都用在了思考上，没有产出正文。请提高 max_tokens。',
        )
      }
      if (finishReason === 'content_filter') {
        throw bilingual(
          'CONTENT_FILTER',
          'river.ai filtered the answer (content_filter).',
          'river.ai 过滤了这次回答（content_filter）。',
        )
      }
      throw bilingual('EMPTY_RESPONSE', 'river.ai returned an empty answer.', 'river.ai 返回了空回答。')
    }

    yield* this.closeBlocks()
    yield* this.reportUsage()
    this.finished = true
    const kind = calls.length > 0
      ? 'tool-calls'
      : finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'max_output_tokens'
        ? 'max-tokens'
        : 'stop'
    yield { type: 'finish', reason: { kind } }
  }

  /** Close the reasoning block if one is open. */
  private *closeReasoning(): Generator<StreamChunk> {
    if (this.reasoningIndex === undefined) return
    const index = this.reasoningIndex
    this.reasoningIndex = undefined
    const block: ContentBlock = { type: 'reasoning', text: this.reasoningText }
    yield { type: 'block-end', index, block }
  }

  /** Close every open block: answer text, then each tool call. */
  private *closeBlocks(): Generator<StreamChunk> {
    yield* this.closeReasoning()
    if (this.textIndex !== undefined) {
      const index = this.textIndex
      this.textIndex = undefined
      yield { type: 'block-end', index, block: { type: 'text', text: this.text } }
    }
    const calls = [...this.calls.values()].sort((a, b) => a.index - b.index)
    for (const call of calls) {
      if (!call.started) continue
      yield {
        type: 'block-end',
        index: call.blockIndex,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id === '' ? fallbackCallId(call.index) : call.id),
          name: call.name,
          arguments: call.arguments === '' ? '{}' : call.arguments,
        },
      }
    }
    this.calls.clear()
  }
}

/** Read whichever reasoning field this model used. */
function readReasoning(delta: Record<string, unknown>): string | undefined {
  const direct = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content)
  if (direct !== undefined) return direct
  const details = delta.reasoning_details
  if (!Array.isArray(details)) return undefined
  const parts: string[] = []
  for (const entry of details) {
    const record = isRecord(entry) ? entry : undefined
    if (record === undefined) continue
    const text = stringValue(record.text) ?? stringValue(record.summary)
    if (text !== undefined && text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** A stable id for a tool call river never identified. */
function fallbackCallId(index: number): string {
  return `call_river_${index}`
}

/**
 * Map river's `usage` onto the harness's disjoint counts.
 *
 * river follows OpenAI: `prompt_tokens` INCLUDES cached tokens. The harness's
 * `inputTokens` is fresh input only and `totalTokens` is the sum of the parts,
 * so the cached and cache-write counts must be subtracted. Passing
 * `prompt_tokens` through unchanged inflates every cached turn, which is the
 * single most common cost-reporting bug in adapters of this shape.
 */
export function mapUsage(raw: Record<string, unknown>): TokenUsage {
  const promptTokens = numberValue(raw.prompt_tokens) ?? 0
  const completionTokens = numberValue(raw.completion_tokens) ?? 0
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const cacheRead = numberValue(details?.cached_tokens) ?? 0
  const cacheWrite = numberValue(raw.cache_creation_input_tokens) ?? 0
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined
  const reasoningTokens = numberValue(completionDetails?.reasoning_tokens) ?? 0

  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheWrite)
  const usage: TokenUsage = {
    inputTokens,
    outputTokens: completionTokens,
    totalTokens: inputTokens + cacheRead + cacheWrite + completionTokens,
  }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens
  return usage
}

/** Re-exported for tests that assert the classification, not the text. */
export { isContextOverflowDetail }
