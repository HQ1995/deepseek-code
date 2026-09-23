import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { createImageOutputProjector } from '../src/image-output.ts'

it('verifies each tool attachment and preserves explicit errors in live and replay projections', async () => {
  const ctx = new Context()
  const reads: string[] = []
  ctx.provide('attachments', {
    async readImage(ref: { attachmentId: string }) {
      reads.push(ref.attachmentId)
      if (ref.attachmentId === 'missing') throw new Error('Stored image is missing')
      return { ref, data: new Uint8Array([1]) }
    },
    imageHostPath(ref: { attachmentId: string }) { return '/private/' + ref.attachmentId + '.png' },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'image', attachment: { attachmentId: 'valid' } }, { type: 'image', attachment: { attachmentId: 'missing' } }] } } } as never
  for (const replay of [false, true]) {
    const updates = await project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' }])
    expect(updates[0]).toMatchObject({ rawOutput: { dscodeImages: ['/private/valid.png'] }, content: [{ content: { text: 'Image preview unavailable: Stored image is missing' } }] })
    expect(replay ? reads.length === 4 : reads.length === 2).toBe(true)
  }
  await ctx.fiber.dispose()
})

it('resolves PTC sub-call images through the same attachment authority', async () => {
  const ctx = new Context()
  ctx.provide('attachments', {
    async readImage(ref: { attachmentId: string }) { return { ref, data: new Uint8Array([1]) } },
    imageHostPath(ref: { attachmentId: string }) { return '/private/' + ref.attachmentId + '.png' },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'ptc-image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/ptc-dispatch', data: { rootCallId: 'code', parentCallId: 'code', subCallId: 'code:ptc:1', name: 'read_image', arguments: {}, isError: false, content: [{ type: 'image', attachment: { attachmentId: 'nested' } }] } } as never
  expect(await project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:1', status: 'completed' }]))
    .toMatchObject([{ toolCallId: 'code:ptc:1', rawOutput: { dscodeImages: ['/private/nested.png'] } }])
  // A sub-call without images never rewrites the projected update.
  const plain = await project({ type: 'tool/ptc-dispatch', data: { content: [{ type: 'text', text: 'ok' }] } } as never,
    [{ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:2', status: 'completed' }])
  expect(plain[0]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:2', status: 'completed' })
  await ctx.fiber.dispose()
})

it('does not create image preview files after disposal interrupts an attachment read', async () => {
  const ctx = new Context()
  let finish!: (value: unknown) => void
  let localized = false
  const reading = new Promise(resolve => { finish = resolve })
  ctx.provide('attachments', {
    readImage: () => reading,
    imageHostPath() { localized = true; return undefined },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'closing-image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'image', attachment: { attachmentId: 'pending' } }] } } } as never
  const projected = project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' }])
  await ctx.fiber.dispose()
  finish({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1]) })
  expect(await projected).toMatchObject([{ rawOutput: { dscodeImages: [], dscodeImageErrors: ['Image preview unavailable: Image preview closed'] } }])
  expect(localized).toBe(false)
})
