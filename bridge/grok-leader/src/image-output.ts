/** Resolve tool images through the attachment authority before exposing a viewer path. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectedUpdate } from './projection.ts'

/**
 * Image blocks of one tool outcome. Native results and PTC sub-dispatches
 * share the model-facing content vocabulary, so both resolve identically.
 */
function imageBlocksOf(event: SessionEvent): Array<{ attachment?: unknown }> {
  if (event.type === 'tool/result') {
    const content = event.data.message.content[0]
    if (content?.type !== 'tool-result') return []
    return content.content.filter(block => block.type === 'image') as Array<{ attachment?: unknown }>
  }
  if (event.type === 'tool/ptc-dispatch') {
    return event.data.content.filter(block => block.type === 'image') as Array<{ attachment?: unknown }>
  }
  return []
}

export function createImageOutputProjector(ctx: Context) {
  let directory: Promise<string> | undefined
  let closed = false
  ctx.effect(() => async () => {
    closed = true
    if (directory !== undefined) await rm(await directory, { recursive: true, force: true })
  })
  return async (event: SessionEvent, updates: ProjectedUpdate[]): Promise<ProjectedUpdate[]> => {
    const images = imageBlocksOf(event)
    if (images.length === 0) return updates
    const paths: string[] = []
    const errors: string[] = []
    for (const image of images) {
      try {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new Error('Attachment storage is unavailable')
        const ref = image.attachment as ImageAttachmentRef
        const stored = await attachments.readImage(ref, AbortSignal.timeout(10_000))
        if (closed) throw new Error('Image preview closed')
        let path = attachments.imageHostPath(stored.ref)
        if (path === undefined) {
          directory ??= mkdtemp(join(tmpdir(), 'dscode-images-'))
          const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const)[stored.ref.mediaType]
          path = join(await directory, randomUUID() + '.' + extension)
          await writeFile(path, stored.data, { mode: 0o600, flag: 'wx' })
        }
        paths.push(path)
      } catch (error) {
        errors.push('Image preview unavailable: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return updates.map(update => update.sessionUpdate !== 'tool_call_update' ? update : ({
      ...update,
      rawOutput: { ...(typeof update.rawOutput === 'object' && update.rawOutput !== null ? update.rawOutput : {}), dscodeImages: paths, dscodeImageErrors: errors },
      content: [
        ...update.content ?? [],
        ...errors.map(text => ({ type: 'content' as const, content: { type: 'text' as const, text } })),
      ],
    }))
  }
}
