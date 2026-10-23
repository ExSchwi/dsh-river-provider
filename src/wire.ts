/**
 * Building river's chat-completions request body.
 *
 * This module is pure: it takes harness request state and returns the JSON body.
 * Keeping it separate is what makes the wire protocol testable without a server
 * — the tests assert on the body river will actually receive, including the
 * cases the upstream plugin got wrong:
 *
 *  - `reasoning_effort` is per-model, and DeepSeek has no `low`. An unknown
 *    effort is snapped to the nearest accepted one instead of being forwarded
 *    verbatim (river answers 400 for an out-of-whitelist value), and `off` is
 *    sent by OMITTING the field rather than as a literal enum member.
 *  - Cached prompt tokens are reported separately by river, so the harness's
 *    `inputTokens` must be `prompt_tokens - cached`; that happens on the way
 *    back, in `stream-decoder.ts`.
 *  - Images are limited to JPEG/PNG. Other formats are re-encoded by the
 *    attachment layer, and a format it cannot encode degrades to a text handle
 *    instead of failing the turn.
 *
 * @module dsh-river-provider/wire
 */

import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { fileHandleText, offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { bilingual, isOutputLimitDetail } from './provider-errors.ts'
import { wireEffort } from './capabilities.ts'
import { isRecord } from './wire-guards.ts'

/** river's documented request-body ceiling, including base64 image payloads. */
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024

/**
 * Image request target for river.
 *
 * 1568 is the long edge above which vision encoders in this model family stop
 * gaining accuracy, and 1 MiB keeps a single request well under the 50 MiB body
 * limit even with a full history of images carrying base64 (~4/3 expansion).
 */
export const REQUEST_IMAGE_MAX_LONG_EDGE = 1568
export const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1024 * 1024

/** What the body builder needs from the plugin to resolve images. */
export interface WireImageResolver {
  /** Read the request variant of one image, honouring the target. */
  readImage: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>
  /** Resolve a tool-readable path for one image, when the backend has one. */
  accessPath: (ref: ImageAttachmentRef) => { readonlyPath: string } | undefined
  /** Bind this request's attachment source; absent for a resolver-free turn. */
  bind?: ((access: unknown) => void) | undefined
}

/** Input to {@link buildRequest}. */
export interface RequestInput {
  model: string
  messages: GenerateOptions['messages']
  system?: string | undefined
  tools: readonly ToolSchema[] | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
  topP?: number | undefined
  stop?: readonly string[] | undefined
  reasoningEffort?: string | undefined
  /** Resolves images; when absent, images degrade to text handles. */
  images?: WireImageResolver | undefined
}

/** river's `content` part for one image. */
interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** Any wire content part. */
type WirePart = { type: 'text'; text: string } | ImagePart

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WirePart[]
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  name?: string
}

/** The JSON body river receives. */
export interface ChatCompletionsBody {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  [key: string]: unknown
}

/**
 * Build the request body.
 *
 * Async because image variants are produced on demand; a text-only turn never
 * touches the attachment layer.
 */
