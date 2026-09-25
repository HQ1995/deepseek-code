/**
 * Child controls without subscriptions: the child overview a turn log implies,
 * the `/subagents` grammar and verbs, prefix selection, and the child-inbox
 * views and actions. native-children keeps ownership checks, accepted work,
 * admissions and every native call; the verbs reach them through ports.
 *
 * @module dscode/child-controls
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { invalidParams } from './acp.ts'
import { textBlocks } from './projection.ts'

/** One native descendant row. */
export type ChildRow = { kind: 'child' | 'diagnostic'; id: string; mode?: 'continuable' | 'one-shot'; label?: string; parentId?: string; activity?: 'running' | 'inactive'; reason?: string }
/** The native subagent service surface the bridge uses. */
export type SubagentsLike = {
  listDescendants(root: SessionId, signal?: AbortSignal): Promise<ChildRow[]>
  interrupt(id: SessionId, authority: { kind: 'ancestor'; agent: Agent }): void
  prompt?: SubagentRuntime['prompt']
}
/** What the parent's pager was last told about one child. */
export type ChildState = { agent?: Agent; label: string; status: string; attemptId: string; output?: string; durationMs?: number }

export const runLength = (start: SessionEvent, end: SessionEvent): number => Math.max(0, end.time - start.time)
export const childTerminalStatus = (kind: string): string => kind === 'completed' || kind === 'max-tokens' ? 'completed'
  : kind === 'aborted' || kind === 'interrupted' ? 'cancelled' : 'failed'
export const childOverview = (id: string, events: readonly SessionEvent[], status?: Agent['status'], activity?: ChildRow['activity']): Pick<ChildState, 'attemptId' | 'status' | 'durationMs'> => {
  const start = events.findLast(event => event.type === 'turn/start')
  const end = events.findLast(event => event.type === 'turn/end')
  const settled = end?.type === 'turn/end' && (start?.type !== 'turn/start' || end.data.turn === start.data.turn)
  return {
    attemptId: id + ':' + String(start?.type === 'turn/start' ? start.data.turn : 'pending'),
    status: status === 'running' || activity === 'running' ? 'running'
      : settled ? childTerminalStatus(end.data.reason.kind) : 'cancelled',
    // The last run's length, so a settled child stops counting up after a restart too.
    ...settled && start !== undefined ? { durationMs: runLength(start, end) } : {},
  }
}

const USAGE = 'Usage: /subagents list\n/subagents pending <child>\n/subagents queue|steer <child> <text>\n/subagents edit <child> <message> <text>\n/subagents remove <child> <message>\n/subagents steer-queued <child> <message|all>\n/subagents clear|stop <child>\nChild and message IDs accept unique prefixes; Agent Team members also accept their names. Stop preserves queued input.'

/** One `/subagents` invocation: its verb (list by default), child selector and free body. */
export interface SubagentsCommand { verb: string; selector: string | undefined; body: string }

