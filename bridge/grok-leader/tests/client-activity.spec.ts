/** The quit guard's facts: DSH's session-activity families plus the bridge's queue, per client. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ACTIVITY_TIMEOUT_MS, createClientActivity, type SessionActivityLike } from '../src/client-activity.ts'
import { makeClient, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

interface Record { clientId: number; id: SessionId; running: boolean; queued: string[]; jobs?: unknown }

function fixture(records: Record[], activity: (sessionId: string) => Promise<readonly SessionActivityLike[]>) {
  const sessions = new Map(records.map(record => [record.id as string, record]))
  const logger = { warn: vi.fn((_message: string) => {}) }
  const guard = createClientActivity<Record>({
    sessions, owned: (clientId, id) => { const record = sessions.get(id); return record?.clientId === clientId ? record : undefined },
    sessionId: record => record.id, activity, prompts: record => ({ running: record.running, queued: record.queued }),
    jobs: record => record.jobs, logger,
  })
  return { guard, logger }
}

afterEach(() => { vi.useRealTimers() })

describe('client activity', () => {
  it('merges the families of every session the client owns, by kind, with nouns and short labels', async () => {
    const families: Record<string, SessionActivityLike[]> = {
      a: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1', label: 'npm test' }, { id: 'j2', label: 'sleep 120 # a long\nsecond line' }, { id: 'j3' }] },
        { kind: 'schedule', items: [{ id: 'r1', label: 'stand-up' }] }],
      b: [{ kind: 'subagent', items: [{ id: 'c1', label: 'review the diff' }] }, { kind: 'webhook' },
        { kind: 'job', items: [{ id: 'j4', label: 'a job with a label far longer than forty characters' }] }],
      c: [{ kind: 'job', items: [{ id: 'j9', label: 'another client' }] }],
    }
    const { guard } = fixture([
      { clientId: 1, id: SessionId('a'), running: true, queued: ['fix the flaky test\nand explain'] },
      { clientId: 1, id: SessionId('b'), running: false, queued: [] },
      { clientId: 2, id: SessionId('c'), running: true, queued: ['theirs'] },
    ], async id => families[id]!)
    expect(await guard.activity(1, {})).toEqual({
      stops: [
        // DSH's turn and the bridge's running prompt are one turn.
        { kind: 'turn', count: 1, one: 'turn', other: 'turns', labels: [] },
        { kind: 'prompt', count: 1, one: 'queued prompt', other: 'queued prompts', labels: ['fix the flaky test'] },
        { kind: 'job', count: 4, one: 'job', other: 'jobs', labels: ['npm test', 'sleep 120 # a long', 'a job with a label far longer than fort…'] },
        { kind: 'subagent', count: 1, one: 'subagent', other: 'subagents', labels: ['review the diff'] },
        // A family a plugin adds reads by its own kind.
        { kind: 'webhook', count: 1, one: 'webhook', other: 'webhooks', labels: [] },
      ],
      waits: [{ kind: 'schedule', count: 1, one: 'reminder', other: 'reminders', labels: ['stand-up'] }],
    })
    expect(await guard.activity(3)).toEqual({ stops: [], waits: [] })
  })

  it('counts a background subagent once, as its child and not also as its job', async () => {
    const jobs = { list: vi.fn((owner: string) => owner === 'a' ? [{ id: 'j1', kind: 'subagent' }, { id: 'j2', kind: 'bash' }] : []) }
    const { guard } = fixture([{ clientId: 1, id: SessionId('a'), running: false, queued: [], jobs }], async () => [
      { kind: 'job', items: [{ id: 'j1', label: 'DSCODE controlled child' }, { id: 'j2', label: 'DSCODE controlled background job' }] },
      { kind: 'subagent', items: [{ id: 'child', label: 'DSCODE controlled child' }] },
    ])
    expect((await guard.activity(1)).stops.map(entry => [entry.kind, entry.count, entry.labels])).toEqual([
      ['job', 1, ['DSCODE controlled background job']], ['subagent', 1, ['DSCODE controlled child']]])
    expect(jobs.list).toHaveBeenCalledWith('a')
    // A job family left with only subagent jobs is not reported at all.
    const only = fixture([{ clientId: 1, id: SessionId('a'), running: false, queued: [], jobs }], async () => [{ kind: 'job', items: [{ id: 'j1' }] }])
    expect(await only.guard.activity(1)).toEqual({ stops: [], waits: [] })
  })

  it('counts only the bridge queue for a session whose providers fail or are too slow', async () => {
    const failing = fixture([{ clientId: 1, id: SessionId('a'), running: true, queued: ['next'] }], async () => { throw new Error('observe failed') })
    expect((await failing.guard.activity(1)).stops.map(entry => entry.kind)).toEqual(['turn', 'prompt'])
    expect(failing.logger.warn).toHaveBeenCalledWith('grok-leader: session activity of a failed: observe failed')
    vi.useFakeTimers()
    const slow = fixture([{ clientId: 1, id: SessionId('a'), running: false, queued: ['next'] }], () => new Promise(() => {}))
    const answer = slow.guard.activity(1)
    await vi.advanceTimersByTimeAsync(ACTIVITY_TIMEOUT_MS)
    expect((await answer).stops.map(entry => entry.kind)).toEqual(['prompt'])
    expect(slow.logger.warn).toHaveBeenCalledWith(expect.stringContaining('took over ' + String(ACTIVITY_TIMEOUT_MS) + ' ms'))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('x.ai/client/activity through the socket', () => {
  const start = useLeaderHarness()

  it('answers the owning client from DSH\'s activity waterfall and the queue, and another client with nothing', async () => {
    const { ctx, registry, client: c, socketPath } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    // The providers DSH composes: the Agent registry's turn, the job registry, the Schedule.
    const on = (ctx as unknown as { on(name: string, listener: (request: { sessionId: string }, next: () => Promise<SessionActivityLike[]>) => Promise<SessionActivityLike[]>): () => void }).on.bind(ctx)
    on('workspace/session-activity', async (request, next) => agent.internals.status === 'running' && request.sessionId === sessionId ? [{ kind: 'turn' }, ...await next()] : next())
    on('workspace/session-activity', async (request, next) => request.sessionId === sessionId
      ? [{ kind: 'job', items: [{ id: 'job-1', label: 'sleep 120' }] }, ...await next()] : next())
    on('workspace/session-activity', async (request, next) => request.sessionId === sessionId
      ? [{ kind: 'schedule', items: [{ id: 'r-1', label: 'stand-up' }] }, ...await next()] : next())

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second prompt' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const answer = await c.request(4, 'x.ai/client/activity', {})
    expect(answer.result).toEqual({
      stops: [
        { kind: 'turn', count: 1, one: 'turn', other: 'turns', labels: [] },
        { kind: 'prompt', count: 1, one: 'queued prompt', other: 'queued prompts', labels: ['second prompt'] },
        { kind: 'job', count: 1, one: 'job', other: 'jobs', labels: ['sleep 120'] },
      ],
      waits: [{ kind: 'schedule', count: 1, one: 'reminder', other: 'reminders', labels: ['stand-up'] }],
    })

    const other = await makeClient(socketPath)
    try {
      register(other)
      await other.next()
      expect((await other.request(1, 'x.ai/client/activity')).result).toEqual({ stops: [], waits: [] })
    } finally { other.socket.destroy() }

    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await waitForId(c, 3)
  })
})
