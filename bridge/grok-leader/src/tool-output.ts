/**
 * Tool-card shapes: the grok ToolKind a dsh tool renders as, the rawInput
 * variants the typed TUI blocks route on, display-only fallback diffs and the
 * typed `rawOutput` rebuilt from model-facing text plus tool-private meta.
 * Pure functions only; `projection` assembles them into session updates.
 *
 * @module dscode/tool-output
 */
import { parseExitStatus } from '@deepseek-ai/dsh-shell'

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
export function diffBlocksFromMeta(meta: unknown): Array<{ type: 'diff'; path: string; oldText?: string; newText: string }> {
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
export function diffBlocksFromCall(prior: { name: string; arguments: unknown } | undefined): Array<{ type: 'diff'; path: string; oldText?: string; newText: string }> {
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
export function rawInputForTool(name: string, args: unknown): unknown {
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
export function typedRawOutput(
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
