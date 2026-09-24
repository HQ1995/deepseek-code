import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { errorMessage, isRecord } from './guards.ts'
import type { SettingsLike } from './native-seams.ts'
import { presetHistory, type PresetHistory } from './preset-history.ts'

/**
 * English display copy for the four shipped (system) agent presets, mirrored
 * from packages/client/ui-agent-preset/src/client/locales.ts presetDisplayText.
 * The dsh preset.yml files are authored in Chinese, so the leader localizes
 * the bundle/status personaDetails instead of editing those files
 * (harness-update hygiene). Custom (user) presets keep the roster's own
 * name/description.
 */
const SHIPPED_PRESET_DISPLAY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  },
  ptc: {
    name: 'PTC mode',
    description: 'Full coding agent without the workflow tool; other tools are exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'Minimal coding agent with a persistent shell.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
}


/** Structural read of the preset roster: discovery plus per-agent composition. */
export interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
  resolve(id?: string): Promise<{ id: string; path?: string; trust?: 'system' | 'user' }>
  read?(id: string): Promise<string>
  copy?(from: string, id: string): Promise<void>
  /** Whether the preset's tools attach only as a session opens (Agent Teams),
   * so it cannot be switched in place. */
  attachesOnOpen?(id: string): Promise<boolean>
  mount(agentCtx: Context, id?: string): Promise<unknown>
  recompose(agentCtx: Context, id: string): Promise<unknown>
  composedPreset?(agentCtx: Context): string | undefined
  serviceFor?(agent: { ctx: Context }, name: string): unknown
}


/**
 * Map the grok agent-selection meta to a dsh preset id. The TUI sends
 * _meta.agentProfile as a string built-in name or an inline JSON definition
 * (pager effects/helpers.rs SessionFlags::to_meta; the shell parses both in
 * upload/turn.rs parse_agent_profile_from_meta). _meta.agentPreset is the
 * dsh-native spelling and wins.
 * @param meta - session/new or session/load _meta.
 * @returns the requested preset id, or undefined for the roster default.
 */
const GROK_PROFILE_FALLBACKS = new Set(['grok-build-plan', 'grok-build-ask-user'])

const presetRequestFromMeta = (meta: Record<string, unknown> | null | undefined): string | undefined => {
  if (meta === undefined || meta === null) return undefined
  const native = meta.agentPreset
  if (native !== undefined) {
    if (typeof native !== 'string') throw invalidParams('_meta.agentPreset must be a string preset id')
    return native
  }
  const profile = meta.agentProfile
  if (profile === undefined) return undefined
  if (typeof profile === 'string') {
    if (profile === 'grok-build-plan-no-subagents') {
      throw invalidParams('--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead')
    }
    return profile
  }
  if (isRecord(profile)) {
    // Verified divergence: upstream parses an inline grok AgentDefinition
    // object (upload/turn.rs parse_agent_profile_from_meta ->
    // AgentDefinition::from_json). dsh has no AgentDefinition equivalent, so
    // reject explicitly instead of silently falling back to the default.
    throw invalidParams('_meta.agentProfile JSON definitions are not supported; send a preset id string')
  }
  // Mirrors the grok shell: non-string/non-object values are ignored
  // (upload/turn.rs parse_agent_profile_from_meta warn path).
  return undefined
}


interface PresetSession { clientId: number; agent: Agent; queue: { readonly busy: boolean } }
interface History { header: { agentPreset?: string }; events: readonly SessionEvent[] }
type Meta = Record<string, unknown> | null | undefined
type Preparation<S> = { kind: 'new'; meta?: Meta }
  | { kind: 'load'; meta?: Meta; source: History; live?: S }
  | { kind: 'fork'; source: History }
interface PresetHost<S extends PresetSession> {
  roster(): AgentPresetsLike | undefined
  settings(): Pick<SettingsLike, 'describe' | 'mutate'> | undefined
  owned(clientId: number, id: SessionId | undefined): S | undefined
  isLive(record: S): boolean
  flush(session: Agent['session']): Promise<unknown>
  /** Already-maintained state at the native Session cursor. */
  history(record: S): PresetHistory
  /** A preset change on this session ended, committed, rolled back or failed. */
  unblocked(record: S): void
}
interface State { closed: boolean; changing: boolean; inconsistent: boolean; pending: Set<Promise<unknown>>; disposal?: Promise<void> }
interface PreparedPreset<S> {
  agentPreset: string | undefined
  mount: ((ctx: Context) => Promise<void>) | undefined
  /** Commit only after native construction and permission validation succeed.
   * This one-shot operation may precede publication; retirement still drains it. */
  commit(record: S): Promise<void>
}
const lockedMessage = 'agent-preset-locked: a preset can only be changed before the session has produced history'
const busy = (record: PresetSession) => record.queue.busy || record.agent.status === 'running'

