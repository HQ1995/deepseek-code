import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { applyRemote, remoteBlock, remoteCommand, remoteConfig, remoteStatus, removeRemote } from '../bin/remote.mjs'
import { checkRemote, localHelpers, sshProbe, sshProbeAsync } from '../bin/remote-check.mjs'

const HASH_A = 'a'.repeat(64), HASH_B = 'B'.repeat(64)
const flags = ['--host', 'swoop', '--workspace', '/home/u/work/', '--node', '/opt/node/bin/node', '--helper', '/opt/dsh/helper.mjs',
  '--helper-hash', HASH_A, '--bootstrap', '/opt/dsh/bootstrap.mjs', '--bootstrap-hash', HASH_B]
const TEMPLATE = '# Your patch layer for this dsh profile\n[]\n'

describe('dscode remote', () => {
  it('validates every coordinate before anything is written', () => {
    expect(remoteConfig(flags)).toEqual({ host: 'swoop', workspace: '/home/u/work', node: '/opt/node/bin/node', helper: '/opt/dsh/helper.mjs',
      helperHash: HASH_A, bootstrapPath: '/opt/dsh/bootstrap.mjs', bootstrapHash: HASH_B.toLowerCase() })
    const replace = (flag: string, value: string) => flags.map((item, index) => index > 0 && flags[index - 1] === flag ? value : item)
    expect(() => remoteConfig(flags.slice(2))).toThrow('missing --host\n')
    // Every missing value is named at once.
    expect(() => remoteConfig(['--host', 'swoop'])).toThrow('missing --workspace, --node, --dsh (or --helper and --bootstrap),'
      + ' --helper-hash and --bootstrap-hash (this home has no DSH runtime to take them from)')
    expect(() => remoteConfig(replace('--host', '-oProxyCommand=x'))).toThrow('OpenSSH alias')
    expect(() => remoteConfig(replace('--workspace', 'work'))).toThrow('absolute POSIX')
    expect(() => remoteConfig(replace('--helper-hash', 'abc'))).toThrow('SHA-256')
    expect(() => remoteConfig([...flags, '--host', 'other'])).toThrow('given twice')
    expect(() => remoteConfig([...flags, '--bogus', 'x'])).toThrow('unknown option --bogus\nUsage')
    expect(() => remoteConfig([...flags, '--host'])).toThrow('--host needs a value')
  })

  it('takes both remote files from one npm directory and the digests from this dscode', () => {
    const local = { version: '0.1.7-rc.1', helperHash: HASH_A, bootstrapHash: 'c'.repeat(64) }
    expect(remoteConfig(['--host', 'swoop', '--workspace', '/w', '--node', '/n/node', '--dsh', '/opt/dsh/', '--no-check'], local)).toEqual({
      host: 'swoop', workspace: '/w', node: '/n/node', helperHash: HASH_A, bootstrapHash: 'c'.repeat(64),
      helper: '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
      bootstrapPath: '/opt/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js',
    })
    // An explicit digest still wins over the local copy.
    expect(remoteConfig(['--host', 'swoop', '--workspace', '/w', '--node', '/n/node', '--dsh', '/opt/dsh', '--helper-hash', HASH_B], local).helperHash).toBe(HASH_B.toLowerCase())
    expect(() => remoteConfig(['--host', 'swoop', '--workspace', '/w', '--node', '/n', '--dsh', '/d', '--helper', '/h'], local)).toThrow('either --dsh or --helper')
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
      const probe = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ node: 'v24.19.0', workspace: true, digests: [HASH_A, HASH_B.toLowerCase()] }), stderr: '' }))
      const options = { profileDir: dir, dedicatedHome: false, withLock, scaffold, write, log, probe }
      await remoteCommand(['--help'], options)
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage: DSH_HOME=DIR dscode remote init/))
      await expect(remoteCommand(['init', ...flags], options)).rejects.toThrow('dedicated DSH_HOME')
      expect(scaffold).not.toHaveBeenCalled()
      // A failed check writes nothing.
      probe.mockReturnValueOnce({ status: 255, stdout: '', stderr: 'ssh: Could not resolve hostname swoop' })
      await expect(remoteCommand(['init', ...flags], { ...options, dedicatedHome: true })).rejects.toThrow('ssh swoop failed: ssh: Could not resolve hostname swoop')
      expect(scaffold).not.toHaveBeenCalled()
      await remoteCommand(['init', ...flags], { ...options, dedicatedHome: true })
      expect(log).toHaveBeenCalledWith('Checked ssh swoop: Node v24.19.0, the workspace, and a helper and bootstrap matching this dscode.')
      expect(scaffold).toHaveBeenCalledOnce()
      expect(withLock).toHaveBeenCalledOnce()
      expect(remoteStatus(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))?.workspace).toBe('/home/u/work')
      await remoteCommand(['status'], options)
      expect(log).toHaveBeenLastCalledWith(`${dir}: remote workspace ssh swoop:/home/u/work (helper sha256 ${HASH_A})`)
      await remoteCommand(['status', '--check'], options)
      expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'swoop', node: '/opt/node/bin/node', bootstrapHash: HASH_B.toLowerCase() }))
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Checked ssh swoop'))
      await remoteCommand(['remove'], { ...options, dedicatedHome: true })
      expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(TEMPLATE)
      await remoteCommand(['init', '--print', ...flags], options)
      expect(log.mock.lastCall![0]).toContain("name: '@hqzhao95/dscode/ssh'")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('dscode remote check', () => {
  const config = { host: 'build', workspace: '/srv/w', node: "/opt/it's/node", helper: '/d/helper.js', helperHash: 'a'.repeat(64),
    bootstrapPath: '/d/process.js', bootstrapHash: 'b'.repeat(64) }
  const report = (patch: Record<string, unknown> = {}) => ({ status: 0, stderr: '',
    stdout: 'motd\n' + JSON.stringify({ node: 'v24.1.0', workspace: true, digests: ['a'.repeat(64), 'b'.repeat(64)], ...patch }) })
  const check = (result: ReturnType<typeof report>, install?: { dir?: string; version: string }) =>
    () => checkRemote(config, { probe: () => result, ...install === undefined ? {} : { install } })

  it('names the one thing to fix', () => {
    expect(check(report())()).toBe('v24.1.0')
    expect(check({ status: 255, stdout: '', stderr: 'Host key verification failed.' })).toThrow('ssh build failed: Host key verification failed.')
    expect(check({ status: 127, stdout: '', stderr: "sh: /opt/it's/node: not found" })).toThrow("/opt/it's/node did not run on build")
    expect(check(report({ node: 'v20.11.0' }))).toThrow('is Node v20.11.0; the helper needs Node 22 or newer')
    expect(check(report({ workspace: false }))).toThrow('/srv/w is not a directory on build')
    expect(check(report({ digests: [null, 'b'.repeat(64)] }), { dir: '/d', version: '0.1.7-rc.1' }))
      .toThrow(`/d/helper.js is missing on build. Install them with: ssh build "mkdir -p '/d' && cd '/d' && npm install @deepseek-ai/dsh-ssh@0.1.7-rc.1 @deepseek-ai/dsh-ptc-runtime-node@0.1.7-rc.1"`)
    expect(check(report({ digests: ['a'.repeat(64), 'c'.repeat(64)] }), { version: '0.1.7-rc.1' }))
      .toThrow('/d/process.js on build is not the @deepseek-ai/dsh-ptc-runtime-node this dscode expects (sha256 ' + 'c'.repeat(64) + ', expected ' + 'b'.repeat(64)
        + '). Install @deepseek-ai/dsh-ssh@0.1.7-rc.1 and @deepseek-ai/dsh-ptc-runtime-node@0.1.7-rc.1 there.')
  })

  it('connects the way the leader does and quotes every remote argument', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    sshProbe(config, spawn as never)
    const [command, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(command).toBe('ssh')
    expect(args.slice(0, 7)).toEqual(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'build'])
    expect(args[7]).toMatch(/^'\/opt\/it'\\''s\/node' '-e' 'const fs/)
    expect(args[7]!.endsWith(" '/srv/w' '/d/helper.js' '/d/process.js'")).toBe(true)
  })

  it('probes without blocking and reads a timeout as ssh failing', async () => {
    type Done = (error: unknown, stdout?: string, stderr?: string) => void
    const answer = (error: unknown, stdout = '', stderr = '') => vi.fn((_c: string, _a: string[], _o: object, done: Done) => done(error, stdout, stderr))
    const ok = answer(null, '{"node":"v24.1.0"}')
    await expect(sshProbeAsync(config, { run: ok as never })).resolves.toEqual({ status: 0, stdout: '{"node":"v24.1.0"}', stderr: '' })
    const [command, args, options] = ok.mock.calls[0] as unknown as [string, string[], { timeout: number }]
    expect(command).toBe('ssh')
    expect(args.slice(0, 7)).toEqual(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', 'build'])
    expect(options.timeout).toBe(10_000)
    await expect(sshProbeAsync(config, { run: answer(Object.assign(new Error('x'), { code: 255 }), '', 'Permission denied (publickey).') as never }))
      .resolves.toEqual({ status: 255, stdout: '', stderr: 'Permission denied (publickey).' })
    await expect(sshProbeAsync(config, { run: answer(Object.assign(new Error('x'), { killed: true, code: null })) as never }))
      .resolves.toEqual({ status: 255, stdout: '', stderr: 'no answer within 10 seconds' })
    const missing = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
    await expect(sshProbeAsync(config, { run: answer(missing) as never })).resolves.toMatchObject({ status: null, error: missing })
  })

  it('takes the default digests from the runtime installation', async () => {
    const { createRequire } = await import('node:module')
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client/package.json')
    const local = localHelpers(anchor)
    expect(local).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+/), helperHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(localHelpers('/nonexistent/bin/dsh')).toBeUndefined()
  })
})
