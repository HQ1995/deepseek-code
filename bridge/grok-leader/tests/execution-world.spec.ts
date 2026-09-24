import { describe, expect, it } from 'vitest'
import { assertMcpTransports, configuredRemote, executionWorld, remoteUnavailable, sessionCwd, SSH_MODULE } from '../src/execution-world.ts'

describe('execution world', () => {
  it('explains a remote workspace that cannot take sessions', () => {
    const remote = { kind: 'ssh' as const, host: 'swoop', workspace: '/w' }
    expect(remoteUnavailable(undefined, { state: 'failed' })).toBeUndefined()
    expect(remoteUnavailable(remote, { state: 'connected' })).toBeUndefined()
    expect(remoteUnavailable(remote, { state: 'lost', reason: 'SSH helper disconnected.' }))
      .toBe('Lost the connection to ssh swoop:/w (SSH helper disconnected). Quit and restart dscode to reconnect.')
    expect(remoteUnavailable(remote, { state: 'failed' }))
      .toBe('Could not connect to ssh swoop:/w. Run `dscode doctor --runtime` in a shell to see why, then restart dscode.')
    expect(remoteUnavailable(remote, { state: 'failed', reason: 'ssh swoop failed: Permission denied (publickey). Use a key.' }))
      .toBe('Could not connect to ssh swoop:/w: ssh swoop failed: Permission denied (publickey). Use a key. '
        + 'Run `dscode doctor --runtime` in a shell to check the host, then restart dscode.')
  })


  it('is local without a remote adapter and normalizes the remote workspace', () => {
    expect(executionWorld(undefined)).toEqual({ kind: 'local' })
    expect(executionWorld({ kind: 'ssh', host: 'swoop', workspace: '/home/u/work/', helperHash: 'x' })).toEqual({ kind: 'ssh', host: 'swoop', workspace: '/home/u/work' })
  })

  it('reads the world from the configured SSH row, connected or not', () => {
    const row = (options: Record<string, unknown>) => ({ options: { name: SSH_MODULE, ...options } })
    expect(configuredRemote([{ options: { name: '@hqzhao95/dscode' } }])).toBeUndefined()
    expect(configuredRemote([row({ disabled: true, config: { host: 'h', workspace: '/w' } })])).toBeUndefined()
    expect(configuredRemote([row({ config: { host: 'swoop', workspace: '/srv/w', helperHash: 'abc' } })])).toEqual({ kind: 'ssh', host: 'swoop', workspace: '/srv/w', helperHash: 'abc' })
    // A conditional or unreadable row still counts as remote.
    expect(configuredRemote([row({ disabled: { expression: 'x' }, config: { expression: 'JSON.parse(x)' } })])).toEqual({ kind: 'ssh', host: '', workspace: '/' })
  })

  it('passes local paths through and confines remote ones to the workspace', () => {
    expect(sessionCwd({ kind: 'local' }, '/Users/me/p')).toBe('/Users/me/p')
    const remote = executionWorld({ kind: 'ssh', host: 'swoop', workspace: '/srv/w' })
    expect(sessionCwd(remote, '/srv/w')).toBe('/srv/w')
    expect(sessionCwd(remote, '/srv/w/a/./b/')).toBe('/srv/w/a/b')
    for (const cwd of ['/srv/w/../x', '/srv/wx', '/srv', '/Users/me/p']) expect(() => sessionCwd(remote, cwd)).toThrow('remote workspace swoop:/srv/w')
    const root = executionWorld({ kind: 'ssh', host: 'h', workspace: '/' })
    expect(sessionCwd(root, '/anything')).toBe('/anything')
  })

  it('refuses host stdio MCP servers only in a remote world', () => {
    const configs = [{ transport: 'stdio', serverName: 'a' }, { transport: 'streamable-http', serverName: 'b' }]
    expect(() => assertMcpTransports({ kind: 'local' }, configs)).not.toThrow()
    expect(() => assertMcpTransports({ kind: 'ssh', host: 'h', workspace: '/w' }, configs)).toThrow('(a)')
    expect(() => assertMcpTransports({ kind: 'ssh', host: 'h', workspace: '/w' }, configs.slice(1))).not.toThrow()
  })
})

describe('SSH plugin module', () => {
  it('loads as the plugin row imports it', async () => {
    const plugin = await import('../ssh/index.mjs')
    expect(plugin.name).toBe('dscode-ssh')
    expect(typeof plugin.apply).toBe('function')
  })

  it('names why a connection failed when dsh-ssh cannot', async () => {
    const { explainFailure } = await import('../ssh/index.mjs')
    const config = { host: 'build', workspace: '/w', node: '/n', helper: '/h.js', helperHash: 'a'.repeat(64),
      bootstrapPath: '/b.js', bootstrapHash: 'b'.repeat(64) }
    const lost = new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')
    const answered = (result: object) => async () => result
    await expect(explainFailure(config, lost, answered({ status: 255, stdout: '',
      stderr: 'ssh: Could not resolve hostname build: nodename nor servname provided, or not known\n' })))
      .resolves.toMatch(/^ssh build failed: ssh: Could not resolve hostname build: .* and a known host key\.$/)
    await expect(explainFailure(config, lost, answered({ status: 0, stderr: '',
      stdout: JSON.stringify({ node: 'v24.1.0', workspace: false, digests: ['a'.repeat(64), 'b'.repeat(64)] }) })))
      .resolves.toBe('/w is not a directory on build; create it first.')
    // The host checks out, or the probe itself broke: what dsh-ssh saw stands.
    await expect(explainFailure(config, lost, answered({ status: 0, stderr: '',
      stdout: JSON.stringify({ node: 'v24.1.0', workspace: true, digests: ['a'.repeat(64), 'b'.repeat(64)] }) })))
      .resolves.toBe(lost.message)
    await expect(explainFailure(config, lost, async () => { throw new Error('spawn failed') })).resolves.toBe(lost.message)
  })
})
