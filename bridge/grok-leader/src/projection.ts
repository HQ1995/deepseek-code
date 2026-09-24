/**
 * Projection layer: map harness session events and dsh tool metadata onto the
 * grok ACP wire shapes the TUI renders. Pure functions only — no leader state,
 * no socket access, no side effects. Split out of index.ts so each function
 * is testable against the published types without building a full leader.
 *
 * @module dscode/projection
 */
import type { TurnEndReason, SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantStreamFirstTokenTime, expandAssistantStream, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { browserCardTitle } from './browser-actions.ts'
import { argumentTitle } from './tool-titles.ts'

/** The grok StopReason vocabulary (agent.rs StopReason). */
export type StopReasonWire = 'end_turn' | 'max_tokens' | 'cancelled'

/** One streaming delta this bridge emits as a session/update notification. */
export type GrokSessionUpdate =
    | { sessionUpdate: 'user_message_chunk'; content: { type: 'text'; text: string } }
    | { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
    | { sessionUpdate: 'agent_thought_chunk'; content: { type: 'text'; text: string } }
    | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: ToolKindWire; status: 'in_progress'; rawInput?: unknown; _meta?: { 'x.ai/tool': { name: string } } }
    | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: 'completed' | 'failed'; content?: Array<ToolResultContentBlock>; rawOutput?: unknown; error?: { name: string; code: string } }
    | { sessionUpdate: 'plan'; entries: Array<{ content: string; priority: string; status: string }> }
/** Non-rendering usage facts carried beside one session update. */
export type ProjectedUpdate = GrokSessionUpdate & {
  totalTokens?: number
  cacheHitPercent?: string
  tokensPerSecond?: string
}

/** A native durable decision, not assistant text or summary compaction. */
export function imageOffloadCount(event: SessionEvent): number | undefined {
  if (String(event.type) !== 'image/offload') return undefined
  const data = event.data as { targets?: Array<{ imageIndexes?: unknown[] }> }
  if (!Array.isArray(data?.targets) || data.targets.length === 0) return undefined
  let count = 0
  for (const target of data.targets) {
    if (!Array.isArray(target?.imageIndexes) || target.imageIndexes.length === 0
      || target.imageIndexes.some(index => !Number.isSafeInteger(index) || Number(index) < 0)) return undefined
    count += target.imageIndexes.length
  }
  return count
}

/** Shared system notice for the parent stream and paged child history. */
export const imageOffloadNotes = (count: number): string[] => [
  `Image context: ${count} older image occurrence(s) omitted from future model requests. Originals remain in history. Switching models or resuming will not restore them; attach or read the image again if needed.`,
]

/** Tool names one native tool-registry developer message added and removed.
 * DSH appends it when a step's tool list differs from the previous request:
 * a plugin or MCP server enabled or disabled while the session runs. Every
 * other developer message stays off the TUI. */
export function toolRegistryChange(event: SessionEvent): { added: string[]; removed: string[] } | undefined {
  if (String(event.type) !== 'developer/message') return undefined
  const message = (event.data as { message?: { source?: { kind?: unknown }; content?: unknown } } | null)?.message
  if (message?.source?.kind !== 'tool-registry' || !Array.isArray(message.content)) return undefined
  const added: string[] = [], removed: string[] = []
  for (const block of message.content as Array<{ type?: unknown; toolName?: unknown } | null>) {
    const name = typeof block?.toolName === 'string' ? block.toolName.replace(/[\x00-\x1f\x7f]/g, '') : ''
    if (name === '') continue
    if (block!.type === 'tool-addition') added.push(name)
    else if (block!.type === 'tool-removal') removed.push(name)
  }
  return added.length + removed.length === 0 ? undefined : { added, removed }
}

