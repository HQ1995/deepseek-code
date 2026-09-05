import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AcpMcpConfigError, mountMcpConfigs, resolveAcpMcpConfigs } from '../src/mcp.ts'

describe('ACP MCP adapter', () => {
  it('maps stdio and Streamable HTTP servers and mounts both', async () => {
    const configs = resolveAcpMcpConfigs([
      {
        name: 'local tools',
        command: process.execPath,
        args: ['server.mjs'],
        env: [{ name: 'TOKEN', value: 'secret' }],
      },
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.test/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
    ], '/workspace')

    expect(configs).toEqual([
      expect.objectContaining({ transport: 'stdio', command: process.execPath, cwd: '/workspace', env: { TOKEN: 'secret' } }),
      expect.objectContaining({ transport: 'streamable-http', serverName: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' } }),
    ])
    expect(configs[0]?.serverName).toMatch(/^local_tools_[0-9a-f]{8}$/)

    const plugin = vi.fn(async () => undefined)
    await mountMcpConfigs({ plugin } as unknown as Context, configs)
    expect(plugin).toHaveBeenCalledTimes(2)
    expect(plugin.mock.calls.map(call => call[1])).toEqual(configs)
  })

  it.each([
    [null, 'must be an array'],
    [[{ name: 'bad', command: 'relative', args: [], env: [] }], 'command must be an absolute path'],
    [[{ name: 'same', command: process.execPath, args: [], env: [] }, { name: 'same', command: process.execPath, args: [], env: [] }], 'duplicate normalized name'],
    [[{ type: 'sse', name: 'legacy', url: 'https://example.test/sse', headers: [] }], 'transport sse is not supported'],
    [[{ type: 'http', name: 'web', url: 'file:///tmp/mcp', headers: [] }], 'absolute HTTP\\(S\\) URL'],
  ])('rejects malformed declarations', (servers, message) => {
    expect(() => resolveAcpMcpConfigs(servers, '/workspace')).toThrow(new RegExp(message))
    expect(() => resolveAcpMcpConfigs(servers, '/workspace')).toThrow(AcpMcpConfigError)
  })
})
