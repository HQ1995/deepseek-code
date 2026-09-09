import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { installLegacySessionMigration } from '../src/session-migration.ts'

it.each([0, 1, 2].flatMap(version => ['dscode/model-selected', 'model/selected'].map(type => ({ version, type }))))('migrates $type from V$version through native V3 publication and preserves the original', async ({ type, version }) => {
  const root = await mkdtemp(join(tmpdir(), 'dscode-migration-'))
  const ctx = new Context()
  try {
    const id = SessionId('legacy-model')
    const directory = join(root, '_no-cwd', id)
    await mkdir(directory, { recursive: true })
    const path = join(directory, version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`)
    const data = { provider: 'mock', model: 'chosen', reasoningEffort: 'high' }
    const bytes = [
      { type: 'session', version, id, createdAt: 1, ...(version >= 2 ? { isSeeded: false } : {}), delegationDepth: 0 },
      { type, seq: 0, time: 10, data },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(path, bytes)
    const original = await stat(path, { bigint: true })
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const uninstall = installLegacySessionMigration(ctx.sessionPersistence)
    for (const mode of ['read', 'write', 'read'] as const) {
      const handle = await ctx.sessionPersistence.open(id, mode)
      try {
        expect(handle.header.version).toBe(3)
        expect((await handle.read()).events).toContainEqual({ type: 'model/selection', seq: 0, time: 10, data })
      } finally { await handle.close() }
    }
    expect(await readFile(path, 'utf8')).toBe(bytes)
    const after = await stat(path, { bigint: true })
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([original.ino, original.size, original.mtimeNs, original.ctimeNs])
    expect(await readFile(join(directory, 'session.v3.jsonl'), 'utf8')).toContain('model/selection')
    if (process.env.DSCODE_E2E_PREVIOUS_RUNTIME) {
      // A real older runtime must refuse V3, never resume the stale V0/V1/V2 file.
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        const require = createRequire(process.env.DSCODE_E2E_PREVIOUS_RUNTIME + '/package.json');
        const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
        const { default: Persistence } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));
        const ctx = new Context();
        try {
          await ctx.plugin(Persistence, { root: process.argv[1], compression: 'none' });
          await assert.rejects(ctx.sessionPersistence.open('legacy-model', 'write'), /newer|unsupported|format/i);
          console.log('older runtime refused V3');
        } finally { await ctx.fiber.dispose(); }
      `, root], { timeout: 15000 })
      expect(result.stdout).toContain('older runtime refused V3')
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
    uninstall()
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try { expect((await handle.read()).events[0]?.type).toBe('model/selection') }
    finally { await handle.close() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not weaken native validation or publish a generation for malformed legacy events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscode-invalid-migration-'))
  const ctx = new Context()
  try {
    const id = SessionId('invalid-model')
    const directory = join(root, '_no-cwd', id)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.v2.jsonl')
    const bytes = [
      { type: 'session', version: 2, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'dscode/model-selected', seq: 0, time: 10, data: { provider: 'mock', model: 'chosen', reasoningEffort: 42 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(path, bytes)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    installLegacySessionMigration(ctx.sessionPersistence)
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readdir(directory)).not.toContain('session.v3.jsonl')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
