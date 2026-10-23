/**
 * The river.ai adapter.
 *
 * The adapter owns one HTTP attempt's worth of protocol: it builds the body,
 * streams it, and maps river's wire vocabulary onto the harness's `StreamChunk`
 * vocabulary. Account selection and rotation happen ABOVE it, injected through
 * `resolveApiKey` / `markRejected`, so the adapter stays a function of
 * (options, key) and is testable without a server.
 *
 * Model facts come from `GET {apiBase}/models` when the catalog is reachable;
 * the static snapshot in `capabilities.ts` is the fallback. That split is
 * deliberate — a new river release becomes usable without a plugin upgrade, and
 * a catalog outage never breaks a turn.
 *
 * @module dsh-river-provider/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  type GenerateOptions,
  type LlmFailure,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  contextWindowFor,
  displayName,
  KNOWN_MODELS,
  modelFacts,
  outputBudgetFor,
  reasoningEffortsFor,
  titleEffort,
} from './capabilities.ts'
import { MAX_ACCOUNT_ROTATIONS, RETRY_MAX_DELAY_MS, type AccountRejection } from './accounts.ts'
import { type RiverPriceBook } from './model-prices.ts'
import {
  bilingual,
  isAccountScopedFailure,
  RATE_LIMIT_CODE,
  responseError,
  SERVER_CODE,
  THROTTLED_CODE,
  TIMEOUT_CODE,
  TRANSPORT_CODE,
} from './provider-errors.ts'
import { SseDecoder } from './sse.ts'
import { StreamDecoder, mapUsage } from './stream-decoder.ts'
import { ownedResponseStream } from './stream-response.ts'
import { assertBodySize, buildRequest, type WireImageResolver } from './wire.ts'

/**
 * The fixed provider id this plugin registers.
 *
 * Not `riverai`: that id already belongs to the pi-ai row in the stock profile,
 * and two plugins claiming one id makes the model picker and the default-model
 * pointer ambiguous about which implementation a request runs through.
 */
export const PROVIDER = 'river'

/** Default API base; every request path hangs off it. */
export const DEFAULT_API_BASE = 'https://api.river.ai/v1'

/**
 * Timeouts, matching river's documented ceilings.
 *
 * river documents prefill at 10 minutes and a non-streaming response at 15, so
 * the whole-request budget is 15 and the silence budget is 10: a stream that
 * goes quiet for longer than the prefill window is dead even though the socket
 * may still be open.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60_000

/** How long a `GET /models` result is trusted. */
export const CATALOG_TTL_MS = 15 * 60_000

/** One attempt's resolved connection settings. */
export interface RiverConnection {
  apiBase: string
  requestTimeoutMs: number
  streamIdleTimeoutMs: number
  /** A user-pinned `max_tokens` ceiling, or absent for "per model". */
  maxOutputTokens?: number
  /** A user-pinned advertised context window, or absent for "the model's own". */
  contextWindowLimit?: number
}

/** What the adapter needs from the plugin. */
export interface RiverAdapterDeps {
  /** The frozen connection settings for this call. */
  connection: () => RiverConnection
  /** Reserve a key for this attempt. */
  resolveApiKey: (model: string) => Promise<{ key: string; accountId: string }>
  /** Record a rejection so the next attempt picks another account. */
  markRejected: (key: string, rejection: AccountRejection, resetAtMs?: number) => void
  /** Record success, clearing a stale cooldown. */
  markHealthy: (key: string) => void
  /** Live pricing, used for the harness's cost display. */
  prices: RiverPriceBook
  /** Image variants, resolved per request. */
  images: WireImageResolver
  /** Whether a model should appear in the picker. */
  isVisible: (model: string) => boolean
  /**
   * The configured default reasoning effort for one model, already translated
   * to a value the model accepts.
   *
   * Consulted only when the caller omits an effort; absent leaves the model's
   * own default, which is the honest behaviour for a model nobody configured.
   */
  defaultEffort?: ((model: string) => string | undefined) | undefined
  /** Optional diagnostic log. */
  log?: ((message: string) => void) | undefined
}

