import type { SessionOperation, SessionWork } from './session-work.ts'
import { hasToolImages } from './image-output.ts'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRuntime, SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { invalidParams, internalError, paramRecord } from './acp.ts'
import { ChildHistoryIndex, CHILD_HISTORY_PAGE_SIZE, type ChildEventReader } from './child-history.ts'
import { WorkflowIndex, type LiveWorkflow } from './workflows.ts'
import { parsePrompt } from './prompt-content.ts'
import { sessionEventToUpdates, textBlocks, type GrokSessionUpdate, type ProjectedUpdate } from './projection.ts'
import type { SessionOutput } from './session-output.ts'

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
  persistence(): Pick<SessionPersistence, 'open' | 'stat'> | undefined
  flush(session: Agent['session']): Promise<unknown>
  projectImages(event: SessionEvent, updates: ProjectedUpdate[]): Promise<ProjectedUpdate[]>
  notify(record: S, method: string, params: unknown): void
  on<K extends keyof ChildEventMap>(name: K, listener: (...args: ChildEventMap[K]) => void): () => void
  logger: { warn(message: string): void }
}
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

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
  type ChildRow = { kind: 'child' | 'diagnostic'; id: string; mode?: 'continuable' | 'one-shot'; label?: string; parentId?: string }
  const liveWorkflows = new Map<string, LiveWorkflow>()
  const workflowIndexes = new WeakMap<S, WorkflowIndex>()
  const emitWorkflows = (record: S, replay = false, runId?: string): void => {
    if (!isLive(record)) return
    let index = workflowIndexes.get(record)
    if (index === undefined) { index = new WorkflowIndex(); workflowIndexes.set(record, index) }
    for (const update of index.updates(record.agent.session, liveWorkflows, Date.now(), runId)) {
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
    for (const record of host.sessions.values()) if (workflowIndexes.get(record)?.has(info.id)) emitWorkflows(record, false, info.id)
  })
  on('workflow/end', info => {
    liveWorkflows.delete(info.id)
    // The tool appends run-end as its awaited native result settles.
    const timer = setTimeout(() => {
      deferredWorkflowEnds.delete(timer)
      if (!closed) for (const record of host.sessions.values()) if (workflowIndexes.get(record)?.has(info.id)) emitWorkflows(record, false, info.id)
    }, 0)
    deferredWorkflowEnds.add(timer)
  })
  type SubagentsLike = {
    listDescendants(root: SessionId): Promise<ChildRow[]>
    interrupt(id: SessionId, authority: { kind: 'ancestor'; agent: Agent }): void
    prompt?: SubagentRuntime['prompt']
  }
  const subagentsService = (record: S): SubagentsLike | undefined => {
    const service = host.subagents(record) as SubagentsLike | undefined
    return typeof service?.listDescendants === 'function' && typeof service.interrupt === 'function' ? service : undefined
  }
  type ChildState = { agent?: Agent; label: string; status: string; attemptId: string; output?: string }
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
  const childTerminalStatus = (kind: string): string => kind === 'completed' || kind === 'max-tokens' ? 'completed'
    : kind === 'aborted' || kind === 'interrupted' ? 'cancelled' : 'failed'
  const childOverview = (id: string, events: readonly SessionEvent[], agent?: Agent): Pick<ChildState, 'attemptId' | 'status'> => {
    const start = events.findLast(event => event.type === 'turn/start')
    const end = events.findLast(event => event.type === 'turn/end')
    return {
      attemptId: id + ':' + String(start?.type === 'turn/start' ? start.data.turn : 'pending'),
      status: agent?.status === 'running' ? 'running'
        : end?.type === 'turn/end' && (start?.type !== 'turn/start' || end.data.turn === start.data.turn)
          ? childTerminalStatus(end.data.reason.kind) : 'cancelled',
    }
  }
  const childLogs = new WeakMap<S, Map<string, { source?: object; index: ChildHistoryIndex; tail: Promise<unknown> }>>()
  const withChildLog = async <T>(record: S, id: string, scope: SessionOperation,
    action: (index: ChildHistoryIndex, meta: SessionInspection['meta'], read: ChildEventReader) => Promise<T> | T,
  ): Promise<T> => {
    const signal = AbortSignal.any([scope.signal, shutdown.signal])
    const assertActive = () => {
      if (!isLive(record) || signal.aborted) throw invalidParams('session closed')
      scope.assertActive()
    }
    assertActive()
    let cache = childLogs.get(record)
    if (cache === undefined) { cache = new Map(); childLogs.set(record, cache) }
    const cached = cache.get(id) ?? { index: new ChildHistoryIndex(), tail: Promise.resolve() }
    cache.delete(id)
    cache.set(id, cached)
    // ponytail: bound metadata to 64 children per root; evicted histories rebuild on demand.
    if (cache.size > 64) cache.delete(cache.keys().next().value!)
    const work = cached.tail.then(async () => {
      assertActive()
      // Resolve after earlier reads/cleanup settle: a completed child can
      // leave the native store while this operation is waiting in the queue.
      // Serialization belongs to the child entry, not its replaceable index.
      const live = host.agent(SessionId(id)), store = host.persistence()
      if (store === undefined) throw internalError('session persistence is not configured')
      const source = live?.session ?? store
      if (cached.source !== source) { cached.source = source; cached.index = new ChildHistoryIndex() }
      const index = cached.index
      assertActive()
      // Fix the live prefix before flushing; later appends belong to the next
      // refresh. Cold storage uses its revision/count and the same read owner.
      let count: number | undefined, revision: string | undefined
      if (live !== undefined) {
        count = live.session.seq
        revision = String(count)
        await host.flush(live.session)
      } else {
        const snapshot = await store.stat(SessionId(id), { signal })
        count = snapshot?.eventCount
        revision = snapshot?.revision
      }
      assertActive()
      const handle = await store.open(SessionId(id), 'read', { signal })
      const failures: unknown[] = []
      let result!: T
      try {
        assertActive()
        const read: ChildEventReader = async (offset, length) => {
          assertActive()
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > CHILD_HISTORY_PAGE_SIZE
            || (count !== undefined && offset + length > count)) throw internalError('invalid child history page')
          if (length === 0) return []
          const { events } = await handle.read(offset, length, { signal })
          assertActive()
          if (events.length > length || (count !== undefined && events.length !== length)) throw internalError('child reader did not return the required page')
          if (events.some((event, position) => event.seq !== offset + position)) throw internalError('child reader returned a noncontiguous page')
          return events
        }
        await index.sync(read, revision, count)
        // Unknown cold lengths become fixed after the index reaches EOF.
        count = index.nextSeq
        result = await action(index, handle.header, read)
        assertActive()
      } catch (error) { failures.push(error) }
      // Close is deliberately uncancellable and always awaited, even after a
      // late open or projection failure. Preserve both errors when it fails.
      try { await handle.close() } catch (error) {
        failures.push(error)
        if (closed) disposalFailures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'child history read and cleanup failed')
      assertActive()
      return result
    })
    cached.tail = work.catch(() => {})
    return work
  }
  const emitChildFinished = (record: S, id: string, status: string, output?: unknown, attemptId?: string): void => {
    const state = childStates.get(record)?.get(id)
    if (state === undefined || (attemptId !== undefined && state.attemptId !== attemptId)) return
    if (state.agent !== undefined) for (const settle of childSettlements.get(state.agent) ?? []) settle(status)
    const text = output === undefined ? undefined : typeof output === 'string' ? output : textBlocks(output).map(block => block.text).join('\n')
    if (state.status === status && (text === undefined || text === state.output)) return
    if (text !== undefined) state.output = text
    state.status = status
    if (!isLive(record)) return
    record.output.notify('x.ai/session_notification', { update: {
        sessionUpdate: 'subagent_finished', subagent_id: id, child_session_id: id, status,
        ...state.output === undefined ? {} : { output: state.output },
      } }, { subagentMetricsAvailable: false, nativeAttemptId: state.attemptId })
  }
  const emitChildrenForRecord = async (record: S, scope: SessionOperation): Promise<void> => {
    const service = subagentsService(record)
    if (service === undefined) return
    const rows = await service.listDescendants(record.agent.session.id)
    if (!isLive(record)) return
    let known = childStates.get(record)
    if (known === undefined) { known = new Map(); childStates.set(record, known) }
    let discoveredWorkflowChild = false
    for (const row of rows) {
      if (row.kind !== 'child') continue
      const overview = await withChildLog(record, row.id, scope, index => childOverview(row.id, index.overviewEvents, host.agent(SessionId(row.id))))
      if (!isLive(record)) return
      const discovery = workflowChildDiscovery.get(record)
      if (discovery?.ids.delete(row.id)) {
        discoveredWorkflowChild = true
        if (discovery.ids.size === 0) workflowChildDiscovery.delete(record)
      }
      const child = host.agent(SessionId(row.id))
      const previous = known.get(row.id)
      if (previous !== undefined && previous.agent === child && previous.attemptId === overview.attemptId) {
        if (overview.status !== 'running') emitChildFinished(record, row.id, overview.status, undefined, overview.attemptId)
        continue
      }
      known.set(row.id, { agent: child, label: row.label ?? '', status: 'running', attemptId: overview.attemptId })
      record.output.notify('x.ai/session_notification', { update: { sessionUpdate: 'subagent_spawned', subagent_id: row.id, child_session_id: row.id, parent_session_id: row.parentId ?? record.agent.session.id, subagent_type: row.mode ?? 'continuable', description: row.label ?? '', ...previous === undefined ? {} : { effective_context_source: 'resumed', resumed_from: row.id } } }, { nativeChildHistory: true, nativeAttemptId: overview.attemptId })
      if (overview.status !== 'running') emitChildFinished(record, row.id, overview.status, undefined, overview.attemptId)
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
    if (event.type === 'turn/start') for (const watch of turnWatches.get(session) ?? []) watch.latest = event
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
        if (event.type === 'turn/end') emitChildFinished(record, session.id, childTerminalStatus(event.data.reason.kind), undefined, session.id + ':' + String(event.data.turn))
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
    if (!nonEmptyString(p.sessionId) || !nonEmptyString(p.childSessionId)) throw invalidParams('subagent history requires sessionId and childSessionId')
    const sessionId = SessionId(p.sessionId), childSessionId = SessionId(p.childSessionId)
    const record = owned(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + sessionId)
    return record.work.read(async scope => {
      const rows = await subagentsService(record)?.listDescendants(record.agent.session.id)
      if (!isLive(record)) throw invalidParams('session closed')
      if (!rows?.some(row => row.kind === 'child' && row.id === p.childSessionId)) throw invalidParams('unknown subagent')
      const after = p.after ?? 0
      if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw invalidParams('invalid child history cursor')
      scope.assertActive()
      return withChildLog(record, childSessionId, scope, async (index, meta, read) => {
        if (owned(clientId, sessionId) !== record) throw invalidParams('unknown session')
        if (after > index.nextSeq) throw invalidParams('child history cursor is ahead of the stored transcript')
        const nextSeq = Math.min(after + CHILD_HISTORY_PAGE_SIZE, index.nextSeq)
        const entries: Array<{ update?: GrokSessionUpdate; meta?: Record<string, unknown>; turnEnded?: boolean }> = []
        let turnStartMs = index.turnStartAt(after)
        for (const event of await read(after, nextSeq - after)) {
          if (!isLive(record)) throw invalidParams('unknown session')
          scope.assertActive()
          if (event.type === 'turn/start') turnStartMs = event.time
          const mapped = sessionEventToUpdates(event, { replay: true, cwd: meta.cwd, toolCall: id => index.toolCallAt(id, event.seq) })
          const updates = hasToolImages(event) ? await host.projectImages(event, mapped) : mapped
          scope.assertActive()
          for (const update of updates) entries.push({ update, meta: { isReplay: true, agentTimestampMs: event.time, turnStartMs, streamStartMs: turnStartMs } })
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

  const cancelSubagent = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/subagent/cancel')
    if (!nonEmptyString(p.sessionId) || !nonEmptyString(p.subagentId)) throw invalidParams('x.ai/subagent/cancel requires sessionId and subagentId')
    const record = owned(clientId, SessionId(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + p.sessionId)
    const subagentId = p.subagentId
    return record.work.run(async scope => {
      const result = (cancelled: boolean, kind: 'cancelled' | 'already_finished' | 'not_found', status?: string): unknown => ({ result: { subagentId, cancelled, outcome: { kind, ...status === undefined ? {} : { status } } } })
      const service = subagentsService(record)
      if (service === undefined) return result(false, 'not_found')
      const rows = await service.listDescendants(record.agent.session.id)
      if (!isLive(record) || record.clientId !== clientId) throw invalidParams('unknown session: ' + p.sessionId)
      scope.assertActive()
      const row = rows.find(entry => entry.id === subagentId && entry.kind === 'child')
      if (row === undefined) return result(false, 'not_found')
      const child = host.agent(SessionId(subagentId))
      if (child === undefined || child.status !== 'running') return result(false, 'already_finished', child?.status ?? 'inactive')
      if (row.mode !== 'continuable') throw internalError('one-shot subagents are not interruptible through the released subagent service')
      const watch: { latest?: SessionEvent<'turn/start'> } = {}
      const watches = turnWatches.get(child.session) ?? new Set()
      turnWatches.set(child.session, watches); watches.add(watch)
      let overview: Pick<ChildState, 'attemptId' | 'status'>
      try {
        overview = await withChildLog(record, subagentId, scope, index => childOverview(subagentId, index.overviewEvents, child))
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
    const record = owned(clientId, typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
    if (record === undefined) throw invalidParams('unknown session')
    return record.work.run(async scope => {
      const service = subagentsService(record)
      if (service === undefined) throw invalidParams('Subagents unavailable')
      const rows = (await service.listDescendants(record.agent.session.id)).filter(row => row.kind === 'child' && row.mode === 'continuable')
      if (owned(clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
      scope.assertActive()
      if (p.childId === undefined || p.childId === null) {
        return { title: 'Child conversations', items: rows.map(row => ({ id: row.id, text: row.label || row.id, detail: host.agent(SessionId(row.id))?.status ?? 'inactive', editable: false })) }
      }
      const row = rows.find(row => row.id === p.childId)
      if (row === undefined) throw invalidParams('Unknown continuable child')
      const action = p.action ?? 'list'
      if (typeof action !== 'string' || !['list', 'queue', 'steer', 'edit', 'remove', 'steer-queued', 'clear', 'stop'].includes(action)) throw invalidParams('Unknown inbox action')
      if (action !== 'list') {
        let body = ''
        if (['edit', 'remove', 'steer-queued'].includes(action)) {
          const child = host.agent(SessionId(row.id))
          const message = [...child?.inbox.nextTurn ?? [], ...child?.inbox.nextStep ?? []].find(message => message.id === p.messageId)
          if (message === undefined) throw invalidParams('This message has already left the queue. Refresh and try again.')
          body = message.id
        }
        if (['queue', 'steer', 'edit'].includes(action)) {
          if (typeof p.text !== 'string' || p.text.trim().length === 0) throw invalidParams('A message is required.')
          body += (body.length > 0 ? ' ' : '') + p.text
        }
        const result = await executeSubagentCommand(clientId, { sessionId: record.agent.session.id, expectedText: p.expectedText, prompt: [{ type: 'text', text: `/subagents ${action} ${row.id}${body.length > 0 ? ' ' + body : ''}` }] })
        if (result.result.kind === 'error') throw invalidParams(result.result.text)
      }
      if (!isLive(record)) throw invalidParams('session closed')
      const child = host.agent(SessionId(row.id))
      return { title: 'Input queue · ' + (row.label || row.id), items: [...child?.inbox.nextTurn ?? [], ...child?.inbox.nextStep ?? []].map(message => ({
        id: message.id, text: textBlocks(message.content).map(block => block.text).join(''),
        detail: child?.inbox.nextTurn.includes(message) ? 'queued for next turn' : 'steering at next step',
        editable: message.content.every(block => block.type === 'text'),
      })) }
    })
  }

  /** Human controls use native child admission and inbox mutations; the parent turn is untouched. */
  const executeSubagentCommand = async (clientId: number, params: unknown): Promise<{ result: { kind: 'success' | 'error'; text: string } }> => {
    const p = paramRecord(params, 'x.ai/subagents')
    const record = owned(clientId, typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const parsed = parsePrompt(p.prompt)
    if (parsed.images.length > 0) throw invalidParams('/subagents accepts text commands only')
    const match = /^\/subagents(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(parsed.text.trim())
    if (match === null) throw invalidParams('x.ai/subagents requires a /subagents invocation')
    return record.work.run(async scope => {
      const [, verb = 'list', selector, body = ''] = match
      const usage = 'Usage: /subagents list\n/subagents pending <child>\n/subagents queue|steer <child> <text>\n/subagents edit <child> <message> <text>\n/subagents remove <child> <message>\n/subagents steer-queued <child> <message|all>\n/subagents clear|stop <child>\nChild and message IDs accept unique prefixes. Stop preserves queued input.'
      const success = (text: string) => ({ result: { kind: 'success' as const, text } })
      const service = subagentsService(record)
      if (service === undefined) throw new Error('Subagents are unavailable in this preset.')
      const rows = (await service.listDescendants(record.agent.session.id)).filter(row => row.kind === 'child')
      if (owned(clientId, record.agent.session.id) !== record) throw new Error('The owning session was closed.')
      scope.assertActive()
      if (verb === 'list' && selector === undefined) {
        return success((rows.length === 0 ? 'No child conversations.' : rows.map(row => {
          const child = host.agent(SessionId(row.id))
          return `${row.id}  ${child?.status === 'running' ? 'running' : 'idle'}  ${row.mode ?? 'unknown'}  ${row.label ?? ''}`
        }).join('\n')) + '\n\n' + usage)
      }
      if (selector === undefined || !['pending', 'queue', 'steer', 'edit', 'remove', 'steer-queued', 'clear', 'stop'].includes(verb)) throw new Error(usage)
      const resolvePrefix = <T extends { id: string }>(items: readonly T[], id: string, label: string): T => {
        const exact = items.find(item => item.id === id)
        if (exact !== undefined) return exact
        const matches = id.length === 0 ? [] : items.filter(item => item.id.startsWith(id))
        if (matches.length !== 1) throw new Error(`${matches.length === 0 ? 'Unknown' : 'Ambiguous'} ${label}: ${id}`)
        return matches[0]!
      }
      const row = resolvePrefix(rows, selector, 'child')
      if (row.mode !== 'continuable') throw new Error('Only continuable children accept these controls.')
      const childId = SessionId(row.id)
      const child = host.agent(childId)
      if (verb === 'queue' || verb === 'steer') {
        if (body.trim().length === 0) throw new Error('A message is required.\n' + usage)
        if (service.prompt === undefined) throw new Error('Child message admission is unavailable.')
        const admission = new AbortController()
        admissions.set(admission, record)
        try {
          const receipt = await service.prompt({
            requestId: randomUUID() as SubagentPromptRequestId,
            parentSessionId: SessionId(row.parentId ?? record.agent.session.id),
            childSessionId: childId,
            mode: 'continuable', delivery: verb,
            content: [{ type: 'text', text: body }],
          }, AbortSignal.any([scope.signal, admission.signal]))
          if (!isLive(record)) throw new Error('The owning session was closed.')
          return success(`${verb === 'queue' ? 'Queued' : 'Steering'} child ${row.id}: ${receipt.messageId}`)
        } finally { admissions.delete(admission) }
      }
      if (verb === 'stop') {
        if (body.length > 0) throw new Error(usage)
        await cancelSubagent(clientId, { sessionId: record.agent.session.id, subagentId: row.id })
        return success(`Child ${row.id} stopped; queued input is preserved.`)
      }
      if (child === undefined) {
        if (verb === 'pending') return success(`Child ${row.id} is inactive; no live queue is available.`)
        throw new Error('The child is inactive; queue a new message to continue it before editing pending input.')
      }
      const pending = [...child.inbox.nextTurn, ...child.inbox.nextStep]
      if (verb === 'pending') {
        if (body.length > 0) throw new Error(usage)
        return success(`Pending input for ${row.id}:\n` + (pending.length === 0 ? '(empty)' : pending.map(message =>
          `${message.id}  ${child.inbox.nextTurn.includes(message) ? 'queued' : 'next-step'}  ${textBlocks(message.content).map(block => block.text).join('\n')}`).join('\n')))
      }
      if (verb === 'clear') {
        if (body.length > 0) throw new Error(usage)
        child.inbox.clear()
        return success(`Cleared ${pending.length} pending message(s) for ${row.id}.`)
      }
      if (verb === 'steer-queued') {
        if (child.status !== 'running') throw new Error('The child has no running turn to steer.')
        const selected = body === 'all' ? [...child.inbox.nextTurn] : [resolvePrefix(child.inbox.nextTurn, body, 'queued message')]
        for (const message of selected) {
          child.inbox.remove(message.id)
          child.steer(message)
        }
        return success(`Steering ${selected.length} queued message(s) into child ${row.id}.`)
      }
      const edit = verb === 'edit' ? /^(\S+)\s+([\s\S]+)$/.exec(body) : undefined
      if (verb === 'edit' && edit == null) throw new Error(usage)
      const message = resolvePrefix(pending, edit?.[1] ?? body, 'pending message')
      if (verb === 'edit') {
        // Validate after asynchronous descendant lookup, immediately before replacement.
        if (message.content.some(block => block.type !== 'text') || (p.expectedText !== undefined && p.expectedText !== textBlocks(message.content).map(block => block.text).join(''))) {
          throw new Error('This message changed or contains attachments; it cannot be replaced by this text edit.')
        }
        child.inbox.replace(message.id, { ...message, content: [{ type: 'text', text: edit![2]! }] })
        return success(`Edited pending message ${message.id} for ${row.id}.`)
      }
      child.inbox.remove(message.id)
      return success(`Removed pending message ${message.id} for ${row.id}.`)
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
