import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { boundOptions, type SelectOption } from './command-options.ts'
import { errorMessage } from './guards.ts'
import type { AgentPresetsLike } from './session-presets.ts'
import type { SessionWork, SessionOperation } from './session-work.ts'
import type { SessionOutput } from './session-output.ts'
import { parsePrompt, type ParsedPrompt } from './prompt-content.ts'
import type { PromptSettleResult } from './prompt-queue.ts'

/** DSH's handler-free command descriptor (`CommandDescriptor`). */
export interface NativeCommandDescriptor {
  definitionId?: string
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
}
export interface NativeCommands {
  list(agent: Agent): ReadonlyArray<NativeCommandDescriptor>
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
type Options = Promise<readonly SelectOption[]> | readonly SelectOption[]
interface CommandHost<S extends CommandSession> {
  sessions: ReadonlyMap<SessionId, S>
  owned(clientId: number, id: SessionId | undefined): S | undefined
  client(id: number): { readonly closed: boolean; notify(method: string, params: unknown): void } | undefined
  registry(): NativeCommands | undefined
  roster(): Pick<AgentPresetsLike, 'list'> | undefined
  skills(record: S): NativeSkills | undefined
  capabilities(record: S): string[]
  profile: { execute(text: string, notify: (message: string) => void): Promise<string>; options(query: string): Options }
  browser: { execute(text: string): Promise<string>; options(): Options }
  team: { execute(record: S, text: string): string }
  preset(record: S, text: string): Promise<string>
  presetOptions(record: S): Options
  children: { command(clientId: number, params: unknown): Promise<CommandResult>; options(record: S, query: string): Options }
  goals: { goal(clientId: number, params: unknown): Promise<CommandResult>; options(record: S): Options }
  on(name: 'commands/change' | 'skills/change' | 'tools/change', listener: () => void): () => void
  logger: { warn(message: string): void }
}
/** The rest of a host command's descriptor, which ACP's name, description and
 * hint cannot carry: its plugin-owned identity, whether composer attachments
 * may accompany it (absent: the client refuses them), whether the client
 * runs it at once over `x.ai/commands/run` instead of queueing it behind the
 * running turn, and whether `x.ai/commands/options` serves the choices of its
 * bare invocation. */
interface CommandMeta { definitionId?: string; attachments?: true; immediate?: true; options?: true }
interface AdvertisedCommand {
  name: string
  description: string
  input?: { hint: string }
  _meta?: { scope: string; path: string; pluginName: string } | CommandMeta
}
/** Commands that control a session beside its running turn rather than
 * inside it: the client sends them over `x.ai/commands/run`, never queued. */
const IMMEDIATE = new Set(['goal', 'subagents'])
/** Commands whose bare invocation offers bridge-served choices; each has its provider below. */
const OPTION_COMMANDS = ['preset', 'dsh', 'browser', 'subagents', 'goal'] as const
const OPTIONS: ReadonlySet<string> = new Set(OPTION_COMMANDS)
const commandMeta = (command: NativeCommandDescriptor): CommandMeta | undefined => {
  const meta: CommandMeta = { ...command.definitionId === undefined ? {} : { definitionId: command.definitionId },
    ...command.input?.attachments === true ? { attachments: true } : {},
    ...IMMEDIATE.has(command.name.toLowerCase()) ? { immediate: true } : {},
    ...OPTIONS.has(command.name.toLowerCase()) ? { options: true } : {} }
  return Object.keys(meta).length === 0 ? undefined : meta
}
const skillScope = (skill: NativeSkillSummary) => skill.source?.startsWith('project-') ? 'repo'
  : skill.source?.startsWith('user-') ? 'user' : skill.source === 'bundled' ? 'bundled' : 'plugin'
const capabilityKey = (capabilities: readonly string[]) => JSON.stringify(capabilities)
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
  /** Capabilities last advertised per session, so a tool change that leaves them alone publishes nothing. */
  const advertised = new WeakMap<S, string>()
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
      input: { hint: 'plugins | enable|disable <bundle>[#row] | add [--trust] <package> | remove <name> | inspect <name>' }, _meta: { options: true } },
    { name: 'browser', description: 'Turn the isolated browser on or off',
      input: { hint: 'status | on [--executable <path>] [--origin <origin>]... [--any-origin] | off | origins add|remove <origin>' }, _meta: { options: true } },
    { name: 'subagents', description: 'Inspect and control child conversations',
      input: { hint: 'list | pending <child> | queue|steer <child> <text> | edit|remove|steer-queued|clear|stop <child> ...' },
      _meta: { immediate: true, options: true } }]
    // The installed presets are its options, not a hint: they change with the roster.
    if (presets.length > 0) commands.push({ name: 'preset', description: 'Switch the active agent preset', input: { hint: '<preset id>' }, _meta: { options: true } })
    if (record === undefined) return commands
    if (host.capabilities(record).includes('team')) commands.push({ name: 'team', description: 'Show the Agent Team roster and task board' })
    const registry = host.registry()
    check()
    const fromPlugins = registry?.list(record.agent) ?? []
    check()
    const claimed = new Set(commands.map(command => command.name.toLowerCase()))
    for (const command of fromPlugins) {
      if (claimed.has(command.name.toLowerCase())) continue
      claimed.add(command.name.toLowerCase())
      const meta = commandMeta(command)
      commands.push({ name: command.name, description: command.description,
        ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
        ...meta === undefined ? {} : { _meta: meta } })
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
    try { host.logger.warn('command discovery failed: ' + errorMessage(error)) } catch { /* observer logging must not veto native registry changes */ }
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
            // ACP's extension field is `_meta`; a bare `meta` never reached the TUI.
            client.notify('session/update', { sessionId: record.agent.session.id,
              update: { sessionUpdate: 'available_commands_update', availableCommands, _meta: { capabilities } } })
            advertised.set(record, capabilityKey(capabilities))
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
  const execute = (record: S, params: Record<string, unknown>, parsed: ParsedPrompt, signal?: AbortSignal): Promise<PromptSettleResult | undefined> | undefined => {
    if (closed) return Promise.reject(internalError('session commands have been disposed'))
    const text = parsed.text.trim()
    // Ordinary prompts must enter the queue synchronously: an added await here
    // would move their admission behind a same-tick cancel or a later prompt.
    if (!text.startsWith('/')) return undefined
    const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase()
    const dsh = /^\/dsh(\s|$)/.test(text), preset = /^\/preset(\s|$)/.test(text), browser = /^\/browser(\s|$)/.test(text), team = /^\/team(\s|$)/.test(text)
    const children = /^\/subagents(?:\s|$)/i.test(text)
    const refusal = name === undefined || !Object.hasOwn(unsupported, name) ? undefined : unsupported[name]
    const reserved = dsh || preset || browser || team || children || refusal !== undefined || name === 'goal'
    const registry = reserved ? undefined : host.registry()
    assertOpen()
    if (!reserved && registry === undefined && name !== 'compact') return undefined
    return accepted(() => record.work.run(async owner => {
      const scope: SessionOperation = signal === undefined ? owner : {
        signal: AbortSignal.any([owner.signal, signal]),
        assertActive() { owner.assertActive(); signal.throwIfAborted() },
      }
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
      if (browser) {
        textOnly('/browser')
        const message = await host.browser.execute(text)
        return settle(record, params, message, scope)
      }
      if (team) {
        textOnly('/team')
        return settle(record, params, host.team.execute(record, text), scope)
      }
      if (preset) {
        textOnly('/preset')
        const message = await host.preset(record, text)
        active(record, scope); void refresh(record)
        return settle(record, params, message, scope)
      }
      if (children || name === 'goal') {
        const execution = children ? await host.children.command(record.clientId, params) : await host.goals.goal(record.clientId, params)
        if (execution.result.kind === 'error') throw invalidParams(execution.result.text)
        return settle(record, params, execution.result.text, scope)
      }
      if (refusal !== undefined) { textOnly('/' + name); throw invalidParams(refusal) }
      if (registry !== undefined) {
        const execution = await registry.execute(record.agent, text, parsed.images, AbortSignal.any([scope.signal, shutdown.signal]))
        active(record, scope)
        if (execution !== undefined) {
          const body = execution.result.text ?? (execution.result.kind === 'success' ? 'done' : 'command failed')
          if (execution.result.kind === 'error') throw invalidParams(body)
          return settle(record, params, body, scope)
        }
      }
      if (name === 'compact') { textOnly('/compact'); throw invalidParams('Manual compaction is unavailable in this session.') }
      return undefined
    }))
  }
  // Tools change whenever a Session, child or MCP server mounts or unmounts a
  // scope, often one registration at a time, and only capabilities follow
  // them. One check per burst; a session refreshes only when its capabilities
  // moved (or a refresh is already reading, which then reads again).
  let toolCheck = false
  const toolsChanged = () => {
    if (toolCheck) return
    toolCheck = true
    queueMicrotask(() => {
      toolCheck = false
      if (!ready || closed) return
      for (const record of host.sessions.values()) {
        if (host.owned(record.clientId, record.agent.session.id) !== record) continue
        let moved: boolean
        try { moved = refreshes.has(record) || advertised.get(record) !== capabilityKey(host.capabilities(record)) } catch (error) { warn(error); continue }
        if (moved) void refresh(record)
      }
    })
  }
  try {
    for (const event of ['commands/change', 'skills/change', 'tools/change'] as const) {
      subscriptions.push(host.on(event, event === 'tools/change' ? toolsChanged : () => {
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
  /** Where each command's options come from, for `query` '' or a `next` row's id. */
  const providers: Record<typeof OPTION_COMMANDS[number], (record: S, query: string) => Options> = {
    preset: record => host.presetOptions(record),
    dsh: (_record, query) => host.profile.options(query),
    browser: () => host.browser.options(),
    subagents: (record, query) => host.children.options(record, query),
    goal: record => host.goals.options(record),
  }
  /** Each immediate command's owner; both take the `x.ai/commands/run` params. */
  const immediate: Record<string, (clientId: number, params: unknown) => Promise<CommandResult>> = {
    goal: (clientId, params) => host.goals.goal(clientId, params),
    subagents: (clientId, params) => host.children.command(clientId, params),
  }
  return {
    /** `x.ai/commands/run`: an immediate command (`_meta.immediate`) runs at once
     * beside the session's turn and queue, and answers with its result instead
     * of settling a prompt. Its owner checks the session and the invocation. */
    run(clientId: number, params: unknown): Promise<CommandResult> {
      return accepted(async () => {
        const p = paramRecord(params, 'x.ai/commands/run')
        const text = parsePrompt(p.prompt).text.trim()
        const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase()
        const owner = name === undefined || !IMMEDIATE.has(name) ? undefined : immediate[name]
        if (owner === undefined) throw invalidParams(`x.ai/commands/run requires an immediate command (${[...IMMEDIATE].map(name => '/' + name).join(', ')})`)
        return owner(clientId, params)
      })
    },
    /** `x.ai/commands/options`: the choices of a command's bare invocation
     * (`_meta.options`) in an owned session, at `query` '' or a `next` row's
     * id. Reads only; the pick comes back as an ordinary command line. */
    options(clientId: number, params: unknown): Promise<{ options: SelectOption[] }> {
      return accepted(async () => {
        const p = paramRecord(params, 'x.ai/commands/options')
        const record = host.owned(clientId, sessionIdParam(p.sessionId))
        if (record === undefined) throw invalidParams('x.ai/commands/options requires an owned sessionId')
        const name = typeof p.name === 'string' ? p.name.replace(/^\//, '').toLowerCase() : undefined
        const provider = name !== undefined && OPTIONS.has(name) ? providers[name as typeof OPTION_COMMANDS[number]] : undefined
        if (provider === undefined) throw invalidParams(`x.ai/commands/options requires a command with options (${OPTION_COMMANDS.map(name => '/' + name).join(', ')})`)
        if (p.query !== undefined && typeof p.query !== 'string') throw invalidParams('x.ai/commands/options query must be a string')
        const query = (p.query ?? '').trim()
        return record.work.read(async scope => {
          active(record, scope)
          const options = boundOptions(await provider(record, query))
          active(record, scope)
          return { options }
        })
      })
    },
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
        const record = host.owned(clientId, sessionIdParam(p.sessionId))
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
