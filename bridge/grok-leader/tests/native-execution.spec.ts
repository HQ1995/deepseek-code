import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { BrowserStatus } from '../src/browser-control.ts'
import { createNativeExecution, type NativeTerminals } from '../src/native-execution.ts'
import { createSessionWork } from '../src/session-work.ts'
import { tick } from './support/async.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
function fixture() {
  const ready = { value: true }, live = { value: true }, terminalAvailable = { value: true }
  const agent = { session: { id: SessionId('one'), header: { agentPreset: 'standard' } } } as Agent
  const record = { clientId: 1, agent, work: createSessionWork({ isLive: () => live.value,
    assertReady: () => { if (!ready.value) throw new Error('initializing') } }) }
  let current: typeof record | undefined = record
  const rows: ReturnType<NativeTerminals['list']> = [{ sessionId: TerminalSessionId('pty'), name: 'shell', type: 'shell', pid: 42, status: { kind: 'running' } }]
  const terminals = {
    list: vi.fn<NativeTerminals['list']>(() => rows),
    read: vi.fn<NativeTerminals['read']>(() => ({ text: 'tail', lineBegin: 1, lineEnd: 3, totalLines: 3, truncated: true })),
    listBackends: vi.fn<NativeTerminals['listBackends']>(() => ['shell']),
    signal: vi.fn<NativeTerminals['signal']>(async () => ({ delivered: true, targetPgid: 42 })),
    kill: vi.fn<NativeTerminals['kill']>(async () => { rows.length = 0; return true }),
  }
  const subprocess = { resolveExecutable: vi.fn(async (command: string, _env: Record<string, string>, _signal: AbortSignal) => '/host/bin/' + command), spawnTerminal: vi.fn() }
  const host = {
    owned: vi.fn((clientId: number, id: SessionId | undefined) => clientId === 1 && id === 'one' ? current : undefined),
    terminals: vi.fn((_record: typeof record) => terminalAvailable.value ? terminals : undefined),
    subprocess: vi.fn((_record: typeof record) => subprocess),
    toolNames: vi.fn((_record: typeof record) => new Set(['lsp', 'terminal_open'])),
    profileDirectory: vi.fn(() => '/profile'),
    inspector: vi.fn<() => { url: string; captureFetch: boolean } | undefined>(() => undefined),
    browser: vi.fn<() => BrowserStatus | undefined>(() => undefined),
    hostTeamRows: vi.fn(async (): Promise<readonly string[]> => []),
    remote: vi.fn((): { host: string; workspace: string; helperHash?: string; connected: boolean } | undefined => undefined),
    plugins: vi.fn(async (): Promise<ReadonlyArray<{ status: string; name: string; detail: string }>> => []),
  }
  const installation = vi.fn(async (_version: string, _directory: string | undefined, _signal: AbortSignal) => JSON.stringify([{ status: 'OK', name: 'Runtime', detail: 'pinned' }]))
  const execution = createNativeExecution(host, installation)
  stops.push(async () => { await execution.dispose(); await record.work.dispose() })
  const doctor = (extra: object = {}) => execution.doctor(1, { sessionId: 'one', tuiVersion: '0.0.14-alpha.12', ...extra })
  const control = (extra: object = {}) => execution.terminals(1, { sessionId: 'one', ...extra })
  return { execution, record, ready, live, terminalAvailable, rows, terminals, subprocess, host, installation, doctor, control,
    replace: () => { current = { ...record } } }
}

