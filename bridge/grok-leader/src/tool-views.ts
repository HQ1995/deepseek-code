/**
 * Tool views: how a DSH tool's own presenters (`presentCall`/`presentResult`
 * on its definition) say one call renders, normalized into the view the TUI
 * reads from `_meta['dscode/view']`. They run at projection time, live and on
 * replay alike, against the registry of the agent whose log is projected: a
 * presenter reads only the call's arguments and the durable result (`content`,
 * `isError`, `meta`), so nothing is persisted. An approval prompt carries the
 * pending call's view too (`native-interactions`). An unmounted tool, a throwing
 * presenter, arguments that no longer match the tool's schema or a view of an
 * unknown shape give no view; the name tables in `projection` then apply.
 *
 * Normalization: content becomes text blocks, a relative terminal `cwd` is
 * resolved against the session cwd, a diff view over the fallback-diff budget
 * is dropped and a generic `rawInput` is capped. No tool is named here.
 *
 * @module dscode/tool-views
 */
import { isAbsolute, resolve } from 'node:path'
import { MAX_FALLBACK_DIFF_CHARS, textBlocks, type ToolKindWire } from './tool-output.ts'

/** A tool's presenters as one agent's registry resolves them. */
export interface ToolPresenters {
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: { content: unknown[]; isError: boolean; meta?: unknown }): unknown
}
/** Resolves a tool name to its presenters; undefined when no such tool is visible. */
export type ToolPresenter = (name: string) => ToolPresenters | undefined

type TextBlock = { type: 'text'; text: string }
/** One file change: `oldText` is null for a new file (or an overwrite presented at call time). */
export interface FileDiffWire { path: string; oldText: string | null; newText: string }
/** A pending call's render intent (DSH `ToolCallView`, normalized). */
export type ToolCallViewWire =
  | { card: 'generic'; title: string; kind?: ToolKindWire; rawInput?: unknown; content?: TextBlock[]; locations?: Array<{ path: string; line?: number }> }
  | { card: 'terminal'; title: string; description?: string; cwd?: string }
  | { card: 'diff'; title: string; diffs: FileDiffWire[]; locations?: Array<{ path: string; line?: number }> }
/** A completed call's render intent (DSH `ToolResultView`, normalized). */
export type ToolResultViewWire =
  | { card: 'generic'; title?: string; content?: TextBlock[] }
  | { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
  | { card: 'diff'; title?: string; diffs: FileDiffWire[] }
  | { card: 'search'; shape: 'matches'; title?: string; files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>; truncated: boolean; total: number }
  | { card: 'search'; shape: 'paths'; title?: string; paths: string[]; truncated: boolean; total: number }
  | { card: 'read'; title?: string; path: string; offset: number; lines: Array<{ number: number; text: string }>; totalLines: number; lang?: string; content?: TextBlock[] }
  | { card: 'web'; kind: 'search'; title?: string; sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>; answer?: string; truncated: boolean }
  | { card: 'web'; kind: 'fetch'; title?: string; url: string; statusCode: number; truncated: boolean }

/** Longest serialized generic `rawInput` a view carries; longer input becomes a truncated string. */
const MAX_RAW_INPUT_CHARS = 8 * 1024
/** The ACP tool kinds a view's `kind` may name (DSH's `ToolCallKind`). */
const KINDS: ReadonlySet<string> = new Set<ToolKindWire>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])

type Check = (value: unknown) => boolean
const isString: Check = value => typeof value === 'string'
const isInteger: Check = value => Number.isSafeInteger(value)
const isCount: Check = value => Number.isSafeInteger(value) && (value as number) >= 0
const isBoolean: Check = value => typeof value === 'boolean'
const exactly = (expected: string): Check => value => value === expected
const arrayOf = (item: Check): Check => value => Array.isArray(value) && value.every(item)
const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** An object whose `required` keys pass and whose present `optional` keys pass. */
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value => {
  const fields = objectOf(value)
  return fields !== undefined && Object.entries(required).every(([key, check]) => check(fields[key]))
    && Object.entries(optional).every(([key, check]) => fields[key] === undefined || check(fields[key]))
}
/** The listed keys of a checked view, without absent ones: the wire carries no stray fields. */
const pick = (fields: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => fields[key] !== undefined).map(key => [key, fields[key]]))

