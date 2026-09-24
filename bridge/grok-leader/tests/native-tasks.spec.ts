import { describe, expect, it, vi } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import type { JobEvent, JobEventFilter } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ScheduleId, ScheduleInputError, createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord, createDailyScheduleRecord,
  createEveryScheduleRecord, createWeeklyScheduleRecord,
  type ScheduleCatalogEntry, type ScheduleCreateRequest, type ScheduleDeleteRequest, type ScheduleRecord,
} from '@deepseek-ai/dsh-schedule'
import { createNativeTasks } from '../src/native-tasks.ts'
import { createSessionWork } from '../src/session-work.ts'
import type { LegacyReminders } from '../src/legacy-reminders.ts'

type Job = { id: string; kind: string; label: string; owner: string; status: 'running' | 'stopping' | 'completed' | 'killed'; startedAt: number; finishedAt?: number }
type Task = { sessionId: SessionId; record: ScheduleRecord; status: 'active' | 'inactive'; lastDelivery?: ScheduleCatalogEntry['lastDelivery'] }

/** The Host Schedule service's shape: Host-storage tasks and a post-commit `schedule/changed`. */
function scheduleService(changed: () => void) {
  const tasks = new Map<string, Task>()
  let next = 0
  const build = (id: ScheduleId, request: ScheduleCreateRequest, now: number): ScheduleRecord => {
    const { prompt, title } = request
    if (request.after_seconds !== undefined) return createAfterScheduleRecord(id, prompt, request.after_seconds, now, title)
    if (request.every_seconds !== undefined) return createEveryScheduleRecord(id, prompt, request.every_seconds, now, title)
    if (request.at !== undefined) return createAtScheduleRecord(id, prompt, request.at, now, title)
    if (request.daily !== undefined) return createDailyScheduleRecord(id, prompt, request.daily, now, title)
    if (request.weekly !== undefined) return createWeeklyScheduleRecord(id, prompt, request.weekly, now, title)
    return createCronScheduleRecord(id, prompt, request.cron!, now, title)
  }
  const service = {
    tasks, changed,
    list: vi.fn(async ({ sessionId }: { sessionId: SessionId }) =>
      [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record)),
    catalog: vi.fn(async (): Promise<ScheduleCatalogEntry[]> => [...tasks.values()]
      .map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status, ...task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery } }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))),
    create: vi.fn(async (sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> => {
      const record = build(ScheduleId('schedule-' + String(++next)), request, Date.now())
      signal?.throwIfAborted()
      tasks.set(record.id, { sessionId, record, status: 'active' }); changed()
      return record
    }),
    delete: vi.fn(async (request: ScheduleDeleteRequest, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (tasks.get(request.id)?.sessionId !== request.sessionId) return { id: request.id, deleted: false as const, code: 'schedule_not_found' as const }
      tasks.delete(request.id); changed()
      return { id: request.id, deleted: true as const }
    }),
    update: vi.fn(async () => { throw new Error('the bridge never updates reminders') }),
    history: vi.fn(async () => { throw new Error('the bridge reads lastDelivery from the catalog') }),
    /** A native delivery: one-shots end, recurring ones advance. */
    deliver(id: string, nextAt?: string) {
      const task = tasks.get(id)!
      task.lastDelivery = { scheduledAt: task.record.scheduledAt, deliveredAt: task.record.scheduledAt, messageId: ('m-' + id) as never }
      if (nextAt === undefined) task.status = 'inactive'
      else task.record = { ...task.record, scheduledAt: nextAt }
      changed()
    },
    seed(sessionId: SessionId, record: ScheduleRecord, status: Task['status'] = 'active') { tasks.set(record.id, { sessionId, record, status }) },
  }
  return service
}

