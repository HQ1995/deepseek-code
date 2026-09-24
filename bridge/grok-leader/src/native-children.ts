import type { SessionOperation, SessionWork } from './session-work.ts'
import { hasToolImages } from './image-output.ts'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { invalidParams, internalError, paramRecord, sessionIdParam } from './acp.ts'
import { errorMessage, nonEmpty } from './guards.ts'
import { CHILD_HISTORY_PAGE_SIZE, createChildLogs } from './child-history.ts'
import { workflowUpdates, type WorkflowHistory, type LiveWorkflow } from './workflows.ts'
import { parsePrompt } from './prompt-content.ts'
import { sessionEventToUpdates, systemNotes, textBlocks, type GrokSessionUpdate, type ProjectedUpdate } from './projection.ts'
import type { SessionOutput } from './session-output.ts'
import {
  childConversations, childOverview, childTerminalStatus, inboxCommand, inboxView, parseSubagentsCommand, runLength, runSubagentVerb,
  type ChildRow, type ChildState, type SubagentsLike,
} from './child-controls.ts'

interface ChildSession {
  work: Pick<SessionWork, 'run' | 'read'>
  clientId: number
  agent: Agent
  output: Pick<SessionOutput, 'notify'>
}
type SubagentLifecycle = { id: string; stopReason?: string; lastAssistantMessage?: unknown }
interface ChildEventMap {
  'workflow/start': [info: { id: string; meta: LiveWorkflow['meta'] }]
  'workflow/phase': [info: { id: string }, phase: string]
  'workflow/end': [info: { id: string }]
  'session/event': [session: Agent['session'], event: SessionEvent]
  'subagent/start': [info: SubagentLifecycle]
  'subagent/end': [info: SubagentLifecycle]
  'agent/status': [payload: { agent: Agent; status: Agent['status'] }]
}
interface ChildHost<S extends ChildSession> {
  sessions: ReadonlyMap<SessionId, S>
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  agent(sessionId: SessionId): Agent | undefined
  subagents(record: S): unknown
  workflow(record: S): WorkflowHistory
  persistence(): Pick<SessionPersistence, 'open' | 'stat'> | undefined
  flush(session: Agent['session']): Promise<unknown>
  projectImages(event: SessionEvent, updates: ProjectedUpdate[]): Promise<ProjectedUpdate[]>
  notify(record: S, method: string, params: unknown): void
  /** Teammates of the session's Agent Team, when its preset has one. */
  teamMembers?(record: S): ReadonlyArray<{ id: string; name: string }> | undefined
  /** The session's background job registry, which runs background one-shot children. */
  jobs?(record: S): unknown
  on<K extends keyof ChildEventMap>(name: K, listener: (...args: ChildEventMap[K]) => void): () => void
  logger: { warn(message: string): void }
}

/** Workflow membership and child visibility are one native projection. Owns
 * their subscriptions, bounded history indexes, refresh coalescing and pending
 * controls so a visible member always has a child view before it is entered. */