const location = shape({ path: isString }, { line: isInteger })
const fileDiff = shape({ path: isString, newText: isString }, { oldText: value => value === null || isString(value) })
const titled = { title: isString }

/** Diff entries within the display budget, or undefined to drop the view. */
function diffsWithinBudget(diffs: unknown): FileDiffWire[] | undefined {
  if (!arrayOf(fileDiff)(diffs)) return undefined
  const entries = (diffs as Array<{ path: string; oldText?: string | null; newText: string }>)
    .map(diff => ({ path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText }))
  const size = entries.reduce((total, diff) => total + (diff.oldText?.length ?? 0) + diff.newText.length, 0)
  return size <= MAX_FALLBACK_DIFF_CHARS ? entries : undefined
}

/** A generic view's salient input, as given or, past the cap, a truncated string. */
function cappedRawInput(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || serialized.length <= MAX_RAW_INPUT_CHARS) return value
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.slice(0, MAX_RAW_INPUT_CHARS) + '…'
}

/** Presenter content as display text blocks; none when it shows nothing. */
const contentOf = (value: unknown): { content?: TextBlock[] } => {
  if (value === undefined) return {}
  const blocks = textBlocks(value)
  return blocks.length === 0 ? {} : { content: blocks }
}

function callViewOf(value: unknown, cwd: string | undefined): ToolCallViewWire | undefined {
  const view = objectOf(value)
  switch (view?.card) {
    case 'generic': {
      if (!shape(titled, { locations: arrayOf(location) })(view)) return undefined
      return { card: 'generic', title: view.title as string, ...typeof view.kind === 'string' && KINDS.has(view.kind) ? { kind: view.kind as ToolKindWire } : {},
        ...view.rawInput === undefined ? {} : { rawInput: cappedRawInput(view.rawInput) }, ...contentOf(view.content),
        ...Array.isArray(view.locations) && view.locations.length > 0 ? { locations: view.locations.map(entry => pick(entry, ['path', 'line'])) as Array<{ path: string }> } : {} }
    }
    case 'terminal': {
      if (!shape(titled, { description: isString, cwd: isString })(view)) return undefined
      const dir = view.cwd as string | undefined
      return { ...pick(view, ['card', 'title', 'description']) as { card: 'terminal'; title: string },
        ...dir === undefined ? {} : { cwd: isAbsolute(dir) || cwd === undefined ? dir : resolve(cwd, dir) } }
    }
    case 'diff': {
      const diffs = shape(titled, { locations: arrayOf(location) })(view) ? diffsWithinBudget(view.diffs) : undefined
      if (diffs === undefined) return undefined
      return { card: 'diff', title: view.title as string, diffs,
        ...Array.isArray(view.locations) && view.locations.length > 0 ? { locations: view.locations.map(entry => pick(entry, ['path', 'line'])) as Array<{ path: string }> } : {} }
    }
    default:
      return undefined
  }
}

/** The result views whose fields pass through as checked. */
const RESULT_SHAPES: Record<string, { check: Check; keys: readonly string[] }> = {
  terminal: { check: shape({}, { title: isString, output: isString, exitCode: isInteger, signal: isString }), keys: ['title', 'output', 'exitCode', 'signal'] },
  matches: { check: shape({ files: arrayOf(shape({ path: isString, matches: arrayOf(shape({ lineNumber: isInteger, line: isString })) })), truncated: isBoolean, total: isCount }, titled),
    keys: ['shape', 'title', 'files', 'truncated', 'total'] },
  paths: { check: shape({ paths: arrayOf(isString), truncated: isBoolean, total: isCount }, titled), keys: ['shape', 'title', 'paths', 'truncated', 'total'] },
  websearch: { check: shape({ sources: arrayOf(shape({ url: isString }, { title: isString, snippet: isString, publishedAt: isString })), truncated: isBoolean }, { title: isString, answer: isString }),
    keys: ['kind', 'title', 'sources', 'answer', 'truncated'] },
  webfetch: { check: shape({ url: isString, statusCode: isInteger, truncated: isBoolean }, titled), keys: ['kind', 'title', 'url', 'statusCode', 'truncated'] },
}