function fixture() {
  const sessions = new Map<SessionId, ReturnType<typeof session>>()
  const ready = new Set<unknown>()
  function session(id: string, clientId = 1) {
    const record = { clientId, agent: { ctx: { get: () => undefined }, session: { id: SessionId(id), header: { cwd: '/workspace' } } } as unknown as Agent,
      output: { notify: vi.fn(), update: vi.fn() },
      work: createSessionWork({ isLive: () => sessions.get(SessionId(id)) === record, assertReady: () => {} }) }
    ready.add(record)
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
  const listeners = new Set<(event: JobEvent) => void>()
  const unsubscribe = vi.fn()
  const jobs = {
    list: vi.fn((agent: SessionId) => rows.filter(row => row.owner === agent)),
    get: vi.fn((id: string, agent: SessionId) => {
      const job = rows.find(row => row.id === id && row.owner === agent)
      if (job === undefined) throw new Error('unknown native job')
      return job
    }),
    kill: vi.fn((id: string, agent: SessionId, _reason?: string): 'requested' | 'already-finished' => { jobs.get(id, agent).status = 'stopping'; return 'requested' }),
    wait: vi.fn(async (id: string, _timeout: number, agent: SessionId) => jobs.get(id, agent)),
    events: { subscribe: vi.fn((_filter: JobEventFilter, listener: (event: JobEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    }) },
    read: vi.fn(() => { throw new Error('must not consume the model cursor') }),
  }
  const names = new Set(['schedule_list', 'schedule_create', 'schedule_delete', 'schedule_update'])
  const schedule = scheduleService(() => tasks.scheduleChanged())
  const output = vi.fn((_registry: object, agent: Agent, id: string) => outputs.get(agent.session.id + ':' + id))
  const warn = vi.fn()
  const legacy = new Map<unknown, LegacyReminders>()
  const host = { sessions, owned: (clientId: number, id: SessionId | undefined) => {
    const record = id === undefined ? undefined : sessions.get(id)
    return record?.clientId === clientId ? record : undefined
  }, jobs: vi.fn((_record: typeof owner): unknown => ({ [symbols.original]: { [symbols.original]: jobs } })),
  toolNames: vi.fn((_record: typeof owner): ReadonlySet<string> | undefined => names),
  schedule: vi.fn((): typeof schedule | undefined => schedule),
  legacyReminders: vi.fn((record: typeof owner) => legacy.get(record)),
  ready: vi.fn((record: typeof owner) => ready.has(record)),
  output, logger: { warn } }
  const tasks = createNativeTasks(host)
  const job = (id: string, record = owner, status: Job['status'] = 'running') => {
    const row: Job = { id, kind: 'bash', label: 'build ' + id, owner: record.agent.session.id, status, startedAt: 1234 }
    rows.push(row); return row
  }
  const change = (record = owner) => { for (const listener of listeners) listener({ type: 'output', owner: record.agent.session.id, id: 'changed' as never, total: 0 }) }
  const request = (taskId: string, record = owner) => ({ sessionId: record.agent.session.id, taskId, source: 'clientUi' })
  const reminder = (text: string, clientId = 1, sessionId = 'owner') => tasks.reminders(clientId, 'x.ai/scheduler/create', { sessionId, text })
  /** Wire updates one owner received, in order. */
  const sent = (record = owner) => record.output.notify.mock.calls.map(call => (call[1] as { update: Record<string, unknown> }).update)
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)) }
  return { tasks, owner, other, sessions, add, rows, outputs, jobs, host, output, listeners, unsubscribe, change, job, request, names, warn, schedule, legacy, ready, reminder, sent, settle }
}