describe('native execution ownership', () => {
  it('advertises only an explicitly mounted Inspector and warns about raw capture', async () => {
    const f = fixture()
    expect((await f.doctor()).text).not.toContain('Developer Inspector')
    f.host.inspector.mockReturnValue({ url: 'devtools://fixture', captureFetch: false })
    expect((await f.doctor()).text).toContain('Fetch capture off. Open in Chrome: devtools://fixture')
    f.host.inspector.mockReturnValue({ url: 'devtools://fixture', captureFetch: true })
    expect((await f.doctor()).text).toContain('ON (raw secrets may be retained)')
  })
  it('names the remote workspace of an SSH profile', async () => {
    const f = fixture()
    expect((await f.doctor()).text).not.toContain('Remote workspace')
    f.host.remote.mockReturnValue({ host: 'swoop', workspace: '/home/u/work', helperHash: 'abc', connected: true })
    expect((await f.doctor()).text).toContain('[INFO] Remote workspace: ssh swoop:/home/u/work; helper sha256 abc. Tools, shells and file edits run there')
    f.host.remote.mockReturnValue({ host: 'swoop', workspace: '/home/u/work', connected: false })
    expect((await f.doctor()).text).toContain('[ERROR] Remote workspace: ssh swoop:/home/u/work. NOT connected')
  })
  it('warns about host-level Team tools rows, which reach every session', async () => {
    const f = fixture()
    expect((await f.doctor()).text).not.toContain('Agent Teams')
    f.host.hostTeamRows.mockResolvedValue(['host-tool-agent-team'])
    expect((await f.doctor()).text).toContain('[WARN] Agent Teams: Host-level Team tools (host-tool-agent-team) give every session Team tools')
  })
  it('reports plugin rows that did not activate right after the installation checks', async () => {
    const f = fixture()
    f.host.plugins.mockResolvedValue([{ status: 'ERROR', name: 'Plugin row auto-review', detail: 'x failed: boom.' }])
    expect((await f.doctor()).text).toContain('[OK] Runtime: pinned\n\n[ERROR] Plugin row auto-review: x failed: boom.\n\n[')
    f.host.plugins.mockRejectedValue(new Error('loader gone'))
    expect((await f.doctor()).text).toContain('[WARN] Plugin rows: Could not read the Loader: loader gone')
  })
  it('reports the browser only while its row is on, and warns without an executable or sandbox', async () => {
    const f = fixture()
    expect((await f.doctor()).text).not.toContain('] Browser:')
    const on: BrowserStatus = { executable: '/opt/chrome', executableSource: 'discovered', sandbox: true, anyOrigin: false, origins: ['https://example.com'], sessions: 1 }
    f.host.browser.mockReturnValue(on)
    expect((await f.doctor()).text).toContain('[OK] Browser: on (1 open); executable: /opt/chrome (discovered); sandbox: on; allowed origins: https://example.com. Browser state')
    f.host.browser.mockReturnValue({ ...on, sandbox: false })
    expect((await f.doctor()).text).toContain('[WARN] Browser: on (1 open)')
    f.host.browser.mockReturnValue({ ...on, sandboxWarning: 'this host restricts unprivileged user namespaces' })
    expect((await f.doctor()).text).toContain('[WARN] Browser: on (1 open); executable: /opt/chrome (discovered); sandbox: on; sandbox may not start: this host restricts')
    f.host.browser.mockReturnValue({ ...on, executable: undefined, executableError: 'No Chrome or Chromium was found.' })
    expect((await f.doctor()).text).toContain('[WARN] Browser: on (1 open); executable: none. No Chrome or Chromium was found; sandbox: on')
  })
  it('reads installation and execution-host diagnostics without starting a model, shell or language server', async () => {
    const f = fixture(), result = await f.doctor()
    expect(result.text).toContain('[OK] Runtime: pinned')
    expect(result.text).toContain('[OK] Shipped LSP preset: typescript-language-server and tsc resolve in the execution host')
    expect(result.text).toContain('LSP enabled; terminal enabled')
    expect(result.text).toContain('[OK] PTY backend: shell backend registered; 1 terminals owned by this session')
    expect(f.host.profileDirectory).toHaveBeenCalledOnce()
    expect(f.installation).toHaveBeenCalledWith('0.0.14-alpha.12', '/profile', expect.any(AbortSignal))
    expect(f.subprocess.resolveExecutable.mock.calls.map(call => call[0])).toEqual(['typescript-language-server', 'tsc'])
    expect(f.terminals.list).toHaveBeenCalledWith(f.record.agent)
    expect(f.subprocess.spawnTerminal).not.toHaveBeenCalled()
    expect(f.terminals.read).not.toHaveBeenCalled()
  })

  it.each(['standard', 'lsp'])('distinguishes optional LSP dependencies in the %s preset', async preset => {
    const f = fixture(); f.record.agent.session.header.agentPreset = preset
    f.subprocess.resolveExecutable.mockRejectedValue(new Error('not found'))
    f.terminals.listBackends.mockReturnValue([])
    const result = await f.doctor()
    expect(result.text).toContain(`[${preset === 'lsp' ? 'ERROR' : 'INFO'}] Shipped LSP preset: Optional dependencies missing`)
    expect(result.text).toContain('[WARN] PTY backend: Shell backend or subprocess PTY support is unavailable')
    expect(f.terminals.list).not.toHaveBeenCalled()
  })

  it.each(['not json', '{}', '[null]', '[{"status":"OK"}]'])('reports malformed installation findings without hiding execution-host diagnostics (%s)', async contents => {
    const f = fixture(); f.installation.mockResolvedValue(contents)
    const result = await f.doctor()
    expect(result.text).toContain('[ERROR] Installation checks: Could not finish.')
    expect(result.text).toContain('[OK] PTY backend:')
  })

  it('validates ownership, input readiness and version before any execution-host reads', async () => {
    const f = fixture()
    await expect(f.execution.doctor(2, { sessionId: 'one' })).rejects.toThrow('owned sessionId')
    await expect(f.execution.terminals(1, {})).rejects.toThrow('owned sessionId')
    await expect(f.doctor({ tuiVersion: '1.2.3; invalid' })).rejects.toThrow('Invalid TUI version')
    f.ready.value = false
    await expect(f.doctor()).rejects.toThrow('initializing')
    await expect(f.control()).rejects.toThrow('initializing')
    expect(f.installation).not.toHaveBeenCalled(); expect(f.host.terminals).not.toHaveBeenCalled()
  })

  it('does not continue a cancelled installation read even when the same session becomes usable again', async () => {
    const f = fixture(), gate = Promise.withResolvers<string>()
    f.installation.mockReturnValueOnce(gate.promise)
    const read = f.doctor(), rejected = expect(read).rejects.toThrow('session closed')
    f.record.work.cancel()
    expect(f.installation.mock.calls[0]![2].aborted).toBe(true)
    gate.resolve('[]'); await rejected
    expect(f.host.subprocess).not.toHaveBeenCalled(); expect(f.host.toolNames).not.toHaveBeenCalled()
    await expect(f.doctor()).resolves.toHaveProperty('text')
  })

  it('does not issue the second executable lookup or later projections after cancellation during the first', async () => {
    const f = fixture(), gate = Promise.withResolvers<string>()
    f.subprocess.resolveExecutable.mockReturnValueOnce(gate.promise)
    const read = f.doctor(), rejected = expect(read).rejects.toThrow('session closed')
    await tick(); expect(f.subprocess.resolveExecutable).toHaveBeenCalledOnce()
    f.record.work.cancel(); gate.resolve('/late'); await rejected
    expect(f.subprocess.resolveExecutable).toHaveBeenCalledOnce()
    expect(f.host.toolNames).not.toHaveBeenCalled(); expect(f.host.terminals).not.toHaveBeenCalled()
  })

  it('aborts and drains an installation read that synchronously reenters module disposal', async () => {
    const f = fixture(), gate = Promise.withResolvers<string>()
    let disposal!: Promise<void>, done = false
    f.installation.mockImplementationOnce(() => {
      disposal = f.execution.dispose(); void disposal.then(() => { done = true }); return gate.promise
    })
    const read = f.doctor(), rejected = expect(read).rejects.toThrow('disposed')
    await tick(); const early = done
    expect(f.installation.mock.calls[0]![2].aborted).toBe(true)
    gate.resolve('[]'); await rejected; await disposal
    expect(early).toBe(false); expect(f.execution.dispose()).toBe(disposal)
    expect(f.host.subprocess).not.toHaveBeenCalled()
  })

  it('projects only the selected owned retained tail and keeps reads non-consuming', async () => {
    const f = fixture()
    const result = await f.control({ terminalId: 'pty' })
    expect(result).toEqual({ title: 'Persistent terminals', items: [{ id: 'pty', text: 'shell\nLines 1–3 of 3 (retained tail)\ntail', detail: 'pty · shell · shell alive · PID 42', editable: false }] })
    expect(f.terminals.read).toHaveBeenCalledWith(f.record.agent, 'pty', { count: 1000 })
    expect(f.terminals.signal).not.toHaveBeenCalled(); expect(f.terminals.kill).not.toHaveBeenCalled()
    f.terminals.read.mockClear()
    await expect(f.control({ terminalId: 'foreign' })).resolves.toMatchObject({ items: [{ id: 'pty', text: 'shell' }] })
    expect(f.terminals.read).not.toHaveBeenCalled()
    f.rows[0]!.status = { kind: 'exited', exitCode: null, signal: 'SIGTERM' }
    expect((await f.control()).items[0]?.detail).toContain('exited (SIGTERM)')
  })

  it('rejects unsupported actions and foreign selections without sending a signal', async () => {
    const f = fixture()
    await expect(f.control({ action: { toString: () => 'list' } })).rejects.toThrow('Unknown terminal action')
    await expect(f.control({ action: 'close' })).rejects.toThrow('Select a terminal')
    await expect(f.control({ action: 'interrupt', terminalId: 'foreign' })).rejects.toThrow('Unknown terminal')
    await expect(f.control({ terminalId: 12 })).rejects.toThrow('Invalid terminal id')
    expect(f.terminals.kill).not.toHaveBeenCalled(); expect(f.terminals.signal).not.toHaveBeenCalled()
    f.terminalAvailable.value = false
    await expect(f.control()).rejects.toThrow('Persistent terminals are unavailable')
  })

  it('checks the exact owner again when a native roster getter reenters cancellation', async () => {
    const f = fixture()
    f.terminals.list.mockImplementationOnce(() => { f.record.work.cancel(); return f.rows })
    await expect(f.control({ action: 'close', terminalId: 'pty' })).rejects.toThrow('session closed')
    expect(f.terminals.kill).not.toHaveBeenCalled()
    f.host.terminals.mockImplementationOnce(() => { f.replace(); return f.terminals })
    await expect(f.control()).rejects.toThrow('session closed')
    expect(f.terminals.list).toHaveBeenCalledOnce()
  })

  it('awaits native interruption and close before refreshing the owned roster', async () => {
    const f = fixture(), gate = Promise.withResolvers<{ delivered: true; targetPgid: number }>()
    f.terminals.signal.mockReturnValueOnce(gate.promise)
    const interrupt = f.control({ action: 'interrupt', terminalId: 'pty' })
    await tick(); expect(f.terminals.list).toHaveBeenCalledOnce()
    expect(f.terminals.read).not.toHaveBeenCalled()
    gate.resolve({ delivered: true, targetPgid: 42 }); await interrupt
    expect(f.terminals.signal).toHaveBeenCalledWith(f.record.agent, 'pty', 'SIGINT')
    await expect(f.control({ action: 'close', terminalId: 'pty' })).resolves.toMatchObject({ items: [] })
    expect(f.terminals.kill).toHaveBeenCalledWith(f.record.agent, 'pty', 'closed from Tasks')
  })

  it('preserves a native close failure and leaves subsequent reads usable', async () => {
    const f = fixture(), failure = new Error('native close failed')
    f.terminals.kill.mockRejectedValueOnce(failure)
    await expect(f.control({ action: 'close', terminalId: 'pty' })).rejects.toBe(failure)
    await expect(f.control()).resolves.toMatchObject({ items: [{ id: 'pty' }] })
  })

  it('drains an uncancellable native kill on module close without issuing another kill or a late read', async () => {
    const f = fixture(), gate = Promise.withResolvers<boolean>()
    let disposal!: Promise<void>, done = false
    f.terminals.kill.mockImplementationOnce(() => {
      disposal = f.execution.dispose(); void disposal.then(() => { done = true }); return gate.promise
    })
    const closing = f.control({ action: 'close', terminalId: 'pty' }), rejected = expect(closing).rejects.toThrow('disposed')
    await tick(); const early = done
    gate.resolve(true); await rejected; await disposal
    expect(early).toBe(false); expect(f.terminals.kill).toHaveBeenCalledOnce()
    expect(f.terminals.list).toHaveBeenCalledOnce(); expect(f.terminals.read).not.toHaveBeenCalled()
    await expect(f.control()).rejects.toThrow('disposed')
  })
})
