import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createNativeInteractions } from '../src/native-interactions.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())) })
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const allowed = { outcome: { outcome: 'selected', optionId: 'allow-once' } }
function fixture() {
  const record = (id: string, clientId = 1) => ({ agent: { session: { id: SessionId(id) } } as Agent, clientId, yolo: false, queue: { cancel: vi.fn() }, work: { cancel: vi.fn() } })
  const root = record('root'), other = record('other', 2)
  const sessions = new Map([[root.agent.session.id, root], [other.agent.session.id, other]])
  const replies = vi.fn(async (): Promise<unknown> => allowed)
  const request = vi.fn((method: string, params: unknown, sessionId?: string, deadline?: number, signal?: AbortSignal): Promise<unknown> => {
    void [method, params, sessionId, deadline]
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('request cancelled'))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      void replies().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
    })
  })
  const client = { closed: false, request: <T>(...args: Parameters<typeof request>) => request(...args) as Promise<T>, rejectSessionRequests: vi.fn() }
  const clients = new Map([[1, client], [2, { ...client, rejectSessionRequests: vi.fn() }]])
  type Host = Parameters<typeof createNativeInteractions<typeof root>>[0]
  const listeners = new Map<string, (...args: never[]) => unknown>(), unsubscribes: Array<ReturnType<typeof vi.fn>> = []
  const on: Host['on'] = vi.fn((name, listener) => {
    listeners.set(name, listener as (...args: never[]) => unknown)
    const stop = vi.fn(() => { listeners.delete(name) }); unsubscribes.push(stop); return stop
  })
  const permission = { set: vi.fn() }, plan = { set: vi.fn() }, ready = vi.fn()
  const host: Host = {
    owned: (clientId, id) => { const r = id === undefined ? undefined : sessions.get(id); return r?.clientId === clientId ? r : undefined },
    ownedAgent: agent => { const r = sessions.get(agent.session.id); return r?.agent === agent ? r : undefined },
    assertReady: ready, client: id => clients.get(id), permissionPresets: () => permission, planMode: () => plan,
    on, logger: { warn: vi.fn() },
  }
  const interactions = createNativeInteractions(host)
  stops.push(() => interactions.dispose())
  const emit = <R>(name: string, ...args: unknown[]) => listeners.get(name)!(...args as never[]) as Promise<R>
  const approve = (r = root, signal?: AbortSignal) => emit<string>('approval/request', { agent: r.agent, callId: 'call', toolName: 'bash', signal }, async () => 'fallback')
  const ask = (signal?: AbortSignal) => emit<{ answers: unknown[] }>('user-questions/request', { agent: root.agent, signal,
    questions: [{ id: 'native-id', header: 'Title', question: 'Proceed?', detail: 'Detail', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No', description: 'Stop' }] }],
  }, async () => ({ answers: [] }))
  return { host, interactions, root, other, record, sessions, clients, client, permission, plan, ready, request, replies, listeners, unsubscribes, approve, ask, emit }
}

describe('native interaction ownership', () => {
  it('routes one-shot approvals to the exact owner and preserves unbounded human waits', async () => {
    const f = fixture(), gate = deferred()
    f.replies.mockReturnValue(gate.promise)
    const decision = f.approve()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    expect(f.request).toHaveBeenCalledWith('session/request_permission', {
      sessionId: 'root', toolCall: { toolCallId: 'call', displayName: 'bash' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
    }, 'root', Infinity, expect.any(AbortSignal))
    gate.resolve(allowed)
    await expect(decision).resolves.toBe('allowed-once')
    expect(await f.approve({ ...f.root, agent: { ...f.root.agent } })).toBe('fallback')
    expect(await f.emit('approval/request', { agent: f.root.agent }, async () => 'fallback')).toBe('fallback')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('rejects malformed grants, distinguishes human cancellation and catches transport failure', async () => {
    const f = fixture()
    for (const response of [null, [], {}, { outcome: null }, { outcome: { outcome: 'selected', optionId: 'allow-always' } }]) {
      f.replies.mockResolvedValueOnce(response)
      await expect(f.approve()).resolves.toBe('rejected')
    }
    f.replies.mockResolvedValueOnce({ outcome: { outcome: 'cancelled' } })
    await expect(f.approve()).resolves.toBe('cancelled')
    f.replies.mockRejectedValueOnce(new Error('connection ended'))
    await expect(f.approve()).resolves.toBe('cancelled')
  })

  it('preserves explicit permission precedence, native presets and plan state', async () => {
    const f = fixture()
    f.interactions.apply(f.root, { permissionMode: 'bypassPermissions', yoloMode: false })
    expect(f.permission.set).toHaveBeenLastCalledWith(f.root.agent.session, 'danger-full-access')
    await expect(f.approve()).resolves.toBe('allowed-once')
    expect(f.request).not.toHaveBeenCalled()
    f.interactions.notification(1, { params: { sessionId: 'root', permission_mode: 'plan', yolo_mode: true } })
    expect(f.root.yolo).toBe(false)
    expect(f.plan.set).toHaveBeenLastCalledWith(f.root.agent, true)
    expect(f.permission.set).toHaveBeenLastCalledWith(f.root.agent.session, 'workspace-write')
    f.interactions.notification(1, { sessionId: 'root', permission_mode: 'unknown', yolo_mode: true })
    expect(f.root.yolo).toBe(false)
    expect(f.plan.set).toHaveBeenLastCalledWith(f.root.agent, false)
    await expect(f.interactions.mode(1, { sessionId: 'root', modeId: 'plan' })).resolves.toEqual({})
    expect(f.plan.set).toHaveBeenLastCalledWith(f.root.agent, true)
  })

  it('validates metadata without silently weakening unsupported CLI policies', () => {
    const f = fixture(), validate = (meta: Record<string, unknown>) => f.interactions.validateMeta(meta, 'session/new')
    for (const key of ['yoloMode', 'autoMode', 'askUserQuestion', 'noReplay', 'rememberAgentPreset']) expect(() => validate({ [key]: 'yes' })).toThrow('must be a boolean')
    for (const key of ['permissionMode', 'sandbox']) expect(() => validate({ [key]: true })).toThrow('must be a string')
    for (const meta of [{ subagents: false }, { autoMode: true }, { askUserQuestion: false }, { sandbox: 'strict' }, { permissionMode: 'unknown' }, { tools: [] }, { disallowedTools: [] }, { rules: '' }, { systemPromptOverride: '' }]) expect(() => validate(meta)).toThrow()
    expect(() => validate({ permissionMode: 'ask', yoloMode: false, sandbox: 'off', autoMode: false, askUserQuestion: true, noReplay: true, rememberAgentPreset: false })).not.toThrow()
    expect(f.permission.set).not.toHaveBeenCalled()
  })

  it('validates missing plan capability before mutation and gates a failed partial native change', async () => {
    const f = fixture()
    f.root.yolo = true
    f.host.planMode = () => undefined
    expect(() => f.interactions.apply(f.root, { permissionMode: 'plan' })).toThrow('not available')
    expect(f.permission.set).not.toHaveBeenCalled()
    expect(f.root.yolo).toBe(true)
    f.host.planMode = () => f.plan
    f.plan.set.mockImplementationOnce(() => { throw new Error('native append failed') })
    expect(() => f.interactions.apply(f.root, { permissionMode: 'always-approve' })).toThrow('native append failed')
    expect(f.root.yolo).toBe(false)
    expect(() => f.interactions.assertReady(f.root)).toThrow('inconsistent')
    expect(f.root.queue.cancel).toHaveBeenCalledOnce()
    expect(f.permission.set).not.toHaveBeenCalled()
    await expect(f.approve()).resolves.toBe('cancelled')
    await expect(f.interactions.mode(1, { sessionId: 'root', modeId: 'default' })).rejects.toThrow('inconsistent')
    expect(f.request).not.toHaveBeenCalled()
  })

  it('denies notifications, mode writes and human requests while the owner is not ready', async () => {
    const f = fixture()
    f.ready.mockImplementation(() => { throw new Error('session is already reloading') })
    f.interactions.notification(1, { sessionId: 'root', permission_mode: 'always-approve' })
    await expect(f.interactions.mode(1, { sessionId: 'root', modeId: 'plan' })).rejects.toThrow('reloading')
    await expect(f.approve()).resolves.toBe('cancelled')
    await expect(f.ask()).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(f.permission.set).not.toHaveBeenCalled(); expect(f.plan.set).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
    f.ready.mockReset()
    await expect(f.approve()).resolves.toBe('allowed-once')
  })

  it('preserves native and cancellation failures while still cancelling pending answers', async () => {
    const f = fixture(), gate = deferred(), native = new Error('native permission write failed'), queue = new Error('queue cancel failed')
    f.replies.mockReturnValue(gate.promise)
    const decision = f.approve()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    f.permission.set.mockImplementationOnce(() => { throw native })
    f.root.queue.cancel.mockImplementationOnce(() => { throw queue })
    let result: unknown
    try { f.interactions.apply(f.root, { permissionMode: 'always-approve' }) } catch (error) { result = error }
    expect((result as AggregateError).errors).toEqual([native, queue])
    await expect(decision).resolves.toBe('cancelled')
    expect(f.client.rejectSessionRequests).toHaveBeenCalledWith('root')
    expect(() => f.interactions.assertReady(f.root)).toThrow('inconsistent')
    gate.resolve(allowed)
  })

  it('ignores foreign-client controls and closed clients without weakening another session', async () => {
    const f = fixture()
    f.interactions.notification(2, { sessionId: 'root', permission_mode: 'always-approve' })
    for (const payload of [null, [], 2, { params: null }]) f.interactions.notification(1, payload)
    await expect(f.interactions.mode(2, { sessionId: 'root', modeId: 'plan' })).rejects.toThrow('unknown session')
    f.client.closed = true; f.root.yolo = true
    await expect(f.approve()).resolves.toBe('cancelled')
    expect(f.permission.set).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
  })

  it('preserves flat question payload, native ids, multiline headings, multi-select and annotations', async () => {
    const f = fixture(), text = 'Title\nProceed?\nDetail'
    f.replies.mockResolvedValue({ outcome: 'accepted', answers: { [text]: ['Yes', 'Other', 2], unknown: ['No'] }, annotations: { [text]: { notes: 'custom\ntext' } } })
    await expect(f.ask()).resolves.toEqual({ answers: [{ id: 'native-id', selected: ['Yes'], custom: 'custom\ntext' }] })
    expect(f.request).toHaveBeenCalledWith('_x.ai/ask_user_question', {
      sessionId: 'root', toolCallId: expect.any(String), questions: [{ question: text, id: 'native-id', multiSelect: true,
        options: [{ label: 'Yes', description: '' }, { label: 'No', description: 'Stop' }] }], mode: 'default',
    }, 'root', Infinity, expect.any(AbortSignal))
    f.replies.mockResolvedValue({ outcome: 'accepted', answers: { [text]: 'No' }, annotations: null })
    await expect(f.ask()).resolves.toEqual({ answers: [{ id: 'native-id', selected: ['No'] }] })
    await expect(f.emit('user-questions/request', { questions: [] }, async () => ({ answers: ['fallback'] }))).resolves.toEqual({ answers: ['fallback'] })
  })

  it('fails closed on malformed question responses and preserves non-cancellation transport errors', async () => {
    const f = fixture()
    for (const response of [null, [], { outcome: 'cancelled' }, { outcome: 'chat_about_this' }, { outcome: 'skip_interview' }, { outcome: 'accepted', answers: [] }]) {
      f.replies.mockResolvedValueOnce(response)
      await expect(f.ask()).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    }
    f.replies.mockRejectedValueOnce(new Error('malformed peer'))
    await expect(f.ask()).rejects.toThrow('malformed peer')
  })

  it('invalidates already-resolved replies on cancellation even when the same owner becomes usable again', async () => {
    const f = fixture(), approval = deferred(), question = deferred()
    f.replies.mockReturnValueOnce(approval.promise).mockReturnValueOnce(question.promise)
    const decision = f.approve(), answer = f.ask()
    const cancelled = expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
    approval.resolve(allowed); question.resolve({ outcome: 'accepted', answers: { 'Title\nProceed?\nDetail': ['Yes'] } })
    f.interactions.cancel(1, 'root') // Reload failed; same record is still live.
    await expect(decision).resolves.toBe('cancelled'); await cancelled
    await expect(f.approve()).resolves.toBe('allowed-once')
    expect(f.client.rejectSessionRequests).toHaveBeenCalledWith('root')
  })

  it('rejects late answers for replacement agents and for disconnected owners', async () => {
    const f = fixture(), gate = deferred()
    f.replies.mockReturnValue(gate.promise)
    const decision = f.approve()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    f.sessions.set(f.root.agent.session.id, f.record('root'))
    gate.resolve(allowed)
    await expect(decision).resolves.toBe('cancelled')
    f.sessions.set(f.root.agent.session.id, f.root)
    f.replies.mockImplementationOnce(async () => { f.client.closed = true; return { outcome: 'accepted', answers: {} } })
    await expect(f.ask()).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('cancels only the native request signal, leaving sibling and other-session approvals live', async () => {
    const f = fixture(), abort = new AbortController(), gate = deferred()
    f.replies.mockReturnValue(gate.promise)
    const first = f.approve(f.root, abort.signal), sibling = f.approve(), other = f.approve(f.other)
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3))
    abort.abort()
    await expect(first).resolves.toBe('cancelled')
    expect(f.client.rejectSessionRequests).not.toHaveBeenCalled()
    gate.resolve(allowed)
    await expect(sibling).resolves.toBe('allowed-once'); await expect(other).resolves.toBe('allowed-once')
    const already = new AbortController(); already.abort()
    await expect(f.approve(f.root, already.signal)).resolves.toBe('cancelled')
    await expect(f.ask(already.signal)).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(f.request).toHaveBeenCalledTimes(3)
  })

  it('publishes accepted work before a request callback reenters disposal and stops every listener once', async () => {
    const f = fixture(), gate = deferred()
    let disposal: Promise<void> | undefined
    f.replies.mockImplementationOnce(() => { disposal = f.interactions.dispose(); return gate.promise })
    const decision = f.approve()
    await expect(decision).resolves.toBe('cancelled')
    expect(disposal).toBe(f.interactions.dispose())
    await disposal
    expect(f.unsubscribes.every(stop => stop.mock.calls.length === 1)).toBe(true)
    gate.reject(new Error('late peer failure')) // Must remain observed after cancellation.
  })

  it('drains pending questions and attempts all unsubscribe callbacks even when one throws', async () => {
    const f = fixture(), gate = deferred()
    f.replies.mockReturnValue(gate.promise)
    const answer = f.ask(), cancelled = expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    f.unsubscribes[0].mockImplementationOnce(() => { throw new Error('unsubscribe failed') })
    const stopped = f.interactions.dispose()
    await expect(stopped).rejects.toThrow('disposal failed'); await cancelled
    expect(f.unsubscribes.every(stop => stop.mock.calls.length === 1)).toBe(true)
    stops.pop() // The intentional disposal failure has already been asserted.
    gate.resolve(undefined)
  })

  it('rolls back a partial subscription setup without hiding cleanup errors', async () => {
    const f = fixture(), failure = new Error('subscription failed'), release = vi.fn(() => { throw new Error('cleanup failed') })
    await f.interactions.dispose()
    let calls = 0
    f.host.on = () => { if (calls++ === 0) return release; throw failure }
    let result: unknown
    try { createNativeInteractions(f.host) } catch (error) { result = error }
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([failure, expect.objectContaining({ message: 'cleanup failed' })])
    expect(release).toHaveBeenCalledOnce()
  })
})