describe('native task ownership', () => {
  it('session cancellation aborts a pending reminder write and prevents the following list', async () => {
    const f = fixture(), held = Promise.withResolvers<ScheduleRecord>()
    let signal!: AbortSignal
    f.schedule.create.mockImplementationOnce((_id, _request, received) => { signal = received!; return held.promise })
    const operation = f.reminder('after 10m check build')
    const rejected = expect(operation).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.schedule.create).toHaveBeenCalledOnce())
    f.owner.work.cancel()
    expect(signal.aborted).toBe(true)
    held.reject(signal.reason)
    await rejected; await f.owner.work.settle()
    expect(f.schedule.catalog).not.toHaveBeenCalled()
    await f.tasks.dispose()
  })

  it('aborts and drains a reminder whose native write synchronously starts disposal', async () => {
    const f = fixture(), held = Promise.withResolvers<ScheduleRecord>(), entered = Promise.withResolvers<void>()
    let disposal!: Promise<void>, done = false, signal!: AbortSignal
    f.schedule.create.mockImplementationOnce(async (_id, _request, received) => {
      signal = received!
      disposal = Promise.resolve(f.tasks.dispose())
      void disposal.then(() => { done = true })
      entered.resolve()
      return held.promise
    })
    const work = f.reminder('after 1m check')
    const rejected = expect(work).rejects.toThrow('session closed')
    await entered.promise; await Promise.resolve()
    try {
      expect(done).toBe(false)
      expect(signal.aborted).toBe(true)
    } finally { held.resolve(createAfterScheduleRecord(ScheduleId('late'), 'check', 60, Date.now(), 'check')) }
    await rejected; await disposal
    expect(f.schedule.create).toHaveBeenCalledTimes(1)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
  })

  it('drains an accepted producer settlement without issuing another kill during disposal', async () => {
    const f = fixture(), row = f.job('one'), held = Promise.withResolvers<Job>()
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
    expect(f.jobs.events.subscribe).toHaveBeenCalledTimes(1)
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
    const finish = Promise.withResolvers<Job>()
    f.jobs.wait.mockImplementationOnce(() => finish.promise)
    const cancelled = f.tasks.kill(1, f.request('one'))
    expect(f.jobs.wait).toHaveBeenLastCalledWith('one', 5000, f.owner.agent.session.id)
    row.status = 'killed'; finish.resolve(row)
    await expect(cancelled).resolves.toMatchObject({ result: { outcome: 'killed' } })
    expect(f.jobs.kill).toHaveBeenCalledWith('one', f.owner.agent.session.id, 'clientUi')
    await f.tasks.dispose()
  })

  it('does not deliver a late cancellation result to a replaced owner', async () => {
    const f = fixture(), row = f.job('one'), finish = Promise.withResolvers<Job>()
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
    const second = { ...f.jobs, events: { subscribe: vi.fn(() => secondUnsubscribe) } }
    f.host.jobs.mockImplementation(record => record === f.other ? second : f.jobs)
    f.tasks.snapshot(f.other)
    f.unsubscribe.mockImplementation(() => { throw new Error('native unsubscribe failed') })
    const disposal = f.tasks.dispose()
    await expect(disposal).rejects.toThrow('subscription disposal failed')
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
    f.job('late'); stale({ type: 'output', owner: f.owner.agent.session.id, id: 'late' as never, total: 0 }); f.tasks.poll(); f.tasks.snapshot(f.owner)
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    expect(() => f.tasks.output(1, f.request('late'))).toThrow('unknown session')
    expect(f.tasks.dispose()).toBe(disposal)
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('retries failed registration and contains one broken registry on the shared heartbeat', async () => {
    const f = fixture(); f.job('one')
    f.jobs.events.subscribe.mockImplementationOnce(() => { throw new Error('not ready') })
    f.tasks.poll()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('not ready'))
    f.tasks.poll()
    expect(f.jobs.events.subscribe).toHaveBeenCalledTimes(2)
    expect(f.owner.output.notify).toHaveBeenCalledTimes(1)
    await f.tasks.dispose()
  })

  it('contains synchronous subscription reentry and disposal before registration returns', async () => {
    const f = fixture(); f.job('one')
    const stop = vi.fn()
    f.jobs.events.subscribe.mockImplementationOnce((_filter, listener) => {
      listener({ type: 'output', owner: f.owner.agent.session.id, id: 'one' as never, total: 0 })
      void f.tasks.dispose()
      return stop
    })
    f.tasks.snapshot(f.owner)
    expect(f.jobs.events.subscribe).toHaveBeenCalledOnce()
    expect(f.jobs.list).toHaveBeenCalledOnce()
    expect(f.owner.output.notify).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    f.tasks.poll()
    expect(f.jobs.list).toHaveBeenCalledOnce()
    await f.tasks.dispose()
  })
})

