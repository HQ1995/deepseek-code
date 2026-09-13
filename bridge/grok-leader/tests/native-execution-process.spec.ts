import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionWork } from '../src/session-work.ts'

const processAdapter = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(() => {}, { [promisify.custom]: processAdapter.execute }) }
})
import { createNativeExecution } from '../src/native-execution.ts'

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture() {
  const child = new EventEmitter()
  let resolve!: (value: { stdout: string }) => void, reject!: (error: unknown) => void
  const result = new Promise<{ stdout: string }>((yes, no) => { resolve = yes; reject = no })
  let signal!: AbortSignal
  processAdapter.execute.mockReset().mockImplementation((executable: string, args: string[], options: { signal: AbortSignal; env: Record<string, string>; timeout: number; maxBuffer: number }) => {
    expect(executable).toBe(process.execPath)
    expect(args[0]).toMatch(/\/bin\/doctor\.mjs$/)
    expect(args.slice(1)).toEqual(['--json', '--runtime-only'])
    expect(options.timeout).toBe(20000); expect(options.maxBuffer).toBe(128 * 1024)
    expect(options.env.DSH_PROFILE_DIR).toBe('/isolated-profile')
    expect(options.env.DSCODE_DOCTOR_TUI_VERSION).toBe('1.2.3')
    signal = options.signal
    signal.addEventListener('abort', () => reject(new Error('process abort requested')), { once: true })
    return Object.assign(result, { child })
  })
  const record = { clientId: 1, agent: { session: { id: SessionId('one'), header: {} } } as Agent,
    work: createSessionWork({ isLive: () => true, assertReady: () => {} }) }
  const subprocess = vi.fn(() => undefined)
  const execution = createNativeExecution({
    owned: (id, sessionId) => id === 1 && sessionId === 'one' ? record : undefined,
    subprocess, terminals: () => undefined, toolNames: () => new Set(), profileDirectory: () => '/isolated-profile',
  })
  const doctor = () => execution.doctor(1, { sessionId: 'one', tuiVersion: '1.2.3' })
  return { child, resolve, record, subprocess, execution, doctor, signal: () => signal }
}

describe('diagnostic child-process completion', () => {
  it('drains an actually spawned diagnostic process before completing module shutdown', async () => {
    const native = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const execute = promisify(native.execFile), f = fixture(), events: string[] = []
    let child: import('node:child_process').ChildProcess | undefined
    processAdapter.execute.mockImplementation((...args: Parameters<typeof execute>) => {
      const request = execute(...args)
      child = request.child
      child.once('close', () => { events.push('process closed') })
      return request
    })
    const request = f.doctor(), rejected = expect(request).rejects.toThrow('disposed')
    expect(child?.pid).toBeGreaterThan(0)
    const closing = f.execution.dispose().then(() => { events.push('module drained') })
    await rejected; await closing; await f.record.work.dispose()
    expect(events).toEqual(['process closed', 'module drained'])
    expect(f.subprocess).not.toHaveBeenCalled()
  })

  it('waits for process close, not only the execFile result callback', async () => {
    const f = fixture()
    let done = false
    const request = f.doctor().then(value => { done = true; return value })
    f.resolve({ stdout: '[]' }); await tick()
    const early = done, continuedEarly = f.subprocess.mock.calls.length
    f.child.emit('close', 0)
    await expect(request).resolves.toHaveProperty('text')
    await f.execution.dispose(); await f.record.work.dispose()
    expect(early).toBe(false); expect(continuedEarly).toBe(0)
  })

  it.each(['session', 'module'])('%s cancellation drains the real child close after early execFile rejection', async owner => {
    const f = fixture()
    const request = f.doctor(), rejected = expect(request).rejects.toThrow(owner === 'session' ? 'session closed' : 'disposed')
    let done = false
    if (owner === 'session') f.record.work.cancel()
    const disposal = (owner === 'session' ? f.record.work.settle() : f.execution.dispose()).then(() => { done = true })
    await tick(); const early = done
    expect(f.signal().aborted).toBe(true)
    f.child.emit('close', null, 'SIGTERM')
    await rejected; await disposal; await f.execution.dispose(); await f.record.work.dispose()
    expect(early).toBe(false); expect(f.subprocess).not.toHaveBeenCalled()
    expect(processAdapter.execute.mock.calls.length).toBe(1)
  })
})
