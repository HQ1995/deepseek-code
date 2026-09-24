import { execFile } from 'node:child_process'
import { browserFacts, type BrowserStatus } from './browser-control.ts'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TerminalSessionId, type TerminalSessionService } from '@deepseek-ai/dsh-terminal'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import { PACKAGE_DIRECTORY } from './package-location.ts'
import type { SessionOperation, SessionWork } from './session-work.ts'

export type NativeTerminals = Pick<TerminalSessionService, 'list' | 'read' | 'signal' | 'kill' | 'listBackends'>
export interface NativeExecutionHost {
  resolveExecutable(command: string, env: Record<string, string>, signal: AbortSignal): Promise<string>
  spawnTerminal?: unknown
}
interface ExecutionSession { agent: Agent; clientId: number; work: Pick<SessionWork, 'run'> }
interface ExecutionHost<S extends ExecutionSession> {
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  terminals(record: S): NativeTerminals | undefined
  subprocess(record: S): NativeExecutionHost | undefined
  toolNames(record: S): ReadonlySet<string>
  profileDirectory(): string | undefined
  inspector?(): { url: string; captureFetch: boolean } | undefined
  /** Live browser facts while the opt-in browser row is active. */
  browser?(): BrowserStatus | undefined
  /** Enabled host-level Team tools rows, which reach every session's agents. */
  hostTeamRows?(): Promise<readonly string[]>
  /** The remote workspace identity when this profile runs tools over SSH. */
  remote?(): { host: string; workspace: string; helperHash?: string; connected: boolean } | undefined
}
type InstallationReader = (version: string, directory: string | undefined, signal: AbortSignal) => Promise<string>
const execute = promisify(execFile)
const readInstallation: InstallationReader = async (version, directory, signal) => {
  const request = execute(process.execPath, [join(PACKAGE_DIRECTORY, 'bin', 'doctor.mjs'), '--json', '--runtime-only'], {
    env: { ...process.env, ...directory ? { DSH_PROFILE_DIR: directory } : {}, DSCODE_DOCTOR_TUI_VERSION: version },
    timeout: 20000, maxBuffer: 128 * 1024, signal,
  })
  // execFile rejects from its error event on abort before the process/stdio
  // close event. Keep the session and module drains attached to real cleanup.
  const closed = new Promise<void>(resolve => { request.child.once('close', () => { resolve() }) })
  try { return (await request).stdout } finally { await closed }
}

/** Session-scoped execution diagnostics and persistent-terminal controls.
 * Native terminals keep process ownership. This module owns accepted reads and
 * controls, bounded diagnostic subprocesses and cancellation-aware projection;
 * closing waits for real signal/kill completion, never kills another PTY. */
