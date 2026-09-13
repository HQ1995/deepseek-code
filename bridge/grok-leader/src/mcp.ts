/** Translate standard ACP MCP declarations into Agent-scoped DSH MCP clients. */

import { createHash } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export type McpClientConfig = McpClient.Config
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpMcpConfigError'
  }
}

/** dsh-base does not load the MCP client; it only enters the leader once a
 *  client actually declares servers, so its schema and SDK stay off the boot
 *  path. Static import edges of this module remain type-only. */
let mcpClient: Promise<typeof McpClient> | undefined
const loadMcpClient = (): Promise<typeof McpClient> => {
  mcpClient ??= import('@deepseek-ai/dsh-mcp-client').catch((error: unknown) => {
    mcpClient = undefined
    throw error
  })
  return mcpClient
}

/** Validate raw ACP declarations before an Agent is created. */
export async function resolveAcpMcpConfigs(raw: unknown, sessionCwd: string): Promise<McpClientConfig[]> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new AcpMcpConfigError('mcpServers must be an array')
  if (raw.length === 0) return []
  const { Config } = await loadMcpClient()
  const names = new Set<string>()
  return raw.map((value, index) => {
    const field = `mcpServers[${index}]`
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new AcpMcpConfigError(`${field} must be an object`)
    }
    const server = value as Record<string, unknown>
    if (typeof server.name !== 'string') throw new AcpMcpConfigError(`${field}.name must be a string`)
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    names.add(serverName)

    if (server.type === undefined) {
      if (typeof server.command !== 'string' || !isAbsolute(server.command)) {
        throw new AcpMcpConfigError(`${field}.command must be an absolute path`)
      }
      const args = stringArray(server.args, `${field}.args`)
      const env = entriesToRecord(server.env, `${field}.env`, 'environment')
      return parseClientConfig(Config, index, {
        transport: 'stdio', serverName, command: server.command, args, env,
        cwd: sessionCwd, failOnStartupError: true,
      })
    }
    if (server.type === 'http') {
      if (typeof server.url !== 'string') throw new AcpMcpConfigError(`${field}.url must be a string`)
      assertHttpUrl(server.url, `${field}.url`)
      const headers = entriesToRecord(server.headers, `${field}.headers`, 'header')
      return parseClientConfig(Config, index, {
        transport: 'streamable-http', serverName, url: server.url, headers,
        failOnStartupError: true,
      })
    }
    throw new AcpMcpConfigError(`${field} transport ${String(server.type)} is not supported`)
  })
}

/** Mount validated clients into the unpublished Agent scope. */
export async function mountMcpConfigs(agentCtx: Context, configs: readonly McpClientConfig[]): Promise<void> {
  if (configs.length === 0) return
  const client = await loadMcpClient()
  for (const config of configs) await agentCtx.plugin(client, config)
}

/** DSH exposes registrations and plugin config, but no live connection status. */
export async function listMcpServers(ctx: Context, agent?: Agent): Promise<{ servers: Array<Record<string, unknown>> }> {
  const client = await loadMcpClient()
  const activeCtx = agent?.ctx ?? ctx
  const visibleScopes = new Set(scopeChainOf(scopeOf(activeCtx)))
  const servers = new Map<string, { transport?: string; tools: Array<{ name: string; description?: string }> }>()
  for (const fiber of ctx.registry.get(client)?.fibers ?? []) {
    const scope = scopeOf(fiber.ctx)
    if (scope !== undefined && !visibleScopes.has(scope)) continue
    const config = fiber.config as Partial<McpClientConfig> | undefined
    if (typeof config?.serverName !== 'string') continue
    servers.set(config.serverName, { transport: config.transport, tools: [] })
  }
  const tools = activeCtx.get('tools') as { schemas(owner?: Agent): Array<{ name: string; description?: string }> } | undefined
  for (const tool of tools?.schemas(agent) ?? []) {
    const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(tool.name)
    if (match === null) continue
    const name = match[1]!
    let server = servers.get(name)
    if (server === undefined) { server = { tools: [] }; servers.set(name, server) }
    server.tools.push({ name: match[2]!, ...typeof tool.description === 'string' ? { description: tool.description } : {} })
  }
  return { servers: [...servers].map(([name, server]) => ({
    name, displayName: name, source: 'plugin', sourceLabel: 'plugin: dsh',
    ...server.transport === undefined ? {} : { type: server.transport },
    session: { enabled: true, status: 'unknown', tools: server.tools },
    _meta: { toolCount: server.tools.length, connectionStatusAvailable: false },
  })) }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new AcpMcpConfigError(`${field} must be an array of strings`)
  }
  return value
}

function entriesToRecord(value: unknown, field: string, kind: 'environment' | 'header'): Record<string, string> {
  if (!Array.isArray(value)) throw new AcpMcpConfigError(`${field} must be an array`)
  const result = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AcpMcpConfigError(`${field} contains an invalid ${kind} entry`)
    }
    const { name, value: entryValue } = raw as Record<string, unknown>
    if (typeof name !== 'string' || typeof entryValue !== 'string') {
      throw new AcpMcpConfigError(`${field} contains an invalid ${kind} entry`)
    }
    if (kind === 'header') {
      try {
        validateHeaderName(name)
        validateHeaderValue(name, entryValue)
      } catch {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (name.length === 0 || name.includes('=') || name.includes('\0') || entryValue.includes('\0')) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    const identity = kind === 'header' ? name.toLowerCase() : name
    if (names.has(identity)) throw new AcpMcpConfigError(`${field} contains duplicate name: ${name}`)
    names.add(identity)
    result[name] = entryValue
  }
  return result
}

function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'server'
  return `${slug}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`.slice(0, 32)
}

function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch {
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

function parseClientConfig(Config: typeof McpClient.Config, index: number, input: unknown): McpClient.Config {
  try {
    return Config(input as McpClient.Config)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
