/** Leader socket spec: the Host Schedule seams dscode composes. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId, createAfterScheduleRecord, type ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule'
import type { Context } from '@deepseek-ai/cordis'
import { register, useLeaderHarness, waitFor, type MockAgent } from './support/leader-harness.ts'

type Resolve = (sessionId: SessionId) => Promise<{ agent: unknown } | { error: Error }>

/** Host Schedule's retry rule: a due reminder whose session does not resolve
 * stays due until the next drive, which `requestDelivery` or a wake starts. */
function dueReminders(ctx: Context, due: Array<{ sessionId: string; text: string }>) {
  let drives = Promise.resolve()
  const drive = (): Promise<void> => drives = drives.then(async () => {
    const controller = ctx.get('sessionController') as unknown as { resolveAgent: Resolve }
    for (const reminder of [...due]) {
      const resolved = await controller.resolveAgent(SessionId(reminder.sessionId))
      if ('error' in resolved) continue
      due.splice(due.indexOf(reminder), 1)
      ;(resolved.agent as MockAgent).followup({ content: [{ type: 'text', text: reminder.text }] } as never)
    }
  })
  return {
    due, drive, idle: () => drives,
    requestDelivery: vi.fn(() => { void drive() }),
    list: vi.fn(async () => [] as ReturnType<typeof createAfterScheduleRecord>[]), catalog: vi.fn(async () => []),
    create: vi.fn(), delete: vi.fn(),
  }
}

describe('leader reminders on the Host Schedule service', () => {
  const start = useLeaderHarness()

  it('provides a sessionController that resolves only sessions a TUI has open', async () => {
    const { ctx, registry, client: c } = await start()
    register(c); await c.next()
    const controller = ctx.get('sessionController') as unknown as { resolveAgent: Resolve }
    expect(Object.keys(controller)).toEqual(['resolveAgent'])
    const { sessionId } = (await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string }
    await expect(controller.resolveAgent(SessionId(sessionId))).resolves.toEqual({ agent: registry.byId.get(sessionId) })
    await c.request(2, 'session/close', { sessionId })
    const closed = await controller.resolveAgent(SessionId(sessionId))
    expect((closed as { error: Error }).error.message).toContain('is not open in dscode')
    expect(registry.resumed).toEqual([])
  })

  it('delivers a reminder that fell due while its session was closed once it is open and ready, with no Schedule write', async () => {
    const { ctx, registry, client: c } = await start()
    register(c); await c.next()
    const schedule = dueReminders(ctx, [{ sessionId: 'persisted-session', text: 'stand up' }])
    ctx.provide('schedule', schedule as never)
    // The service appearing asks for delivery; the session is closed, so the reminder stays due.
    await vi.waitFor(() => expect(schedule.requestDelivery).toHaveBeenCalledOnce())
    await schedule.idle()
    expect(schedule.due).toHaveLength(1)
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    await vi.waitFor(() => expect(registry.byId.get('persisted-session')?.internals.followups).toEqual(['stand up']))
    expect(schedule.due).toEqual([])
    expect(schedule.create).not.toHaveBeenCalled(); expect(schedule.delete).not.toHaveBeenCalled()
  })

  it('delivers a reminder that fell due while its open session was reloading once the failed reload returns it', async () => {
    const flush = vi.fn(async (_session: object) => true)
    const { ctx, registry, client: c } = await start({ sessionsStore: { flushed: [], flush } })
    register(c); await c.next()
    const schedule = dueReminders(ctx, [])
    ctx.provide('schedule', schedule as never)
    const params = { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: [] }
    expect((await c.request(1, 'session/load', params)).error).toBeUndefined()
    const agent = registry.byId.get('persisted-session')!
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    flush.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; throw new Error('storage unavailable') })
    const reload = c.request(2, 'session/load', params)
    await entered.promise
    // Delivery requests made before the hold (the preset step's) run while the session reloads.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(schedule.requestDelivery).toHaveBeenCalledTimes(3)
    // A scheduled wake while the session reloads cannot deliver into it.
    schedule.due.push({ sessionId: 'persisted-session', text: 'check the build' })
    await schedule.drive()
    expect(schedule.due).toHaveLength(1)
    gate.resolve()
    expect((await reload).error).toBeDefined()
    await vi.waitFor(() => expect(agent.internals.followups).toEqual(['check the build']))
    expect(registry.byId.get('persisted-session')).toBe(agent)
  })

  it('shows the Tasks rows of a session opened before the Schedule service appeared', async () => {
    const { ctx, client: c } = await start({ tools: { schemas: () => [{ name: 'schedule_create' }, { name: 'schedule_list' }] } })
    register(c); await c.next()
    const { sessionId } = (await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string }
    const record = createAfterScheduleRecord(ScheduleId('schedule-early'), 'check the build', 600, Date.now(), 'check the build')
    const schedule = { ...dueReminders(ctx, []), list: vi.fn(async () => [record]) }
    ctx.provide('schedule', schedule as never)
    await waitFor(() => c.all.some(message => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'scheduled_task_created'))
    const created = c.all.find(message => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'scheduled_task_created')!
    expect(created.params).toMatchObject({ sessionId, update: { task_id: 'schedule-early', prompt: 'check the build' }, _meta: { nativeSchedule: true } })
  })

  it('routes /reminders to ctx.schedule and mirrors schedule/changed into the Tasks pane', async () => {
    const { ctx, client: c } = await start({ tools: { schemas: () => [{ name: 'schedule_create' }, { name: 'schedule_list' }] } })
    register(c); await c.next()
    const { sessionId } = (await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string }
    const records: ReturnType<typeof createAfterScheduleRecord>[] = []
    const schedule = {
      list: vi.fn(async () => records),
      catalog: vi.fn(async () => records.map(record => ({ ...record, sessionId: SessionId(sessionId), status: 'active' as const }))),
      create: vi.fn(async (_id: SessionId, request: ScheduleCreateRequest) => {
        const record = createAfterScheduleRecord(ScheduleId('schedule-1'), request.prompt, request.after_seconds!, Date.now(), request.title)
        records.push(record)
        return record
      }),
      delete: vi.fn(),
      requestDelivery: vi.fn(),
    }
    ctx.provide('schedule', schedule as never)
    const created = await c.request(2, 'x.ai/scheduler/create', { sessionId, text: 'after 10m check the build' })
    expect(schedule.create).toHaveBeenCalledWith(sessionId, { after_seconds: 600, prompt: 'check the build', title: 'check the build' }, expect.any(AbortSignal))
    expect(created.result).toMatchObject({ title: 'Session reminders', items: [{ id: 'schedule-1', text: 'check the build', detail: expect.stringMatching(/^active · after 10m · next /) }] })
    await waitFor(() => c.all.some(message => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'scheduled_task_created'))
    records.length = 0
    ctx.emit('schedule/changed')
    await waitFor(() => c.all.some(message => (message.params as { update?: { sessionUpdate?: string; reason?: string } } | undefined)?.update?.sessionUpdate === 'scheduled_task_deleted'))
    const deleted = c.all.find(message => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'scheduled_task_deleted')!
    expect(deleted.params).toMatchObject({ sessionId, update: { task_id: 'schedule-1', reason: 'deleted' }, _meta: { nativeSchedule: true } })
  })
})