export function createNativeChildren<S extends ChildSession>(host: ChildHost<S>) {
  let closed = false
  let disposal: Promise<void> | undefined
  const shutdown = new AbortController(), disposalFailures: unknown[] = []
  const admissions = new Map<AbortController, S>()
  const pending = new Set<Promise<unknown>>()
  const unsubscribes: Array<() => void> = []
  const deferredWorkflowEnds = new Set<NodeJS.Timeout>()
  const interruptions = new Set<{ record: S; abort(): void }>()
  const isLive = (record: S) => !closed && host.sessions.get(record.agent.session.id) === record
  const owned = (clientId: number, id: SessionId | undefined) => closed ? undefined : host.owned(clientId, id)
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    return work
  }
  const request = <T>(operation: () => Promise<T>): Promise<T> => {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
    const work = track(new Promise<T>((yes, no) => { resolve = yes; reject = no }))
    // Reserve ownership first without delaying the native request's admission.
    try { resolve(operation()) } catch (error) { reject(error) }
    return work
  }
  const on: ChildHost<S>['on'] = (name, listener) => {
    try {
      const stop = host.on(name, (...args) => { if (!closed) listener(...args) })
      unsubscribes.push(stop)
      return stop
    } catch (error) {
      // A partially constructed module has no disposer to return to the host.
      closed = true
      const failures: unknown[] = [error]
      for (const stop of unsubscribes.splice(0)) {
        try { stop() } catch (failure) { failures.push(failure) }
      }
      throw new AggregateError(failures, 'native child subscription setup failed')
    }
  }
  const liveWorkflows = new Map<string, LiveWorkflow>()
  const emitWorkflows = (record: S, replay = false, runId?: string): void => {
    if (!isLive(record)) return
    for (const update of workflowUpdates(host.workflow(record), liveWorkflows, Date.now(), runId)) {
      // A visible member must already have a native child view: otherwise an
      // immediate Enter is lost before subagent_spawned reaches the pager.
      if (update.agents.some(agent => workflowChildDiscovery.get(record)?.ids.has(agent.agent_id))) continue
      record.output.notify('x.ai/session_notification', { update }, { isReplay: replay })
    }
  }
  on('workflow/start', info => { liveWorkflows.set(info.id, { meta: info.meta }) })
  on('workflow/phase', (info, phase) => {
    const run = liveWorkflows.get(info.id)
    if (run === undefined) return
    run.phase = phase
    for (const record of host.sessions.values()) emitWorkflows(record, false, info.id)
  })
  on('workflow/end', info => {
    liveWorkflows.delete(info.id)
    // The tool appends run-end as its awaited native result settles.
    const timer = setTimeout(() => {
      deferredWorkflowEnds.delete(timer)
      if (!closed) for (const record of host.sessions.values()) emitWorkflows(record, false, info.id)
    }, 0)
    deferredWorkflowEnds.add(timer)
  })
  const subagentsService = (record: S): SubagentsLike | undefined => {
    const service = host.subagents(record) as SubagentsLike | undefined
    return typeof service?.listDescendants === 'function' && typeof service.interrupt === 'function' ? service : undefined
  }
  const childStates = new WeakMap<S, Map<string, ChildState>>()
  // Workflow workers publish membership before their child reaches the native
  // session corpus; scoped child events need not reach this host listener.
  // Reconcile only undiscovered members, using the existing 500ms host timer.
  // Bound retries so a broken/deleted child cannot scan the corpus forever.
  const workflowChildDiscovery = new WeakMap<S, { ids: Set<string>; deadline: number }>()
  const childSettlements = new WeakMap<Agent, Set<(status: string) => void>>()
  // Only interruption reads need the latest turn arriving across their await.
  // This is transient control state, not another retained history projection.
  const turnWatches = new Map<Agent['session'], Set<{ latest?: SessionEvent<'turn/start'> }>>()
  const turnStarts = new WeakMap<Agent['session'], SessionEvent<'turn/start'>>()
  /** DSH 0.1.7-rc.2 walks parent catalogs: when the root's own catalog cannot
   * be read the whole listing rejects (a SessionQueryError, where rc.1 listed
   * nothing). Say so plainly instead of passing the raw native error on. */
  const listChildRows = async (service: SubagentsLike, record: S, scope: SessionOperation): Promise<ChildRow[]> => {
    try {
      return await service.listDescendants(record.agent.session.id, AbortSignal.any([scope.signal, shutdown.signal]))
    } catch (error) {
      if (!isLive(record) || shutdown.signal.aborted) throw invalidParams('session closed')
      scope.assertActive()
      throw internalError('could not list the subagents of this session (' + errorMessage(error) + '); reopen the session and try again')
    }
  }
  const withChildLog = createChildLogs<S>({
    signal: shutdown.signal, isLive,
    agent: id => host.agent(id), persistence: () => host.persistence(), flush: session => host.flush(session),
    closeFailed: error => { if (closed) disposalFailures.push(error) },
  })
  const emitChildFinished = (record: S, id: string, status: string, output?: unknown, attemptId?: string, durationMs?: number): void => {
    const state = childStates.get(record)?.get(id)
    if (state === undefined || (attemptId !== undefined && state.attemptId !== attemptId)) return
    if (durationMs !== undefined) state.durationMs = durationMs
    if (state.agent !== undefined) for (const settle of childSettlements.get(state.agent) ?? []) settle(status)
    const text = output === undefined ? undefined : typeof output === 'string' ? output : textBlocks(output).map(block => block.text).join('\n')
    if (state.status === status && (text === undefined || text === state.output)) return
    if (text !== undefined) state.output = text
    state.status = status
    if (!isLive(record)) return
    record.output.notify('x.ai/session_notification', { update: {
        sessionUpdate: 'subagent_finished', subagent_id: id, child_session_id: id, status,
        ...state.output === undefined ? {} : { output: state.output },
        ...state.durationMs === undefined ? {} : { duration_ms: state.durationMs },
      } }, { subagentMetricsAvailable: false, ...state.durationMs === undefined ? {} : { subagentDurationAvailable: true },
      nativeAttemptId: state.attemptId })
  }
  const emitChildrenForRecord = async (record: S, scope: SessionOperation): Promise<void> => {
    const service = subagentsService(record)
    if (service === undefined) return
    const rows = await listChildRows(service, record, scope)
    if (!isLive(record)) return
    let known = childStates.get(record)
    if (known === undefined) { known = new Map(); childStates.set(record, known) }
    let discoveredWorkflowChild = false
    const team = host.teamMembers?.(record)
    for (const row of rows) {
      if (row.kind !== 'child') continue
      const overview = await withChildLog(record, row.id, scope, (index, _meta, _read, status) => childOverview(row.id, index.overviewEvents, status, row.activity))
      if (!isLive(record)) return
      const discovery = workflowChildDiscovery.get(record)
      if (discovery?.ids.delete(row.id)) {
        discoveredWorkflowChild = true
        if (discovery.ids.size === 0) workflowChildDiscovery.delete(record)
      }
      const child = host.agent(SessionId(row.id))
      const previous = known.get(row.id)
      if (previous !== undefined && previous.agent === child && previous.attemptId === overview.attemptId) {
        if (overview.status !== 'running') emitChildFinished(record, row.id, overview.status, undefined, overview.attemptId, overview.durationMs)
        continue
      }
      known.set(row.id, { agent: child, label: row.label ?? '', status: 'running', attemptId: overview.attemptId })
      const member = team?.find(item => item.id === row.id)
      record.output.notify('x.ai/session_notification', { update: { sessionUpdate: 'subagent_spawned', subagent_id: row.id, child_session_id: row.id, parent_session_id: row.parentId ?? record.agent.session.id, subagent_type: row.mode ?? 'continuable', description: row.label ?? '', ...member === undefined ? {} : { persona: member.name, role: 'teammate' }, ...previous === undefined ? {} : { effective_context_source: 'resumed', resumed_from: row.id } } }, { nativeChildHistory: true, nativeAttemptId: overview.attemptId })
      if (overview.status !== 'running') emitChildFinished(record, row.id, overview.status, undefined, overview.attemptId, overview.durationMs)
    }
    if (discoveredWorkflowChild) emitWorkflows(record)
  }
  const childRefreshes = new WeakMap<S, { dirty: boolean; promise: Promise<void> }>()
  const refreshChildren = (record: S): Promise<void> => {
    if (!isLive(record)) return Promise.resolve()
    const pending = childRefreshes.get(record)
    if (pending !== undefined) { pending.dirty = true; return pending.promise }
    const state = { dirty: true, promise: Promise.resolve() }
    childRefreshes.set(record, state)
    state.promise = track(record.work.read(async scope => {
      await Promise.resolve()
      try {
        while (state.dirty && isLive(record) && !scope.signal.aborted) {
          state.dirty = false
          try { await emitChildrenForRecord(record, scope) } catch (error) {
            if (isLive(record)) host.logger.warn('grok-leader: subagent snapshot failed: ' + errorChain(error))
          }
        }
      } finally { childRefreshes.delete(record) }
    }).catch(error => {
      childRefreshes.delete(record)
      if (isLive(record)) host.logger.warn('grok-leader: subagent refresh cancelled: ' + errorChain(error))
    }))
    return state.promise
  }
  on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'turn/start') {
      turnStarts.set(session, event)
      for (const watch of turnWatches.get(session) ?? []) watch.latest = event
    }
    const record = host.sessions.get(session.header.id)
    if (record !== undefined && record.agent.session === session) {
      if (String(event.type).startsWith('tool-workflow/')) {
        if (String(event.type) === 'tool-workflow/agent-start') {
          const pending = workflowChildDiscovery.get(record) ?? { ids: new Set<string>(), deadline: 0 }
          pending.ids.add((event.data as { childId: string }).childId)
          pending.deadline = Date.now() + 30000
          workflowChildDiscovery.set(record, pending)
        }
        emitWorkflows(record, false, (event.data as { runId: string }).runId)
        refreshChildren(record)
      }
    }
    for (const record of host.sessions.values()) {
      const child = childStates.get(record)?.get(session.id)
      if (child?.agent?.session === session) {
        host.notify(record, 'x.ai/subagent/history_changed', {
          sessionId: record.agent.session.id, childSessionId: session.id, nextSeq: event.seq + 1,
        })
        if (event.type === 'turn/end') {
          const start = turnStarts.get(session)
          emitChildFinished(record, session.id, childTerminalStatus(event.data.reason.kind), undefined, session.id + ':' + String(event.data.turn),
            start?.type === 'turn/start' && start.data.turn === event.data.turn ? runLength(start, event) : undefined)
        }
      }
      if (event.type === 'turn/start' && session !== record.agent.session) refreshChildren(record)
    }
  })
  on('subagent/start', () => { for (const record of host.sessions.values()) refreshChildren(record) })
  on('subagent/end', info => {
    for (const record of host.sessions.values()) {
      const state = childStates.get(record)?.get(info.id)
      // The exact turn/end settles lifecycle; holder-level end only enriches its terminal output.
      if (state !== undefined && state.status !== 'running') emitChildFinished(record, info.id, state.status, info.lastAssistantMessage)
      refreshChildren(record)
    }
  })

  const childHistory = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/subagent/history')
    if (!nonEmpty(p.sessionId) || !nonEmpty(p.childSessionId)) throw invalidParams('subagent history requires sessionId and childSessionId')
    const sessionId = SessionId(p.sessionId), childSessionId = SessionId(p.childSessionId)
    const record = owned(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + sessionId)
    return record.work.read(async scope => {
      const service = subagentsService(record)
      const rows = service === undefined ? [] : await listChildRows(service, record, scope)
      if (!isLive(record)) throw invalidParams('session closed')
      if (!rows.some(row => row.kind === 'child' && row.id === p.childSessionId)) {
        const unreadable = rows.find(row => row.kind === 'diagnostic' && row.id === p.childSessionId)
        throw invalidParams(unreadable === undefined ? 'unknown subagent'
          : 'subagent ' + p.childSessionId + ' cannot be shown: its session is ' + (unreadable.reason ?? 'unavailable'))
      }
      const after = p.after ?? 0
      if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw invalidParams('invalid child history cursor')
      scope.assertActive()
      return withChildLog(record, childSessionId, scope, async (index, meta, read) => {
        if (owned(clientId, sessionId) !== record) throw invalidParams('unknown session')
        if (after > index.nextSeq) throw invalidParams('child history cursor is ahead of the stored transcript')
        const nextSeq = Math.min(after + CHILD_HISTORY_PAGE_SIZE, index.nextSeq)
        const entries: Array<{ update?: GrokSessionUpdate; meta?: Record<string, unknown>; imageNotes?: string[]; turnEnded?: boolean }> = []
        let turnStartMs = index.turnStartAt(after)
        for (const event of await read(after, nextSeq - after)) {
          if (!isLive(record)) throw invalidParams('unknown session')
          scope.assertActive()
          if (event.type === 'turn/start') turnStartMs = event.time
          const mapped = sessionEventToUpdates(event, { replay: true, cwd: meta.cwd, toolCall: id => index.toolCallAt(id, event.seq) })
          const updates = hasToolImages(event) ? await host.projectImages(event, mapped) : mapped
          scope.assertActive()
          for (const update of updates) entries.push({ update, meta: { isReplay: true, agentTimestampMs: event.time, turnStartMs, streamStartMs: turnStartMs } })
          const notes = systemNotes(event)
          if (notes !== undefined) entries.push({ imageNotes: notes })
          if (event.type === 'turn/end') entries.push({ turnEnded: true })
        }
        if (!isLive(record)) throw invalidParams('unknown session')
        const live = host.agent(childSessionId)
        let durable = live === undefined
        if (live !== undefined && live.status !== 'running' && index.durableSeq < index.nextSeq) {
          // The live prefix was already flushed. Verify its tail through the
          // same owned handle, including when the metadata index was cached.
          if (index.nextSeq > 0) await read(index.nextSeq - 1, 1)
          index.durableSeq = index.nextSeq
        }
        durable ||= index.durableSeq >= index.nextSeq
        if (owned(clientId, sessionId) !== record) throw invalidParams('unknown session')
        return { nextSeq, totalSeq: index.nextSeq, entries, durable }
      })
    })
  }

  type JobsLike = {
    list(caller: SessionId): Array<{ id: string; kind: string; label: string; status: string }>
    kill(id: string, caller: SessionId, reason?: string): 'requested' | 'already-finished'
    wait(id: string, timeoutMs: number, caller: SessionId): Promise<{ status: string }>
  }
  /** The native service interrupts only continuable children. A background
   * one-shot child runs inside a `subagent` job labelled with its description
   * (DSH's subagent tool), and the Tasks pane lists it only as its child row,
   * so a stop there kills that job, as the official job controller does. The
   * job names no child: it is found by label among this session's running
   * subagent jobs. A label that another running one-shot child or job shares
   * refuses rather than stop the wrong one. */
  const stopBackgroundChild = async (record: S, row: ChildRow, rows: readonly ChildRow[], scope: SessionOperation,
    result: (cancelled: boolean, kind: 'cancelled' | 'already_finished' | 'not_found', status?: string) => unknown): Promise<unknown> => {
    const refused = 'one-shot subagents are not interruptible through the released subagent service'
    const jobs = host.jobs?.(record) as JobsLike | undefined
    if (typeof jobs?.list !== 'function' || typeof jobs.kill !== 'function' || typeof jobs.wait !== 'function' || row.label === undefined) throw internalError(refused)
    const caller = record.agent.session.id
    const matches = jobs.list(caller).filter(job => job.kind === 'subagent' && job.label === row.label && (job.status === 'running' || job.status === 'stopping'))
    if (matches.length === 0) throw internalError(refused)
    const namesakes = rows.filter(other => other.kind === 'child' && other.mode !== 'continuable' && other.label === row.label
      && host.agent(SessionId(other.id))?.status === 'running')
    if (matches.length > 1 || namesakes.length > 1) throw internalError('several running subagents are named "' + row.label + '", so dscode cannot tell which background job to stop; let it finish or ask the agent to stop it')
    scope.assertActive()
    const id = matches[0]!.id
    const requested = jobs.kill(id, caller, 'cancelled by the user')
    const settled = requested === 'already-finished' ? undefined : await jobs.wait(id, 5000, caller)
    if (!isLive(record)) throw invalidParams('session closed')
    if (settled === undefined) return result(false, 'already_finished')
    if (settled.status === 'running' || settled.status === 'stopping') throw internalError('subagent cancellation requested; its background job has not settled yet')
    return result(settled.status === 'killed', settled.status === 'killed' ? 'cancelled' : 'already_finished', settled.status === 'killed' ? 'cancelled' : settled.status)
  }

  const cancelSubagent = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/subagent/cancel')
    if (!nonEmpty(p.sessionId) || !nonEmpty(p.subagentId)) throw invalidParams('x.ai/subagent/cancel requires sessionId and subagentId')
    const record = owned(clientId, SessionId(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + p.sessionId)
    const subagentId = p.subagentId
    return record.work.run(async scope => {
      const result = (cancelled: boolean, kind: 'cancelled' | 'already_finished' | 'not_found', status?: string): unknown => ({ result: { subagentId, cancelled, outcome: { kind, ...status === undefined ? {} : { status } } } })
      const service = subagentsService(record)
      if (service === undefined) return result(false, 'not_found')
      const rows = await listChildRows(service, record, scope)
      if (!isLive(record) || record.clientId !== clientId) throw invalidParams('unknown session: ' + p.sessionId)
      scope.assertActive()
      const row = rows.find(entry => entry.id === subagentId && entry.kind === 'child')
      if (row === undefined) return result(false, 'not_found')
      const child = host.agent(SessionId(subagentId))
      if (child === undefined || child.status !== 'running') return result(false, 'already_finished', child?.status ?? 'inactive')
      if (row.mode !== 'continuable') return await stopBackgroundChild(record, row, rows, scope, result)
      const watch: { latest?: SessionEvent<'turn/start'> } = {}
      const watches = turnWatches.get(child.session) ?? new Set()
      turnWatches.set(child.session, watches); watches.add(watch)
      let overview: Pick<ChildState, 'attemptId' | 'status'>
      try {
        overview = await withChildLog(record, subagentId, scope, (index, _meta, _read, status) => childOverview(subagentId, index.overviewEvents, status, row.activity))
      } finally {
        watches.delete(watch)
        if (watches.size === 0) turnWatches.delete(child.session)
      }
      scope.assertActive()
      if (!isLive(record)) throw invalidParams('session closed')
      if (host.agent(SessionId(subagentId)) !== child || child.status !== 'running') return result(false, 'already_finished', child.status)
      // No await from this reconciliation through listener setup and interrupt.
      // A newer turn may have started even while the read handle was closing.
      if (watch.latest !== undefined) overview.attemptId = subagentId + ':' + String(watch.latest.data.turn)
      let known = childStates.get(record)
      if (known === undefined) { known = new Map(); childStates.set(record, known) }
      known.set(subagentId, { agent: child, label: row.label ?? '', ...overview, status: 'running' })
      let listeners = childSettlements.get(child)
      if (listeners === undefined) { listeners = new Set(); childSettlements.set(child, listeners) }
      let settle!: (status: string) => void
      let abort!: () => void
      const settled = new Promise<string>((resolve, reject) => {
        settle = resolve
        abort = () => reject(invalidParams('session closed'))
      })
      void settled.catch(() => {}) // interrupt may abort reentrantly and then throw.
      const interruption = { record, abort }
      interruptions.add(interruption)
      scope.signal.addEventListener('abort', abort, { once: true })
      listeners.add(settle)
      let timer: NodeJS.Timeout | undefined
      try {
        scope.assertActive()
        service.interrupt(SessionId(subagentId), { kind: 'ancestor', agent: record.agent })
        const status = await Promise.race([
          settled,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(internalError('subagent interruption requested; no terminal turn observed yet')), 5000); timer.unref() }),
        ])
        if (!isLive(record)) throw invalidParams('session closed')
        return result(status === 'cancelled', status === 'cancelled' ? 'cancelled' : 'already_finished', status)
      } finally {
        clearTimeout(timer)
        listeners.delete(settle)
        interruptions.delete(interruption)
        scope.signal.removeEventListener('abort', abort)
      }
    })
  }

  const childInbox = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/subagent/inbox')
    const record = owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session')
    const child = (id: string) => host.agent(SessionId(id))
    return record.work.run(async scope => {
      const service = subagentsService(record)
      if (service === undefined) throw invalidParams('Subagents unavailable')
      const rows = (await listChildRows(service, record, scope)).filter(row => row.kind === 'child' && row.mode === 'continuable')
      if (owned(clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
      scope.assertActive()
      if (p.childId === undefined || p.childId === null) return childConversations(rows, child)
      const row = rows.find(row => row.id === p.childId)
      if (row === undefined) throw invalidParams('Unknown continuable child')
      const command = inboxCommand(row, p, child)
      if (command !== undefined) {
        const result = await executeSubagentCommand(clientId, { sessionId: record.agent.session.id, expectedText: p.expectedText, prompt: [{ type: 'text', text: command }] })
        if (result.result.kind === 'error') throw invalidParams(result.result.text)
      }
      if (!isLive(record)) throw invalidParams('session closed')
      return inboxView(row, child(row.id), host.teamMembers?.(record)?.some(item => item.id === row.id) === true)
    })
  }

  /** Human controls use native child admission and inbox mutations; the parent turn is untouched. */
  const executeSubagentCommand = async (clientId: number, params: unknown): Promise<{ result: { kind: 'success' | 'error'; text: string } }> => {
    const p = paramRecord(params, 'x.ai/subagents')
    const record = owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const parsed = parsePrompt(p.prompt)
    if (parsed.images.length > 0) throw invalidParams('/subagents accepts text commands only')
    const command = parseSubagentsCommand(parsed.text)
    if (command === undefined) throw invalidParams('x.ai/subagents requires a /subagents invocation')
    return record.work.run(async scope => {
      const service = subagentsService(record)
      if (service === undefined) throw new Error('Subagents are unavailable in this preset.')
      const rows = (await listChildRows(service, record, scope)).filter(row => row.kind === 'child')
      if (owned(clientId, record.agent.session.id) !== record) throw new Error('The owning session was closed.')
      scope.assertActive()
      const text = await runSubagentVerb(command, {
        rows, members: host.teamMembers?.(record) ?? [], expectedText: p.expectedText,
        child: id => host.agent(SessionId(id)),
        prompt: service.prompt === undefined ? undefined : async (row, delivery, body) => {
          const admission = new AbortController()
          admissions.set(admission, record)
          try {
            const receipt = await service.prompt!({
              requestId: randomUUID() as SubagentPromptRequestId,
              parentSessionId: SessionId(row.parentId ?? record.agent.session.id),
              childSessionId: SessionId(row.id),
              mode: 'continuable', delivery,
              content: [{ type: 'text', text: body }],
            }, AbortSignal.any([scope.signal, admission.signal]))
            if (!isLive(record)) throw new Error('The owning session was closed.')
            return receipt
          } finally { admissions.delete(admission) }
        },
        stop: id => cancelSubagent(clientId, { sessionId: record.agent.session.id, subagentId: id }),
      })
      return { result: { kind: 'success' as const, text } }
    }).catch(error => ({ result: { kind: 'error' as const, text: errorChain(error) } }))
  }

  on('agent/status', ({ agent, status }) => {
    if (host.sessions.get(agent.session.id)?.agent === agent) return
    for (const owner of host.sessions.values()) {
      void refreshChildren(owner)
      if (status === 'idle' && childStates.get(owner)?.get(agent.session.id)?.agent === agent) {
        host.notify(owner, 'x.ai/subagent/history_changed', {
          sessionId: owner.agent.session.id, childSessionId: agent.session.id, nextSeq: agent.session.seq,
        })
      }
    }
  })

  return {
    snapshot(record: S, replay = false): Promise<void> {
      // Cold attachment needs the same child-before-member ordering as live
      // discovery. Replay callers must await this before acknowledging the
      // lifecycle request, which closes the client's replay window.
      return track(refreshChildren(record).then(() => {
        try { emitWorkflows(record, replay) } catch (error) {
          if (isLive(record)) host.logger.warn('grok-leader: workflow snapshot failed: ' + errorChain(error))
        }
      }))
    },
    poll(): void {
      if (closed) return
      for (const [admission, record] of admissions) if (!isLive(record)) admission.abort()
      for (const interruption of interruptions) if (!isLive(interruption.record)) interruption.abort()
      for (const record of host.sessions.values()) {
        const discovery = workflowChildDiscovery.get(record)
        if (discovery === undefined) continue
        if (Date.now() >= discovery.deadline) {
          workflowChildDiscovery.delete(record)
          host.logger.warn('grok-leader: workflow child discovery timed out; reopen the session to retry')
          emitWorkflows(record)
        } else void refreshChildren(record)
      }
    },
    // Register the request before an external lookup can synchronously reenter
    // disposal. The native calls still run under their original owner checks.
    history: (clientId: number, params: unknown) => request(() => childHistory(clientId, params)),
    cancel: (clientId: number, params: unknown) => request(() => cancelSubagent(clientId, params)),
    inbox: (clientId: number, params: unknown) => request(() => childInbox(clientId, params)),
    command: (clientId: number, params: unknown) => request(() => executeSubagentCommand(clientId, params)),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => {
        while (pending.size > 0) await Promise.allSettled([...pending])
        if (disposalFailures.length > 0) throw new AggregateError(disposalFailures, 'native child subscription or read cleanup failed')
      })
      shutdown.abort()
      for (const admission of admissions.keys()) admission.abort()
      for (const interruption of interruptions) interruption.abort()
      for (const timer of deferredWorkflowEnds) clearTimeout(timer)
      deferredWorkflowEnds.clear()
      liveWorkflows.clear()
      for (const stop of unsubscribes.splice(0)) {
        try { stop() } catch (error) { disposalFailures.push(error) }
      }
      return disposal
    },
  }
}