/** Names a tool notice spells out per list; the rest are counted. */
const TOOL_NOTICE_NAMES = 6
/** Shared one-line system notice for a tool change, e.g. `Tools added: a, b · removed: c`. */
export const toolRegistryNotes = (change: { added: readonly string[]; removed: readonly string[] }): string[] => {
  const names = (list: readonly string[]) => list.slice(0, TOOL_NOTICE_NAMES).join(', ')
    + (list.length > TOOL_NOTICE_NAMES ? ` and ${list.length - TOOL_NOTICE_NAMES} more` : '')
  const parts = [
    ...change.added.length > 0 ? ['added: ' + names(change.added)] : [],
    ...change.removed.length > 0 ? ['removed: ' + names(change.removed)] : [],
  ]
  return parts.length === 0 ? [] : ['Tools ' + parts.join(' · ')]
}

/** The neutral system notice one durable event carries, if any: an image
 * offload or a tool change. Live, replayed and child history show the same
 * lines; the TUI renders them as plain system text, never assistant output. */
export function systemNotes(event: SessionEvent): string[] | undefined {
  const offloaded = imageOffloadCount(event)
  if (offloaded !== undefined) return imageOffloadNotes(offloaded)
  const tools = toolRegistryChange(event)
  return tools === undefined ? undefined : toolRegistryNotes(tools)
}

/** Released token-meter values: usage is cumulative; pressure is next-request occupancy. */
export interface ContextProjectionValues {
  tokenUsage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  contextPressure?: { projectedTokens?: number; contextWindow?: number }
  contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number }
}

export function contextInfoFromProjection(values: ContextProjectionValues): Record<string, unknown> {
  const used = values.contextPressure?.projectedTokens
  const total = values.contextPressure?.contextWindow
  const breakdown = values.contextBreakdown
  return {
    available: used !== undefined,
    capacityAvailable: total !== undefined,
    breakdownAvailable: breakdown !== undefined,
    autoCompactThresholdAvailable: false,
    ...used === undefined ? {} : { used },
    ...total === undefined ? {} : { total },
    ...used === undefined || total === undefined ? {} : {
      freeTokens: Math.max(0, total - used),
      ...total <= 0 ? {} : { usagePct: Math.round(used / total * 100) },
    },
    ...breakdown === undefined ? {} : {
      breakdownApproximate: true,
      systemPromptTokens: breakdown.systemTokens,
      toolDefinitionsTokens: breakdown.toolsTokens,
      messageTokens: breakdown.messageTokens,
    },
  }
}

export interface NativeGoalView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation: 'armed' | 'disarmed'
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: { code: string; message: string }
}

export function goalUpdateFromView(goal: NativeGoalView): Record<string, unknown> {
  return {
    sessionUpdate: 'goal_updated', goal_id: goal.id, objective: goal.objective,
    status: goal.phase === 'active' ? goal.activation : goal.phase === 'paused' ? 'user_paused' : goal.phase,
    phase: 'idle',
    native_goal: {
      revision: goal.revision, phase: goal.phase, activation: goal.activation,
      rounds_started: goal.roundsStarted, max_goal_rounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : { reason: goal.blockedReason },
    },
  }
}

/** grok ACP ToolKind vocabulary the TUI renders for a tool call. */
export type ToolKindWire = 'execute' | 'read' | 'edit' | 'search' | 'fetch' | 'other'

/** grok ToolCallContent shapes the TUI understands (text or file diff).
 *
 * NOTE: ACP's `ToolCallContent` is an internally-tagged enum whose variants are
 * `content` / `diff` / `terminal` — a bare `{"type":"text"}` block does NOT
 * deserialize and drops the whole `tool_call_update` notification in the TUI.
 * Text must ride as `{"type":"content","content":{"type":"text",...}}`. */
export type ToolResultContentBlock =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'diff'; path: string; oldText?: string; newText: string }

/**
 * Flatten ACP prompt blocks to text, mirroring the ACP bridge codec: text
 * blocks concatenate verbatim, baseline resource links become bracketed
 * textual references.
 * @param prompt - prompt content blocks.
 * @returns text in wire order.
 */
