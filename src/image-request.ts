/**
 * Assembling the request from harness messages, including images.
 *
 * river takes images as base64 `data:` URLs inside the user message, so every
 * image block has to be encoded before the body is serialised. Encoding is the
 * expensive part (a 1568px PNG becomes ~1 MB of base64), which is why the
 * harness exposes a cached request variant: {@link encodeImages} reuses the
 * attachment store's cache keyed by `variantId`, so a conversation with a
 * screenshotted page pays for the encode once, not once per turn.
 *
 * @module dsh-river-provider/image-request
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Longest edge river accepts without quality loss on a vision model. */
export const REQUEST_IMAGE_MAX_LONG_EDGE = 1568

/** Largest single encoded image, comfortably inside river's 50 MiB body cap. */
export const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1024 * 1024

/**
 * Fit an image into a bounding box, preserving aspect ratio.
 *
 * Returns the original dimensions when it already fits, so an image that needs
 * no downscale is not re-encoded (re-encoding a PNG screenshots loses text
 * fidelity the model needs).
 */
export function longEdgeDimensions(width: number, height: number, longEdge: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: longEdge, height: longEdge }
  }
  const current = Math.max(width, height)
  if (current <= longEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = longEdge / current
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** The request-encoding target for one image. */
export function requestImageTarget(ref: ImageAttachmentRef): { width: number; height: number; maxBytes: number } {
  // An image with unknown dimensions is treated as square at the edge limit:
  // the store then produces the largest usable variant rather than failing.
  const dims = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE)
  return { width: dims.width, height: dims.height, maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES }
}

/** Whether river accepts this media type inline. */
export function isRiverImageType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase()
  return normalized === 'image/jpeg' || normalized === 'image/png'
}

/**
 * The text that replaces an image river cannot receive.
 *
 * A `webp` or `gif` screenshot is common in practice; dropping the block
 * silently would make the model answer as if the image were never attached, so
 * the block degrades to a description naming the file.
 */
export function unsupportedImageText(ref: ImageAttachmentRef): string {
  const name = ref.name === undefined ? 'image' : ref.name
  return `[image not sent: river.ai accepts JPEG and PNG only — ${name} is ${ref.mediaType}]`
}

/** Base64 of raw bytes. */
export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

/**
 * Encode one image through the harness's cached request variant.
 *
 * The access object comes from the request's own attachment store, so the
 * encode lands in the cache keyed by the request variant and a second turn over
 * the same screenshot reuses the bytes instead of transcoding again.
 */
export async function encodeImage(
  readImageRequest: (ref: ImageAttachmentRef, target: unknown, signal?: AbortSignal) => Promise<{ mediaType: string; data: Uint8Array }>,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<{ mediaType: string; base64: string } | undefined> {
  if (!isRiverImageType(ref.mediaType)) return undefined
  const encoded = await readImageRequest(ref, requestImageTarget(ref), signal)
  return { mediaType: encoded.mediaType, base64: toBase64(encoded.data) }
}
