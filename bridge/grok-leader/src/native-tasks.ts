import type { SessionWork } from './session-work.ts'
import type { SessionDiscovery } from './session-discovery.ts'
import { randomUUID } from 'node:crypto'
import type { JobEvent, JobEvents } from '@deepseek-ai/dsh-jobs'
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldScheduleEvents } from '@deepseek-ai/dsh-schedule'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { invalidParams, internalError, paramRecord, sessionIdParam } from './acp.ts'
import { parseReminder } from './reminders.ts'
import { nonEmpty } from './guards.ts'
import type { SessionOutput } from './session-output.ts'
import { jobOutputPatch } from './job-output.ts'

interface TaskSession {
  work: Pick<SessionWork, 'run' | 'read'>
  agent: Agent
  output: Pick<SessionOutput, 'notify' | 'update'>
}
interface TaskHost<T extends TaskSession> {
  sessions: ReadonlyMap<SessionId, T>
  owned(clientId: number, sessionId: SessionId | undefined): T | undefined
  jobs(record: T): unknown
  tools(record: T): { runtime: Pick<ToolRuntime, 'execute'>; names: ReadonlySet<string> } | undefined
  discovery: Pick<SessionDiscovery, 'select'>
  flush(session: Agent['session']): Promise<unknown>
  /** Passive collected output; never advances the model's native job cursor. */
  output(registry: object, owner: Agent, id: string): string | undefined
  logger: { warn(message: string): void }
}
interface ScheduleProjections {
  stateOf(session: Agent['session'], key: 'schedule'): ReturnType<typeof foldScheduleEvents> | undefined
}

/** Native task controls, reminder projection and passive job-output snapshots
 * share one owner. The host supplies a single heartbeat; this module creates
 * no timer and releases every registry subscription on disposal. */
