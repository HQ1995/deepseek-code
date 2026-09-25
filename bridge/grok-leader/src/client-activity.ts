/** The quit guard's facts (`x.ai/client/activity`): what quitting this client
 * would stop, and what waits for its session to open again. For each session
 * the client owns, DSH's `workspace/session-activity` waterfall reports the
 * families that keep it active, as DSH's own archive admission and desktop
 * quit inspection read them: the Agent's turn, the job registry's jobs, the
 * subagent runtime's children and the Schedule's reminders, and any family a
 * plugin adds. The bridge adds its own queue: a running prompt and the queued
 * rows. Counts merge by kind, each with a noun and a few short labels, so a
 * client renders them with no per-kind logic. Nothing is stopped here. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isRecord, nonEmpty } from './guards.ts'

/** One family of DSH's `workspace/session-activity` waterfall (`SessionActivity`,
 * @deepseek-ai/dsh-workspace); `items` names what is active when the family has identity. */
export interface SessionActivityLike {
  readonly kind: string
  readonly items?: ReadonlyArray<{ readonly id: string; readonly label?: string }>
}

/** One kind of work with how it reads: `one`/`other` are its noun by count. */
export interface ActivityCount {
  kind: string
  count: number
  one: string
  other: string
  /** At most `MAX_LABELS`, one line each, in the order DSH reported them. */
  labels: string[]
}

/** `stops`: work quitting ends now. `waits`: work that stays and resumes when its session next opens. */
export interface ClientActivity {
  stops: ActivityCount[]
  waits: ActivityCount[]
}

export interface ClientActivityHost<T> {
  sessions: { values(): Iterable<T> }
  owned(clientId: number, sessionId: SessionId): T | undefined
  sessionId(record: T): SessionId
  /** DSH's activity waterfall for one session. */
  activity(sessionId: string): Promise<readonly SessionActivityLike[]>
  /** The bridge's own prompts for the session (`PromptQueue.pending`). */
  prompts(record: T): { readonly running: boolean; readonly queued: readonly string[] }
  /** The session's job registry: a `subagent` job's child is already counted as a subagent. */
  jobs(record: T): unknown
  logger: { warn(message: string): void }
}

/** How a family reads; `waits` for one that outlives this client. Unknown
 * families read by their own kind and stop with the leader. */
const FAMILIES: Record<string, { one: string; other: string; waits?: true }> = {
  turn: { one: 'turn', other: 'turns' },
  prompt: { one: 'queued prompt', other: 'queued prompts' },
  job: { one: 'job', other: 'jobs' },
  subagent: { one: 'subagent', other: 'subagents' },
  // A reminder's timer lives in the leader; one that falls due while its
  // session is closed is delivered when the session next opens.
  schedule: { one: 'reminder', other: 'reminders', waits: true },
}
const ORDER = ['turn', 'prompt', 'job', 'subagent', 'schedule']
export const MAX_LABELS = 3
const MAX_LABEL = 40
/** Inside the TUI's 500 ms ask: a session whose providers are slower counts only the bridge's own work. */
export const ACTIVITY_TIMEOUT_MS = 400

const label = (text: string): string | undefined => {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '')?.replace(/[\p{Cc}\p{Cf}]/gu, '')
  if (line === undefined || line === '') return undefined
  return line.length > MAX_LABEL ? line.slice(0, MAX_LABEL - 1).trimEnd() + '…' : line
}

/** Ids of the session's `subagent` jobs; empty when the registry cannot say. */
function subagentJobs(registry: unknown, sessionId: string): Set<string> {
  const list = isRecord(registry) ? registry.list : undefined
  if (typeof list !== 'function') return new Set()
  try {
    const jobs: unknown = list.call(registry, sessionId)
    return new Set(Array.isArray(jobs) ? jobs.filter(job => isRecord(job) && job.kind === 'subagent' && typeof job.id === 'string').map(job => (job as { id: string }).id) : [])
  } catch { return new Set() }
}

/** The families a session reported, or none once the ask outlives its budget. */
async function bounded(ask: Promise<readonly SessionActivityLike[]>): Promise<readonly SessionActivityLike[] | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ACTIVITY_TIMEOUT_MS) })
  try { return await Promise.race([ask, late]) } finally { clearTimeout(timer) }
}

export function createClientActivity<T>(host: ClientActivityHost<T>) {
  /** Add one session's work to the tally: its families, then the bridge's queue. */
  const count = async (record: T, add: (kind: string, count: number, labels: readonly (string | undefined)[]) => void): Promise<void> => {
    const sessionId = host.sessionId(record)
    let families: readonly SessionActivityLike[] = []
    try {
      const reported = await bounded(host.activity(sessionId))
      if (reported === 'timeout') host.logger.warn('grok-leader: session activity of ' + sessionId + ' took over ' + String(ACTIVITY_TIMEOUT_MS) + ' ms; counting the bridge queue only')
      else families = reported
    } catch (error) {
      host.logger.warn('grok-leader: session activity of ' + sessionId + ' failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    const prompts = host.prompts(record)
    let turn = prompts.running
    const childJobs = subagentJobs(host.jobs(record), sessionId)
    for (const family of Array.isArray(families) ? families : []) {
      if (!isRecord(family) || !nonEmpty(family.kind)) continue
      if (family.kind === 'turn') { turn = true; continue }
      const items = Array.isArray(family.items) ? family.items.filter(item => isRecord(item) && nonEmpty(item.id)) as Array<{ id: string; label?: unknown }> : undefined
      const shown = family.kind === 'job' ? items?.filter(item => !childJobs.has(item.id)) : items
      if (shown?.length === 0) continue
      add(family.kind, shown?.length ?? 1, shown?.map(item => typeof item.label === 'string' ? label(item.label) : undefined) ?? [])
    }
    // DSH's turn family and the bridge's running prompt are the same turn.
    if (turn) add('turn', 1, [])
    if (prompts.queued.length > 0) add('prompt', prompts.queued.length, prompts.queued.map(label))
  }
  return {
    /** `x.ai/client/activity`: the client's sessions, asked at once; takes no params. */
    async activity(clientId: number, _params?: unknown): Promise<ClientActivity> {
      const records = [...host.sessions.values()].filter(record => host.owned(clientId, host.sessionId(record)) === record)
      const tally = new Map<string, { count: number; labels: string[] }>()
      const add = (kind: string, amount: number, labels: readonly (string | undefined)[]) => {
        const entry = tally.get(kind) ?? { count: 0, labels: [] }
        entry.count += amount
        for (const text of labels) if (text !== undefined && entry.labels.length < MAX_LABELS && !entry.labels.includes(text)) entry.labels.push(text)
        tally.set(kind, entry)
      }
      await Promise.all(records.map(record => count(record, add)))
      const rank = (kind: string) => ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length
      const counts = [...tally].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([kind, { count: amount, labels }]) => {
        const family = FAMILIES[kind] ?? { one: kind, other: kind.endsWith('s') ? kind : kind + 's' }
        return { kind, count: amount, one: family.one, other: family.other, labels, waits: family.waits === true }
      })
      const strip = ({ waits: _waits, ...entry }: ActivityCount & { waits: boolean }): ActivityCount => entry
      return { stops: counts.filter(entry => !entry.waits).map(strip), waits: counts.filter(entry => entry.waits).map(strip) }
    },
  }
}