export function parseSubagentsCommand(text: string): SubagentsCommand | undefined {
  const match = /^\/subagents(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (match === null) return undefined
  const [, verb = 'list', selector, body = ''] = match
  return { verb, selector, body }
}

/** What one accepted `/subagents` command may read and do. */
export interface SubagentVerbPorts {
  /** The owning session's child rows, already listed. */
  rows: readonly ChildRow[]
  members: ReadonlyArray<{ id: string; name: string }>
  /** The text the client last saw for the message an edit replaces. */
  expectedText: unknown
  child(id: string): Agent | undefined
  /** Native child admission; absent when the service offers none. */
  prompt?(row: ChildRow, delivery: 'queue' | 'steer', text: string): Promise<{ messageId: string }>
  stop(id: string): Promise<unknown>
}

const resolvePrefix = <T extends { id: string }>(items: readonly T[], id: string, label: string): T => {
  const exact = items.find(item => item.id === id)
  if (exact !== undefined) return exact
  const matches = id.length === 0 ? [] : items.filter(item => item.id.startsWith(id))
  if (matches.length !== 1) throw new Error(`${matches.length === 0 ? 'Unknown' : 'Ambiguous'} ${label}: ${id}`)
  return matches[0]!
}

/** Run one parsed command and return its reply. A throw is the user-facing
 * refusal. Native calls start in the caller's tick: nothing here awaits
 * before a port or an inbox mutation. */
export async function runSubagentVerb(command: SubagentsCommand, ports: SubagentVerbPorts): Promise<string> {
  const { verb, selector, body } = command
  const { rows, members } = ports
  if (verb === 'list' && selector === undefined) {
    return (rows.length === 0 ? 'No child conversations.' : rows.map(row => {
      const child = ports.child(row.id)
      const name = members.find(member => member.id === row.id)?.name
      const label = name === undefined ? row.label ?? '' : name + ' (teammate)' + (row.label ? ' · ' + row.label : '')
      return `${row.id}  ${child?.status === 'running' ? 'running' : 'idle'}  ${row.mode ?? 'unknown'}  ${label}`
    }).join('\n')) + '\n\n' + USAGE
  }
  if (selector === undefined || !['pending', 'queue', 'steer', 'edit', 'remove', 'steer-queued', 'clear', 'stop'].includes(verb)) throw new Error(USAGE)
  // /team names teammates, so a teammate's name selects its child conversation.
  const named = members.find(member => member.name === selector)
  const row = rows.find(item => item.id === named?.id) ?? resolvePrefix(rows, selector, 'child')
  if (row.mode !== 'continuable') throw new Error('Only continuable children accept these controls.')
  // Queued Team messages carry mailbox receipts; changing them here would
  // desynchronize the Team's delivery bookkeeping.
  const member = members.find(item => item.id === row.id)
  if (member !== undefined && ['edit', 'remove', 'clear', 'steer-queued'].includes(verb)) {
    throw new Error(`${member.name} is an Agent Team member; its queued input is Team mailbox delivery. Message it through the Lead, or stop it.`)
  }
  const child = ports.child(row.id)
  if (verb === 'queue' || verb === 'steer') {
    if (body.trim().length === 0) throw new Error('A message is required.\n' + USAGE)
    if (ports.prompt === undefined) throw new Error('Child message admission is unavailable.')
    const receipt = await ports.prompt(row, verb, body)
    return `${verb === 'queue' ? 'Queued' : 'Steering'} child ${row.id}: ${receipt.messageId}`
  }
  if (verb === 'stop') {
    if (body.length > 0) throw new Error(USAGE)
    await ports.stop(row.id)
    return `Child ${row.id} stopped; queued input is preserved.`
  }
  return pendingVerb(verb, row.id, child, body, ports.expectedText)
}

/** The verbs over a child's pending input: pending, clear, steer-queued, edit, remove. */
function pendingVerb(verb: string, id: string, child: Agent | undefined, body: string, expectedText: unknown): string {
  if (child === undefined) {
    if (verb === 'pending') return `Child ${id} is inactive; no live queue is available.`
    throw new Error('The child is inactive; queue a new message to continue it before editing pending input.')
  }
  const pending = [...child.inbox.nextTurn, ...child.inbox.nextStep]
  if (verb === 'pending') {
    if (body.length > 0) throw new Error(USAGE)
    return `Pending input for ${id}:\n` + (pending.length === 0 ? '(empty)' : pending.map(message =>
      `${message.id}  ${child.inbox.nextTurn.includes(message) ? 'queued' : 'next-step'}  ${textBlocks(message.content).map(block => block.text).join('\n')}`).join('\n'))
  }
  if (verb === 'clear') {
    if (body.length > 0) throw new Error(USAGE)
    child.inbox.clear()
    return `Cleared ${pending.length} pending message(s) for ${id}.`
  }
  if (verb === 'steer-queued') {
    if (child.status !== 'running') throw new Error('The child has no running turn to steer.')
    const selected = body === 'all' ? [...child.inbox.nextTurn] : [resolvePrefix(child.inbox.nextTurn, body, 'queued message')]
    for (const message of selected) {
      child.inbox.remove(message.id)
      child.steer(message)
    }
    return `Steering ${selected.length} queued message(s) into child ${id}.`
  }
  const edit = verb === 'edit' ? /^(\S+)\s+([\s\S]+)$/.exec(body) : undefined
  if (verb === 'edit' && edit == null) throw new Error(USAGE)
  const message = resolvePrefix(pending, edit?.[1] ?? body, 'pending message')
  if (verb === 'edit') {
    // Validate after asynchronous descendant lookup, immediately before replacement.
    if (message.content.some(block => block.type !== 'text') || (expectedText !== undefined && expectedText !== textBlocks(message.content).map(block => block.text).join(''))) {
      throw new Error('This message changed or contains attachments; it cannot be replaced by this text edit.')
    }
    child.inbox.replace(message.id, { ...message, content: [{ type: 'text', text: edit![2]! }] })
    return `Edited pending message ${message.id} for ${id}.`
  }
  child.inbox.remove(message.id)
  return `Removed pending message ${message.id} for ${id}.`
}

/** The inbox picker: one row per continuable child. */
export const childConversations = (rows: readonly ChildRow[], child: (id: string) => Agent | undefined) => ({
  title: 'Child conversations',
  items: rows.map(row => ({ id: row.id, text: row.label || row.id, detail: child(row.id)?.status ?? 'inactive', editable: false })),
})

/** The `/subagents` command one inbox action stands for; undefined for `list`. */
export function inboxCommand(row: ChildRow, p: Record<string, unknown>, child: (id: string) => Agent | undefined): string | undefined {
  const action = p.action ?? 'list'
  if (typeof action !== 'string' || !['list', 'queue', 'steer', 'edit', 'remove', 'steer-queued', 'clear', 'stop'].includes(action)) throw invalidParams('Unknown inbox action')
  if (action === 'list') return undefined
  let body = ''
  if (['edit', 'remove', 'steer-queued'].includes(action)) {
    const agent = child(row.id)
    const message = [...agent?.inbox.nextTurn ?? [], ...agent?.inbox.nextStep ?? []].find(message => message.id === p.messageId)
    if (message === undefined) throw invalidParams('This message has already left the queue. Refresh and try again.')
    body = message.id
  }
  if (['queue', 'steer', 'edit'].includes(action)) {
    if (typeof p.text !== 'string' || p.text.trim().length === 0) throw invalidParams('A message is required.')
    body += (body.length > 0 ? ' ' : '') + p.text
  }
  return `/subagents ${action} ${row.id}${body.length > 0 ? ' ' + body : ''}`
}

/** One child's input queue; a teammate's queued input is Team mailbox delivery, not editable. */
export const inboxView = (row: ChildRow, child: Agent | undefined, member: boolean) => ({
  title: 'Input queue · ' + (row.label || row.id), items: [...child?.inbox.nextTurn ?? [], ...child?.inbox.nextStep ?? []].map(message => ({
    id: message.id, text: textBlocks(message.content).map(block => block.text).join(''),
    detail: child?.inbox.nextTurn.includes(message) ? 'queued for next turn' : 'steering at next step',
    editable: !member && message.content.every(block => block.type === 'text'),
  })),
})