export function acpPromptToText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return ''
  return prompt.flatMap((block): string[] => {
    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text':
        return typeof b.text === 'string' ? [b.text] : []
      case 'resource_link':
        return ['\n[resource_link name=' + JSON.stringify(b.name) + ' uri=' + JSON.stringify(b.uri) + ']\n']
      default:
        return []
    }
  }).join('')
}

/** Integer cache percentage with positive midpoint ties rounded up. */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / 200)) {
      lower = candidate
    } else {
      upper = candidate - 1
    }
  }
  return lower
}

/**
 * Display-ready cache-hit share of the three disjoint dsh input buckets.
 * A non-full ratio that rounds to 100 gains only enough decimals to remain
 * below 100; a true full hit is the sole `100` result.
 */
export function cacheHitPercent(
  uncachedInputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): string | undefined {
  const denominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  if (denominator === 0) return undefined
  const missedInputTokens = uncachedInputTokens + cacheWriteTokens
  if (missedInputTokens === 0) return '100'
  const integerPercent = roundedIntegerPercent(cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)
  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}
/** Map native live or expanded durable chunks; tool execution uses tool/call. */
export function assistantChunkToUpdates(
  chunk: StreamChunk,
): Array<GrokSessionUpdate> {
  if (!('text' in chunk) || chunk.text.length === 0) return []
  if (chunk.type === 'text-delta') {
    return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } }]
  }
  if (chunk.type === 'reasoning-delta') {
    return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } }]
  }
  return []
}