function resultViewOf(value: unknown): ToolResultViewWire | undefined {
  const view = objectOf(value)
  if (view === undefined) return undefined
  const passThrough = (key: string) => {
    const known = RESULT_SHAPES[key]!
    return known.check(view) ? { card: view.card, ...pick(view, known.keys) } as ToolResultViewWire : undefined
  }
  switch (view.card) {
    case 'generic':
      return shape({}, titled)(view) ? { card: 'generic', ...pick(view, ['title']), ...contentOf(view.content) } : undefined
    case 'terminal':
      return passThrough('terminal')
    case 'diff': {
      const diffs = shape({}, titled)(view) ? diffsWithinBudget(view.diffs) : undefined
      return diffs === undefined ? undefined : { card: 'diff', ...pick(view, ['title']), diffs }
    }
    case 'search':
      return view.shape === 'matches' || view.shape === 'paths' ? passThrough(view.shape) : undefined
    case 'read': {
      const read = shape({ path: isString, offset: isInteger, lines: arrayOf(shape({ number: isInteger, text: isString })), totalLines: isCount }, { title: isString, lang: isString })
      return read(view) ? { card: 'read', ...pick(view, ['title', 'path', 'offset', 'lines', 'totalLines', 'lang']), ...contentOf(view.content) } as ToolResultViewWire : undefined
    }
    case 'web':
      return view.kind === 'search' || view.kind === 'fetch' ? passThrough('web' + view.kind) : undefined
    default:
      return undefined
  }
}

/** A presenter call that never throws: undefined for a missing presenter or a failure. */
function present<T>(presenter: ToolPresenter | undefined, name: string, run: (tool: ToolPresenters) => unknown, normalize: (value: unknown) => T | undefined): T | undefined {
  try {
    const tool = presenter?.(name)
    return tool === undefined ? undefined : normalize(run(tool))
  } catch {
    return undefined
  }
}

/** The pending call's view, or undefined when the tool presents none. */
export function callView(presenter: ToolPresenter | undefined, name: string, args: unknown, cwd?: string): ToolCallViewWire | undefined {
  return present(presenter, name, tool => tool.presentCall?.(args), value => callViewOf(value, cwd))
}

/** The completed call's view from its durable result, or undefined when the tool presents none. */
export function resultView(
  presenter: ToolPresenter | undefined,
  name: string,
  args: unknown,
  result: { content: unknown; isError: boolean; meta?: unknown },
): ToolResultViewWire | undefined {
  const content = Array.isArray(result.content) ? result.content : []
  return present(presenter, name, tool => tool.presentResult?.(args, {
    content, isError: result.isError, ...result.meta === undefined ? {} : { meta: result.meta },
  }), resultViewOf)
}

/** The ACP tool kind a call view implies: a terminal executes, a diff edits. */
export function viewKind(view: ToolCallViewWire): ToolKindWire {
  if (view.card === 'terminal') return 'execute'
  if (view.card === 'diff') return 'edit'
  return view.kind ?? 'other'
}

/** Presenters from one agent's tool registry, as that agent resolves them. */
export function registryPresenter(agent: { ctx: unknown } | undefined): ToolPresenter | undefined {
  if (agent === undefined) return undefined
  return name => {
    const tools = (agent.ctx as { get(name: string): unknown }).get('tools') as { get?(name: string, scope?: unknown): ToolPresenters | undefined } | undefined
    return tools?.get?.(name, agent)
  }
}
