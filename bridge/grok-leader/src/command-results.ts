/**
 * Command results as their own durable blocks. DSH's command registry records
 * every command it runs as a log-only `command/run` → `command/done` pair,
 * paired by `commandId` like `tool/call` → `tool/result`, and never as a
 * message. Each pair projects onto one xAI `command_result` notice, live, on
 * replay and in child history alike, which the TUI renders as a "/name args"
 * block with the result's text. A success that names an earlier authoritative
 * event (`sourceEventSeq`) and has no text shows nothing: that event already
 * renders it. DSH's command text is plain UI text (its own client shows it
 * preformatted), so it is sent as such. Pure mapping; the owning output keeps
 * the pending runs.
 *
 * Bridge-owned commands (`/dsh`, `/browser`, `/preset`, `/team`,
 * `/subagents`) are not DSH commands and leave no such records: their results
 * ride the same notice live only (`commandResultNotice`), marked `markdown`
 * because their text is written as Markdown.
 *
 * @module dscode/command-results
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The TUI's `command_result` update. `args` is the invocation's input after
 * the name, trimmed and absent when empty or unrecorded; `markdown` says the
 * text is Markdown rather than plain text. */
export type CommandResultNotice = {
  sessionUpdate: 'command_result'
  name: string
  args?: string
  kind: 'success' | 'error'
  text?: string
  markdown?: true
}

/** A command a durable `command/run` started: its name and recorded input. */
export interface CommandRun { name: string; args?: string }

/** Commands between their durable `command/run` and `command/done`, by commandId. */
export type CommandFold = Map<string, CommandRun>

/** One result notice for a command line's name and input. */
export function commandResultNotice(name: string, args: string | undefined, kind: 'success' | 'error', text?: string, markdown = false): CommandResultNotice {
  const input = args?.trim() ?? ''
  return { sessionUpdate: 'command_result', name, ...input === '' ? {} : { args: input }, kind,
    ...text === undefined ? {} : { text }, ...markdown ? { markdown: true as const } : {} }
}

/** The name and input of a `/name input` line, for a bridge-owned command's notice. */
export function commandLine(line: string): CommandRun | undefined {
  const match = /^\/(\S+)(.*)$/s.exec(line.trim())
  if (match === null) return undefined
  const args = match[2]!.trim()
  return { name: match[1]!.toLowerCase(), ...args === '' ? {} : { args } }
}

/** The run one durable `command/run` records, keyed by its commandId. */
export function commandRun(event: SessionEvent): { commandId: string; run: CommandRun } | undefined {
  if (String(event.type) !== 'command/run') return undefined
  const data = event.data as { commandId?: unknown; name?: unknown; args?: unknown } | null
  if (typeof data?.commandId !== 'string' || typeof data.name !== 'string' || data.name === '') return undefined
  return { commandId: data.commandId, run: { name: data.name, ...typeof data.args === 'string' ? { args: data.args } : {} } }
}

/** The commandId a durable `command/done` settles. */
export function commandDoneId(event: SessionEvent): string | undefined {
  if (String(event.type) !== 'command/done') return undefined
  const id = (event.data as { commandId?: unknown } | null)?.commandId
  return typeof id === 'string' ? id : undefined
}

/** The notice one durable `command/done` shows, given its run: none for an
 * unpaired settlement or a text-less success an earlier event presents. */
export function commandResult(event: SessionEvent, run: (commandId: string) => CommandRun | undefined): CommandResultNotice | undefined {
  const id = commandDoneId(event)
  const started = id === undefined ? undefined : run(id)
  if (started === undefined) return undefined
  const data = event.data as { kind?: unknown; text?: unknown; sourceEventSeq?: unknown }
  const kind = data.kind === 'error' ? 'error' : data.kind === 'success' ? 'success' : undefined
  if (kind === undefined) return undefined
  const text = typeof data.text === 'string' ? data.text : undefined
  if (kind === 'success' && text === undefined && data.sourceEventSeq !== undefined) return undefined
  return commandResultNotice(started.name, started.args, kind, text)
}

/** Fold one event of a stream seen in order: a run is remembered until its
 * settlement, which yields its notice (if any). */
export function commandResults(fold: CommandFold, event: SessionEvent): CommandResultNotice[] {
  const started = commandRun(event)
  if (started !== undefined) { fold.set(started.commandId, started.run); return [] }
  const id = commandDoneId(event)
  if (id === undefined) return []
  const notice = commandResult(event, commandId => fold.get(commandId))
  fold.delete(id)
  return notice === undefined ? [] : [notice]
}
