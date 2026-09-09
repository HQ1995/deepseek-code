import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'
import { expect, it, vi } from 'vitest'
import { exportSessionArchive } from '../src/session-export.ts'

const archive = vi.hoisted(() => ({ fail: false }))
vi.mock('@deepseek-ai/dsh-session-log-export', () => ({
  sessionLogExportDeps: () => ({ sessionQuery: {}, sessionPersistence: {}, attachments: {} }),
  flushLiveSessionLog: async () => {},
  readSessionLogText: async () => 'logical session',
  streamSessionLogZip: () => new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([80, 75, 3, 4]))
    if (archive.fail) controller.error(new Error('attachment read failed'))
    else controller.close()
  } }),
}))

it('publishes a complete private archive, refusing existing files/symlinks and removing failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-export-'))
  const ctx = {} as never, session = 'session' as never
  try {
    const signal = new AbortController().signal
    const target = await exportSessionArchive(ctx, session, cwd, 'logs/a b.zip', signal)
    expect(await readFile(target)).toEqual(Buffer.from([80, 75, 3, 4]))
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    await expect(exportSessionArchive(ctx, session, cwd, 'logs/a b.zip', signal)).rejects.toMatchObject({ code: 'EEXIST' })
    await writeFile(join(cwd, 'keep'), 'original')
    await symlink(join(cwd, 'keep'), join(cwd, 'existing.zip'))
    await expect(exportSessionArchive(ctx, session, cwd, 'existing.zip', signal)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(cwd, 'keep'), 'utf8')).toBe('original')
    archive.fail = true
    await expect(exportSessionArchive(ctx, session, cwd, 'broken.zip', signal)).rejects.toThrow('attachment read failed')
    const abort = new AbortController(); abort.abort()
    await expect(exportSessionArchive(ctx, session, cwd, 'cancelled.zip', abort.signal)).rejects.toThrow()
    await expect(exportSessionArchive(ctx, session, cwd, 'wrong.md', signal)).rejects.toThrow('.zip filename')
    expect((await readdir(cwd)).sort()).toEqual(['existing.zip', 'keep', 'logs'])
    expect(await readdir(join(cwd, 'logs'))).toEqual(['a b.zip'])
  } finally {
    archive.fail = false
    await rm(cwd, { recursive: true, force: true })
  }
})
