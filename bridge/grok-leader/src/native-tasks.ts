import type { SessionWork } from './session-work.ts'
import type { JobEvent, JobEvents } from '@deepseek-ai/dsh-jobs'
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult, ScheduleListRequest, ScheduleRecord,
} from '@deepseek-ai/dsh-schedule'
import { invalidParams, internalError, paramRecord, sessionIdParam } from './acp.ts'
import { parseReminder, reminderItem, reminderSchedule } from './reminders.ts'
import { legacyRemindersNotice, type LegacyReminders } from './legacy-reminders.ts'
import { nonEmpty } from './guards.ts'
import type { SessionOutput } from './session-output.ts'
import { jobOutputPatch } from './job-output.ts'

/** The Host Schedule service calls this bridge makes; tasks live in Host storage, not in session events. */
export interface ScheduleServiceLike {
  list(request: ScheduleListRequest): Promise<ScheduleRecord[]>
  catalog(): Promise<ScheduleCatalogEntry[]>
  create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
  delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult>
}
interface TaskSession {
  work: Pick<SessionWork, 'run' | 'read'>
  agent: Agent
  output: Pick<SessionOutput, 'notify' | 'update'>
}
interface TaskHost<T extends TaskSession> {
  sessions: ReadonlyMap<SessionId, T>
  owned(clientId: number, sessionId: SessionId | undefined): T | undefined
  jobs(record: T): unknown
  /** The preset's native tool names; `/reminders` follows the `schedule` capability. */
  toolNames(record: T): ReadonlySet<string> | undefined
  schedule(): ScheduleServiceLike | undefined
  /** Legacy session-event reminders, from the bridge's host-only projection. */
  legacyReminders(record: T): LegacyReminders | undefined
  /** Initialized and answering its client: session notices wait for this. */
  ready(record: T): boolean
  /** Passive collected output; never advances the model's native job cursor. */
  output(registry: object, owner: Agent, id: string): string | undefined
  logger: { warn(message: string): void }
}

/** How long a TUI reminder control may wait for the serialized native write. */
const REMINDER_REQUEST_MS = 12_000
const isScheduleInputError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'ScheduleInputError' && typeof (error as { code?: unknown }).code === 'string'

