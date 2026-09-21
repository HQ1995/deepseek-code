import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { AcpMcpConfigError, listMcpServers, mountMcpConfigs, resolveAcpMcpConfigs } from '../src/mcp.ts'

describe('ACP MCP adapter', () => {
  it('lists zero-tool servers without inventing connection status or leaking another agent scope', async () => {
    const ctx = new Context()
    const a = createScope(ctx, {}), b = createScope(ctx, {})
    ctx.provide('tools', { schemas: () => [{ name: 'mcp__global__echo', description: 'Echo' }] } as never)
    const get = ctx.registry.get.bind(ctx.registry)
    const spy = vi.spyOn(ctx.registry, 'get').mockImplementation(plugin => plugin === McpClient ? {
      fibers: [
        { ctx, config: { serverName: 'global', transport: 'stdio' } },
        { ctx: a.ctx, config: { serverName: 'empty', transport: 'streamable-http', headers: { Authorization: 'secret' } } },
        { ctx: b.ctx, config: { serverName: 'other-agent', transport: 'stdio' } },
      ],
    } as never : get(plugin))
    try {
      const listed = await listMcpServers(ctx, { ctx: a.ctx } as Agent)
      expect(listed.servers).toMatchObject([
        { name: 'global', source: 'plugin', session: { status: 'unknown', tools: [{ name: 'echo' }] } },
        { name: 'empty', session: { status: 'unknown', tools: [] } },
      ])
      expect(listed.servers).toHaveLength(2)
      expect(JSON.stringify(listed)).not.toContain('secret')
    } finally { spy.mockRestore(); await ctx.fiber.dispose() }
  })

  it('attributes tools to the longest matching fiber name and does not invent leftover servers', async () => {
    const ctx = new Context()
    const a = createScope(ctx, {})
    ctx.provide('tools', { schemas: () => [
      { name: 'mcp__team__tools__list', description: 'List' },
      { name: 'mcp__unknown__echo', description: 'Echo' },
    ] } as never)
    const get = ctx.registry.get.bind(ctx.registry)
    const spy = vi.spyOn(ctx.registry, 'get').mockImplementation(plugin => plugin === McpClient ? {
      fibers: [
        { ctx: a.ctx, config: { serverName: 'team', transport: 'stdio' } },
        { ctx: a.ctx, config: { serverName: 'team__tools', transport: 'stdio' } },
      ],
    } as never : get(plugin))
    try {
      const listed = await listMcpServers(ctx, { ctx: a.ctx } as Agent)
      expect(listed.servers).toMatchObject([
        { name: 'team', session: { tools: [] } },
        { name: 'team__tools', session: { tools: [{ name: 'list' }] } },
      ])
      expect(listed.servers.map(server => server.name)).toEqual(['team', 'team__tools'])
    } finally { spy.mockRestore(); await ctx.fiber.dispose() }
  })

  it('maps stdio and Streamable HTTP servers and mounts both', async () => {
    const configs = await resolveAcpMcpConfigs([
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
  ])('rejects malformed declarations', async (servers, message) => {
    await expect(resolveAcpMcpConfigs(servers, '/workspace')).rejects.toThrow(new RegExp(message))
    await expect(resolveAcpMcpConfigs(servers, '/workspace')).rejects.toThrow(AcpMcpConfigError)
  })

  it('keeps the MCP client off the boot path until a client declares servers', async () => {
    const source = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/^import type \* as McpClient from '@deepseek-ai\/dsh-mcp-client'$/m)
    expect(source).not.toMatch(/^import \* as McpClient/m)
    await expect(resolveAcpMcpConfigs(undefined, '/workspace')).resolves.toEqual([])
    await expect(resolveAcpMcpConfigs([], '/workspace')).resolves.toEqual([])
    const plugin = vi.fn(async () => undefined)
    await mountMcpConfigs({ plugin } as unknown as Context, [])
    expect(plugin).not.toHaveBeenCalled()
  })
})
