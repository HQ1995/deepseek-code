import { describe, expect, it, vi } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createNativeTasks } from '../src/native-tasks.ts'
import { createSessionWork } from '../src/session-work.ts'

type Job = { id: string; kind: string; label: string; ownerSession: string; status: 'running' | 'stopping' | 'completed' | 'killed'; startedAt: number; finishedAt?: number }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture() {
  const sessions = new Map<SessionId, ReturnType<typeof session>>()
  function session(id: string, clientId = 1) {
    const events: SessionEvent[] = []
    const record = { clientId, agent: { ctx: { get: () => undefined }, session: { id: SessionId(id), header: { cwd: '/workspace' }, ownEvents: () => events } } as unknown as Agent,
      output: { notify: vi.fn(), update: vi.fn() }, events,
      work: createSessionWork({ isLive: () => sessions.get(SessionId(id)) === record, assertReady: () => {} }) }
    return record
  }
  const add = (id: string, clientId = 1) => {
    const record = session(id, clientId)
    sessions.set(record.agent.session.id, record)
    return record
  }
  const owner = add('owner'), other = add('other', 2)
  const rows: Job[] = []
  const outputs = new Map<string, string>()
  const listeners = new Set<(owner?: Agent) => void>()
  const unsubscribe = vi.fn()
  const jobs = {
    list: vi.fn((agent: Agent) => rows.filter(row => row.ownerSession === agent.session.id)),
    get: vi.fn((id: string, agent: Agent) => {
      const job = rows.find(row => row.id === id && row.ownerSession === agent.session.id)
      if (job === undefined) throw new Error('unknown native job')
      return job
    }),
    kill: vi.fn((id: string, agent: Agent, _reason?: string): 'requested' | 'already-finished' => { jobs.get(id, agent).status = 'stopping'; return 'requested' }),
    wait: vi.fn(async (id: string, _timeout: number, agent: Agent) => jobs.get(id, agent)),
    onJobsChanged: vi.fn((listener: (owner?: Agent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    }),
    read: vi.fn(() => { throw new Error('must not consume the model cursor') }),
  }
  const names = new Set(['schedule_list', 'schedule_create', 'schedule_delete'])
  const execute = vi.fn(async (_request: unknown): Promise<unknown> => ({ isError: false, value: [] }))
  const output = vi.fn((_registry: object, agent: Agent, id: string) => outputs.get(agent.session.id + ':' + id))
  const warn = vi.fn()
  const host = { sessions, owned: (clientId: number, id: SessionId | undefined) => {
    const record = id === undefined ? undefined : sessions.get(id)
    return record?.clientId === clientId ? record : undefined
  }, jobs: vi.fn((_record: typeof owner): unknown => ({ [symbols.original]: { [symbols.original]: jobs } })),
  tools: (_record: typeof owner) => ({ runtime: { execute } as Pick<ToolRuntime, 'execute'>, names }), output, logger: { warn } }
  const tasks = createNativeTasks(host)
  const job = (id: string, record = owner, status: Job['status'] = 'running') => {
    const row: Job = { id, kind: 'bash', label: 'build ' + id, ownerSession: record.agent.session.id, status, startedAt: 1234 }
    rows.push(row); return row
  }
  const change = (record = owner) => { for (const listener of listeners) listener(record.agent) }
  const request = (taskId: string, record = owner) => ({ sessionId: record.agent.session.id, taskId, source: 'clientUi' })
  const append = (data: unknown, record = owner) => {
    const event = { seq: record.events.length, time: 1000, type: 'schedule/change', data } as SessionEvent
    record.events.push(event); return event
  }
  return { tasks, owner, other, sessions, add, rows, outputs, jobs, host, output, listeners, unsubscribe, change, job, request, names, execute, append, warn }
}

describe('native task ownership', () => {
  it('session cancellation aborts a reminder and prevents the following list even if the owner is live again', async () => {
    const f = fixture(), held = deferred<unknown>()
    let signal!: AbortSignal
    f.execute.mockImplementationOnce(request => { signal = (request as { signal: AbortSignal }).signal; return held.promise })
    const operation = f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner', text: 'after 10m check build' })
    const rejected = expect(operation).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce())
    f.owner.work.cancel()
    expect(signal.aborted).toBe(true)
    held.resolve({ isError: false, value: {} })
    await rejected; await f.owner.work.settle()
    expect(f.execute).toHaveBeenCalledOnce()
    await f.tasks.dispose()
  })

  it('aborts and drains a reminder whose native executor synchronously starts disposal', async () => {
    const f = fixture(), held = deferred<unknown>(), entered = deferred<void>()
    let disposal!: Promise<void>, done = false, signal!: AbortSignal
    f.execute.mockImplementationOnce(async request => {
      signal = (request as { signal: AbortSignal }).signal
      disposal = Promise.resolve(f.tasks.dispose())
      void disposal.then(() => { done = true })
      entered.resolve()
      return held.promise
    })
    const work = f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner', text: 'after 1m check' })
    const rejected = expect(work).rejects.toThrow('session closed')
    await entered.promise; await Promise.resolve()
    try {
      expect(done).toBe(false)
      expect(signal.aborted).toBe(true)
    } finally { held.resolve({ isError: false, value: {} }) }
    await rejected; await disposal
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
  })

  it('drains an accepted producer settlement without issuing another kill during disposal', async () => {
    const f = fixture(), row = f.job('one'), held = deferred<Job>()
    f.jobs.wait.mockImplementationOnce(() => held.promise)
    const work = f.tasks.kill(1, f.request('one'))
    const rejected = expect(work).rejects.toThrow('session closed')
    let done = false
    const disposal = Promise.resolve(f.tasks.dispose()).then(() => { done = true })
    await Promise.resolve()
    try { expect(done).toBe(false) } finally { held.resolve({ ...row, status: 'killed' }) }
    await rejected; await disposal
    expect(f.jobs.kill).toHaveBeenCalledTimes(1)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
  })

  it('shares one subscription across fresh Cordis proxies and scopes push/output to the native owner', async () => {
    const f = fixture()
    f.job('one'); f.job('two', f.other)
    f.tasks.snapshot(f.owner); f.tasks.snapshot(f.other); f.tasks.poll()
    expect(f.jobs.onJobsChanged).toHaveBeenCalledTimes(1)
    expect(f.owner.output.notify).toHaveBeenCalledTimes(1)
    expect(f.other.output.notify).toHaveBeenCalledTimes(1)
    f.job('three'); f.change()
    expect(f.owner.output.notify).toHaveBeenCalledTimes(2)
    expect(f.other.output.notify).toHaveBeenCalledTimes(1)
    expect(() => f.tasks.output(2, f.request('one'))).toThrow('unknown session')
    expect(() => f.tasks.output(1, f.request('two'))).toThrow('unknown native job')
    expect(f.jobs.read).not.toHaveBeenCalled()
    expect(f.output.mock.calls.every(([registry]) => registry === f.jobs)).toBe(true)
    await f.tasks.dispose()
  })

  it('deduplicates passive output and stops rescanning settled immutable producers', async () => {
    const f = fixture(), row = f.job('one')
    f.tasks.poll(); f.tasks.poll()
    expect(f.owner.output.notify).toHaveBeenCalledTimes(1)
    f.outputs.set('owner:one', 'first')
    f.tasks.poll(); f.tasks.poll()
    expect(f.owner.output.update).toHaveBeenCalledTimes(1)
    f.outputs.set('owner:one', 'first\nlast')
    Object.assign(row, { status: 'completed', finishedAt: 2345 })
    f.change()
    expect(f.owner.output.notify).toHaveBeenLastCalledWith('x.ai/task_completed', { update: {
      sessionUpdate: 'task_completed', task_snapshot: expect.objectContaining({ output: 'first\nlast', completed: true,
        start_time: { secs_since_epoch: 1, nanos_since_epoch: 234000000 }, end_time: { secs_since_epoch: 2, nanos_since_epoch: 345000000 } }),
    } }, { nativeTask: { status: 'completed', kind: 'bash', outputAvailable: true } })
    const reads = f.output.mock.calls.length
    f.tasks.poll(); f.tasks.poll()
    expect(f.output).toHaveBeenCalledTimes(reads)
    expect(f.owner.output.update).toHaveBeenCalledTimes(1) // completion carries the authoritative final snapshot
    expect(f.tasks.output(1, f.request('one'))).toEqual({ taskId: 'one', status: 'completed', available: true, output: 'first\nlast' })
    await f.tasks.dispose()
  })

  it('keeps checking a settled producer until its final output becomes available', async () => {
    const f = fixture(); f.job('one', f.owner, 'completed')
    f.tasks.poll(); f.tasks.poll()
    expect(f.tasks.output(1, f.request('one'))).toEqual({ taskId: 'one', status: 'completed', available: false, output: '' })
    f.outputs.set('owner:one', '')
    f.tasks.poll()
    expect(f.owner.output.notify).toHaveBeenCalledTimes(2)
    expect(f.tasks.output(1, f.request('one'))).toMatchObject({ available: true, output: '' })
    await f.tasks.dispose()
  })

  it('distinguishes absent, exited, unsettled and producer-confirmed cancellation', async () => {
    const f = fixture(), row = f.job('one')
    f.job('foreign', f.other); f.job('done', f.owner, 'completed')
    await expect(f.tasks.kill(1, f.request('foreign'))).resolves.toEqual({ result: { taskId: 'foreign', outcome: 'not_found' } })
    await expect(f.tasks.kill(1, f.request('done'))).resolves.toMatchObject({ result: { outcome: 'already_exited' } })
    expect(f.jobs.kill).not.toHaveBeenCalled()
    await expect(f.tasks.kill(1, f.request('one'))).rejects.toThrow('producer has not settled')
    const finish = deferred<Job>()
    f.jobs.wait.mockImplementationOnce(() => finish.promise)
    const cancelled = f.tasks.kill(1, f.request('one'))
    expect(f.jobs.wait).toHaveBeenLastCalledWith('one', 5000, f.owner.agent)
    row.status = 'killed'; finish.resolve(row)
    await expect(cancelled).resolves.toMatchObject({ result: { outcome: 'killed' } })
    expect(f.jobs.kill).toHaveBeenCalledWith('one', f.owner.agent, 'clientUi')
    await f.tasks.dispose()
  })

  it('does not deliver a late cancellation result to a replaced owner', async () => {
    const f = fixture(), row = f.job('one'), finish = deferred<Job>()
    f.jobs.wait.mockImplementationOnce(() => finish.promise)
    const cancelled = f.tasks.kill(1, f.request('one'))
    f.add('owner')
    row.status = 'killed'; finish.resolve(row)
    await expect(cancelled).rejects.toThrow('session closed')
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    await f.tasks.dispose()
  })

  it('releases all registry subscriptions even if one fails and blocks stale listeners', async () => {
    const f = fixture()
    f.tasks.snapshot(f.owner)
    const stale = [...f.listeners][0]!
    const secondUnsubscribe = vi.fn()
    const second = { ...f.jobs, onJobsChanged: vi.fn(() => secondUnsubscribe) }
    f.host.jobs.mockImplementation(record => record === f.other ? second : f.jobs)
    f.tasks.snapshot(f.other)
    f.unsubscribe.mockImplementation(() => { throw new Error('native unsubscribe failed') })
    const disposal = f.tasks.dispose()
    await expect(disposal).rejects.toThrow('subscription disposal failed')
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
    f.job('late'); stale(f.owner.agent); f.tasks.poll(); f.tasks.snapshot(f.owner)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    expect(() => f.tasks.output(1, f.request('late'))).toThrow('unknown session')
    expect(f.tasks.dispose()).toBe(disposal)
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('retries failed registration and contains one broken registry on the shared heartbeat', async () => {
    const f = fixture(); f.job('one')
    f.jobs.onJobsChanged.mockImplementationOnce(() => { throw new Error('not ready') })
    f.tasks.poll()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('not ready'))
    f.tasks.poll()
    expect(f.jobs.onJobsChanged).toHaveBeenCalledTimes(2)
    expect(f.owner.output.notify).toHaveBeenCalledTimes(1)
    await f.tasks.dispose()
  })

  it('contains synchronous subscription reentry and disposal before registration returns', async () => {
    const f = fixture(); f.job('one')
    const stop = vi.fn()
    f.jobs.onJobsChanged.mockImplementationOnce(listener => {
      listener(f.owner.agent)
      void f.tasks.dispose()
      return stop
    })
    f.tasks.snapshot(f.owner)
    expect(f.jobs.onJobsChanged).toHaveBeenCalledOnce()
    expect(f.jobs.list).toHaveBeenCalledOnce()
    expect(f.owner.output.notify).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    f.tasks.poll()
    expect(f.jobs.list).toHaveBeenCalledOnce()
    await f.tasks.dispose()
  })

  it('replays active reminders and clears deleted IDs exactly once after reconnect', async () => {
    const f = fixture()
    const after = createAfterScheduleRecord(ScheduleId('once'), 'check', 600, 1000)
    const every = createEveryScheduleRecord(ScheduleId('repeat'), 'again', 300, 1000)
    f.append({ version: 1, operation: 'create', schedule: after })
    f.append({ version: 1, operation: 'delete', id: after.id })
    f.append({ version: 1, operation: 'create', schedule: every })
    f.tasks.snapshot(f.owner); f.tasks.snapshot(f.owner)
    expect(f.owner.output.notify).toHaveBeenCalledTimes(2)
    expect(f.owner.output.notify).toHaveBeenCalledWith('x.ai/session_notification', { update: {
      sessionUpdate: 'scheduled_task_created', task_id: 'repeat', prompt: 'again', human_schedule: 'every 300s', next_fire_at: every.scheduledAt,
    } }, { nativeSchedule: true })
    expect(f.owner.output.notify).toHaveBeenCalledWith('x.ai/session_notification', { update: {
      sessionUpdate: 'scheduled_task_deleted', task_id: 'once', reason: 'deleted',
    } }, { nativeSchedule: true })
    f.tasks.observe(f.owner, f.append({ version: 1, operation: 'delete', id: 'repeat' }))
    expect(f.owner.output.notify).toHaveBeenCalledTimes(3)
    await f.tasks.dispose()
  })

  it('parses reminder controls through the native tools without changing the prompt', async () => {
    const f = fixture()
    const cases = [
      ['after 10m check\nthe build', { after_seconds: 600, prompt: 'check\nthe build' }],
      ['every 5m check', { every_seconds: 300, prompt: 'check' }],
      ['at 2030-01-01T00:00:00Z check', { at: '2030-01-01T00:00:00Z', prompt: 'check' }],
    ] as const
    for (const [text, args] of cases) {
      await f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner', text })
      expect(f.execute).toHaveBeenNthCalledWith(f.execute.mock.calls.length - 1, expect.objectContaining({ name: 'schedule_create', arguments: args,
        agent: f.owner.agent, callId: expect.stringMatching(/^tui-/), signal: expect.any(AbortSignal) }))
      expect(f.execute).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'schedule_list' }))
    }
    const calls = f.execute.mock.calls.length
    for (const text of ['every 0m check', 'after 999999999999999999d check', 'weekly check', 'after 1h']) {
      await expect(f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner', text })).rejects.toThrow()
    }
    expect(f.execute).toHaveBeenCalledTimes(calls)
    f.execute.mockResolvedValueOnce({ isError: false, value: {} }).mockResolvedValueOnce({ isError: false, value: [{ id: 'repeat', prompt: 'check', state: 'waiting', scheduledAt: 'future', kind: 'every', everySeconds: 300 }] })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/delete', { sessionId: 'owner', taskId: 'once' })).resolves.toEqual({ title: 'Session reminders', items: [
      { id: 'repeat', text: 'check', detail: 'waiting · future · every 300s', editable: false },
    ] })
    await f.tasks.dispose()
  })

  it('enforces reminder availability/ownership and preserves native errors', async () => {
    const f = fixture(), request = { sessionId: 'owner' }
    await expect(f.tasks.reminders(2, 'x.ai/scheduler/list', request)).rejects.toThrow('unknown session')
    f.names.clear()
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toThrow('unavailable')
    expect(f.execute).not.toHaveBeenCalled()
    f.names.add('schedule_list')
    f.execute.mockResolvedValueOnce({ isError: true, error: { message: 'native failure' } })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toMatchObject({ code: -32603, message: 'native failure' })
    f.execute.mockResolvedValueOnce({ isError: false, value: { code: 'invalid_rule', message: 'too frequent' } })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toMatchObject({ code: -32602, message: 'too frequent' })
    f.execute.mockResolvedValueOnce({ isError: false, value: {} })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toThrow('Invalid reminder list')
    await f.tasks.dispose()
  })

  it.each(['replaced', 'disposed'])('rejects late reminder results after the owner is %s', async action => {
    const f = fixture(), finish = deferred<unknown>()
    f.execute.mockImplementationOnce(() => finish.promise)
    const request = f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner', text: 'after 1m check' })
    const disposal = action === 'disposed' ? f.tasks.dispose() : undefined
    if (action !== 'disposed') { f.add('owner'); f.tasks.poll() }
    expect((f.execute.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true)
    finish.resolve({ isError: false, value: {} })
    await expect(request).rejects.toThrow('session closed')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    await disposal
    await f.tasks.dispose()
  })
})