/** Native task controls, reminder views and passive job-output snapshots
 * share one owner. The host supplies a single heartbeat and the
 * `schedule/changed` signal; this module creates no timer and releases every
 * registry subscription on disposal. */
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

  // Tasks-pane rows mirror the session's active Host tasks. One read runs per
  // owner at a time; requests made before it starts share it, later ones queue
  // exactly one more, so every durable change is observed without a backlog.
  const reminderSnapshots = new WeakMap<T, Map<string, string>>()
  const reminderReads = new WeakMap<T, { tail: Promise<void>; waiting: boolean }>()
  const publishReminders = async (record: T, schedule: ScheduleServiceLike, assertActive: () => void): Promise<void> => {
    const sessionId = record.agent.session.id
    const active = await schedule.list({ sessionId })
    assertActive()
    const next = new Map(active.map(row => [row.id as string, JSON.stringify(row)]))
    let previous = reminderSnapshots.get(record), ended: Map<string, ScheduleCatalogEntry> | undefined
    const endedRows = async () => ended ??= new Map((await schedule.catalog())
      .filter(entry => entry.sessionId === sessionId && entry.status === 'inactive').map(entry => [entry.id as string, entry]))
    // A reconnecting TUI may still show rows that ended while it was away.
    if (previous === undefined) previous = new Map([...(await endedRows()).keys()].map(id => [id, '']))
    const removed = [...previous.keys()].filter(id => !next.has(id))
    if (removed.length > 0) await endedRows()
    assertActive()
    for (const row of active) {
      if (previous.get(row.id) === next.get(row.id)) continue
      record.output.notify('x.ai/session_notification', { update: {
        sessionUpdate: 'scheduled_task_created', task_id: row.id, prompt: row.prompt,
        human_schedule: reminderSchedule(row), next_fire_at: row.scheduledAt,
      } }, { nativeSchedule: true })
    }
    for (const id of removed) {
      record.output.notify('x.ai/session_notification', { update: {
        sessionUpdate: 'scheduled_task_deleted', task_id: id, reason: ended?.has(id) === true ? 'completed' : 'deleted',
      } }, { nativeSchedule: true })
    }
    reminderSnapshots.set(record, next)
  }
  const emitReminders = (record: T): Promise<void> | undefined => {
    const schedule = host.schedule()
    if (!isLive(record) || schedule === undefined) return undefined
    const previous = reminderReads.get(record)
    if (previous?.waiting === true) return previous.tail
    const state = { tail: undefined as unknown as Promise<void>, waiting: true }
    state.tail = request(() => record.work.read(async scope => {
      await previous?.tail.catch(() => {})
      state.waiting = false
      const signal = AbortSignal.any([scope.signal, shutdown.signal])
      const assertActive = () => {
        scope.assertActive()
        if (!isLive(record) || signal.aborted) throw invalidParams('session closed')
      }
      assertActive()
      await publishReminders(record, schedule, assertActive)
    }))
    reminderReads.set(record, state)
    const settled = () => { if (reminderReads.get(record) === state) reminderReads.delete(record) }
    void state.tail.then(settled, settled)
    return state.tail
  }
  const warnReminders = (record: T, work: Promise<void> | undefined): Promise<void> | undefined => work?.catch(error => {
    if (isLive(record)) host.logger.warn('TUI reminders: ' + errorChain(error))
  })

  // An earlier dscode's session-event reminders never fire again. Say so once
  // per open, after the load response, through the TUI's system-note path.
  const legacyNotices = new WeakMap<T, string>()
  const deliverNotices = (): void => {
    for (const record of host.sessions.values()) {
      const text = legacyNotices.get(record)
      if (text === undefined || !host.ready(record)) continue
      legacyNotices.delete(record)
      record.output.notify('x.ai/session_notification', { update: { sessionUpdate: 'image_dropped', notes: [text] } }, { legacySchedule: true })
    }
  }

  const reminders = async (clientId: number, method: string, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, method)
    const record = owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session')
    return record.work.run(async scope => {
      const schedule = host.schedule()
      if (schedule === undefined || host.toolNames(record)?.has('schedule_create') !== true) throw invalidParams('Reminders are unavailable in this preset.')
      const sessionId = record.agent.session.id
      const invoke = async <R>(operation: (signal: AbortSignal) => Promise<R>): Promise<R> => {
        scope.assertActive()
        if (!isLive(record)) throw invalidParams('session closed')
        const controller = new AbortController()
        invocations.set(controller, record)
        const signal = AbortSignal.any([scope.signal, controller.signal, AbortSignal.timeout(REMINDER_REQUEST_MS)])
        let result: R
        try {
          result = await operation(signal)
        } catch (error) {
          if (owned(clientId, sessionId) !== record || scope.signal.aborted || controller.signal.aborted) throw invalidParams('session closed')
          if (isScheduleInputError(error)) throw invalidParams(error.message)
          if (signal.aborted) throw internalError('The reminder service is busy; try again.')
          throw internalError(errorChain(error))
        } finally { invocations.delete(controller) }
        if (owned(clientId, sessionId) !== record) throw invalidParams('session closed')
        return result
      }
      if (method === 'x.ai/scheduler/create') {
        if (typeof p.text !== 'string') throw invalidParams('A reminder is required.')
        let args: ScheduleCreateRequest
        try { args = parseReminder(p.text) } catch (error) { throw invalidParams(errorChain(error)) }
        await invoke(signal => schedule.create(sessionId, args, signal))
      } else if (method === 'x.ai/scheduler/delete') {
        if (!nonEmpty(p.taskId)) throw invalidParams('taskId is required')
        const id = p.taskId as ScheduleDeleteRequest['id']
        const result = await invoke(signal => schedule.delete({ sessionId, id }, signal))
        if (!result.deleted) throw invalidParams('Reminder ' + id + ' no longer exists.')
      }
      const rows = await invoke(async () => (await schedule.catalog()).filter(entry => entry.sessionId === sessionId))
      // The Tasks pane already shows a successful change when the panel refreshes.
      if (method !== 'x.ai/scheduler/list') await warnReminders(record, emitReminders(record))
      scope.assertActive()
      // Armed reminders first, soonest first; ended ones stay listed until deleted.
      rows.sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active'))
      return { title: 'Session reminders', items: rows.map(reminderItem) }
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
      // The Tasks pane merges job, child and workflow rows. A background
      // subagent's job runs a one-shot child that already has its child row,
      // whose stop kills this job (native-children); a second row would list
      // it twice. A workflow job stays: its workflow row offers no stop.
      if (job.kind === 'subagent') continue
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
  /** DSH appends the kill reason to the job detail the model reads. A stop
   * from the Tasks pane uses the official job controller's wording, and the
   * headless reaper's `teardown` says the session ended; the wire's raw
   * `source` means nothing to the model. */
  const killReasons = { clientUi: 'cancelled by the user', teardown: 'session closed' } as const
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
      const requested = jobs.kill(taskId, record.agent.session.id, killReasons[source])
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
    /** Session open: jobs, the session's Host reminders, and a pending legacy
     * notice. A Schedule read failure is reported, never an open failure. */
    snapshot(record: T): void | Promise<void> {
      emitJobsForRecord(record)
      try {
        const notice = legacyRemindersNotice(host.legacyReminders(record))
        if (notice !== undefined) legacyNotices.set(record, notice)
      } catch (error) { host.logger.warn('TUI legacy reminders: ' + errorChain(error)) }
      return warnReminders(record, emitReminders(record))
    },
    /** `schedule/changed`: every durable Host task write, including deliveries. */
    scheduleChanged(): void {
      if (closed) return
      for (const record of host.sessions.values()) void warnReminders(record, emitReminders(record))
    },
    poll(): void {
      if (closed) return
      for (const [controller, record] of invocations) if (!isLive(record)) controller.abort()
      for (const record of host.sessions.values()) {
        try { emitJobsForRecord(record) } catch (error) { host.logger.warn('TUI job output: ' + errorChain(error)) }
      }
      deliverNotices()
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
