/**
 * Image resolution for river requests.
 *
 * river accepts images as base64 `data:` URLs inside a message's content parts,
 * and only as JPEG or PNG. Two consequences drive this module:
 *
 *  1. Re-encoding is expensive — a 1568px screenshot becomes roughly a
 *     megabyte of base64 — so the read goes through the attachment store's
 *     cached `request` variant instead of encoding the original each turn.
 *  2. A format river cannot take (webp, gif) must not take the whole turn down.
 *     `wire.ts` degrades such a block to a text handle naming the file.
 *
 * The store is fetched from the plugin context rather than handed in through
 * `GenerateOptions`: the harness's request type carries no attachment slot, so
 * the adapter resolves the live store once per attempt. That also means a turn
 * whose profile has no attachment service degrades every image to text instead
 * of failing.
 *
 * @module dsh-river-provider/images
 */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireImageResolver } from './wire.ts'
import { isRiverImageType, REQUEST_IMAGE_MAX_ENCODED_BYTES, REQUEST_IMAGE_MAX_LONG_EDGE, requestImageTarget } from './image-request.ts'

/**
 * Resolves images through the mounted attachment store.
 *
 * The store is per-profile and stable for the plugin's lifetime, so binding it
 * once at registration is enough; `bind` exists for the context-first form the
 * adapter uses when the store appears after the plugin loaded.
 */
export class AttachmentImageResolver implements WireImageResolver {
  private store: AttachmentStore | undefined
  private mapHostPath: (hostPath: string) => string | undefined

  constructor(mapHostPath: (hostPath: string) => string | undefined = () => undefined) {
    this.mapHostPath = mapHostPath
  }

  /** Bind the profile's attachment store (idempotent; latest binding wins). */
  bind(store: unknown): void {
    this.store = store as AttachmentStore | undefined
  }

  /**
   * Read the request variant of one image, honouring river's limits.
   *
   * The byte ceiling is enforced by the store's encoder ladder: asking for a
   * target makes it produce the smallest variant that fits, and a variant that
   * still overflows is refused by `assertBodySize` at serialization rather than
   * silently truncating an image the model was told about.
   */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<RequestImageAttachment> {
    const store = this.store
    if (store === undefined) {
      throw new Error('No attachment store is available for this river.ai request.')
    }
    if (!isRiverImageType(ref.mediaType)) {
      // The caller degrades this to text; throwing here would abort the turn
      // over an attachment the model simply cannot see.
      throw new UnsupportedImageFormat(ref)
    }
    return store.readImageRequest(ref, requestImageTarget(ref), signal)
  }

  /**
   * Resolve a tool-readable path for one image, when the backend has one.
   *
   * river has no path-based image reference — content parts carry bytes only —
   * so a block that falls back to text still names the file the model could ask
   * a tool to open.
   */
  accessPath(ref: ImageAttachmentRef): { readonlyPath: string } | undefined {
    const store = this.store
    if (store === undefined) return undefined
    const hostPath = store.imageHostPath(ref)
    if (hostPath === undefined) return undefined
    const readonlyPath = this.mapHostPath(hostPath)
    return readonlyPath === undefined ? undefined : { readonlyPath }
  }
}

/** Raised for a format river cannot accept; `wire.ts` turns it into text. */
export class UnsupportedImageFormat extends Error {
  readonly ref: ImageAttachmentRef
  constructor(ref: ImageAttachmentRef) {
    super(`river.ai accepts JPEG and PNG only; ${ref.mediaType} needs conversion.`)
    this.ref = ref
    this.name = 'UnsupportedImageFormat'
  }
}

export { REQUEST_IMAGE_MAX_LONG_EDGE, REQUEST_IMAGE_MAX_ENCODED_BYTES }