/** Native token-meter precedence: explicit usage, otherwise last stream sample. */
export function assistantEventUsage(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  // Usage records are never delta-compacted, so no expansion/allocation is needed.
  for (let index = event.data.stream.length - 1; index >= 0; index -= 1) {
    const record = event.data.stream[index]!
    if (record.type === 'chunk' && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Whole-session decode fold, field for field the upstream `sessionStats`
 * decode pair: the first token of a step's stream to its assembled message,
 * and that message's provider output tokens over the same span. Retries
 * re-enter the fold through the attempt that produced the first token.
 */
export interface DecodeSpeed {
  openStep: { turn: number; step: number; firstTokenTime: number | null } | null
  decodeMs: number
  decodeTokens: number
}

export const emptyDecodeSpeed = (): DecodeSpeed => ({ openStep: null, decodeMs: 0, decodeTokens: 0 })

/** Fold one session event into the decode pair, mirroring `sessionStats`. */
export function noteDecodeSpeed(speed: DecodeSpeed, event: SessionEvent): void {
  if (event.type === 'step/start') {
    speed.openStep = { turn: event.data.turn, step: event.data.step, firstTokenTime: null }
    return
  }
  const open = speed.openStep
  if (open === null) return
  if (event.type === 'assistant/attempt') {
    if (open.turn !== event.data.turn || open.step !== event.data.step || open.firstTokenTime !== null) return
    open.firstTokenTime = assistantStreamFirstTokenTime(event.data.stream) ?? null
    return
  }
  if (event.type !== 'assistant/message') return
  if (open.turn !== event.data.turn || open.step !== event.data.step) return
  speed.openStep = null
  const firstTokenTime = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream) ?? null
  const outputTokens = event.data.usage?.outputTokens
  if (firstTokenTime === null || typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0) return
  speed.decodeMs += Math.max(0, event.time - firstTokenTime)
  speed.decodeTokens += outputTokens
}

/**
 * Display-ready decode speed by the upstream client rule (integer at or above
 * 10, one decimal below), or undefined before one timed step has landed.
 */
export function decodeTokensPerSecond(speed: DecodeSpeed): string | undefined {
  if (speed.decodeMs <= 0 || speed.decodeTokens <= 0) return undefined
  const value = speed.decodeTokens / speed.decodeMs * 1000
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

/** The native todos projection as an ACP plan. ACP requires a priority; DSH
 * todos have none, so each entry uses its neutral value. */
function todoPlan(data: unknown): Array<GrokSessionUpdate> {
  const todos = (data as { todos?: unknown } | undefined)?.todos
  if (!Array.isArray(todos) || !todos.every(todo => todo !== null && typeof todo === 'object'
    && typeof todo.content === 'string' && ['pending', 'in_progress', 'completed'].includes(todo.status))) return []
  return [{ sessionUpdate: 'plan', entries: todos.map(todo => ({ content: todo.content, priority: 'medium', status: todo.status })) }]
}

/** Render presented declarations only: opening a link remains an explicit
 * user action. The viewed session's cwd also gives forked and child history
 * their own paths. */
function deliveredFiles(files: ReadonlyArray<{ path: string; description?: string }>, cwd: string | undefined): Array<GrokSessionUpdate> {
  const literal = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&')
  const lines = files.map(file => {
    const label = literal(file.path)
    const path = cwd !== undefined || isAbsolute(file.path) ? resolve(cwd ?? '/', file.path) : undefined
    const link = path === undefined ? label : `[${label}](<${pathToFileURL(path).href}>)`
    return `- ${link}${file.description === undefined ? '' : ': ' + literal(file.description)}`
  })
  return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n**Delivered files**\n${lines.join('\n')}\n\n` } }]
}

/** One tool card opening; native calls and PTC sub-calls share it. A card titled by what
 * it does keeps its tool name in `_meta['x.ai/tool']`, which headless output reads first. */
function toolCallStarted(toolCallId: string, name: string, args: unknown): GrokSessionUpdate {
  const title = browserCardTitle(name, args) ?? argumentTitle(args) ?? name
  return { sessionUpdate: 'tool_call', toolCallId, title, kind: toolKindForName(name, args), status: 'in_progress', rawInput: rawInputForTool(name, args),
    ...title === name ? {} : { _meta: { 'x.ai/tool': { name } } } }
}

/** One tool card settlement: rendered content, typed raw output and the native error identity. */
function toolCallSettled(
  toolCallId: string,
  failed: boolean,
  contents: Array<ToolResultContentBlock>,
  rawOutput: Record<string, unknown> | undefined,
  error?: { name: string; code: string },
): GrokSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: failed ? 'failed' : 'completed',
    ...contents.length > 0 ? { content: contents } : {},
    ...rawOutput === undefined ? {} : { rawOutput },
    ...error === undefined ? {} : { error },
  }
}

/**
 * Map native durable settlements to TUI deltas. The embedded stream preserves
 * reasoning and failed-attempt content; dense positions already delivered live
 * are skipped. Tool calls/results remain owned by their durable execution events.
 * Empty streams are native seeded messages and use their assembled content.
 */
export function sessionEventToUpdates(
  event: SessionEvent,
  options: {
    replay: boolean
    cwd?: string
    streamedChunks?: ReadonlySet<number>
    toolCall?: (callId: string) => { name: string; arguments: unknown } | undefined
  },
): Array<GrokSessionUpdate> {
  if (!options.replay && event.type === 'user/message') return []
  // The native todos projection resets at turn/start and retains turn/end.
  // All consumers (live, resume and child history) must see the same state.
  if (event.type === 'turn/start') return [{ sessionUpdate: 'plan', entries: [] }]
  if (String(event.type) === 'todo/write') return todoPlan(event.data)
  switch (event.type) {
    case 'deliverables/presented':
      return deliveredFiles(event.data.files, options.cwd)
    case 'user/message': {
      const source = event.data.source as { kind?: unknown }
      if (source.kind !== 'user') return []
      return textBlocks(event.data.content).map(content => ({
        sessionUpdate: 'user_message_chunk',
        content,
      }))
    }
    case 'assistant/attempt':
    case 'assistant/message': {
      if (event.data.stream.length > 0) {
        return expandAssistantStream(event.data.stream).flatMap(({ chunk }, index) =>
          options.streamedChunks?.has(index) === true ? [] : assistantChunkToUpdates(chunk))
      }
      if (event.type === 'assistant/attempt') return []
      return event.data.message.content.flatMap(block => {
        if (block.type === 'text') return assistantChunkToUpdates({ type: 'text-delta', index: 0, text: block.text })
        if (block.type === 'reasoning') return assistantChunkToUpdates({ type: 'reasoning-delta', index: 0, text: block.text })
        return []
      })
    }
    case 'tool/call': {
      if (typeof event.data.callId !== 'string' || event.data.callId === '') return []
      const prior = options.toolCall?.(event.data.callId)
      const args = prior === undefined ? parseJsonObject(event.data.arguments) : prior.arguments
      return [toolCallStarted(event.data.callId, event.data.name, args)]
    }
    case 'tool/result': {
      const message = event.data.message
      const callId = message.toolCallId
      const failed = message.isError === true || event.data.error !== undefined
      if (typeof callId !== 'string' || callId === '') return []
      const prior = options.toolCall?.(callId)
      const metaDiffs = diffBlocksFromMeta(event.data.meta)
      const contents: ToolResultContentBlock[] = [
        ...textBlocks(message.content).map(block => ({ type: 'content' as const, content: block })),
        ...metaDiffs,
        ...(metaDiffs.length === 0 && !failed ? diffBlocksFromCall(prior) : []),
      ]
      const error = event.data.error === undefined ? undefined : { name: event.data.error.name, code: event.data.error.code }
      return [toolCallSettled(callId, failed, contents, typedRawOutput(prior, event.data.meta, contents, failed), error)]
    }
    // PTC mode runs tools inside a `run_code` program. These two durable events
    // are the only carrier of those nested calls (log-only: `deriveMessages()`
    // ignores them, so they never re-enter model context), and each started
    // sub-call settles exactly once — aborts included. Rendering them through
    // the native call/result path keeps one card vocabulary for both planes.
    case 'tool/ptc-dispatch-start': {
      if (typeof event.data.subCallId !== 'string' || event.data.subCallId === '') return []
      return [toolCallStarted(event.data.subCallId, event.data.name, event.data.arguments)]
    }
    case 'tool/ptc-dispatch': {
      const callId = event.data.subCallId
      if (typeof callId !== 'string' || callId === '') return []
      const prior = options.toolCall?.(callId)
      const contents: ToolResultContentBlock[] = [
        ...textBlocks(event.data.content).map(block => ({ type: 'content' as const, content: block })),
        ...(event.data.isError ? [] : diffBlocksFromCall(prior)),
      ]
      // Sub-calls carry no tool-private presentation meta, so only the
      // argument-derived raw shapes (execute/edit) can be reconstructed.
      return [toolCallSettled(callId, event.data.isError, contents, typedRawOutput(prior, undefined, contents, event.data.isError))]
    }
    default:
      // Other durable events belong to native state projections or diagnostics.
      // Tool-registry developer messages are system notices (toolRegistryChange),
      // not ACP stream updates: child history pages parse only the latter.
      return []
  }
}

/**
 * Map a DeepSeek Harness tool name to the grok ACP ToolKind the TUI renders.
 * Keeping the mapping here (instead of the presets) lets one bridge serve
 * every preset without changing `dsh-agent-presets` tool names.
 */
export function toolKindForName(name: string, args?: unknown): ToolKindWire {
  const n = name.toLowerCase()
  if (n === 'str_replace_editor') {
    const command = (args as { command?: unknown } | undefined)?.command
    return command === 'view' ? 'read' : 'edit'
  }
  if (n === 'bash' || n === 'pwsh' || n === 'run_code' || n === 'run_terminal_command') return 'execute'
  if (n === 'read' || n === 'read_image') return 'read'
  if (n === 'write' || n === 'edit') return 'edit'
  if (n === 'grep' || n === 'glob') return 'search'
  if (n === 'web_search' || n === 'x_search' || n === 'search') return 'search'
  if (n === 'web_fetch' || n === 'fetch') return 'fetch'
  return 'other'
}

/** Parse model-produced tool arguments JSON into an object when possible. */
export function parseJsonObject(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // Keep rawInput absent rather than a string: grok's typed tool blocks
    // expect raw_input to be a JSON object.
  }
  return undefined
}
/**
 * Safety cap for TUI-side fallback diff blocks.
 *
 * The bridge only synthesizes these for display; it must never become a
 * performance path. If an edit payload is large enough that the TUI's diff
 * renderer could spend noticeable time on it, we skip the diff fallback and
 * let the normal text result render instead.
 */
const MAX_FALLBACK_DIFF_CHARS = 64 * 1024

/** True when a fallback diff stays within the display-only performance budget. */
function withinDiffBudget(oldText: string | undefined, newText: string): boolean {
  return (oldText?.length ?? 0) + newText.length <= MAX_FALLBACK_DIFF_CHARS
}

/** True when a value looks like a dsh tool-fs diff-meta envelope. */
function isDiffMeta(meta: unknown): meta is { diffs: Array<{ path?: unknown; oldText?: unknown; newText?: unknown }> } {
  if (typeof meta !== 'object' || meta === null) return false
  const diffs = (meta as { diffs?: unknown }).diffs
  return Array.isArray(diffs)
}

/** Convert dsh tool-fs `meta.diffs` into grok ACP diff content blocks. */
function diffBlocksFromMeta(meta: unknown): Array<{ type: 'diff'; path: string; oldText?: string; newText: string }> {
  if (!isDiffMeta(meta)) return []
  const blocks: Array<{ type: 'diff'; path: string; oldText?: string; newText: string }> = []
  for (const diff of meta.diffs) {
    if (typeof diff !== 'object' || diff === null) continue
    if (typeof diff.newText !== 'string') continue
    if (!withinDiffBudget(typeof diff.oldText === 'string' ? diff.oldText : undefined, diff.newText)) continue
    blocks.push({
      type: 'diff',
      path: typeof diff.path === 'string' ? diff.path : '',
      ...typeof diff.oldText === 'string' ? { oldText: diff.oldText } : {},
      newText: diff.newText,
    })
  }
  return blocks
}

/** Fallback diff blocks for Edit/Write results that lack presentationMeta. */
function diffBlocksFromCall(prior: { name: string; arguments: unknown } | undefined): Array<{ type: 'diff'; path: string; oldText?: string; newText: string }> {
  if (prior === undefined) return []
  const args = (prior.arguments ?? {}) as Record<string, unknown>
  const lower = prior.name.toLowerCase()
  const path = typeof args.file_path === 'string' ? args.file_path
    : typeof args.filePath === 'string' ? args.filePath
    : typeof args.path === 'string' ? args.path
    : undefined
  if (path === undefined) return []
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string') return value
    }
    return undefined
  }
  if (lower === 'edit') {
    const oldText = stringField('old_string', 'oldString')
    const newText = stringField('new_string', 'newString')
    if (newText === undefined) return []
    if (!withinDiffBudget(oldText, newText)) return []
    return [{ type: 'diff', path, ...(oldText !== undefined ? { oldText } : {}), newText }]
  }
  if (lower === 'str_replace_editor') {
    const command = stringField('command')
    // `view` is a read; never synthesize an edit diff for it.
    if (command === 'view') return []
    const oldText = stringField('old_str')
    // file_text: str_replace_editor `create` carries the whole file there.
    const newText = stringField('new_str', 'file_text')
      ?? (command === 'str_replace' ? '' : undefined)
    if (newText === undefined) return []
    if (!withinDiffBudget(oldText, newText)) return []
    return [{ type: 'diff', path, ...(oldText !== undefined ? { oldText } : {}), newText }]
  }
  if (lower === 'write') {
    const newText = stringField('content')
    if (newText === undefined) return []
    if (!withinDiffBudget(undefined, newText)) return []
    return [{ type: 'diff', path, newText }]
  }
  return []
}

/**
 * Add grok-specific rawInput fields the typed TUI blocks need. `variant` is
 * required for the TUI to route `Search`-kind calls to `WebSearch`/`XSearch`.
 */
function rawInputForTool(name: string, args: unknown): unknown {
  if (args === undefined || args === null || typeof args !== 'object') return args
  const lower = name.toLowerCase()
  if (lower === 'web_search') return { ...args, variant: 'WebSearch' }
  if (lower === 'x_search') return { ...args, variant: 'XSearch' }
  return args
}

/** Join text content blocks into the model-facing result text. */
function textFromContents(contents: Array<{ type: 'text'; text: string } | { type: 'content'; content: { type: 'text'; text: string } } | { type: 'diff'; path: string; oldText?: string; newText: string }>): string {
  return contents
    .filter((block): block is { type: 'text'; text: string } | { type: 'content'; content: { type: 'text'; text: string } } => block.type === 'text' || block.type === 'content')
    .map(block => block.type === 'content' ? block.content.text : block.text)
    .join('')
}

/** Build grok `ToolOutput::Bash` from the model-facing text result. */
function bashRawOutput(
  prior: { name: string; arguments: unknown } | undefined,
  text: string,
  isError: boolean,
): Record<string, unknown> | undefined {
  if (prior === undefined || isError || !['bash', 'pwsh'].includes(prior.name.toLowerCase())) return undefined
  const args = (prior.arguments ?? {}) as { command?: unknown; description?: unknown; run_in_background?: unknown }
  if (args.run_in_background === true) return undefined
  const status = parseExitStatus(text)
  const output = Buffer.from(text, 'utf8')
  return {
    type: 'Bash',
    output: Array.from(output),
    output_for_prompt: text,
    // Grok uses -1 when termination supplied a signal instead of an exit code.
    exit_code: 'exitCode' in status ? status.exitCode : -1,
    command: typeof args.command === 'string' ? args.command : '',
    truncated: /\n\[output truncated; full output: [^\n]+\]/.test(text),
    signal: 'signal' in status ? status.signal : null,
    timed_out: /\n\[timed out after [\d.]+ms\]$/.test(status.body),
    ...typeof args.description === 'string' && args.description.length > 0 ? { description: args.description } : {},
    current_dir: '',
    output_file: '',
    total_bytes: output.length,
  }
}

/** Build grok `ToolOutput::ReadFile` from dsh-tool-fs `presentationMeta`. */
function readRawOutputFromMeta(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as { path?: unknown; offset?: unknown; lines?: unknown; totalLines?: unknown }
  if (typeof m.path !== 'string' || !Array.isArray(m.lines) || typeof m.totalLines !== 'number'
    || !Number.isInteger(m.totalLines) || m.totalLines < 0) return undefined
  const lines = m.lines as Array<{ number?: unknown; text?: unknown }>
  const rawOutput = lines
    .filter(line => typeof line.text === 'string')
    .map(line => line.text as string)
    .join('\n')
  const offset = typeof m.offset === 'number' ? m.offset : 1
  return {
    type: 'ReadFile',
    FileContent: {
      content: rawOutput,
      absolute_path: m.path,
      offset,
      total_lines: m.totalLines,
      limit: lines.length,
      raw_output: rawOutput,
    },
  }
}

/** Build grok `ToolOutput::GrepSearch` from dsh-tool-fs-search `presentationMeta`. */
function searchRawOutputFromMeta(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as { shape?: unknown; files?: unknown; paths?: unknown; total?: unknown }
  if (m.shape === 'matches') {
    const files = Array.isArray(m.files)
      ? (m.files as Array<{ path?: unknown; matches?: unknown }>)
          .filter(file => typeof file.path === 'string' && Array.isArray(file.matches))
          .map(file => ({
            path: file.path as string,
            matches: (file.matches as Array<{ lineNumber?: unknown; line?: unknown }>)
              .filter(match => typeof match.lineNumber === 'number' && typeof match.line === 'string')
              .map(match => ({ line_number: match.lineNumber as number, content: match.line as string })),
          }))
      : []
    return {
      type: 'GrepSearch',
      stdout: [],
      stderr: [],
      exit_code: 0,
      match_count: typeof m.total === 'number' ? m.total : 0,
      file_matches: files,
    }
  }
  if (m.shape === 'paths') {
    const paths = Array.isArray(m.paths) ? (m.paths as string[]).filter(path => typeof path === 'string') : []
    const stdout = Buffer.from(paths.join('\n'), 'utf8')
    return {
      type: 'GrepSearch',
      stdout: Array.from(stdout),
      stderr: [],
      exit_code: 0,
      match_count: typeof m.total === 'number' ? m.total : paths.length,
      file_matches: [],
    }
  }
  return undefined
}

/** Build grok `ToolOutput::WebSearch` from dsh-tool-web `presentationMeta`. */
function webSearchRawOutput(
  prior: { name: string; arguments: unknown } | undefined,
  meta: unknown,
  text: string,
): Record<string, unknown> | undefined {
  if (prior === undefined) return undefined
  const args = (prior.arguments ?? {}) as { query?: unknown }
  const m = (meta ?? {}) as { sources?: unknown }
  const citations = Array.isArray(m.sources)
    ? (m.sources as Array<{ url?: unknown }>)
        .filter(source => typeof source.url === 'string')
        .map(source => source.url as string)
    : []
  return {
    type: 'WebSearch',
    query: typeof args.query === 'string' ? args.query : '',
    content: text,
    citations,
    allowed_domains: null,
    inline_fallback: null,
  }
}

/** Build grok `ToolOutput::WebFetch` from dsh-tool-web `presentationMeta`. */
function webFetchRawOutput(
  prior: { name: string; arguments: unknown } | undefined,
  meta: unknown,
  text: string,
): Record<string, unknown> | undefined {
  if (prior === undefined) return undefined
  const args = (prior.arguments ?? {}) as { url?: unknown }
  const m = (meta ?? {}) as { url?: unknown; statusCode?: unknown }
  if (typeof m.statusCode !== 'number' || !Number.isInteger(m.statusCode) || m.statusCode < 100 || m.statusCode > 599) return undefined
  return {
    type: 'WebFetch',
    Content: {
      url: typeof m.url === 'string' ? m.url : typeof args.url === 'string' ? args.url : '',
      content: text,
      content_type: 'text',
      status_code: m.statusCode,
      bytes: Buffer.byteLength(text, 'utf8'),
    },
  }
}

/**
 * Build the structured grok `rawOutput` for the TUI's typed tool blocks.
 * dsh-session only carries model-facing text plus tool-private `meta`, so the
 * bridge reconstructs the wire shape the grok TUI already understands.
 */
function typedRawOutput(
  prior: { name: string; arguments: unknown } | undefined,
  meta: unknown,
  contents: Array<ToolResultContentBlock>,
  isError: boolean,
): Record<string, unknown> | undefined {
  if (prior === undefined) return undefined
  const kind = toolKindForName(prior.name, prior.arguments)
  if (isError) return kind === 'execute' ? bashRawOutput(prior, textFromContents(contents), true) : undefined
  const text = textFromContents(contents)
  switch (kind) {
    case 'execute':
      return bashRawOutput(prior, text, false)
    case 'read':
      return readRawOutputFromMeta(meta)
    case 'search':
      if (prior.name.toLowerCase() === 'web_search' || prior.name.toLowerCase() === 'x_search') {
        return webSearchRawOutput(prior, meta, text)
      }
      return searchRawOutputFromMeta(meta)
    case 'fetch':
      return webFetchRawOutput(prior, meta, text)
    default:
      return undefined
  }
}

/** Turn dsh image/text blocks into display text blocks. */
export function textBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(content)) return []
  const blocks: Array<{ type: 'text'; text: string }> = []
  for (const raw of content) {
    const block = raw as { type?: string; text?: string; attachment?: { attachmentId?: string } }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: '[image attachment ' + String(block.attachment?.attachmentId) + ']' })
    }
  }
  return blocks
}

/**
 * Map a harness turn ending to the grok StopReason vocabulary (agent.rs StopReason).
 * @param reason - harness turn outcome.
 * @returns the closest legal grok stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReasonWire {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // cancelled is reserved for explicit client cancellation and disposal,
    // settled out of band; aborted turns are ordinary quiescence.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
