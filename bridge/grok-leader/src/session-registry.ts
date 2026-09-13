import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams } from './acp.ts'
import type { SessionWork } from './session-work.ts'

export interface OwnedSession {
  clientId: number
  agent: Agent
  queue: { cancel(): void; dispose(): Promise<void> }
  work: Pick<SessionWork, 'cancel' | 'settle' | 'dispose'>
  mcpInitTimer: ReturnType<typeof setTimeout> | undefined
  dispose(): Promise<void>
}

export interface SessionRegistryDependencies {
  clientIsLive(clientId: number): boolean
  flush(session: Agent['session']): Promise<unknown>
  cancelRequests(clientId: number, sessionId: SessionId): void
  logger: { warn(message: string): void }
}

/** Sole owner of accepted sessions and their lifecycle. A retiring id stays
 * reserved until durable flush and disposal finish; a late creator is disposed
 * before its failed publication returns. Features receive only the read view. */
export function createSessionRegistry<T extends OwnedSession>(dependencies: SessionRegistryDependencies) {
  const records = new Map<SessionId, T>()
  const retiring = new Map<SessionId, T>()
  const releases = new WeakMap<T, Promise<void>>()
  const operations = new Set<Promise<unknown>>()
  const teardowns = new Set<Promise<void>>()
  const reloading = new WeakSet<T>()
  // Preflight borrows the native session until its idle/flush/capture phase
  // settles. Explicit close must not release that session underneath it.
  const reloadDrains = new WeakMap<T, Promise<void>>()
  let closed = false
  let disposal: Promise<void> | undefined
  let shutdownTeardowns: Set<Promise<void>> | undefined

  const assertOpen = (): void => {
    if (closed) throw internalError('the grok leader has been disposed')
  }
  const owned = (clientId: number, sessionId: SessionId | undefined): T | undefined => {
    const record = sessionId === undefined ? undefined : records.get(sessionId)
    return record?.clientId === clientId ? record : undefined
  }
  const ownedAgent = (agent: Agent): T | undefined => {
    const record = records.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }
  // Read/event ownership survives reversible reload preflight; input admission
  // does not. A failed flush restores admission without replacing the owner.
  const acceptsInput = (record: T): boolean => !closed && records.get(record.agent.session.id) === record && !reloading.has(record)
  const assertReady = (record: T): void => {
    assertOpen()
    if (records.get(record.agent.session.id) !== record) throw invalidParams('session closed')
    if (reloading.has(record)) throw invalidParams('session is already reloading')
  }
  const clearTimer = (record: T): void => {
    clearTimeout(record.mcpInitTimer)
    record.mcpInitTimer = undefined
  }
  const trackTeardown = (record: T, pending: Promise<void>): Promise<void> => {
    releases.set(record, pending)
    teardowns.add(pending)
    shutdownTeardowns?.add(pending)
    // Observe both outcomes without creating an unhandled rejected tail.
    void pending.then(() => { teardowns.delete(pending) }, () => { teardowns.delete(pending) })
    return pending
  }

  /** Withdraw synchronously; drain bridge input, flush, and always dispose.
   * The owned agent disposer retires its driver. Reload has already flushed
   * and captured the final log before committing this irreversible step. */
  const retire = (record: T, alreadyFlushed: boolean): Promise<void> => {
    const previous = releases.get(record)
    if (previous !== undefined) return previous
    if (records.get(record.agent.session.id) !== record) return Promise.resolve()
    records.delete(record.agent.session.id)
    retiring.set(record.agent.session.id, record)
    clearTimer(record)
    const reloadDrain = reloadDrains.get(record)
    // Cancellation/disposal hooks can throw or reenter close/shutdown. Publish
    // this retirement first, then attempt every cleanup step exactly once.
    let resolve!: () => void, reject!: (reason: unknown) => void
    const pending = trackTeardown(record, new Promise<void>((yes, no) => { resolve = yes; reject = no }))
    const failures: unknown[] = []
    try { dependencies.cancelRequests(record.clientId, record.agent.session.id) } catch (error) { failures.push(error) }
    let promptDrain: Promise<void> | undefined
    try { promptDrain = record.queue.dispose() } catch (error) { failures.push(error) }
    let controlDrain: Promise<void> | undefined
    try { controlDrain = record.work.dispose() } catch (error) { failures.push(error) }
    void (async () => {
      try {
        const drains = await Promise.allSettled([promptDrain, controlDrain, reloadDrain])
        for (const result of drains) if (result.status === 'rejected') failures.push(result.reason as unknown)
        if (!alreadyFlushed) {
          try { await dependencies.flush(record.agent.session) } catch (error) { failures.push(error) }
        }
      } finally {
        try { await record.dispose() } catch (error) { failures.push(error) }
        if (retiring.get(record.agent.session.id) === record) retiring.delete(record.agent.session.id)
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map(error => errorChain(error)).join('; '))
    })().then(resolve, reject)
    return pending
  }
  const close = (record: T): Promise<void> => retire(record, false)

  const drain = async (): Promise<void> => {
    // Operations can publish or reject late and start disposal while draining.
    // Re-snapshot until both owned sets are empty.
    while (operations.size > 0 || teardowns.size > 0) await Promise.allSettled([...operations, ...teardowns])
  }

  return {
    records: records as ReadonlyMap<SessionId, T>,
    get closed() { return closed },
    assertOpen, assertReady, acceptsInput, owned, ownedAgent, close, drain,
    /** A failed preflight keeps the exact live owner and its usable queue.
     * Only after idle + durable flush + capture succeeds does retirement commit. */
    async reload<R>(record: T, capture: () => R, settle?: () => Promise<void>): Promise<R> {
      assertOpen()
      if (records.get(record.agent.session.id) !== record) throw invalidParams('unknown session')
      if (reloading.has(record)) throw invalidParams('session is already reloading')
      reloading.add(record)
      // Publish before cancellation hooks can reenter close. This barrier is
      // completion-only: preflight errors belong to the reload caller, while
      // explicit close still performs its own final flush and cleanup.
      let release!: () => void
      const preflight = new Promise<void>(resolve => { release = resolve })
      reloadDrains.set(record, preflight)
      const finishPreflight = () => {
        if (reloadDrains.get(record) === preflight) reloadDrains.delete(record)
        release()
      }
      try {
        const failures: unknown[] = []
        try { record.queue.cancel() } catch (error) { failures.push(error) }
        clearTimer(record)
        try { dependencies.cancelRequests(record.clientId, record.agent.session.id) } catch (error) { failures.push(error) }
        try { record.work.cancel() } catch (error) { failures.push(error) }
        // Failed cancellation must neither skip other owners nor reopen input
        // while their accepted work is still running. Observe sync throws too.
        const drains = await Promise.allSettled([
          Promise.resolve().then(() => settle?.()),
          Promise.resolve().then(() => record.work.settle()),
        ])
        for (const result of drains) if (result.status === 'rejected') failures.push(result.reason as unknown)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'session reload settlement failed')
        if (records.get(record.agent.session.id) !== record) throw invalidParams('session closed')
        await record.agent.whenIdle()
        if (records.get(record.agent.session.id) !== record) throw invalidParams('session closed')
        await dependencies.flush(record.agent.session)
        if (records.get(record.agent.session.id) !== record) throw invalidParams('session closed')
        const result = capture()
        if (records.get(record.agent.session.id) !== record) throw invalidParams('session closed')
        // Release the borrow before retiring ourselves, otherwise retirement
        // would wait for the reload that is itself awaiting retirement.
        finishPreflight()
        await retire(record, true)
        return result
      } finally { finishPreflight(); reloading.delete(record) }
    },
    async operation<R>(clientId: number, operation: () => Promise<R>): Promise<R> {
      assertOpen()
      if (!dependencies.clientIsLive(clientId)) throw invalidParams('client disconnected')
      // The callback can synchronously enter host shutdown. Its promise must
      // already belong to this registry when that drain snapshots operations.
      const pending = Promise.resolve().then(operation)
      operations.add(pending)
      try { return await pending } finally { operations.delete(pending) }
    },
    async publish(sessionId: SessionId, record: T): Promise<void> {
      if (records.get(sessionId) === record) throw invalidParams('session already published')
      if (closed || !dependencies.clientIsLive(record.clientId) || records.has(sessionId) || retiring.has(sessionId)) {
        clearTimer(record)
        const pending = Promise.resolve().then(async () => {
          try { await record.queue.dispose() } finally { await record.dispose() }
        })
        await trackTeardown(record, pending)
        throw invalidParams('session owner disconnected, leader closed, or session already in use')
      }
      records.set(sessionId, record)
    },
    disconnect(clientId: number): void {
      for (const record of records.values()) {
        if (record.clientId !== clientId) continue
        void close(record).catch(error => {
          dependencies.logger.warn('grok-leader: session teardown failed for ' + String(record.agent.session.id) + ': ' + errorChain(error))
        })
      }
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      const pending = shutdownTeardowns = new Set(teardowns)
      disposal = Promise.resolve().then(async () => {
        await drain()
        const results = await Promise.allSettled([...pending])
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
        if (failures.length > 0) throw new AggregateError(failures,
          'grok leader teardown failed for ' + String(failures.length) + ' session(s): ' + failures.map(error => errorChain(error)).join('; '))
      })
      for (const record of [...records.values()]) close(record)
      return disposal
    },
  }
}