export async function buildRequest(input: RequestInput): Promise<ChatCompletionsBody> {
  // The store is bound at registration; a turn whose profile has no attachment
  // service simply carries no resolver and every image degrades to text.
  const messages: WireMessage[] = []
  if (input.system !== undefined && input.system !== '') {
    messages.push({ role: 'system', content: input.system })
  }
  for (const message of input.messages) {
    const converted = await convertMessage(message, input.images)
    if (converted !== undefined) messages.push(converted)
  }

  const body: ChatCompletionsBody = {
    model: input.model,
    messages,
    // `stream_options.include_usage` is what makes river emit the final usage
    // frame; without it the harness records every call as zero tokens and the
    // cost badge and per-account spend are both wrong.
    stream: true,
    stream_options: { include_usage: true },
  }
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens
  if (input.temperature !== undefined) body.temperature = input.temperature
  if (input.topP !== undefined) body.top_p = input.topP
  if (input.stop !== undefined && input.stop.length > 0) body.stop = [...input.stop]

  // `off` carries no wire value at all: the field is omitted, which river reads
  // as "do not reason" on every route. Sending the literal `none` instead would
  // be a model-specific enum member, and a gateway in front may reject it.
  const effort = wireEffort(input.model, input.reasoningEffort)
  if (effort !== undefined) body.reasoning_effort = effort

  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

/** Convert one harness message into zero or one wire messages. */
async function convertMessage(
  message: RequestInput['messages'][number],
  images: WireImageResolver | undefined,
): Promise<WireMessage | undefined> {
  const role = message.role
  if (role === 'tool') {
    const text = plainText(message.content)
    const wire: WireMessage = { role: 'tool', content: text, tool_call_id: String(message.toolCallId) }
    if (message.isError === true) {
      // river has no tool-error flag; the error text is what the model reads,
      // and `content` cannot be empty or the message is rejected.
      wire.content = text === '' ? '(tool failed with no output)' : `[tool error] ${text}`
    }
    return wire
  }

  if (role === 'assistant') {
    const text = plainText(message.content)
    const calls = message.content.filter((block) => block.type === 'tool-call')
    const wire: WireMessage = { role: 'assistant', content: text }
    if (calls.length > 0) {
      wire.tool_calls = calls.map((block) => {
        const call = block as Extract<ContentBlock, { type: 'tool-call' }>
        return {
          id: String(call.id),
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
        }
      })
      // A tool-call-only assistant turn must not carry `content: ''`; river
      // echoes null there, and some gateways reject an empty string on replay.
      if (text === '') delete (wire as { content?: unknown }).content
    }
    // Reasoning is never replayed: river accepts `reasoning_content` only on
    // responses, and resending it would bill the same tokens twice while
    // confusing the model's chain of thought.
    return wire
  }

  const parts = await convertParts(message.content, images)
  const wire: WireMessage = { role: role === 'developer' ? 'system' : role, content: singleText(parts) ?? parts }
  return wire
}

/**
 * Convert content blocks into wire parts.
 *
 * Text blocks merge into one part per run; images become `image_url` data URLs.
 * Ordering is preserved because a model reading "the error above" needs the
 * same sequence the user typed.
 */
async function convertParts(
  content: readonly ContentBlock[],
  images: WireImageResolver | undefined,
): Promise<WirePart[]> {
  const parts: WirePart[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        if (block.text !== '') parts.push({ type: 'text', text: block.text })
        break
      }
      case 'reasoning': {
        // See convertMessage: reasoning is not replayed.
        break
      }
      case 'image': {
        const ref = block.attachment
        if (block.offloaded === true) {
          parts.push({ type: 'text', text: offloadedImageText(ref, images?.accessPath(ref)) })
          break
        }
        if (images === undefined) {
          parts.push({ type: 'text', text: textOnlyImageText(ref) })
          break
        }
        try {
          const version = await images.readImage(ref)
          parts.push({ type: 'text', text: requestImageHandleText(ref, version, images.accessPath(ref)) })
          parts.push({ type: 'image_url', image_url: { url: dataUrl(version) } })
        } catch {
          // A decode failure must not destroy the turn: the model still sees
          // the reference and can ask for the bytes through a tool.
          parts.push({ type: 'text', text: textOnlyImageText(ref) })
        }
        break
      }
      case 'file': {
        parts.push({ type: 'text', text: fileHandleText(block.attachment, undefined) })
        break
      }
      case 'tool-call':
      case 'tool-addition':
      case 'tool-removal': {
        // History markers, not content.
        break
      }
      default: {
        break
      }
    }
  }
  return parts
}

/** Collapse a part list to a plain string when it is text-only. */
function singleText(parts: readonly WirePart[]): string | undefined {
  if (parts.length === 0) return undefined
  if (parts.length === 1) {
    const only = parts[0]
    return only !== undefined && only.type === 'text' ? only.text : undefined
  }
  return undefined
}

/** Concatenate the text blocks of one message. */
function plainText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Build the data URL river accepts for an inline image. */
function dataUrl(image: RequestImageAttachment): string {
  const base64 = Buffer.from(image.data).toString('base64')
  return `data:${image.mediaType};base64,${base64}`
}

/**
 * Reject a body that river would refuse with 413.
 *
 * Failing locally yields a precise message naming the limit; failing remotely
 * yields an opaque 413 after uploading 50 MiB.
 */
export function assertBodySize(bytes: number): void {
  if (bytes <= MAX_REQUEST_BYTES) return
  throw bilingual(
    'IMAGE_OFFLOAD_REQUIRED',
    `The request is ${(bytes / 1024 / 1024).toFixed(1)} MiB, over river.ai's 50 MiB limit. Offload older images and retry.`,
    `请求体积 ${(bytes / 1024 / 1024).toFixed(1)} MiB，超过 river.ai 的 50 MiB 上限。请卸下较早的图片后重试。`,
    { offloadImages: 1 },
  )
}

/**
 * True when a rejection names `max_tokens`, so the caller can retry with the
 * model's own ceiling instead of failing the turn.
 */
export function isMaxTokensRejection(detail: string): boolean {
  return isOutputLimitDetail(detail) && /max_tokens|max output/i.test(detail)
}

/** Narrow a decoded JSON value to a record. */
export { isRecord }
