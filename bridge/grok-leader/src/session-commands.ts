import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import type { AgentPresetsLike } from './session-presets.ts'
import type { SessionWork, SessionOperation } from './session-work.ts'
import type { SessionOutput } from './session-output.ts'
import type { ParsedPrompt } from './prompt-content.ts'
import type { PromptSettleResult } from './prompt-queue.ts'

export interface NativeCommands {
  list(agent: Agent): ReadonlyArray<{ name: string; description: string; input?: { hint: string } }>
  execute(agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
}
interface NativeSkillSummary {
  name: string
  description: string
  whenToUse?: string
  invocation?: { userInvocable?: boolean; modelInvocable?: boolean }
  provider?: string
  source?: string
  resourceBase?: { kind: string; path?: string }
  path?: string
}
export interface NativeSkills { list(lookup: { cwd?: string; scope: Agent }): Promise<NativeSkillSummary[]> }
interface CommandSession {
  agent: Agent
  clientId: number
  work: Pick<SessionWork, 'read' | 'run'>
  output: Pick<SessionOutput, 'update'>
}
type CommandResult = { result: { kind: string; text: string } }
interface CommandHost<S extends CommandSession> {
  sessions: ReadonlyMap<SessionId, S>
  owned(clientId: number, id: SessionId | undefined): S | undefined
  client(id: number): { readonly closed: boolean; notify(method: string, params: unknown): void } | undefined
  registry(): NativeCommands | undefined
  roster(): Pick<AgentPresetsLike, 'list'> | undefined
  skills(record: S): NativeSkills | undefined
  capabilities(record: S): string[]
  profile: { execute(text: string, notify: (message: string) => void): Promise<string> }
  preset(record: S, text: string): Promise<string>
  children: { command(clientId: number, params: unknown): Promise<CommandResult> }
  goals: { goal(clientId: number, params: unknown): Promise<CommandResult> }
  on(name: 'commands/change' | 'skills/change', listener: () => void): () => void
  logger: { warn(message: string): void }
}
interface AdvertisedCommand {
  name: string
  description: string
  input?: { hint: string }
  _meta?: { scope: string; path: string; pluginName: string }
}
const skillScope = (skill: NativeSkillSummary) => skill.source?.startsWith('project-') ? 'repo'
  : skill.source?.startsWith('user-') ? 'user' : skill.source === 'bundled' ? 'bundled' : 'plugin'
const skillPath = (skill: NativeSkillSummary) => skill.path ?? skill.resourceBase?.path ?? ''
const skillDescription = (skill: NativeSkillSummary) => (skill.invocation?.modelInvocable === false ? 'User only · ' : '') + skill.description
const unsupported: Record<string, string> = {
  auto: '/auto is unsupported: the permission classifier is not available in dscode.',
  delete: '/delete is not supported yet; use /exit to close without deleting durable history.',
  remember: '/remember is not supported by the dsh memory runtime yet.',
}

/** Command advertisements and routing share the native registry and one owner.
 * Catalog work without a session still drains on host shutdown. Bound reads
 * and executions also belong to their session's work scope. Native features
 * retain their own mutations; this module owns precedence, cancellation-aware
 * dispatch and turnless/ambient presentation, never prompt queue settlement. */
export function createSessionCommands<S extends CommandSession>(host: CommandHost<S>) {
  let closed = false, ready = false, disposal: Promise<void> | undefined
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>()
  const subscriptions: Array<() => void> = [], disposalFailures: unknown[] = []
  const refreshes = new WeakMap<S, { dirty: boolean; promise: Promise<void> }>()
  const assertOpen = () => { if (closed) throw internalError('session commands have been disposed') }
  const accepted = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(internalError('session commands have been disposed'))
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    // Native callbacks may reenter close; publish before invoking any of them.
    try { resolve(Promise.resolve(operation()).then(value => { assertOpen(); return value })) }
    catch (error) { reject(error) }
    return result
  }
  const active = (record: S, scope: SessionOperation) => {
    assertOpen(); scope.assertActive()
    if (host.owned(record.clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
  }
  const catalog = async (record?: S, scope?: SessionOperation): Promise<AdvertisedCommand[]> => {
    const check = () => { if (record !== undefined) active(record, scope!); else assertOpen() }
    check()
    const roster = host.roster()
    check()
    const presets = roster === undefined ? [] : await roster.list()
    check()
    const commands: AdvertisedCommand[] = [{ name: 'dsh', description: 'Manage dsh plugins',
      input: { hint: 'plugins | add [--trust] <package> | remove <name> | inspect <name>' } },
    { name: 'subagents', description: 'Inspect and control child conversations',
      input: { hint: 'list | pending <child> | queue|steer <child> <text> | edit|remove|steer-queued|clear|stop <child> ...' } }]
    if (presets.length > 0) commands.push({ name: 'preset', description: 'Switch the active agent preset', input: { hint: presets.map(preset => preset.id).join(' | ') } })
    if (record === undefined) return commands
    const registry = host.registry()
    check()
    const fromPlugins = registry?.list(record.agent) ?? []
    check()
    const claimed = new Set(commands.map(command => command.name.toLowerCase()))
    for (const command of fromPlugins) {
      if (claimed.has(command.name.toLowerCase())) continue
      claimed.add(command.name.toLowerCase())
      commands.push({ name: command.name, description: command.description,
        ...command.input === undefined ? {} : { input: { hint: command.input.hint } } })
    }
    const skills = host.skills(record)
    check()
    const listed = skills === undefined ? [] : await skills.list({ cwd: record.agent.session.header.cwd, scope: record.agent })
    check()
    for (const skill of listed) {
      if (skill.invocation?.userInvocable === false || claimed.has(skill.name.toLowerCase())) continue
      claimed.add(skill.name.toLowerCase())
      commands.push({ name: skill.name, description: skillDescription(skill), input: { hint: 'Instructions for this skill' },
        _meta: { scope: skillScope(skill), path: skillPath(skill), pluginName: skill.provider ?? 'dsh' } })
    }
    return commands
  }
  const warn = (error: unknown) => {
    if (closed) return
    try { host.logger.warn('command discovery failed: ' + (error instanceof Error ? error.message : String(error))) } catch { /* observer logging must not veto native registry changes */ }
  }
  const refresh = (record: S): Promise<void> => {
    if (closed) return Promise.resolve()
    const previous = refreshes.get(record)
    if (previous !== undefined) { previous.dirty = true; return previous.promise }
    const state = { dirty: false, promise: Promise.resolve() }
    state.promise = accepted(async () => {
      // Publish coalescing state before invoking native discovery callbacks.
      await Promise.resolve()
      return record.work.read(async scope => {
        try {
          do {
            state.dirty = false
            const availableCommands = await catalog(record, scope)
            const capabilities = host.capabilities(record)
            active(record, scope)
            // A change during the read invalidates its advertisement, not the
            // next request. Reread before publishing an older roster last.
            if (state.dirty) continue
            const client = host.client(record.clientId)
            active(record, scope)
            if (client === undefined || client.closed) return
            client.notify('session/update', { sessionId: record.agent.session.id,
              update: { sessionUpdate: 'available_commands_update', availableCommands, meta: { capabilities } } })
          } while (state.dirty)
        } finally { if (refreshes.get(record) === state) refreshes.delete(record) }
      })
    }).catch(warn).finally(() => { if (refreshes.get(record) === state) refreshes.delete(record) })
    refreshes.set(record, state)
    return state.promise
  }
  const notify = (record: S, message: string) => record.output.update({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message },
  }, false, Date.now())
  const settle = (record: S, params: Record<string, unknown>, message: string, scope: SessionOperation): PromptSettleResult => {
    active(record, scope)
    const meta = params._meta as Record<string, unknown> | null | undefined
    const promptId = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
    notify(record, message)
    return { stopReason: 'end_turn', _meta: { sessionId: String(record.agent.session.id), promptId } }
  }
  const execute = (record: S, params: Record<string, unknown>, parsed: ParsedPrompt): Promise<PromptSettleResult | undefined> | undefined => {
    if (closed) return Promise.reject(internalError('session commands have been disposed'))
    const text = parsed.text.trim()
    // Ordinary prompts must enter the queue synchronously: an added await here
    // would move their admission behind a same-tick cancel or a later prompt.
    if (!text.startsWith('/')) return undefined
    const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase()
    const dsh = /^\/dsh(\s|$)/.test(text), preset = /^\/preset(\s|$)/.test(text)
    const children = /^\/subagents(?:\s|$)/i.test(text)
    const refusal = name === undefined || !Object.hasOwn(unsupported, name) ? undefined : unsupported[name]
    const reserved = dsh || preset || children || refusal !== undefined || name === 'goal'
    const registry = reserved ? undefined : host.registry()
    assertOpen()
    if (!reserved && registry === undefined && name !== 'compact') return undefined
    return accepted(() => record.work.run(async scope => {
      active(record, scope)
      const textOnly = (command: string) => { if (parsed.images.length > 0) throw invalidParams(command + ' does not accept image attachments') }
      if (dsh) {
        textOnly('/dsh')
        const message = await host.profile.execute(text, message => {
          // Let accepted profile transactions finish atomically, but suppress
          // progress from a cancelled generation even if its owner reopens.
          try { active(record, scope) } catch { return }
          notify(record, message)
        })
        return settle(record, params, message, scope)
      }
      if (preset) {
        textOnly('/preset')
        const message = await host.preset(record, text)
        active(record, scope); void refresh(record)
        return settle(record, params, message, scope)
      }
      if (children || name === 'goal') {
        const execution = children ? await host.children.command(record.clientId, params) : await host.goals.goal(record.clientId, params)
        return settle(record, params, execution.result.kind === 'error' ? 'error: ' + execution.result.text : execution.result.text, scope)
      }
      if (refusal !== undefined) { textOnly('/' + name); return settle(record, params, refusal, scope) }
      if (registry !== undefined) {
        const execution = await registry.execute(record.agent, text, parsed.images, AbortSignal.any([scope.signal, shutdown.signal]))
        active(record, scope)
        if (execution !== undefined) {
          const body = execution.result.text ?? (execution.result.kind === 'success' ? 'done' : 'command failed')
          return settle(record, params, execution.result.kind === 'error' ? 'error: ' + body : body, scope)
        }
      }
      if (name === 'compact') { textOnly('/compact'); return settle(record, params, 'Manual compaction is unavailable in the selected preset.', scope) }
      return undefined
    }))
  }
  try {
    for (const event of ['commands/change', 'skills/change'] as const) {
      subscriptions.push(host.on(event, () => {
        if (ready && !closed) for (const record of host.sessions.values()) void refresh(record)
      }))
    }
    ready = true
  } catch (error) {
    closed = true; shutdown.abort()
    const failures = [error]
    for (const unsubscribe of subscriptions) { try { unsubscribe() } catch (failure) { failures.push(failure) } }
    if (failures.length > 1) throw new AggregateError(failures, 'command subscription construction failed')
    throw error
  }
  return {
    catalog(clientId?: number, params?: unknown): Promise<{ commands: AdvertisedCommand[] }> {
      return accepted(async () => {
        const p = clientId === undefined && params === undefined ? {} : paramRecord(params, 'x.ai/commands/list')
        const id = typeof p.sessionId === 'string' ? p.sessionId : typeof p.session_id === 'string' ? p.session_id : undefined
        const record = id === undefined || clientId === undefined ? undefined : host.owned(clientId, SessionId(id))
        if (id !== undefined && record === undefined) throw invalidParams('unknown session: ' + id)
        return { commands: record === undefined ? await catalog() : await record.work.read(scope => catalog(record, scope)) }
      })
    },
    skills(clientId: number, params: unknown): Promise<{ skills: Array<Record<string, unknown>> }> {
      return accepted(async () => {
        const p = paramRecord(params, 'x.ai/skills/list')
        const record = host.owned(clientId, typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
        if (record === undefined) throw invalidParams('skills/list requires an owned sessionId')
        return record.work.read(async scope => {
          active(record, scope)
          const skills = host.skills(record)
          active(record, scope)
          const listed = skills === undefined ? [] : await skills.list({ cwd: record.agent.session.header.cwd, scope: record.agent })
          active(record, scope)
          return { skills: listed.map(skill => ({ name: skill.name, display_name: skill.name, description: skillDescription(skill),
            has_user_specified_description: false, when_to_use: skill.whenToUse, short_description: skillDescription(skill),
            path: skillPath(skill), scope: skillScope(skill), ...skill.provider === undefined ? {} : { plugin_name: skill.provider },
            user_invocable: skill.invocation?.userInvocable ?? true, enabled: true })) }
        })
      })
    },
    refresh, execute,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => {
        while (pending.size > 0) await Promise.allSettled([...pending])
        if (disposalFailures.length > 0) throw new AggregateError(disposalFailures, 'command subscriptions failed to dispose')
      })
      for (const unsubscribe of subscriptions) { try { unsubscribe() } catch (error) { disposalFailures.push(error) } }
      shutdown.abort()
      return disposal
    },
  }
}
