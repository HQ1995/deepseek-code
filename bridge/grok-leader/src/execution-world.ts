/** Where a session's tools run. In a remote workspace (one SSH connection per
 * profile) session paths are not host paths: the TUI must never open, read or
 * link them locally, and the leader keeps sessions inside that workspace. */
import { posix } from 'node:path'
import { invalidParams } from './acp.ts'

export type ExecutionWorld = { kind: 'local' } | { kind: 'ssh'; host: string; workspace: string }

/** A remote workspace as the profile configures it. */
export interface RemoteLike { kind: 'ssh'; host: string; workspace: string; helperHash?: string }

/** The shipped SSH adapter row that makes a profile remote. */
export const SSH_MODULE = '@hqzhao95/dscode/ssh'

/** Structural read of config-editor entries (dsh 0.1.7). */
export interface ConfigEntryLike { options: { name?: unknown; disabled?: unknown; config?: unknown } }

/** The remote workspace a profile configures, whether or not it connected: a
 * profile whose SSH row failed must never be reported as local. Only a
 * literal `disabled: true` row is local. */
export function configuredRemote(entries: Iterable<ConfigEntryLike>): RemoteLike | undefined {
  for (const entry of entries) {
    if (entry.options.name !== SSH_MODULE || entry.options.disabled === true) continue
    const config = (entry.options.config ?? {}) as Record<string, unknown>
    const text = (key: string) => typeof config[key] === 'string' ? config[key] as string : ''
    return { kind: 'ssh', host: text('host'), workspace: text('workspace') || '/', ...typeof config.helperHash === 'string' ? { helperHash: config.helperHash } : {} }
  }
  return undefined
}

export function executionWorld(remote: RemoteLike | undefined): ExecutionWorld {
  return remote === undefined ? { kind: 'local' } : { kind: 'ssh', host: remote.host, workspace: trimSlash(posix.normalize(remote.workspace)) }
}

const trimSlash = (path: string) => path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

/** The session cwd for this world. A remote cwd must be an absolute POSIX
 * path inside the remote workspace; a host path is refused, never mapped. */
export function sessionCwd(world: ExecutionWorld, cwd: string): string {
  if (world.kind === 'local') return cwd
  const path = trimSlash(posix.normalize(cwd))
  const inside = path === world.workspace || path.startsWith(world.workspace === '/' ? '/' : world.workspace + '/')
  if (!posix.isAbsolute(cwd) || !inside) {
    throw invalidParams('This profile works in the remote workspace ' + world.host + ':' + world.workspace + '; open sessions there, not at ' + cwd)
  }
  return path
}

/** Remote sessions cannot start host stdio MCP servers: their commands and
 * cwd would run on this computer beside a remote workspace. */
export function assertMcpTransports(world: ExecutionWorld, configs: ReadonlyArray<{ transport: string; serverName: string }>): void {
  if (world.kind === 'local') return
  const local = configs.filter(config => config.transport === 'stdio').map(config => config.serverName)
  if (local.length > 0) {
    throw invalidParams('Local stdio MCP servers cannot run beside a remote workspace (' + local.join(', ') + '); use an HTTP MCP server or add it to the remote profile.')
  }
}
