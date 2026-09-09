/** Save the official logical-log archive without exposing partial ZIPs or replacing files. */
import { createWriteStream } from 'node:fs'
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { flushLiveSessionLog, readSessionLogText, sessionLogExportDeps, streamSessionLogZip } from '@deepseek-ai/dsh-session-log-export'

export async function exportSessionArchive(ctx: Context, sessionId: SessionId, cwd: string, filename: string, signal: AbortSignal): Promise<string> {
  if (!filename.trim() || filename.includes('\0') || extname(filename).toLowerCase() !== '.zip') {
    throw new Error('Session archive requires a .zip filename')
  }
  const target = resolve(cwd, filename.startsWith('~/') ? join(homedir(), filename.slice(2)) : filename)
  const deps = sessionLogExportDeps(ctx)
  const { sessionQuery, sessionPersistence, attachments } = deps
  if (!sessionQuery || !sessionPersistence || !attachments) throw new Error('Native session archive services are unavailable')
  await flushLiveSessionLog(deps, sessionId, signal)
  const root = await readSessionLogText(sessionPersistence, sessionId, signal)
  if (root === undefined) throw new Error('Session log was not found')
  signal.throwIfAborted()
  await mkdir(dirname(target), { recursive: true })
  const temporary = await mkdtemp(join(dirname(target), '.dscode-export-'))
  try {
    const file = join(temporary, 'session.zip')
    const stream = streamSessionLogZip({ ...deps, sessionQuery, sessionPersistence, attachments }, root, sessionId, true, 6, signal)
    await pipeline(Readable.fromWeb(stream), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
    signal.throwIfAborted()
    // A same-filesystem hard link publishes the complete file atomically and refuses overwrite.
    await link(file, target)
    return target
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
