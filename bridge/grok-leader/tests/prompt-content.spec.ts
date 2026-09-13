import { describe, expect, it, vi } from 'vitest'
import { AttachmentError, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { admitPromptContent, parsePrompt } from '../src/prompt-content.ts'

describe('prompt content admission', () => {
  it('validates block shapes without committing bytes and preserves mixed input order', async () => {
    const refs = [{ attachmentId: 'first' }, { attachmentId: 'second' }]
    const saveImages = vi.fn(async () => refs)
    const store = { saveImages } as unknown as AttachmentStore
    const parsed = parsePrompt([
      { type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/png', data: 'AQ==' },
      { type: 'resource_link', name: 'source', uri: 'file:///workspace/file' },
      { type: 'image', mimeType: 'image/webp', data: 'Ag==' }, { type: 'text', text: 'after' },
    ])
    expect(saveImages).not.toHaveBeenCalled()
    const durable = await admitPromptContent(store, parsed)
    expect(durable).toEqual([
      { type: 'text', text: 'before' }, { type: 'image', attachment: refs[0] },
      { type: 'text', text: '\n[resource_link name="source" uri="file:///workspace/file"]\n' },
      { type: 'image', attachment: refs[1] }, { type: 'text', text: 'after' },
    ])
    expect(saveImages).toHaveBeenCalledOnce()
    expect(saveImages).toHaveBeenCalledWith([
      { data: new Uint8Array([1]), mediaType: 'image/png' }, { data: new Uint8Array([2]), mediaType: 'image/webp' },
    ])
    expect(parsed.text).not.toContain('AQ==')
  })

  it('rejects malformed content before storage and canonicalizes the whole image batch before any commit', async () => {
    for (const prompt of [undefined, {}, [null], [[]], [{ type: 'text', text: 3 }], [{ type: 'audio', data: 'raw' }], [{ type: 'image', mimeType: 'image/svg+xml', data: 'AQ==' }]]) {
      expect(() => parsePrompt(prompt)).toThrow()
    }
    const saveImages = vi.fn()
    const parsed = parsePrompt([
      { type: 'image', mimeType: 'image/png', data: 'AQ==' },
      { type: 'image', mimeType: 'image/png', data: 'AQ' },
    ])
    await expect(admitPromptContent({ saveImages } as unknown as AttachmentStore, parsed)).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('canonical base64') })
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('distinguishes native admission refusals from missing or failed storage', async () => {
    const parsed = parsePrompt([{ type: 'text', text: 'message' }])
    await expect(admitPromptContent(undefined, parsed)).rejects.toMatchObject({ code: -32603 })
    const saveImages = vi.fn(async (): Promise<never> => { throw new AttachmentError('bad image', 'INVALID_IMAGE_BASE64') })
    const store = { saveImages } as unknown as AttachmentStore
    await expect(admitPromptContent(store, parsed)).rejects.toMatchObject({ code: -32602, message: 'bad image' })
    saveImages.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(admitPromptContent(store, parsed)).rejects.toMatchObject({ code: -32603, message: expect.stringContaining('disk unavailable') })
  })
})