describe('native reminders through the Host Schedule service', () => {
  it('creates every /reminders kind with a derived title and lists the session\'s rows', async () => {
    const f = fixture(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const cases: Array<[string, Partial<ScheduleCreateRequest>]> = [
      ['after 10m check\nthe build', { after_seconds: 600, prompt: 'check\nthe build', title: 'check' }],
      ['every 5m check', { every_seconds: 300, prompt: 'check', title: 'check' }],
      ['at 2099-01-01T00:00:00Z ship it', { at: '2099-01-01T00:00:00Z', prompt: 'ship it', title: 'ship it' }],
      ['daily 09:00 stand up', { daily: { time: '09:00:00', time_zone: zone }, prompt: 'stand up', title: 'stand up' }],
      ['weekly mon,wed 17:30 review', { weekly: { weekdays: [1, 3], time: '17:30:00', time_zone: zone }, prompt: 'review', title: 'review' }],
      ['cron "0 9 * * 1-5" poll', { cron: { expression: '0 9 * * 1-5', time_zone: zone }, prompt: 'poll', title: 'poll' }],
    ]
    for (const [text, request] of cases) {
      await f.reminder(text)
      expect(f.schedule.create).toHaveBeenLastCalledWith('owner', request, expect.any(AbortSignal))
    }
    f.schedule.seed(SessionId('other'), createAfterScheduleRecord(ScheduleId('foreign'), 'not mine', 60, Date.now(), 'not mine'))
    const list = await f.tasks.reminders(1, 'x.ai/scheduler/list', { sessionId: 'owner' }) as { title: string; items: Array<{ id: string; text: string; detail: string }> }
    expect(list.title).toBe('Session reminders')
    expect(list.items.map(item => item.text)).toEqual(expect.arrayContaining(['check\nthe build', 'check', 'ship it', 'stand up', 'review', 'poll']))
    expect(list.items).toHaveLength(6)
    expect(list.items.map(item => item.detail.split(' · ').slice(0, 2).join(' · '))).toEqual(expect.arrayContaining([
      'active · after 10m', 'active · every 5m', 'active · at 2099-01-01T00:00:00.000Z', `active · daily 09:00 ${zone}`,
      `active · weekly Mon,Wed 17:30 ${zone}`, `active · cron "0 9 * * 1-5" ${zone}`,
    ]))
    expect(f.schedule.update).not.toHaveBeenCalled()
    await f.tasks.dispose()
  })

  it('keeps native validation as the authority and maps its errors', async () => {
    const f = fixture()
    await expect(f.reminder('at 2000-01-01T00:00:00Z too late')).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/future/i) })
    f.schedule.create.mockRejectedValueOnce(new ScheduleInputError('frequency_too_high', 'every_seconds must be at least 60.'))
    await expect(f.reminder('every 1m check')).rejects.toMatchObject({ code: -32602, message: 'every_seconds must be at least 60.' })
    f.schedule.create.mockRejectedValueOnce(new Error('storage offline'))
    await expect(f.reminder('every 1m check')).rejects.toMatchObject({ code: -32603, message: expect.stringContaining('storage offline') })
    // Parsing failures never reach the service.
    const calls = f.schedule.create.mock.calls.length
    for (const text of ['every 30s check', 'weekly check', 'after 1h', 'cron 0 9 * * * check']) await expect(f.reminder(text)).rejects.toMatchObject({ code: -32602 })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/create', { sessionId: 'owner' })).rejects.toThrow('A reminder is required.')
    expect(f.schedule.create).toHaveBeenCalledTimes(calls)
    await f.tasks.dispose()
  })

  it('deletes within the owning session and reports a missing row', async () => {
    const f = fixture()
    await f.reminder('after 10m first'); await f.reminder('every 1h second')
    const result = await f.tasks.reminders(1, 'x.ai/scheduler/delete', { sessionId: 'owner', taskId: 'schedule-1' }) as { items: Array<{ id: string }> }
    expect(f.schedule.delete).toHaveBeenCalledWith({ sessionId: 'owner', id: 'schedule-1' }, expect.any(AbortSignal))
    expect(result.items.map(item => item.id)).toEqual(['schedule-2'])
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/delete', { sessionId: 'owner', taskId: 'schedule-1' })).rejects.toMatchObject({ code: -32602, message: 'Reminder schedule-1 no longer exists.' })
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/delete', { sessionId: 'owner' })).rejects.toThrow('taskId is required')
    await f.tasks.dispose()
  })

  it('enforces reminder availability and ownership', async () => {
    const f = fixture(), request = { sessionId: 'owner' }
    await expect(f.tasks.reminders(2, 'x.ai/scheduler/list', request)).rejects.toThrow('unknown session')
    f.host.schedule.mockReturnValueOnce(undefined)
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toThrow('unavailable in this preset')
    f.names.delete('schedule_create')
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toThrow('unavailable in this preset')
    f.host.toolNames.mockReturnValueOnce(undefined)
    await expect(f.tasks.reminders(1, 'x.ai/scheduler/list', request)).rejects.toThrow('unavailable in this preset')
    expect(f.schedule.catalog).not.toHaveBeenCalled()
    await f.tasks.dispose()
  })

  it.each(['replaced', 'disposed'])('rejects late reminder results after the owner is %s', async action => {
    const f = fixture(), finish = Promise.withResolvers<ScheduleRecord>()
    f.schedule.create.mockImplementationOnce(() => finish.promise)
    const request = f.reminder('after 1m check')
    await vi.waitFor(() => expect(f.schedule.create).toHaveBeenCalledOnce())
    const disposal = action === 'disposed' ? f.tasks.dispose() : undefined
    if (action !== 'disposed') { f.add('owner'); f.tasks.poll() }
    expect((f.schedule.create.mock.calls[0]![2]!).aborted).toBe(true)
    finish.resolve(createAfterScheduleRecord(ScheduleId('late'), 'check', 60, Date.now(), 'check'))
    await expect(request).rejects.toThrow('session closed')
    expect(f.schedule.catalog).not.toHaveBeenCalled()
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    await disposal
    await f.tasks.dispose()
  })
})

