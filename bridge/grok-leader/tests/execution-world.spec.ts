import { describe, expect, it } from 'vitest'
import { assertMcpTransports, configuredRemote, executionWorld, sessionCwd, SSH_MODULE } from '../src/execution-world.ts'

describe('execution world', () => {
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
