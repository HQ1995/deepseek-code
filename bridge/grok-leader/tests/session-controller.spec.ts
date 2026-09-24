import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionController, provideSessionController, type ScheduleDeliveryLike } from '../src/session-controller.ts'

type Row = { agent: Agent; ready: boolean }
function fixture() {
  const records = new Map<SessionId, Row>()
  const agent = (id: string) => ({ id: SessionId(id), session: { id: SessionId(id) } }) as unknown as Agent
  const schedule: { current: ScheduleDeliveryLike | undefined } = { current: { requestDelivery: vi.fn() } }
  const warn = vi.fn()
  const controller = createSessionController<Row>({
    record: id => records.get(id), ready: row => row.ready, schedule: () => schedule.current, logger: { warn },
  })
  const open = (id: string, ready = true) => {
    const row = { agent: agent(id), ready }
    records.set(SessionId(id), row)
    return row
  }
  const requested = () => vi.mocked(schedule.current!.requestDelivery!).mock.calls.length
  const turn = () => new Promise<void>(resolve => { setImmediate(resolve) })
  return { records, schedule, warn, controller, open, requested, turn }
}

describe('dscode sessionController', () => {
  it('resolves only a session that is open and ready, and answers at once otherwise', async () => {
    const f = fixture(), row = f.open('open'), busy = f.open('busy', false)
    await expect(f.controller.resolveAgent(SessionId('open'))).resolves.toEqual({ agent: row.agent })
    for (const id of ['busy', 'closed']) {
      const result = await f.controller.resolveAgent(SessionId(id))
      expect((result as { error: Error }).error.message).toBe(`Session ${id} is not open in dscode; its reminders are delivered while it is open.`)
    }
    busy.ready = true
    await expect(f.controller.resolveAgent(SessionId('busy'))).resolves.toEqual({ agent: busy.agent })
  })

  it('asks Schedule to deliver once per event-loop turn when a session becomes ready or the service appears', async () => {
    const f = fixture(), ready = f.open('ready'), busy = f.open('busy', false)
    f.controller.deliverable(busy)
    await f.turn()
    expect(f.requested()).toBe(0)
    f.controller.deliverable(ready); f.controller.deliverable(ready); f.controller.deliverable()
    expect(f.requested()).toBe(0)
    await f.turn()
    expect(f.requested()).toBe(1)
    f.controller.deliverable()
    await f.turn()
    expect(f.requested()).toBe(2)
  })

  it('waits for a Schedule service that is not up, and warns once when it cannot retry', async () => {
    const f = fixture(), row = f.open('open')
    const service = f.schedule.current
    f.schedule.current = undefined
    f.controller.deliverable(row)
    await f.turn()
    f.schedule.current = service
    expect(f.requested()).toBe(0)
    f.schedule.current = {}
    f.controller.deliverable(row); await f.turn()
    f.controller.deliverable(row); await f.turn()
    expect(f.warn).toHaveBeenCalledOnce()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('has no requestDelivery'))
    f.schedule.current = { requestDelivery: () => { throw new Error('schedule stopping') } }
    f.controller.deliverable(row); await f.turn()
    expect(f.warn).toHaveBeenLastCalledWith('grok-leader: reminder delivery request failed: schedule stopping')
  })

  it('stops resolving and drops a pending request when the leader shuts down', async () => {
    const f = fixture(), row = f.open('open')
    f.controller.deliverable(row)
    f.controller.dispose()
    await f.turn()
    expect(f.requested()).toBe(0)
    f.controller.deliverable(row); await f.turn()
    expect(f.requested()).toBe(0)
    const result = await f.controller.resolveAgent(SessionId('open'))
    expect((result as { error: Error }).error.message).toMatch(/while the dscode leader shuts down/)
  })

  it('provides only resolveAgent, and never replaces another sessionController', async () => {
    const f = fixture(), row = f.open('open'), info = vi.fn()
    const ctx = new Context()
    expect(provideSessionController(ctx, f.controller, { info })).toBe(true)
    const provided = ctx.get('sessionController') as unknown as { resolveAgent(id: SessionId): Promise<unknown> }
    expect(Object.keys(provided)).toEqual(['resolveAgent'])
    await expect(provided.resolveAgent(SessionId('open'))).resolves.toEqual({ agent: row.agent })
    expect(info).not.toHaveBeenCalled()

    const other = new Context(), web = { resolveAgent: vi.fn() }
    other.provide('sessionController', web as never)
    expect(provideSessionController(other, f.controller, { info })).toBe(false)
    expect(other.get('sessionController')).toBe(web)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('another plugin provides sessionController'))
  })
})