describe('Tasks-pane reminder rows from schedule/changed', () => {
  const created = (record: ScheduleRecord, schedule: string) => ({
    sessionUpdate: 'scheduled_task_created', task_id: record.id, prompt: record.prompt, human_schedule: schedule, next_fire_at: record.scheduledAt,
  })

  it('announces creation, recurring advances, deliveries and deletions, each once and only to the owner', async () => {
    const f = fixture()
    await f.tasks.snapshot(f.owner); await f.tasks.snapshot(f.other)
    expect(f.sent()).toEqual([])
    await f.reminder('every 5m repeat'); await f.reminder('after 10m once'); await f.reminder('daily 09:00 wake')
    await f.settle()
    const [repeat, once, daily] = ['schedule-1', 'schedule-2', 'schedule-3'].map(id => f.schedule.tasks.get(id)!.record)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(f.sent()).toEqual([created(repeat!, 'every 5m'), created(once!, 'once'), created(daily!, `daily 09:00 ${zone}`)])
    expect(f.owner.output.notify.mock.calls.every(call => call[0] === 'x.ai/session_notification' && (call[2] as { nativeSchedule?: boolean }).nativeSchedule === true)).toBe(true)
    expect(f.sent(f.other)).toEqual([])

    const advanced = '2099-01-01T00:00:00.000Z'
    f.schedule.deliver('schedule-1', advanced); f.schedule.deliver('schedule-2')
    await f.settle()
    expect(f.sent().slice(3)).toEqual([
      { ...created(repeat!, 'every 5m'), next_fire_at: advanced },
      { sessionUpdate: 'scheduled_task_deleted', task_id: 'schedule-2', reason: 'completed' },
    ])
    await f.tasks.reminders(1, 'x.ai/scheduler/delete', { sessionId: 'owner', taskId: 'schedule-3' })
    await f.settle()
    expect(f.sent().slice(5)).toEqual([{ sessionUpdate: 'scheduled_task_deleted', task_id: 'schedule-3', reason: 'deleted' }])
    f.tasks.scheduleChanged(); await f.settle()
    expect(f.sent()).toHaveLength(6)
    await f.tasks.dispose()
  })

  it('clears rows that ended while the TUI was away exactly once per open', async () => {
    const f = fixture(), now = Date.now()
    f.schedule.seed(SessionId('owner'), createAfterScheduleRecord(ScheduleId('ended'), 'done', 60, now, 'done'), 'inactive')
    const armed = createEveryScheduleRecord(ScheduleId('armed'), 'again', 300, now, 'again')
    f.schedule.seed(SessionId('owner'), armed)
    f.schedule.seed(SessionId('other'), createAfterScheduleRecord(ScheduleId('foreign-ended'), 'x', 60, now, 'x'), 'inactive')
    await f.tasks.snapshot(f.owner); await f.tasks.snapshot(f.owner)
    expect(f.sent()).toEqual([created(armed, 'every 5m'), { sessionUpdate: 'scheduled_task_deleted', task_id: 'ended', reason: 'completed' }])
    const reopened = f.add('owner')
    await f.tasks.snapshot(reopened)
    expect(f.sent(reopened)).toHaveLength(2)
    await f.tasks.dispose()
  })

  it('publishes a change made during a held read through one queued read, and never publishes to a closed owner', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    await f.tasks.snapshot(f.owner); await f.tasks.snapshot(f.other)
    const list = f.schedule.list.getMockImplementation()!
    // The owner's next read answers with the rows as they were when it started.
    let hold = true
    f.schedule.list.mockImplementation(async request => {
      const rows = await list(request)
      if (hold && request.sessionId === 'owner') { hold = false; entered.resolve(); await gate.promise }
      return rows
    })
    const reads = f.schedule.list.mock.calls.length
    f.tasks.scheduleChanged()
    await entered.promise
    const burst = createAfterScheduleRecord(ScheduleId('burst'), 'burst', 60, Date.now(), 'burst')
    f.schedule.seed(SessionId('owner'), burst)
    for (let index = 0; index < 20; index++) f.tasks.scheduleChanged()
    gate.resolve(); await f.settle()
    expect(f.sent()).toEqual([created(burst, 'once')])
    expect(f.sent(f.other)).toEqual([])
    expect(f.schedule.list.mock.calls.length - reads).toBeLessThanOrEqual(2 * 2) // owner + other, one running and one queued each
    const held = Promise.withResolvers<ScheduleRecord[]>()
    f.schedule.list.mockImplementationOnce(() => held.promise)
    f.schedule.seed(SessionId('owner'), createAfterScheduleRecord(ScheduleId('late'), 'late', 60, Date.now(), 'late'))
    const refresh = f.tasks.snapshot(f.owner)
    f.sessions.delete(SessionId('owner'))
    held.resolve([burst, f.schedule.tasks.get('late')!.record])
    await refresh
    expect(f.sent()).toEqual([created(burst, 'once')])
    expect(f.warn).not.toHaveBeenCalled()
    await f.tasks.dispose()
  })

  it('reports a Schedule read failure without failing the session open', async () => {
    const f = fixture()
    f.schedule.list.mockRejectedValueOnce(new Error('storage offline'))
    await expect(f.tasks.snapshot(f.owner)).resolves.toBeUndefined()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('storage offline'))
    f.host.schedule.mockReturnValue(undefined)
    expect(f.tasks.snapshot(f.owner)).toBeUndefined()
    await f.tasks.dispose()
  })
})