/** One catalog entry as river's `GET /models` reports it. */
interface CatalogModel {
  id: string
  name?: string
  description?: string
  vision?: boolean
}

/** A cached catalog snapshot. */
interface Catalog {
  at: number
  models: readonly CatalogModel[]
}

/**
 * The river.ai adapter.
 *
 * `stream()` performs exactly one HTTP attempt. Retries and rotation above the
 * request lifetime are the harness's job; the only state this class keeps is
 * the model catalog.
 */
export class RiverAdapter extends LlmAdapter {
  private catalog: Catalog | undefined
  private catalogInFlight: Promise<void> | undefined

  constructor(private readonly deps: RiverAdapterDeps) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'river.ai' }
  }

  /**
   * Retry policy: many attempts, long ceiling.
   *
   * `maxDelayMs` MUST equal {@link RETRY_MAX_DELAY_MS}: a `providerRetryAfterMs`
   * longer than the ceiling is discarded by the retry layer, which would turn a
   * well-behaved `Retry-After: 600` into a hammering loop.
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    void provider
    return {
      mode: 'normal',
      maxRetries: MAX_ACCOUNT_ROTATIONS * 4,
      retryableCodes: [
        RATE_LIMIT_CODE,
        THROTTLED_CODE,
        SERVER_CODE,
        TIMEOUT_CODE,
        TRANSPORT_CODE,
        'EMPTY_RESPONSE',
      ],
      // A long-horizon window (an account out of credit until a reset) is
      // waited out by the retry engine, so the ceiling must be large enough to
      // carry a `providerRetryAfterMs` an account reports.
      initialDelayMs: 500,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      jitterRatio: 0.1,
    }
  }

  /** Every model this provider can serve. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    void provider
    await this.refreshCatalog()
    const catalog = this.catalog?.models ?? []
    const ids = catalog.length === 0
      // An unreachable catalog (no key yet, or an outage) must not leave the
      // picker empty: the snapshot is what a fresh install shows.
      ? Object.keys(KNOWN_MODELS)
      : catalog.map((entry) => entry.id)
    return ids.filter((id) => this.deps.isVisible(id)).map((id) => this.describe(id, catalog))
  }

  /** Resolve one model id, falling back to the static snapshot. */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    void provider
    await this.refreshCatalog(signal)
    const facts = modelFacts(model)
    const connection = this.deps.connection()
    const resolved: LlmResolvedModelInfo = {
      provider: PROVIDER,
      id: model,
      name: displayName(model),
      context: { contextWindow: contextWindowFor(model, connection.contextWindowLimit) },
      defaultMaxTokens: this.outputCeiling(model),
      // The harness re-sends tool definitions when the set narrows; river keeps
      // one tool block per request, so history carries additions only.
      toolUpdate: 'addition-only',
    }
    const efforts = reasoningEffortsFor(model)
    if (efforts.length > 0) {
      // The configured default is resolved HERE rather than by rewriting each
      // request: `resolveCallWithInfo` materializes `defaultEffort` into any call
      // that omits one, and the harness then records the effective effort in the
      // request header, so the choice survives across turns without the adapter
      // second-guessing a caller that already decided.
      const configured = this.deps.defaultEffort?.(model) ?? facts.defaultEffort
      const defaultEffort = configured === undefined
        ? undefined
        : ReasoningEffortId(configured)
      resolved.reasoning = defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
    }
    return resolved
  }

  /**
   * One HTTP attempt.
   *
   * The connection is frozen at CALL time, not at construction: a settings edit
   * during a turn must not change the base URL halfway through an attempt.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection: RiverConnection = Object.freeze({ ...this.deps.connection() })
    return ownedResponseStream(options.signal, (signal) => this.runAttempt(options, connection, signal))
  }

  /**
   * Pick an account, translating pool exhaustion into a retry-aware error.
   *
   * The pool already knows how long the soonest account stays cooling down, but
   * it reports that as `retryAfterMs` on its own error type. Letting that escape
   * unwrapped loses the number: `dsh-llm-retry` only honours a wait it can read
   * off `providerRetryAfterMs`, so the harness would fall back to its generic
   * backoff and give up long before an account actually frees up.
   */
  private async resolveAccount(model: string): Promise<{ key: string; accountId: string }> {
    try {
      return await this.deps.resolveApiKey(model)
    } catch (error) {
      const wait = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
      if (typeof wait !== 'number' || !Number.isFinite(wait) || wait <= 0) throw error
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: unknown }).code
      throw new LlmError(message, typeof code === 'string' ? code : 'RATE_LIMIT', {
        providerRetryAfterMs: wait,
      })
    }
  }

  /** Run the request and stream its chunks. */
  private async *runAttempt(
    options: GenerateOptions,
    connection: RiverConnection,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const account = await this.resolveAccount(options.model)
    const maxTokens = this.requestMaxTokens(options)
    const body = await buildRequest({
      model: options.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      maxTokens,
      temperature: options.temperature,
      stop: options.stop,
      reasoningEffort: options.purpose === 'session-title'
        // A title is three words: reasoning there is paid for and never read.
        ? (titleEffort(options.model) ?? options.reasoningEffort)
        : options.reasoningEffort,
      images: this.deps.images,
    })
    const serialized = JSON.stringify(body)
    assertBodySize(Buffer.byteLength(serialized, 'utf8'))

    const url = `${trimSlash(connection.apiBase)}/chat/completions`
    // One controller per attempt. The caller's signal aborts it, and so do the
    // request and idle timers — a `fetch` left running past either budget would
    // hold the turn open after the harness has given up on it.
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const requestTimer = setTimeout(
      () => controller.abort(bilingual(TIMEOUT_CODE, 'river.ai request timed out.', 'river.ai 请求超时。')),
      connection.requestTimeoutMs,
    )

    let idleTimer: NodeJS.Timeout | undefined
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => controller.abort(bilingual(TIMEOUT_CODE, 'river.ai stopped sending data.', 'river.ai 停止发送数据了。')),
        connection.streamIdleTimeoutMs,
      )
    }
    const stopTimers = (): void => {
      clearTimeout(requestTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = undefined
      signal.removeEventListener('abort', onAbort)
    }

    let response: Response
    try {
      armIdle()
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          authorization: `Bearer ${account.key}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: serialized,
        signal: controller.signal,
      })
    } catch (error) {
      stopTimers()
      throw this.transportError(error, signal)
    }

    try {
      if (!response.ok) {
        const payload = await readJsonSafe(response)
        this.rejectFromStatus(response.status, payload, account.key)
        throw responseError(
          response.status,
          payload,
          response.headers.get('x-request-id') ?? undefined,
          response.headers.get('retry-after') ?? undefined,
        )
      }

      // A 200 carrying JSON instead of a stream means river (or an
      // intermediary) chose the non-streaming path; parse it rather than
      // waiting for SSE frames that will never come.
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        yield* this.nonStreamingChunks(await readJsonSafe(response))
      } else {
        yield* this.streamChunks(response, maxTokens, account.key, armIdle)
      }
      this.deps.markHealthy(account.key)
    } finally {
      stopTimers()
    }
  }

  /** Decode the SSE body into harness chunks. */
  private async *streamChunks(
    response: Response,
    maxTokens: number | undefined,
    key: string,
    armIdle: () => void,
  ): AsyncGenerator<StreamChunk> {
    const body = response.body
    if (body === null) {
      throw bilingual('EMPTY_RESPONSE', 'river.ai returned no body.', 'river.ai 没有返回任何响应体。')
    }
    const reader = body.getReader()
    const text = new TextDecoder()
    const sse = new SseDecoder()
    const decoder = new StreamDecoder(maxTokens)
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        armIdle()
        for (const event of sse.push(text.decode(step.value, { stream: true }))) {
          if (event.data === '[DONE]') {
            yield* decoder.finish()
            return
          }
          yield* this.guard(key, () => decoder.accept(event.data))
          if (decoder.done) return
        }
      }
      for (const event of sse.flush()) {
        if (event.data === '[DONE]') break
        yield* this.guard(key, () => decoder.accept(event.data))
        if (decoder.done) return
      }
      // The socket closed without a terminal frame. A partial answer is still an
      // answer; `finish()` decides whether the turn is usable.
      if (!decoder.done) yield* this.guard(key, () => decoder.finish())
    } catch (error) {
      this.reclassifyThrow(error, key)
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  /** Run a decoder step, classifying an account-scoped failure on the way out. */
  private *guard(key: string, step: () => Generator<StreamChunk>): Generator<StreamChunk> {
    try {
      yield* step()
    } catch (error) {
      this.reclassifyThrow(error, key)
      throw error
    }
  }

  /**
   * Accept a non-streamed completion.
   *
   * Some proxies strip `stream: true`; parsing the JSON body keeps the turn
   * working instead of surfacing "no frames received".
   */
  private *nonStreamingChunks(payload: unknown): Generator<StreamChunk> {
    const completion = asRecord(payload)
    const choices = completion?.choices
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
    const message = choice === undefined ? undefined : asRecord(choice.message)
    if (message === undefined) {
      throw bilingual('EMPTY_RESPONSE', 'river.ai returned no message.', 'river.ai 没有返回任何消息。')
    }
    let index = 0
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (reasoning !== '') {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: reasoning }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
      index += 1
    }
    const content = typeof message.content === 'string' ? message.content : ''
    if (content !== '') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: content }
      yield { type: 'block-end', index, block: { type: 'text', text: content } }
      index += 1
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    for (const raw of calls) {
      const call = asRecord(raw)
      if (call === undefined) continue
      const fn = asRecord(call.function)
      const id = typeof call.id === 'string' ? call.id : `call_river_${index}`
      const name = typeof fn?.name === 'string' ? fn.name : ''
      const args = typeof fn?.arguments === 'string' && fn.arguments !== '' ? fn.arguments : '{}'
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: id as never, name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: id as never, name, arguments: args } }
      index += 1
    }
    const usage = asRecord(completion?.usage)
    if (usage !== undefined) yield { type: 'usage', usage: mapUsage(usage) }
    const finishReason = choice === undefined ? undefined : choice.finish_reason
    const kind = calls.length > 0
      ? 'tool-calls'
      : finishReason === 'length' || finishReason === 'max_tokens'
        ? 'max-tokens'
        : 'stop'
    yield { type: 'finish', reason: { kind } }
  }

  /** `max_tokens` for this call: the caller's budget, capped by the model. */
  private requestMaxTokens(options: GenerateOptions): number | undefined {
    const ceiling = this.outputCeiling(options.model)
    if (options.maxTokens === undefined) return ceiling
    return Math.min(options.maxTokens, ceiling)
  }

  /** The model's own ceiling, or the configured override when lower. */
  private outputCeiling(model: string): number {
    return outputBudgetFor(model, this.deps.connection().maxOutputTokens)
  }

  /** Build the detached metadata for one model id. */
  private describe(id: string, catalog: readonly CatalogModel[]): LlmModelInfo {
    const entry = catalog.find((candidate) => candidate.id === id)
    const facts = modelFacts(id)
    const vision = entry?.vision ?? facts.vision
    const info: LlmModelInfo = {
      provider: PROVIDER,
      id,
      name: entry?.name ?? displayName(id),
      inputModalities: vision ? ['text', 'image'] : ['text'],
    }
    const description = entry?.description ?? catalogDescription(id)
    if (description !== undefined) info.description = description
    return info
  }

  /**
   * Refresh the model catalog, at most once per {@link CATALOG_TTL_MS}.
   *
   * Failure is silent by design: the snapshot answers, so a catalog outage must
   * never become a failed turn.
   */
  private refreshCatalog(signal?: AbortSignal): Promise<void> {
    if (this.catalog !== undefined && Date.now() - this.catalog.at < CATALOG_TTL_MS) return Promise.resolve()
    if (this.catalogInFlight !== undefined) return this.catalogInFlight
    this.catalogInFlight = (async () => {
      try {
        const connection = this.deps.connection()
        const account = await this.deps.resolveApiKey('')
        const response = await fetch(`${trimSlash(connection.apiBase)}/models`, {
          headers: { ...attributionHeaders(), authorization: `Bearer ${account.key}` },
          ...(signal === undefined ? {} : { signal }),
        })
        if (!response.ok) return
        const list = asRecord(await response.json())?.data
        if (!Array.isArray(list)) return
        const models: CatalogModel[] = []
        for (const raw of list) {
          const entry = asRecord(raw)
          const id = entry?.id
          if (typeof id !== 'string') continue
          // `GET /v1/models` returns only `id`, `object` and `owned_by` — no
          // context window, no output ceiling, no input modalities. Limits and
          // vision therefore come from the doc-maintained snapshot and cannot
          // be read from here; anything else would be dead code pretending to
          // track the server.
          const model: CatalogModel = { id }
          if (typeof entry?.name === 'string') model.name = entry.name
          if (typeof entry?.description === 'string') model.description = entry.description
          models.push(model)
        }
        if (models.length > 0) this.catalog = { at: Date.now(), models }
      } catch {
        // Snapshot fallback; see the method contract.
      } finally {
        this.catalogInFlight = undefined
      }
    })()
    return this.catalogInFlight
  }

  /** Record an account-scoped rejection learned from an HTTP status. */
  private rejectFromStatus(status: number, payload: unknown, key: string): void {
    if (status === 429 || status === 503) this.deps.markRejected(key, 'throttled', findRetryAfter(payload))
    else if (status === 401 || status === 403) this.deps.markRejected(key, 'invalid-credential')
    else if (status === 402) this.deps.markRejected(key, 'rate-limit', findRetryAfter(payload))
  }

  /** Mark an error's key when the error is account-scoped. */
  private reclassifyThrow(error: unknown, key: string): void {
    const failure = (error as { failure?: LlmFailure }).failure
    if (failure === undefined || !isAccountScopedFailure(failure)) return
    const resetAt = failure.providerRetryAfterMs === undefined
      ? undefined
      : Date.now() + failure.providerRetryAfterMs
    if (failure.code === 'INVALID_CREDENTIAL') this.deps.markRejected(key, 'invalid-credential')
    else if (failure.code === 'QUOTA') this.deps.markRejected(key, 'rate-limit', resetAt)
    else this.deps.markRejected(key, 'throttled', resetAt)
  }

  /** Wrap a fetch throw into a classified `LlmError`. */
  private transportError(error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) {
      return bilingual('ABORTED', 'The river.ai request was aborted.', 'river.ai 请求已中止。')
    }
    // A classified error thrown by a timer is already the right error.
    if (error instanceof LlmErrorCarrier) return error.cause as Error
    const failure = (error as { failure?: LlmFailure }).failure
    if (failure !== undefined) return error as Error
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError') {
      return bilingual(TIMEOUT_CODE, 'river.ai stopped responding.', 'river.ai 停止响应了。')
    }
    const message = error instanceof Error ? error.message : String(error)
    return bilingual(
      TRANSPORT_CODE,
      `Could not reach river.ai: ${message}`,
      `无法连接 river.ai：${message}`,
    )
  }
}

/** Marker so a classified error surfacing through `fetch` keeps its identity. */
class LlmErrorCarrier extends Error {
  override readonly cause: Error
  constructor(cause: Error) {
    super(cause.message)
    this.cause = cause
  }
}

/** Model blurbs shown in the picker when the catalog is silent. */
function catalogDescription(id: string): string | undefined {
  const facts = modelFacts(id)
  if (facts.price.input === 0) return undefined
  return `$${facts.price.input}/M in · $${facts.price.output}/M out · ${Math.round(facts.contextWindow / 1024)}K context`
}

/** Strip a trailing slash from a base URL. */
function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read a JSON body without throwing on a non-JSON or empty payload. */
async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Find a `Retry-After` inside a JSON error body, as epoch ms. */
function findRetryAfter(payload: unknown): number | undefined {
  const record = asRecord(payload)
  const error = asRecord(record?.error)
  for (const source of [record, error]) {
    if (source === undefined) continue
    const ms = source.retry_after_ms
    if (typeof ms === 'number' && Number.isFinite(ms)) return Date.now() + ms
    const seconds = source.retry_after
    if (typeof seconds === 'number' && Number.isFinite(seconds)) return Date.now() + seconds * 1000
  }
  return undefined
}