export function createNativeTasks<T extends TaskSession>(host: TaskHost<T>) {
  let closed = false
  let disposal: Promise<void> | undefined
  const shutdown = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const invocations = new Map<AbortController, T>()
  const request = <R>(operation: () => Promise<R>): Promise<R> => {
    let resolve!: (value: R | PromiseLike<R>) => void, reject!: (reason: unknown) => void
    const work = new Promise<R>((yes, no) => { resolve = yes; reject = no })
    pending.add(work)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    // Native code may reenter disposal before its first await.
    try { resolve(operation()) } catch (error) { reject(error) }
    return work
  }
  const isLive = (record: T) => !closed && host.sessions.get(record.agent.session.id) === record
  const owned = (clientId: number, sessionId: SessionId | undefined): T | undefined =>
    closed ? undefined : host.owned(clientId, sessionId)
  const reminderSnapshots = new WeakMap<T, Map<string, string>>()
  const reminderCursors = new WeakMap<T, number>()
  const reminderReads = new WeakMap<T, Promise<void>>()
  const scheduleState = (record: T) => (record.agent.ctx.get('sessionProjections') as ScheduleProjections | undefined)?.stateOf(record.agent.session, 'schedule')
  const publishReminders = (record: T, folded: ReturnType<typeof foldScheduleEvents>, end: number): void => {
    if (!isLive(record)) return
    if (end < (reminderCursors.get(record) ?? -1)) return
    reminderCursors.set(record, end)
    const cached = reminderSnapshots.get(record)
    const active = folded.active
    const previous = cached ?? new Map<string, string>(folded.seenIds.map(id => [id, '']))
    const next = new Map<string, string>()
    for (const reminder of active) {
      const serialized = JSON.stringify(reminder)
      next.set(reminder.id, serialized)
      if (previous.get(reminder.id) === serialized) continue
      record.output.notify('x.ai/session_notification', { update: {
          sessionUpdate: 'scheduled_task_created', task_id: reminder.id, prompt: reminder.prompt,
          human_schedule: reminder.kind === 'every' ? `every ${reminder.everySeconds}s` : 'once',
          next_fire_at: reminder.scheduledAt,
        } }, { nativeSchedule: true })
    }
    for (const id of previous.keys()) {
      if (next.has(id)) continue
      record.output.notify('x.ai/session_notification', { update: { sessionUpdate: 'scheduled_task_deleted', task_id: id, reason: 'deleted' } }, { nativeSchedule: true })
    }
    reminderSnapshots.set(record, next)
  }
  const emitReminders = (record: T): void | Promise<void> => {
    if (!isLive(record)) return
    const previous = reminderReads.get(record), native = scheduleState(record)
    if (previous === undefined) {
      if (native !== undefined) return publishReminders(record, native, record.agent.session.seq)
      if (record.agent.session.seq === record.agent.session.inheritedEventCount) return publishReminders(record, foldScheduleEvents([]), record.agent.session.seq)
    }
    // Only optional-capability absence needs storage. Serialize observed cuts,
    // keeping native Schedule's decoder/fold as the single transition authority.
    const work = request(() => record.work.read(async scope => {
      const session = record.agent.session, end = session.seq, inherited = session.inheritedEventCount
      const signal = AbortSignal.any([scope.signal, shutdown.signal])
      const assertActive = () => {
        scope.assertActive()
        if (!isLive(record) || signal.aborted) throw invalidParams('session closed')
      }
      await previous?.catch(() => {})
      assertActive()
      const current = scheduleState(record)
      if (current !== undefined) return publishReminders(record, current, session.seq)
      await host.flush(session)
      assertActive()
      const events = await host.discovery.select(session.id, { end, signal }, event =>
        event.seq >= inherited && event.type === 'schedule/change' ? event : undefined)
      assertActive()
      // A native unit can appear while the read is pending. Never publish an
      // older fallback over its newer state; no alternate Schedule logic here.
      const latest = scheduleState(record)
      publishReminders(record, latest ?? foldScheduleEvents(events), latest === undefined ? end : session.seq)
    }))
    reminderReads.set(record, work)
    const settled = () => { if (reminderReads.get(record) === work) reminderReads.delete(record) }
    void work.then(settled, settled)
    return work
  }

  const reminders = async (clientId: number, method: string, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, method)
    const record = owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session')
    return record.work.run(async scope => {
      const available = host.tools(record)
      if (available === undefined || !available.names.has('schedule_list')) throw invalidParams('Reminders are unavailable in this preset.')
      const invoke = async (name: string, args: unknown) => {
        scope.assertActive()
        if (!isLive(record)) throw invalidParams('session closed')
        const controller = new AbortController()
        invocations.set(controller, record)
        const signal = AbortSignal.any([scope.signal, controller.signal, AbortSignal.timeout(10_000)])
        let result: Awaited<ReturnType<ToolRuntime['execute']>>
        try {
          result = await available.runtime.execute({ callId: ToolCallId('tui-' + randomUUID()), name, arguments: args, agent: record.agent, signal })
        } finally { invocations.delete(controller) }
        if (owned(clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
        if (result.isError) throw internalError(result.error.message)
        const value = result.value
        if (value !== null && !Array.isArray(value) && typeof value === 'object' && typeof value.code === 'string') {
          throw invalidParams(String(value.message ?? value.code))
        }
        return value
      }
      if (method === 'x.ai/scheduler/create') {
        if (typeof p.text !== 'string') throw invalidParams('A reminder is required.')
        let args: Record<string, unknown>
        try { args = parseReminder(p.text) } catch (error) { throw invalidParams(errorChain(error)) }
        await invoke('schedule_create', args)
      } else if (method === 'x.ai/scheduler/delete') {
        if (!nonEmpty(p.taskId)) throw invalidParams('taskId is required')
        await invoke('schedule_delete', { id: p.taskId })
      }
      const rows = await invoke('schedule_list', {})
      if (!Array.isArray(rows)) throw internalError('Invalid reminder list')
      await emitReminders(record)
      return { title: 'Session reminders', items: rows.map(value => {
        const row = value as Record<string, unknown>
        return { id: row.id, text: row.prompt, detail: `${row.state} · ${row.scheduledAt} · ${row.kind === 'every' ? 'every ' + String(row.everySeconds) + 's' : 'once'}`, editable: false }
      }) }
    })
  }

  type JobSnapshotLike = {
    id: string; kind: string; label: string; owner?: string
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
    detail?: string; startedAt: number; finishedAt?: number
  }
  type JobsLike = {
    list(caller: SessionId): JobSnapshotLike[]
    get(id: string, caller: SessionId): JobSnapshotLike
    kill(id: string, caller: SessionId, reason?: string): 'requested' | 'already-finished'
    wait(id: string, timeoutMs: number, caller: SessionId): Promise<JobSnapshotLike>
    events: JobEvents
  }
  const jobsService = (record: T): JobsLike | undefined => {
    let service = host.jobs(record) as JobsLike | undefined
    // Cordis lookups can stack fresh context proxies. Subscribe once on the
    // underlying registry so identity and listener scope cover every owner.
    for (;;) {
      const original = (service as (JobsLike & Record<symbol, JobsLike>) | undefined)?.[symbols.original]
      if (original === undefined) break
      service = original
    }
    return typeof service?.list === 'function' && typeof service.get === 'function'
      && typeof service.kill === 'function' && typeof service.wait === 'function'
      && typeof service.events?.subscribe === 'function' ? service : undefined
  }
  const jobSubscriptions = new Map<JobsLike, () => void>()
  const jobSnapshots = new WeakMap<T, Map<string, string>>()
  const jobOutputSnapshots = new WeakMap<T, Map<string, string>>()
  const jobIsRunning = (job: JobSnapshotLike): boolean => job.status === 'running' || job.status === 'stopping'
  const emitJobsForRecord = (record: T): void => {
    if (!isLive(record)) return
    const jobs = jobsService(record)
    if (jobs === undefined) return
    if (!jobSubscriptions.has(jobs)) {
      // Some registries notify synchronously while subscribing. Reserve the
      // identity before installing the listener, and roll it back on failure.
      jobSubscriptions.set(jobs, () => {})
      try {
        const unsubscribe = jobs.events.subscribe({ owners: 'all' }, (event: JobEvent) => {
          const owner = event.type === 'output' ? event.owner : event.job.owner
          if (closed) return
          for (const record of host.sessions.values()) {
            if ((owner === undefined || record.agent.session.id === owner) && jobsService(record) === jobs) emitJobsForRecord(record)
          }
        })
        if (closed) unsubscribe()
        else jobSubscriptions.set(jobs, unsubscribe)
      } catch (error) {
        jobSubscriptions.delete(jobs)
        throw error
      }
    }
    if (!isLive(record)) return
    let previous = jobSnapshots.get(record)
    if (previous === undefined) { previous = new Map(); jobSnapshots.set(record, previous) }
    const systemTime = (ms: number): unknown => ({ secs_since_epoch: Math.floor(ms / 1000), nanos_since_epoch: (ms % 1000) * 1_000_000 })
    for (const job of jobs.list(record.agent.session.id)) {
      // Settled producers are immutable; do not rescan their output every tick.
      // A settled producer's final passive output can arrive after settlement.
      // Stop rescanning only after that final output has actually been observed.
      if (!jobIsRunning(job) && previous.get(job.id) === JSON.stringify([job, true])) continue
      const output = host.output(jobs, record.agent, job.id)
      const serialized = JSON.stringify([job, output !== undefined])
      if (previous.get(job.id) === serialized) {
        emitJobOutput(record, job.id, output)
        continue
      }
      const known = previous.has(job.id)
      previous.set(job.id, serialized)
      const cwd = record.agent.session.header.cwd ?? ''
      if (jobIsRunning(job)) {
        if (!known) record.output.notify('x.ai/task_backgrounded', { update: { sessionUpdate: 'task_backgrounded', tool_call_id: job.id, task_id: job.id, command: job.label, cwd, description: job.label } })
      } else {
        record.output.notify('x.ai/task_completed', { update: {
            sessionUpdate: 'task_completed',
            task_snapshot: {
              task_id: job.id, command: job.label, display_command: job.label, cwd,
              start_time: systemTime(job.startedAt),
              end_time: job.finishedAt === undefined ? null : systemTime(job.finishedAt),
              exit_code: null, signal: null, completed: true, output: output ?? '',
            },
          } }, { nativeTask: { status: job.status, kind: job.kind, outputAvailable: output !== undefined, ...job.detail === undefined ? {} : { detail: job.detail } } })
      }
      if (jobIsRunning(job)) emitJobOutput(record, job.id, output)
      else jobOutputSnapshots.get(record)?.delete(job.id)
    }
  }
  const emitJobOutput = (record: T, id: string, output: string | undefined): void => {
    if (output === undefined) return
    if (!isLive(record)) return
    let previous = jobOutputSnapshots.get(record)
    if (previous === undefined) { previous = new Map(); jobOutputSnapshots.set(record, previous) }
    const before = previous.get(id)
    if (before === output) return
    previous.set(id, output)
    record.output.update({
      sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
      rawOutput: jobOutputPatch(before, output),
    }, false)
  }
  const killTask = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/task/kill')
    if (!nonEmpty(p.sessionId) || !nonEmpty(p.taskId) || (p.source !== 'clientUi' && p.source !== 'teardown')) throw invalidParams('x.ai/task/kill requires sessionId, taskId and source')
    const record = owned(clientId, SessionId(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + p.sessionId)
    const taskId = p.taskId, source = p.source
    return record.work.run(async scope => {
      const jobs = jobsService(record)
      if (jobs === undefined || !jobs.list(record.agent.session.id).some(job => job.id === taskId)) return { result: { taskId, outcome: 'not_found' } }
      const before = jobs.get(taskId, record.agent.session.id)
      if (!jobIsRunning(before)) { emitJobsForRecord(record); return { result: { taskId, outcome: 'already_exited' } } }
      scope.assertActive()
      if (!isLive(record)) throw invalidParams('session closed')
      const requested = jobs.kill(taskId, record.agent.session.id, source)
      const settled = requested === 'already-finished' ? jobs.get(taskId, record.agent.session.id) : await jobs.wait(taskId, 5000, record.agent.session.id)
      if (!isLive(record)) throw invalidParams('session closed')
      emitJobsForRecord(record)
      if (jobIsRunning(settled)) throw internalError('task cancellation requested; producer has not settled yet')
      return { result: { taskId, outcome: settled.status === 'killed' ? 'killed' : 'already_exited' } }
    })
  }

  const taskOutput = (clientId: number, params: unknown): unknown => {
    const p = paramRecord(params, 'x.ai/task/output')
    if (!nonEmpty(p.sessionId) || !nonEmpty(p.taskId)) throw invalidParams('task output requires sessionId and taskId')
    const record = owned(clientId, SessionId(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session')
    const jobs = jobsService(record)
    if (jobs === undefined) throw invalidParams('jobs unavailable')
    const job = jobs.get(p.taskId, record.agent.session.id)
    const output = host.output(jobs, record.agent, job.id)
    return { taskId: job.id, status: job.status, available: output !== undefined, output: output ?? '' }
  }
  return {
    snapshot(record: T): void | Promise<void> { emitJobsForRecord(record); return emitReminders(record) },
    observe(record: T, event: SessionEvent): void {
      if (String(event.type) === 'schedule/change') void emitReminders(record)?.catch(error => {
        if (isLive(record)) host.logger.warn('TUI reminder history: ' + errorChain(error))
      })
    },
    poll(): void {
      if (closed) return
      for (const [controller, record] of invocations) if (!isLive(record)) controller.abort()
      for (const record of host.sessions.values()) {
        try { emitJobsForRecord(record) } catch (error) { host.logger.warn('TUI job output: ' + errorChain(error)) }
      }
    },
    output: taskOutput,
    kill: (clientId: number, params: unknown) => request(() => killTask(clientId, params)),
    reminders: (clientId: number, method: string, params: unknown) => request(() => reminders(clientId, method, params)),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      const failures: unknown[] = []
      disposal = Promise.resolve().then(async () => {
        while (pending.size > 0) await Promise.allSettled([...pending])
        if (failures.length > 0) throw new AggregateError(failures, 'native task subscription disposal failed')
      })
      shutdown.abort()
      for (const controller of invocations.keys()) controller.abort()
      for (const unsubscribe of jobSubscriptions.values()) {
        try { unsubscribe() } catch (error) { failures.push(error) }
      }
      jobSubscriptions.clear()
      return disposal
    },
  }
}