/** Owns preset selection, composition rollback, durable/default writes and
 * roster views. Dependencies are lazy native capabilities, never the host
 * context. A retiring session drains its accepted mutations before its native
 * Agent is released; neither a late lookup nor a second switch can revive it. */
export function createSessionPresets<S extends PresetSession>(host: PresetHost<S>) {
  const states = new WeakMap<S, State>(), pending = new Set<Promise<unknown>>()
  let closed = false, disposal: Promise<void> | undefined
  const stateOf = (record: S): State => {
    let state = states.get(record)
    if (state === undefined) { state = { closed: false, changing: false, inconsistent: false, pending: new Set() }; states.set(record, state) }
    return state
  }
  const assertOpen = () => { if (closed) throw internalError('session presets have been disposed') }
  const assertLive = (record: S) => {
    if (closed || stateOf(record).closed || !host.isLive(record)) throw invalidParams('session closed')
  }
  const assertReady = (record: S) => {
    assertLive(record)
    if (stateOf(record).inconsistent) throw internalError('agent preset composition is inconsistent; close and reload the session')
    if (stateOf(record).changing) throw invalidParams('agent-preset-locked: a preset change is in progress')
  }
  const run = <R>(operation: () => Promise<R>, record?: S): Promise<R> => {
    // Reserve before invoking native capabilities: they can synchronously close
    // the owner or dispose the plugin from a registration/event callback.
    const state = record === undefined ? undefined : stateOf(record)
    let resolve!: (value: R | PromiseLike<R>) => void, reject!: (reason: unknown) => void
    const work = new Promise<R>((yes, no) => { resolve = yes; reject = no })
    pending.add(work); state?.pending.add(work)
    const done = () => { pending.delete(work); state?.pending.delete(work) }
    void work.then(done, done)
    try { assertOpen(); if (state?.closed) throw invalidParams('session closed'); resolve(operation()) } catch (error) { reject(error) }
    return work
  }
  const change = <R>(record: S, operation: () => Promise<R>): Promise<R> => run(async () => {
    assertReady(record)
    const state = stateOf(record)
    state.changing = true
    try { return await operation() } finally {
      state.changing = false
      host.unblocked(record)
    }
  }, record)
  const drain = async (work: ReadonlySet<Promise<unknown>>) => {
    while (work.size > 0) await Promise.allSettled([...work])
  }
  const remember = async (preset: string): Promise<void> => {
    const service = host.settings()
    if (service === undefined) throw internalError('the settings service is not configured')
    const user = service.describe?.().find(entry => entry.ns === 'agent-preset-registry')?.user
    if (user !== null && typeof user === 'object' && (user as Record<string, unknown>).selectedDefault === preset) return
    try { await service.mutate('agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: preset }]) }
    catch (error) { throw internalError('failed to remember preset "' + preset + '": ' + errorMessage(error)) }
  }
  const resolveReal = async (roster: AgentPresetsLike | undefined, request: string) => {
    try { return (await roster?.resolve(request))?.id } catch { return undefined }
  }
  const compose = async (roster: AgentPresetsLike | undefined, request: string | undefined) => {
    if (roster === undefined) return { agentPreset: undefined, mount: undefined }
    let resolved: { id: string }
    try { resolved = await roster.resolve(request) } catch (error) {
      if (request === undefined || !GROK_PROFILE_FALLBACKS.has(request)) {
        throw invalidParams('unknown agent preset "' + String(request) + '": ' + errorMessage(error))
      }
      resolved = await roster.resolve(undefined)
    }
    return { agentPreset: resolved.id, mount: (ctx: Context) => run(async () => { await roster.mount(ctx, resolved.id); assertOpen() }) }
  }
  const current = (roster: AgentPresetsLike | undefined, record: S) => roster?.composedPreset?.(record.agent.ctx)
    ?? host.history(record).selected ?? undefined
  const swap = async (roster: AgentPresetsLike, record: S, target: string, previous: string | undefined) => {
    assertLive(record)
    if (busy(record) || host.history(record).locked) throw invalidParams(lockedMessage)
    await roster.recompose(record.agent.ctx, target)
    try {
      assertLive(record)
      if (busy(record) || host.history(record).locked) throw invalidParams(lockedMessage)
      record.agent.session.append('agent-preset/selected', { agentPreset: target })
      // Flush is part of the same commit as append: a durable-write failure
      // must restore the previous composition, like an append failure.
      await host.flush(record.agent.session)
    } catch (error) {
      if (previous !== undefined) {
        try { await roster.recompose(record.agent.ctx, previous) }
        catch (rollback) {
          stateOf(record).inconsistent = true
          throw new AggregateError([error, rollback], 'preset selection and composition rollback failed; close and reload the session')
        }
      } else stateOf(record).inconsistent = true
      throw error
    }
  }
  const prepare = async (request: Preparation<S>): Promise<PreparedPreset<S>> => {
    const roster = host.roster()
    const meta = request.kind === 'fork' ? undefined : request.meta
    const explicit = request.kind === 'fork' ? undefined : presetRequestFromMeta(meta)
    let explicitPreset: string | undefined, selected: string | undefined, appendOnCommit = false
    const live = request.kind === 'load' ? request.live : undefined
    if (request.kind === 'new') selected = explicit
    else {
      explicitPreset = explicit === undefined ? undefined : await resolveReal(roster, explicit)
      if (explicit !== undefined && explicitPreset === undefined && !GROK_PROFILE_FALLBACKS.has(explicit)) throw invalidParams('unknown agent preset "' + explicit + '"')
      if (live !== undefined) {
        assertLive(live)
        // Reselecting a live preset still reloads/disposes its agent.
        if (explicitPreset !== undefined && busy(live)) throw invalidParams('agent-preset-locked: cannot change preset while a turn is running')
      }
      const history = live === undefined ? presetHistory(request.source.header, request.source.events) : host.history(live)
      const previous = live === undefined ? history.selected ?? undefined : current(roster, live)
      const switching = explicitPreset !== undefined && explicitPreset !== previous
      if (switching && history.locked) throw invalidParams(lockedMessage)
      selected = explicitPreset ?? previous
      appendOnCommit = switching && live === undefined
    }
    const prepared = await compose(roster, selected)
    assertOpen()
    if (request.kind === 'new') explicitPreset = explicit !== undefined && prepared.agentPreset === explicit ? explicit : undefined
    if (live !== undefined) {
      assertLive(live)
      const previous = current(roster, live)
      if (explicitPreset !== undefined && explicitPreset !== previous) {
        if (roster === undefined) throw internalError('agent preset roster is not configured')
        await swap(roster, live, explicitPreset, previous)
      }
      assertLive(live)
      if (explicitPreset !== undefined && meta?.rememberAgentPreset === true) await remember(explicitPreset)
      assertLive(live)
    }
    let commit: Promise<void> | undefined, committedRecord: S | undefined
    return {
      ...prepared,
      commit(record) {
        if (commit !== undefined) return committedRecord === record ? commit : Promise.reject(internalError('preset preparation already committed to another session'))
        committedRecord = record
        // Defer to publish the one-shot promise before native append callbacks.
        return commit = run(async () => {
          await Promise.resolve()
          assertOpen()
          if (stateOf(record).closed) throw invalidParams('session closed')
          if (appendOnCommit && explicitPreset !== undefined) {
            record.agent.session.append('agent-preset/selected', { agentPreset: explicitPreset })
            await host.flush(record.agent.session)
          }
          if (live === undefined && explicitPreset !== undefined && meta?.rememberAgentPreset === true) {
            assertOpen()
            if (stateOf(record).closed) throw invalidParams('session closed')
            await remember(explicitPreset)
          }
        }, record)
      },
    }
  }
  const command = async (record: S, text: string): Promise<string> => {
    const roster = host.roster()
    if (roster === undefined) throw invalidParams('Preset management is unavailable in this session.')
    const requested = text.replace(/^\/preset\s*/, '').trim()
    if (requested.length === 0) {
      const presets = await roster.list()
      assertLive(record)
      return 'Usage: /preset <id>\nAvailable: ' + presets.map(preset => preset.id).join(', ')
    }
    if (/\s/.test(requested)) throw invalidParams('Usage: /preset <id>')
    const resolved = await resolveReal(roster, requested)
    assertLive(record)
    if (resolved === undefined) throw invalidParams('Unknown preset "' + requested + '".')
    const previous = current(roster, record)
    if (previous !== resolved) {
      if (busy(record) || host.history(record).locked) throw invalidParams(lockedMessage)
      // Reopening (session/load with the preset) recreates the agent; an
      // in-place recompose would leave Team tools missing or behind.
      for (const id of [resolved, previous]) {
        if (id === undefined || await roster.attachesOnOpen?.(id) !== true) continue
        assertLive(record)
        throw invalidParams('Preset "' + id + '" attaches Agent Team tools when a session opens, so it cannot be switched in place.'
          + ' Reopen this session with the preset you want (the TUI preset picker does this) or start a new session.')
      }
      assertLive(record)
      await swap(roster, record, resolved, previous)
    }
    assertLive(record)
    await remember(resolved)
    assertLive(record)
    return previous === resolved
      ? 'Preset "' + resolved + '" is active and is now the default for new sessions.'
      : 'Switched to preset "' + resolved + '" and made it the default for new sessions.'
  }
  /** The TUI displays one bundle persona per preset and sends the chosen id
   * back as _meta.agentProfile. Custom presets keep their authored display copy. */
  const status = async () => {
    const roster = host.roster(), presets = roster === undefined ? [] : await roster.list()
    assertOpen()
    const defaultPersona = roster === undefined ? undefined : (await roster.resolve(undefined)).id
    assertOpen()
    return {
      hasCache: presets.length > 0, personas: presets.map(preset => preset.id),
      ...defaultPersona === undefined ? {} : { defaultPersona }, roles: [], agents: [], skills: [],
      personaDetails: presets.map(preset => {
        const shipped = preset.name === undefined ? SHIPPED_PRESET_DISPLAY[preset.id] : undefined
        const description = shipped?.description ?? preset.description
        return { name: shipped?.name ?? preset.name ?? preset.id, ...description === undefined ? {} : { description }, hasInputs: false, hasOutputs: false }
      }), roleDetails: [],
    }
  }
  const controls = async (record: S, p: Record<string, unknown>) => {
    assertLive(record)
    const roster = host.roster()
    if (roster === undefined) throw invalidParams('Preset management is unavailable.')
    const presetId = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw invalidParams('Preset id must contain lowercase letters, digits or hyphens.')
      return value
    }
    const action = p.action ?? 'list'
    let document: { id: string; content: string; editPath?: string } | undefined
    if (action === 'copy') {
      if (roster.copy === undefined) throw invalidParams('Preset copying is unavailable.')
      await roster.copy(presetId(p.from), presetId(p.id))
    } else if (action === 'read' || action === 'edit') {
      if (roster.read === undefined) throw invalidParams('Preset reading is unavailable.')
      const preset = await roster.resolve(presetId(p.id))
      assertLive(record)
      if (action === 'edit' && (preset.trust !== 'user' || preset.path === undefined)) throw invalidParams('Copy this shipped preset before editing it.')
      document = { id: preset.id, content: await roster.read(preset.id), ...action === 'edit' ? { editPath: preset.path } : {} }
    } else if (action !== 'list') throw invalidParams('Unknown preset action: ' + String(action))
    assertLive(record)
    const presets = await roster.list()
    assertLive(record)
    return {
      title: 'Agent presets',
      items: presets.map(preset => ({ id: preset.id, text: [preset.name ?? preset.id, preset.description].filter(Boolean).join('\n'), detail: preset.id + ' · ' + (preset.trust ?? 'system'), editable: preset.trust === 'user' })),
      ...document === undefined ? {} : { document },
    }
  }
  return {
    prepare(request: Preparation<S>): Promise<PreparedPreset<S>> {
      return request.kind === 'load' && request.live !== undefined
        ? change(request.live, () => prepare(request)) : run(() => prepare(request))
    },
    command: (record: S, text: string) => change(record, () => command(record, text)),
    assertReady,
    status: () => run(status),
    controls(clientId: number, params: unknown) {
      return run(async () => {
        const p = paramRecord(params, 'x.ai/presets')
        const record = host.owned(clientId, sessionIdParam(p.sessionId))
        if (record === undefined) throw invalidParams('presets requires an owned sessionId')
        return run(() => controls(record, p), record)
      })
    },
    retire(record: S): Promise<void> {
      const state = stateOf(record)
      state.closed = true
      return state.disposal ??= Promise.resolve().then(() => drain(state.pending))
    },
    dispose(): Promise<void> {
      closed = true
      return disposal ??= Promise.resolve().then(() => drain(pending))
    },
  }
}