export function createNativeExecution<S extends ExecutionSession>(host: ExecutionHost<S>, installation: InstallationReader = readInstallation) {
  let closed = false, disposal: Promise<void> | undefined
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>()
  const assertOpen = () => { if (closed) throw internalError('native execution has been disposed') }
  const active = (record: S, scope: SessionOperation) => {
    assertOpen(); scope.assertActive()
    if (host.owned(record.clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
  }
  const accept = <T>(clientId: number, params: unknown, method: string,
    operation: (record: S, p: Record<string, unknown>, scope: SessionOperation) => Promise<T>,
  ): Promise<T> => {
    if (closed) return Promise.reject(internalError('native execution has been disposed'))
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    // Publish before native getters/callbacks can reenter disposal.
    try {
      const p = paramRecord(params, 'x.ai/' + method)
      const record = host.owned(clientId, typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
      assertOpen()
      if (record === undefined) throw invalidParams(method + ' requires an owned sessionId')
      resolve(record.work.run(async scope => {
        active(record, scope)
        const value = await operation(record, p, scope)
        active(record, scope)
        return value
      }))
    } catch (error) { reject(error) }
    return result
  }
  return {
    doctor(clientId: number, params: unknown) {
      return accept(clientId, params, 'doctor', async (record, p, scope) => {
        if (typeof p.tuiVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(p.tuiVersion)) throw invalidParams('Invalid TUI version')
        const findings: Array<{ status: string; name: string; detail: string }> = []
        const signal = AbortSignal.any([scope.signal, shutdown.signal])
        const directory = host.profileDirectory()
        active(record, scope)
        try {
          const parsed: unknown = JSON.parse(await installation(p.tuiVersion, directory, signal))
          if (!Array.isArray(parsed) || !parsed.every(row => row !== null && typeof row === 'object'
            && typeof row.status === 'string' && typeof row.name === 'string' && typeof row.detail === 'string')) throw new Error('invalid installation findings')
          findings.push(...parsed)
        } catch { findings.push({ status: 'ERROR', name: 'Installation checks', detail: 'Could not finish. Run dscode doctor --runtime in a shell.' }) }
        active(record, scope)
        const subprocess = host.subprocess(record)
        active(record, scope)
        const missing: string[] = []
        for (const command of ['typescript-language-server', 'tsc']) {
          active(record, scope)
          try {
            if (subprocess === undefined) throw new Error('no execution host')
            await subprocess.resolveExecutable(command, {}, AbortSignal.any([signal, AbortSignal.timeout(3000)]))
          } catch { missing.push(command) }
          active(record, scope)
        }
        const names = host.toolNames(record)
        active(record, scope)
        findings.push({ status: missing.length ? (record.agent.session.header.agentPreset === 'lsp' ? 'ERROR' : 'INFO') : 'OK', name: 'Shipped LSP preset', detail: missing.length
          ? `Optional dependencies missing in execution host: ${missing.join(', ')}. Install typescript-language-server and typescript there (npm install -g typescript-language-server typescript), then restart. Standard works without them.`
          : 'typescript-language-server and tsc resolve in the execution host; server startup is checked on the first LSP query.' })
        findings.push({ status: 'INFO', name: 'Session tools', detail: `LSP ${names.has('lsp') ? 'enabled' : 'not selected'}; terminal ${names.has('terminal_open') ? 'enabled' : 'not selected'}. Use /preset lsp or /preset terminal before starting a new conversation.` })
        const terminals = host.terminals(record)
        active(record, scope)
        const backends = terminals?.listBackends() ?? []
        active(record, scope)
        const available = backends.includes('shell') && typeof subprocess?.spawnTerminal === 'function'
        const count = available ? terminals!.list(record.agent).length : 0
        active(record, scope)
        findings.push({ status: available ? 'OK' : 'WARN', name: 'PTY backend', detail: available
          ? `shell backend registered; ${count} terminals owned by this session. Shell startup and sandbox permissions are checked when opening a terminal.`
          : 'Shell backend or subprocess PTY support is unavailable. Restore the terminal services in the dscode profile and restart; run dscode update --force-reinstall if runtime files are missing.' })
        const inspector = host.inspector?.()
        active(record, scope)
        const browser = host.browser?.()
        if (browser !== undefined) findings.push({ status: browser.executable === undefined || !browser.sandbox || browser.sandboxWarning !== undefined ? 'WARN' : 'OK', name: 'Browser',
          detail: ['on (' + String(browser.sessions) + ' open)', ...browserFacts(browser).map(fact => fact.replace(/\.$/, ''))].join('; ')
            + '. Browser state is isolated; network and host access are not confined.' })
        const remote = host.remote?.()
        if (remote !== undefined) findings.push({ status: remote.connected ? 'INFO' : 'ERROR', name: 'Remote workspace', detail: `ssh ${remote.host}:${remote.workspace}`
          + (remote.helperHash === undefined ? '' : `; helper sha256 ${remote.helperHash}`)
          + (remote.connected
            ? '. Tools, shells and file edits run there; session paths are never opened on this computer. Losing the SSH connection needs a leader restart.'
            : '. NOT connected: no tool can run. Check the SSH alias, helper and digests, then restart dscode.') })
        const hostTeamRows = await host.hostTeamRows?.() ?? []
        active(record, scope)
        if (hostTeamRows.length > 0) findings.push({ status: 'WARN', name: 'Agent Teams', detail: `Host-level Team tools (${hostTeamRows.join(', ')})`
          + ' give every session Team tools beside its own delegation tools. Remove the profile or bundle that added them; dscode mounts Team tools only in the teams preset.' })
        if (inspector !== undefined) findings.push({ status: 'WARN', name: 'Developer Inspector', detail:
          `Full host debugger access on loopback; do not forward its port. Fetch capture ${inspector.captureFetch ? 'ON (raw secrets may be retained)' : 'off'}. Open in Chrome: ${inspector.url}` })
        return { text: ['Dscode runtime diagnostics', ...findings.map(f => `[${f.status}] ${f.name}: ${f.detail}`)].join('\n\n') }
      })
    },
    terminals(clientId: number, params: unknown) {
      return accept(clientId, params, 'terminals', async (record, p, scope) => {
        const terminals = host.terminals(record)
        active(record, scope)
        if (terminals === undefined) throw invalidParams('Persistent terminals are unavailable. Run /doctor.')
        const action = p.action ?? 'list'
        if (typeof action !== 'string' || !['list', 'interrupt', 'close'].includes(action)) throw invalidParams('Unknown terminal action')
        let id: TerminalSessionId | undefined
        if (p.terminalId !== undefined && p.terminalId !== null) {
          if (typeof p.terminalId !== 'string') throw invalidParams('Invalid terminal id')
          const roster = terminals.list(record.agent)
          active(record, scope)
          if (roster.some(item => item.sessionId === p.terminalId)) id = TerminalSessionId(p.terminalId)
          else if (action !== 'list') throw invalidParams('Unknown terminal in this session. Refresh the list.')
          // Missing/foreign selection only refreshes the owned roster. Never
          // read it, nor trap polling when the model already closed that PTY.
        }
        if (action !== 'list') {
          if (id === undefined) throw invalidParams('Select a terminal first.')
          if (action === 'interrupt') await terminals.signal(record.agent, id, 'SIGINT')
          else { await terminals.kill(record.agent, id, 'closed from Tasks'); id = undefined }
          active(record, scope)
        }
        const roster = terminals.list(record.agent)
        active(record, scope)
        return { title: 'Persistent terminals', items: roster.map(item => {
          active(record, scope)
          const output = item.sessionId === id ? terminals.read(record.agent, item.sessionId, { count: 1000 }) : undefined
          active(record, scope)
          const state = item.status.kind === 'running' ? 'shell alive' : `exited (${item.status.exitCode ?? item.status.signal ?? 'unknown'})`
          return { id: String(item.sessionId),
            text: [item.name ?? item.sessionId, ...output === undefined ? [] : [
              `Lines ${output.lineBegin}–${output.lineEnd} of ${output.totalLines}${output.truncated ? ' (retained tail)' : ''}`, output.text,
            ]].join('\n'),
            detail: `${item.sessionId} · ${item.type} · ${state}${item.pid === undefined ? '' : ` · PID ${item.pid}`}`, editable: false }
        }) }
      })
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => { while (pending.size > 0) await Promise.allSettled([...pending]) })
      shutdown.abort()
      return disposal
    },
  }
}
