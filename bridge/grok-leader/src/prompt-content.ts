import { admitEncodedImages, isImageAdmissionError, type AttachmentStore, type EncodedImageAttachment, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { invalidParams, internalError } from './acp.ts'
import { acpPromptToText } from './projection.ts'

/** Durable model-facing prompt blocks accepted from the ACP composer. */
export type DurablePromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

/** Validated ACP prompt before image bytes are committed to durable storage. */
export interface ParsedPrompt {
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'resource_link'; name: unknown; uri: unknown }
    | { type: 'image'; image: EncodedImageAttachment }
  >
  text: string
  images: EncodedImageAttachment[]
}
const imageMediaTypes: Record<ImageMediaType, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
}

/** Validate ACP prompt blocks without committing image bytes. */
export const parsePrompt = (value: unknown): ParsedPrompt => {
  if (!Array.isArray(value)) throw invalidParams('session/prompt prompt must be an array')
  const blocks: ParsedPrompt['blocks'] = []
  const images: EncodedImageAttachment[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalidParams('prompt content blocks must be objects')
    }
    const block = raw as Record<string, unknown>
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalidParams('text prompt content requires text')
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'resource_link') {
      blocks.push({ type: 'resource_link', name: block.name, uri: block.uri })
    } else if (block.type === 'image') {
      if (typeof block.data !== 'string' || typeof block.mimeType !== 'string'
        || !Object.hasOwn(imageMediaTypes, block.mimeType)) {
        throw invalidParams('image prompt content requires canonical base64 data and a supported mimeType')
      }
      const image: EncodedImageAttachment = {
        data: block.data,
        mediaType: block.mimeType as ImageMediaType,
      }
      blocks.push({ type: 'image', image })
      images.push(image)
    } else {
      throw invalidParams('only text, resource_link, and image prompt content is supported')
    }
  }
  return { blocks, images, text: acpPromptToText(value) }
}

/** Commit one validated prompt's images, preserving ACP block order. */
export const admitPromptContent = async (attachments: AttachmentStore | undefined, parsed: ParsedPrompt): Promise<DurablePromptBlock[]> => {
  if (attachments === undefined) throw internalError('image attachment storage is not configured')
  let refs: readonly ImageAttachmentRef[]
  try {
    refs = await admitEncodedImages(attachments, parsed.images)
  } catch (error) {
    if (isImageAdmissionError(error)) throw invalidParams(error.message)
    throw internalError('image attachment storage failed: ' + errorChain(error))
  }
  let imageIndex = 0
  return parsed.blocks.map((block): DurablePromptBlock => {
    if (block.type === 'text') return block
    if (block.type === 'resource_link') {
      return { type: 'text', text: acpPromptToText([block]) }
    }
    return { type: 'image', attachment: refs[imageIndex++]! }
  })
}