describe('legacy session-event reminders', () => {
  it('sends one system note per open, only after the session is ready', async () => {
    const f = fixture(), state: LegacyReminders = { inherited: 0, active: [{ id: 'schedule-1', kind: 'every', prompt: 'standup' }] }
    f.legacy.set(f.owner, state)
    f.ready.delete(f.owner)
    await f.tasks.snapshot(f.owner)
    f.tasks.poll()
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    f.ready.add(f.owner)
    f.tasks.poll(); f.tasks.poll()
    expect(f.owner.output.notify).toHaveBeenCalledOnce()
    expect(f.owner.output.notify).toHaveBeenCalledWith('x.ai/session_notification', { update: {
      sessionUpdate: 'image_dropped', notes: [expect.stringMatching(/^This session has a reminder created by an earlier dscode version \("standup"\)\. It no longer fires/)],
    } }, { legacySchedule: true })
    // Legacy rows are never shown as live Tasks-pane rows.
    expect(f.sent().some(update => update.sessionUpdate === 'scheduled_task_created')).toBe(false)
    const reopened = f.add('owner')
    f.legacy.set(reopened, state)
    await f.tasks.snapshot(reopened); f.tasks.poll()
    expect(reopened.output.notify).toHaveBeenCalledOnce()
    await f.tasks.dispose()
  })

  it('stays quiet without legacy reminders and reports an unreadable projection', async () => {
    const f = fixture()
    f.legacy.set(f.owner, { inherited: 0, active: [] })
    await f.tasks.snapshot(f.owner); f.tasks.poll()
    f.host.legacyReminders.mockImplementationOnce(() => { throw new Error('projection unavailable') })
    await f.tasks.snapshot(f.other); f.tasks.poll()
    expect(f.owner.output.notify).not.toHaveBeenCalled()
    expect(f.other.output.notify).not.toHaveBeenCalled()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('projection unavailable'))
    await f.tasks.dispose()
  })
})
