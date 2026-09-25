import type { SessionWork } from './session-work.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { parsePrompt } from './prompt-content.ts'
import { goalUpdateFromView, type ContextProjectionValues, type NativeGoalView } from './projection.ts'
import type { SessionOutput } from './session-output.ts'
import { planModeUpdate } from './turn-notices.ts'

interface StatusSession {
  work: Pick<SessionWork, 'run'>
  agent: Agent
  output: Pick<SessionOutput, 'notify' | 'update' | 'activity'>
}
export interface NativeStatusProjections {
  snapshot(session: unknown, keys: readonly string[]): { values: ContextProjectionValues }
  onChanged(listener: (session: unknown, key: string) => void): () => void
}
export interface NativeGoalAuthority {
  get(agent: Agent): NativeGoalView | undefined
  pause(agent: Agent, ref: { id: string; revision: number }): unknown
}
interface StatusEvents {
  'goal/changed': [{ agent: Agent; change?: { ref?: { id?: string } } }]
  'goal/activation-changed': [{ sessionId: string }]
  'agent/status': [{ agent: Agent }]
  'agent/created': [{ agent: Agent }]
}
interface StatusHost<S extends StatusSession> {
  sessions: ReadonlyMap<SessionId, S>
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  goals(record: S): NativeGoalAuthority | undefined
  commands(): { execute(agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined> } | undefined
  projections(): NativeStatusProjections | undefined
  on<K extends keyof StatusEvents>(name: K, listener: (...args: StatusEvents[K]) => void): () => void
}

/** Native goal/activity/context observations share the attached session's
 * lifetime. Reads never arm a goal; only its native command authority mutates
 * it, and cancellation pauses an armed active goal without reviving old ones. */
export function createNativeSessionStatus<S extends StatusSession>(host: StatusHost<S>) {
  let closed = false
  let disposal: Promise<void> | undefined
  const snapshots = new WeakMap<S, { id: string; serialized: string }>()
  const unsubscribes: Array<() => void> = []
  const commands = new Map<AbortController, S>()
  const pending = new Set<Promise<unknown>>()
  const isLive = (record: S) => !closed && host.sessions.get(record.agent.session.id) === record
  const ownedAgent = (agent: Agent): S | undefined => {
    const record = host.sessions.get(agent.session.id)
    return !closed && record?.agent === agent ? record : undefined
  }
  const refresh = (record: S, initial = false, replay = false, clearedId?: string): void => {
    if (!isLive(record)) return
    const goal = host.goals(record)?.get(record.agent)
    const previous = snapshots.get(record)
    const id = goal?.id ?? clearedId ?? previous?.id ?? (initial ? '' : undefined)
    if (id === undefined) return
    const update = goal === undefined
      ? { sessionUpdate: 'goal_updated', goal_id: id, objective: '', status: 'cleared', phase: 'idle' }
      : goalUpdateFromView(goal)
    const serialized = JSON.stringify(update)
    if (!initial && previous?.serialized === serialized) return
    snapshots.set(record, { id, serialized })
    record.output.notify('x.ai/session_notification', {
      update: { ...update, ...initial ? { is_snapshot: true } : {} },
    }, { ...replay ? { isReplay: true } : {} })
  }
  const on: StatusHost<S>['on'] = (name, listener) => {
    const stop = host.on(name, (...args) => { if (!closed) listener(...args) })
    unsubscribes.push(stop)
    return stop
  }
  try {
    on('goal/changed', ({ agent, change }) => {
      const record = ownedAgent(agent)
      if (record !== undefined) refresh(record, false, false, change?.ref?.id)
    })
    on('goal/activation-changed', ({ sessionId }) => {
      const record = host.sessions.get(SessionId(sessionId))
      if (record !== undefined) refresh(record)
    })
    on('agent/status', ({ agent }) => {
      const record = ownedAgent(agent)
      if (record === undefined) return
      record.output.activity(agent.status === 'running')
      queueMicrotask(() => refresh(record))
    })
    on('agent/created', ({ agent }) => {
      const record = ownedAgent(agent)
      if (record !== undefined) queueMicrotask(() => refresh(record))
    })
    const projections = host.projections()
    if (projections !== undefined) unsubscribes.push(projections.onChanged((session, key) => {
      if (closed || !['tokenUsage', 'contextPressure', 'contextBreakdown', 'goal'].includes(key)) return
      for (const record of host.sessions.values()) {
        if (record.agent.session !== session) continue
        if (key === 'goal') { queueMicrotask(() => refresh(record)); continue }
        record.output.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }, false)
      }
    }))
  } catch (error) {
    closed = true
    const failures: unknown[] = [error]
    for (const stop of unsubscribes.splice(0)) {
      try { stop() } catch (failure) { failures.push(failure) }
    }
    throw new AggregateError(failures, 'native status subscription setup failed')
  }

  /** The committed plan mode for the TUI's indicator. A new or forked session
   * has no replayed `plan/mode` to carry it, and the TUI learns its id only
   * from the response, so its lifecycle sends this once more afterwards. */
  const mode = (record: S, replay = false): void => {
    if (!isLive(record)) return
    let plan: { active?: unknown } | undefined
    try { plan = (host.projections()?.snapshot(record.agent.session, ['plan']).values as { plan?: { active?: unknown } } | undefined)?.plan } catch { return }
    if (typeof plan?.active === 'boolean') record.output.update(planModeUpdate(plan.active), replay)
  }
  const goal = async (clientId: number, params: unknown): Promise<{ result: { kind: string; text: string } }> => {
    const p = paramRecord(params, 'x.ai/goal')
    const record = closed ? undefined : host.owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    return record.work.run(async scope => {
      const parsed = parsePrompt(p.prompt)
      if (!/^\/goal(?:\s|$)/i.test(parsed.text.trim())) throw invalidParams('x.ai/goal requires a /goal invocation')
      const controller = new AbortController()
      commands.set(controller, record)
      try {
        const execution = await host.commands()?.execute(record.agent, parsed.text, parsed.images, AbortSignal.any([scope.signal, controller.signal]))
        if (!isLive(record)) throw invalidParams('session closed')
        if (execution === undefined) throw invalidParams('Goal commands are unavailable in the selected preset.')
        if (typeof execution.result?.kind !== 'string' || typeof execution.result.text !== 'string') {
          throw internalError('invalid goal command response: expected result.kind and result.text')
        }
        return { result: { kind: execution.result.kind, text: execution.result.text } }
      } finally { commands.delete(controller) }
    })
  }
  return {
    contextValues(record: S): ContextProjectionValues {
      return !isLive(record) ? {} : host.projections()?.snapshot(record.agent.session, ['tokenUsage', 'contextPressure', 'contextBreakdown']).values ?? {}
    },
    snapshot(record: S, replay = false): void {
      if (!isLive(record)) return
      record.output.activity(record.agent.status === 'running')
      mode(record, replay)
      refresh(record, true, replay)
    },
    mode,
    refresh(record: S): void { refresh(record) },
    pauseGoal(record: S): void {
      if (!isLive(record)) return
      const goals = host.goals(record), goal = goals?.get(record.agent)
      if (goal?.phase === 'active' && goal.activation === 'armed') goals?.pause(record.agent, { id: goal.id, revision: goal.revision })
    },
    goal(clientId: number, params: unknown) {
      // Register accepted work before calling native code, which can reenter
      // disposal synchronously (for example through an abort/retirement hook).
      const work = Promise.resolve().then(() => goal(clientId, params))
      pending.add(work)
      void work.then(() => pending.delete(work), () => pending.delete(work))
      return work
    },
    poll(): void {
      for (const [controller, record] of commands) if (!isLive(record)) controller.abort()
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      const failures: unknown[] = []
      // Publish the one disposal promise before abort/unsubscribe callbacks
      // run, so reentrant disposal shares the same drain.
      disposal = Promise.resolve().then(async () => {
        while (pending.size > 0) await Promise.allSettled([...pending])
        if (failures.length > 0) throw new AggregateError(failures, 'native status subscription disposal failed')
      })
      for (const controller of commands.keys()) controller.abort()
      for (const stop of unsubscribes.splice(0)) {
        try { stop() } catch (error) { failures.push(error) }
      }
      return disposal
    },
  }
}
