import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { applyRemote, remoteBlock, remoteCommand, remoteConfig, remoteStatus, removeRemote } from '../bin/remote.mjs'

const HASH_A = 'a'.repeat(64), HASH_B = 'B'.repeat(64)
const flags = ['--host', 'swoop', '--workspace', '/home/u/work/', '--node', '/opt/node/bin/node', '--helper', '/opt/dsh/helper.mjs',
  '--helper-hash', HASH_A, '--bootstrap', '/opt/dsh/bootstrap.mjs', '--bootstrap-hash', HASH_B]
const TEMPLATE = '# Your patch layer for this dsh profile\n[]\n'

describe('dscode remote', () => {
  it('validates every coordinate before anything is written', () => {
    expect(remoteConfig(flags)).toEqual({ host: 'swoop', workspace: '/home/u/work', node: '/opt/node/bin/node', helper: '/opt/dsh/helper.mjs',
      helperHash: HASH_A, bootstrapPath: '/opt/dsh/bootstrap.mjs', bootstrapHash: HASH_B.toLowerCase() })
    const replace = (flag: string, value: string) => flags.map((item, index) => index > 0 && flags[index - 1] === flag ? value : item)
    expect(() => remoteConfig(flags.slice(2))).toThrow('--host is required')
    expect(() => remoteConfig(replace('--host', '-oProxyCommand=x'))).toThrow('OpenSSH alias')
    expect(() => remoteConfig(replace('--workspace', 'work'))).toThrow('absolute POSIX')
    expect(() => remoteConfig(replace('--helper-hash', 'abc'))).toThrow('SHA-256')
    expect(() => remoteConfig([...flags, '--host', 'other'])).toThrow('given twice')
    expect(() => remoteConfig([...flags, '--bogus', 'x'])).toThrow('Usage')
  })

  it('replaces the empty template with rows the loader reads as intended', () => {
    const text = applyRemote(TEMPLATE, remoteConfig(flags))
    expect(text.startsWith('# Your patch layer')).toBe(true)
    expect(load(text)).toEqual([
      { id: 'subprocess', disabled: true }, { id: 'sandbox', disabled: true }, { id: 'fs-sandbox', disabled: true }, { id: 'ptc-runtime', disabled: true },
      { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: '/home/u/work' } },
      { insert: [{ id: 'dscode-ssh', name: '@hqzhao95/dscode/ssh', config: { host: 'swoop', node: '/opt/node/bin/node', helper: '/opt/dsh/helper.mjs',
        helperHash: HASH_A, workspace: '/home/u/work', bootstrapPath: '/opt/dsh/bootstrap.mjs', bootstrapHash: HASH_B.toLowerCase() } }] },
    ])
    expect(remoteStatus(text)).toEqual({ host: 'swoop', workspace: '/home/u/work', helperHash: HASH_A })
  })

  it('keeps the user entries, replaces its own block and removes it again', () => {
    const user = '# mine\n- id: llm-deepseek\n  config:\n    baseURL: !!js process.env.X\n'
    const once = applyRemote(user, remoteConfig(flags))
    expect(once.startsWith(user)).toBe(true)
    const moved = applyRemote(once, remoteConfig(flags.map(item => item === 'swoop' ? 'other' : item)))
    expect(moved.match(/dscode remote workspace \(managed/g)).toHaveLength(1)
    expect(remoteStatus(moved)?.host).toBe('other')
    expect(removeRemote(moved)).toEqual({ text: user, removed: true })
    expect(removeRemote(applyRemote(TEMPLATE, remoteConfig(flags)))).toEqual({ text: '# Your patch layer for this dsh profile\n[]\n', removed: true })
    expect(removeRemote(user)).toEqual({ text: user, removed: false })
    expect(() => applyRemote('[{id: x, disabled: true}]\n', remoteConfig(flags))).toThrow('not a block-style list')
    expect(() => removeRemote(remoteBlock(remoteConfig(flags)).replace('# <<< dscode remote workspace', ''))).toThrow('damaged')
  })

  it('finds its block by whole marker lines, whatever the values quote', () => {
    const tricky = remoteConfig(flags.map(item => item === '/opt/dsh/helper.mjs' ? '/opt/# <<< dscode remote workspace/helper.mjs' : item))
    const text = applyRemote(TEMPLATE, tricky)
    expect(remoteStatus(text)).toEqual({ host: 'swoop', workspace: '/home/u/work', helperHash: HASH_A })
    expect((load(text) as Array<{ insert?: Array<{ config: { helper: string } }> }>).at(-1)!.insert![0]!.config.helper).toBe('/opt/# <<< dscode remote workspace/helper.mjs')
    expect(removeRemote(text)).toEqual({ text: TEMPLATE, removed: true })
  })

  it('refuses the default home and edits a dedicated one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dscode-remote-'))
    try {
      const log = vi.fn(), withLock = vi.fn(async (action: () => Promise<unknown>) => action())
      const scaffold = vi.fn(() => writeFileSync(join(dir, 'cordis.patch.yml'), TEMPLATE, { flag: 'a' }))
      const write = (path: string, text: string) => writeFileSync(path, text)
      const options = { profileDir: dir, dedicatedHome: false, withLock, scaffold, write, log }
      await expect(remoteCommand(['init', ...flags], options)).rejects.toThrow('dedicated DSH_HOME')
      expect(scaffold).not.toHaveBeenCalled()
      await remoteCommand(['init', ...flags], { ...options, dedicatedHome: true })
      expect(scaffold).toHaveBeenCalledOnce()
      expect(withLock).toHaveBeenCalledOnce()
      expect(remoteStatus(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))?.workspace).toBe('/home/u/work')
      await remoteCommand(['status'], options)
      expect(log).toHaveBeenLastCalledWith(`${dir}: remote workspace ssh swoop:/home/u/work (helper sha256 ${HASH_A})`)
      await remoteCommand(['remove'], { ...options, dedicatedHome: true })
      expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(TEMPLATE)
      await remoteCommand(['init', '--print', ...flags], options)
      expect(log.mock.lastCall![0]).toContain("name: '@hqzhao95/dscode/ssh'")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
