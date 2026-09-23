import { createNativeCapabilities, type NativeToolSchemas } from './native-capabilities.ts'
import { listMcpServers } from './mcp.ts'
import { createLeaderLifecycle } from './leader-lifecycle.ts'
import { createNativeAsides, type NativeAsideRuntime } from './native-asides.ts'
import { createSessionInput } from './session-input.ts'
import { createSessionArtifacts, type NativeSessionTitles, type NativeSessionReferences } from './session-artifacts.ts'
import { createNativeExecution, type NativeExecutionHost, type NativeTerminals } from './native-execution.ts'
import { createSessionCommands, type NativeCommands, type NativeSkills } from './session-commands.ts'
import { createSessionDiscovery, type SessionProjectionCacheLike, type SessionQueryLike } from './session-discovery.ts'
import { createNativeInteractions } from './native-interactions.ts'
import { createSessionLifecycle, type SessionRecord } from './session-lifecycle.ts'
import { createPresetCatalog } from './preset-catalog.ts'
import { createSessionPresets, type AgentPresetsLike } from './session-presets.ts'
import { presetHistoryProjection } from './preset-history.ts'
import { workflowProjection } from './workflows.ts'
import { createSessionModels } from './session-models.ts'
// Keep durable event augmentations reachable through the published type entry.
export type {} from './session-models.ts'
export type {} from './preset-history.ts'
export type {} from './workflows.ts'
import { createNativeSessionStatus, type NativeStatusProjections, type NativeGoalAuthority } from './native-session-status.ts'
import { createNativeChildren } from './native-children.ts'
import { createNativeTasks } from './native-tasks.ts'
import { createSessionRegistry } from './session-registry.ts'
import { PACKAGE_VERSION } from './package-location.ts'
import { createProfilePlugins, inspectPluginRuntime } from './profile-plugins.ts'
export { analyzeBundlePatch, parseCommandLine, inspectPluginRuntime, type BundlePatchAnalysis } from './profile-plugins.ts'
import { protectTerminalSignals } from './terminal-signal.ts'
import { JSONRPC_METHOD_NOT_FOUND, internalError, paramRecord } from './acp.ts'
import { createModelCatalog } from './model-catalog.ts'
import type { LlmLike, SettingsLike, CredentialsLike, AgentDefaultModelLike } from './native-seams.ts'
export { providerUserSection, providerUserProfile, hasUserProviderRoute, knownRouteBaseUrls } from './provider-profile.ts'
/**
 * Grok leader-protocol unix-socket server driving harness agents.
 *
 * Outer envelope: grok leader framing (codec.ts / protocol.ts), verified
 * against the real TUI capture in tests/fixtures/grok-tui-messages.jsonl and
 * the contract in docs/grok-leader-protocol.md. Inner dialect:
 * ACP JSON-RPC strings mapped onto the harness services the ACP bridge drives
 * (agents.create/resume, agent.followup / whenIdle / cancel, session/event,
 * approval/request, sessions.flush, llm.listProviders/listModels,
 * sessionPersistence.list/open, agentDefaultModel.saveSelection). Divergences
 * from upstream grok behavior are marked at the code site with the grok
 * file:line they were verified against.
 * @module dscode
 */

import { statSync } from 'node:fs'
import { createLeaderTransport } from './leader-transport.ts'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installLegacySessionMigration } from './session-migration.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {
  type AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-app-boot'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RpcError } from './protocol.ts'
import { jobOutputSnapshot } from './job-output.ts'
import { createImageOutputProjector } from './image-output.ts'
import { exportSessionArchive } from './session-export.ts'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { acpPromptToText, cacheHitPercent, decodeTokensPerSecond, emptyDecodeSpeed, noteDecodeSpeed, promptHasUnsupportedContent, sessionEventToUpdates, toolKindForName, turnEndToStopReason, type DecodeSpeed, type GrokSessionUpdate, type ProjectedUpdate, type StopReasonWire, type ToolKindWire } from './projection.ts'

export { acpPromptToText, cacheHitPercent, decodeTokensPerSecond, emptyDecodeSpeed, noteDecodeSpeed, promptHasUnsupportedContent, sessionEventToUpdates, toolKindForName, turnEndToStopReason }
export type { DecodeSpeed, GrokSessionUpdate, ProjectedUpdate, StopReasonWire, ToolKindWire }
export type { ToolResultContentBlock } from './projection.ts'

export const name = 'grok-leader'
/** Agents, maintained policy state and durable discovery must exist before accepting clients. */
export const inject = ['agents', 'sessionPersistence', 'sessionProjections', 'attachments']

/** Plugin config: socket path and the provider/model selection used for created agents. */
export interface GrokLeaderConfig {
  /** Unix socket path the grok clients connect to. */
  socketPath?: string
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Fold 2+ plain queued prompts into one turn (grok ui.combine_queued_prompts). */
  combineQueuedPrompts?: boolean
  /** What a prompt sent while a turn is running does (grok ui.follow_up_behavior):
   *  'queue' (the default, grok parity) parks it until the turn ends — a queued
   *  row's Enter is Send Now, which cancels the running turn and runs the row
   *  next; 'steer' folds it into the running turn at the harness's next step
   *  boundary without interrupting (Codex-style steering). */
  followUpBehavior?: 'queue' | 'steer'
  /** Grace before the host exits after the last client disconnects (ms). */
  idleExitMs?: number
}

export const Config: Schema<GrokLeaderConfig> = Schema.object({
  // Deliberate deviation from the harness config convention (defaults on
  // schema fields): provider/model/followUpBehavior resolve as
  // `config value ?? env ?? fallback` in apply(), which requires ABSENCE to
  // be observable — a schema default would fill the slot before the env
  // layer could speak.
  socketPath: Schema.string().default('/tmp/dsh-grok-leader.sock'),
  provider: Schema.string(),
  model: Schema.string(),
  combineQueuedPrompts: Schema.boolean(),
  followUpBehavior: Schema.union(['queue', 'steer'] as const),
  idleExitMs: Schema.number().default(2000),
})

/** Wire method names of the embedded ACP dialect (agent-client-protocol 0.10.4). */
const WIRE = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionLoad: 'session/load',
  sessionList: 'session/list',
  sessionSetModel: 'session/set_model',
  sessionSetMode: 'session/set_mode',
  sessionClose: 'session/close',
  sessionUpdate: 'session/update',
  modelsList: 'x.ai/models/list',
  modelsUpdate: 'x.ai/models/update',
  sessionsList: 'x.ai/sessions/list',
  providersAdd: 'x.ai/providers/add',
  providersUpdate: 'x.ai/providers/update',
  providersRemove: 'x.ai/providers/remove',
} as const

/** Structural read of the session store: this bridge needs only one flush entry point. */
interface SessionsLike {
  flush(session: object): Promise<unknown>
}

/**
 * Mount the grok leader server.
 * @param ctx - Cordis context carrying the agent factory and harness services.
 * @param config - socket path and initial provider/model selection.
 */
export function apply(ctx: Context, config: GrokLeaderConfig): void {
  const agents = ctx.agents
  ctx.sessionProjections.register(presetHistoryProjection)
  ctx.sessionProjections.register(workflowProjection)
  protectTerminalSignals(ctx)
  const jobOutput = jobOutputSnapshot
  const projectImages = createImageOutputProjector(ctx)
  ctx.effect(() => installLegacySessionMigration(ctx.get('sessionPersistence')))
  const logger = ctx.logger
  // Build provenance banner: three caches can pin stale bridge code (the
  // profile's node_modules copy, a live leader process, a stale lib build),
  // and "which build is actually serving" has been unanswerable from logs.
  // The loaded file's own mtime IS its build time; stderr reaches the
  // launcher's leader log unconditionally.
  try {
    const self = fileURLToPath(import.meta.url)
    process.stderr.write('grok-leader: loaded ' + self + ' (built ' + statSync(self).mtime.toISOString() + ')\n')
  } catch { /* provenance only; never block mounting */ }
  // Read lazily like the other optional services: the settings provider
  // (dsh-settings-file) publishes asynchronously after apply.
  const settings = (): SettingsLike | undefined => ctx.get('settings') as SettingsLike | undefined
  // Read lazily so teardown cannot retain a stale service instance. Static
  // injection above prevents the socket from opening before persistence mounts.
  const persistence = () => ctx.get('sessionPersistence')
  // Read lazily too: agent-default-model depends on the settings provider and
  // can mount after apply, so an eager capture would make session/set_model
  // silently skip saveSelection (and /effort would not persist).
  const agentDefaultModel = (): AgentDefaultModelLike | undefined => ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  /** Read the preset roster on demand: it mounts asynchronously after apply. */
  const agentPresets = createPresetCatalog(ctx)
  const registry = createSessionRegistry<SessionRecord>({
    clientIsLive: id => connections.get(id)?.closed === false,
    flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
    cancelRequests: (clientId, sessionId) => interactions.cancel(clientId, sessionId),
    logger,
  })
  const sessions = registry.records
  const sessionPresets = createSessionPresets<SessionRecord>({
    roster: agentPresets, settings, owned: registry.owned,
    isLive: record => !registry.closed && registry.ownedAgent(record.agent) === record,
    flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
    history: record => {
      const state = ctx.sessionProjections.stateOf(record.agent.session, 'dscodePresetHistory')
      if (state === undefined) throw internalError('preset history projection is unavailable')
      return state
    },
  })
  const transport = createLeaderTransport({
    socketPath: config.socketPath ?? '/tmp/dsh-grok-leader.sock',
    version: PACKAGE_VERSION,
    async request(clientId, method, params) {
      try { return await dispatchRequest(clientId, method, params) }
      catch (error) { throw error instanceof RpcError ? error : internalError(errorChain(error)) }
    },
    notification: (clientId, method, params) => { handleNotification(clientId, method, params) },
    registered: () => { leaderHost.registered() },
    disconnected: clientId => { leaderHost.disconnected(clientId) },
    failed: error => { leaderHost.failed(error) },
    logger,
  })
  const connections = transport.clients
  const models = createModelCatalog({
    config,
    llm: () => ctx.get('llm') as LlmLike | undefined,
    settings,
    getCredentials: () => ctx.get('credentials') as CredentialsLike | undefined,
    getDefaultModel: agentDefaultModel,
    isProviderInUse: id => sessionModels.isProviderInUse(id),
    onChanged: (current, reason) => sessionModels.changed(current, reason),
    logger,
  })
  // The settings service announces recomposed namespaces and profile reloads;
  // the catalog keeps its provider-section snapshot until one of them lands.
  ctx.on('settings/document-updated', ns => { models.settingsChanged(ns) })
  ctx.on('app-boot/config-reload', () => { models.settingsChanged() })
  const sessionModels = createSessionModels({
    sessions, owned: (clientId, id) => lifecycle.writable(clientId, id), config, catalog: models, defaults: agentDefaultModel,
    clients: () => connections.keys(),
    notify: (clientId, method, params) => connections.get(clientId)?.notify(method, params),
    flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
  })
  // grok's ui.combine_queued_prompts (default off); env override for dev shells.
  const combineQueued = config.combineQueuedPrompts === true || process.env.DSCODE_COMBINE_QUEUED === '1'
  // Explicit config wins; the env override serves dev shells; the default is
  // queue (grok parity). 'steer' folds follow-ups into the running turn.
  const followUpSteer = (config.followUpBehavior ?? process.env.DSCODE_FOLLOW_UP ?? 'queue') === 'steer'
  const interactions = createNativeInteractions<SessionRecord>({
    owned: registry.owned, ownedAgent: registry.ownedAgent,
    assertReady: record => lifecycle.assertReady(record),
    client: id => connections.get(id),
    permissionPresets: () => ctx.get('permissionPresets') as { set(session: Agent['session'], preset: string): void } | undefined,
    planMode: record => presetServiceFor(record, 'planMode') as { set(agent: Agent, active: boolean): unknown } | undefined,
    on: (name, listener) => ctx.on(name as never, listener as never), logger,
  })
  const discovery = createSessionDiscovery({
    persistence, query: () => ctx.get('sessionQuery') as SessionQueryLike | undefined,
    projectionCache: () => ctx.get('sessionProjectionCache') as SessionProjectionCacheLike | undefined,
    log: message => logger.warn(message),
    owns: session => sessions.get(session.header.id)?.agent.session === session,
    onEvent: listener => ctx.on('session/event', listener),
    onCreated: listener => ctx.on('session/created', listener),
  })
  const lifecycle = createSessionLifecycle({
    agents, registry, models: sessionModels, presets: sessionPresets, persistence, discovery,
    flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
    client: id => connections.get(id),
    queue: { combineQueued, followUpSteer },
    permissions: interactions,
    contextValues: record => nativeStatus.contextValues(record), projectImages, logger,
    views: {
      status: (record, replay) => nativeStatus.snapshot(record, replay),
      children: (record, replay) => children.snapshot(record, replay),
      tasks: record => tasks.snapshot(record),
      commands: record => { void sessionCommands.refresh(record) },
    },
  })
  // The one-time COMPAT SHIM (/dsh login + /dsh code for the pre-registry
  // subscriptions plugin) is RETIRED: @hqzhao95/dsh-subscriptions-commands
  // registers /login, /logout, /code, /subscriptions-status through the dsh
  // command registry, so they auto-surface as slash commands with zero
  // bridge involvement. The bridge carries no plugin-specific code.

  const ownedAgentRecord = registry.ownedAgent
  const ownedRecord = registry.owned

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    ownedAgentRecord(agent)?.output.assistant(frame)
  })

  // Translate the session firehose into grok streaming deltas. Committed text,
  // reasoning deltas, tool calls, tool results, and Todo plans stream; titles
  // and retry markers are presentation or trace data and stay off this path.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    nativeStatus.refresh(record)
    tasks.observe(record, event)
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    try {
      record.output.live(event)
    } finally {
      record.queue.observe(event)
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedAgentRecord(agent)?.queue.claimed(message.id, turn)
  })
  ctx.on('agent/error', ({ agent, turn, error }) => {
    ownedAgentRecord(agent)?.queue.failed(turn, error)
  })

  const initializeResponse = async (): Promise<unknown> => {
    const current = await models.initialize()
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: false },
        mcpCapabilities: { http: true },
        sessionCapabilities: { list: {}, close: {} },
      },
      // Advertise the api-key method so the pager's fail-closed empty-list
      // auth gate treats the leader as authenticated; the harness providers
      // own credentials, so the bridge answers authenticate with no meta.
      authMethods: [{ id: 'xai.api_key', name: 'API key' }],
      agentInfo: { name: 'deepseek-harness-grok-leader', version: PACKAGE_VERSION },
      // cancelRewind is false: the bridge cancels turns but does not implement
      // the client-side rewind composer restore, so it stays unadvertised.
      // modelState flattens provider-scoped dsh model ids into one global
      // catalog of modelId strings (agent.rs SessionModelState); the
      // leader-side routesByModel map keeps provider ownership for
      // session/set_model.
      _meta: {
        grokShell: true,
        cancelRewind: false,
        sessionRecap: false,
        availableCommands: (await sessionCommands.catalog()).commands,
        modelState: {
          currentModelId: current.currentModelId,
          availableModels: current.availableModels,
          // SessionModelState carries only currentModelId/availableModels; the
          // provider roster and current-provider id ride in modelState._meta
          // (the ACP extension point the pager reads back as ModelState meta).
          _meta: {
            currentProviderId: current.currentProviderId,
            providers: current.providers,
          },
        },
      },
    }
  }

  const presetServiceFor = (record: SessionRecord, name: string): unknown =>
    agentPresets()?.serviceFor?.(record.agent, name)
      ?? record.agent.ctx.get(name)
      ?? ctx.get(name)

  const nativeCapabilities = createNativeCapabilities<SessionRecord>({
    tools: record => record.agent.ctx.get('tools') as NativeToolSchemas | undefined,
    hasService: (record, name) => presetServiceFor(record, name) !== undefined,
  })

  /** The dsh plugin command registry, when the composition mounts it. */
  const dshCommands = (): NativeCommands | undefined => ctx.get('commands') as NativeCommands | undefined

  const profilePlugins = createProfilePlugins({
    inspectRuntime: name => inspectPluginRuntime(ctx, name),
    installAnchor: () => (ctx.get('profileContext') as { installAnchor?: string } | undefined)?.installAnchor,
  })
  const sessionCommands = createSessionCommands<SessionRecord>({
    sessions, owned: ownedRecord, client: id => connections.get(id),
    registry: dshCommands, roster: agentPresets,
    skills: record => presetServiceFor(record, 'skills') as NativeSkills | undefined,
    capabilities: nativeCapabilities.capabilities, profile: profilePlugins, preset: sessionPresets.command,
    children: { command: (clientId, params) => children.command(clientId, params) },
    goals: { goal: (clientId, params) => nativeStatus.goal(clientId, params) },
    on: (name, listener) => ctx.on(name as never, listener as never), logger,
  })

  const input = createSessionInput<SessionRecord>({
    owned: ownedRecord, assertReady: lifecycle.assertReady,
    commands: sessionCommands, models,
    attachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    notify: (record, method, params) => connections.get(record.clientId)?.notify(method, params),
    cancelHuman: interactions.cancel,
    goal: { pauseGoal: record => nativeStatus.pauseGoal(record), refresh: record => nativeStatus.refresh(record) },
  })

  const execution = createNativeExecution<SessionRecord>({
    owned: ownedRecord, profileDirectory: profilePlugins.directory,
    inspector: () => ctx.get('dscodeInspector') as { url: string; captureFetch: boolean } | undefined,
    terminals: record => presetServiceFor(record, 'terminals') as NativeTerminals | undefined,
    subprocess: record => presetServiceFor(record, 'subprocess') as NativeExecutionHost | undefined,
    toolNames: nativeCapabilities.toolNames,
  })

  const asides = createNativeAsides<SessionRecord>({
    owned: ownedRecord, canDelegate: record => nativeCapabilities.capabilities(record).includes('subagents'),
    subagents: record => presetServiceFor(record, 'subagents') as NativeAsideRuntime | undefined,
  })

  const artifacts = createSessionArtifacts<SessionRecord>({
    owned: ownedRecord, client: id => connections.get(id),
    titles: () => ctx.get('sessionTitle') as NativeSessionTitles | undefined,
    references: () => ctx.get('sessionReferenceResolver') as NativeSessionReferences | undefined,
    archive: (id, cwd, filename, signal) => exportSessionArchive(ctx, id, cwd, filename, signal),
  })

  const dispatchRequest = async (clientId: number, method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'x.ai/session/export':
        return await artifacts.archive(clientId, params)
      case 'x.ai/session/references':
        return await artifacts.references(clientId, params)
      case 'x.ai/goal':
        return await nativeStatus.goal(clientId, params)
      case 'x.ai/task/output':
        return tasks.output(clientId, params)
      case 'x.ai/task/kill':
        return await tasks.kill(clientId, params)
      case 'x.ai/subagent/history':
        return await children.history(clientId, params)
      case 'x.ai/subagent/cancel':
        return await children.cancel(clientId, params)
      case 'x.ai/subagent/inbox':
        return await children.inbox(clientId, params)
      case 'x.ai/scheduler/list':
      case 'x.ai/scheduler/create':
      case 'x.ai/scheduler/delete':
        return await tasks.reminders(clientId, method, params)
      case 'x.ai/subagents':
        return await children.command(clientId, params)
      case WIRE.initialize:
        return await initializeResponse()
      case WIRE.authenticate:
        return {}
      case WIRE.sessionNew:
        return await lifecycle.new(clientId, params)
      case WIRE.sessionPrompt:
        return await input.prompt(clientId, params)
      case 'x.ai/session/cancel_prompt':
        return input.cancelPrompt(clientId, params)
      case WIRE.sessionLoad:
        return await lifecycle.load(clientId, params)
      case WIRE.sessionList:
        return await discovery.list(WIRE.sessionList)
      case WIRE.sessionSetModel:
        return await sessionModels.set(clientId, params)
      case WIRE.sessionSetMode:
        return await interactions.mode(clientId, params)
      case 'x.ai/session/fork':
        return await lifecycle.fork(clientId, params)
      case 'x.ai/rewind/points':
        return await lifecycle.points(clientId, params)
      case 'x.ai/rewind/execute':
        return await lifecycle.rewind(clientId, params)
      case 'x.ai/session/rename':
        return await artifacts.rename(clientId, params)
      case WIRE.sessionClose:
        return await lifecycle.close(clientId, params)
      case WIRE.modelsList:
        return await models.list()
      case WIRE.providersAdd:
        return await models.add(params)
      case WIRE.providersUpdate:
        return await models.update(params)
      case WIRE.providersRemove:
        return await models.remove(params)
      case 'x.ai/btw':
        return await asides.btw(clientId, params)
      case 'x.ai/interject':
        return input.interject(clientId, params)
      case 'x.ai/commands/list':
        return await sessionCommands.catalog(clientId, params)
      case 'x.ai/prompt_history':
        return lifecycle.history(clientId, params)
      case 'x.ai/marketplace/list':
        return { sources: [] }
      // The extension modal always offers these tabs; an unimplemented method
      // renders as "couldn't load hooks/plugins: method not found". No config
      // is loaded in the dsh-backed leader, so answer with the empty shape.
      case 'x.ai/hooks/list':
        return { hooks: [], projectTrusted: false, loadErrors: [] }
      case 'x.ai/plugins/list':
        return { plugins: [] }
      case 'x.ai/doctor':
        return await execution.doctor(clientId, params)
      case 'x.ai/terminals':
        return await execution.terminals(clientId, params)
      case 'x.ai/presets':
        return await sessionPresets.controls(clientId, params)
      case 'x.ai/skills/list':
        return await sessionCommands.skills(clientId, params)
      case 'x.ai/mcp/list': {
        const p = paramRecord(params, 'x.ai/mcp/list')
        const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
        const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
        return await listMcpServers(ctx, record?.agent)
      }
      case 'x.ai/workflows/list':
        // Legacy template catalog. Native run history is pushed via workflow_updated.
        return { workflows: [] }
      case 'x.ai/billing':
        return { config: null, onDemandEnabled: false, subscriptionTier: null }
      case 'x.ai/bundle/status':
        return await sessionPresets.status()
      case 'x.ai/suggestPrompt':
        return { suggestion: null, generation: (params as { generation?: number } | undefined)?.generation ?? 0 }
      case 'x.ai/session/info':
        return artifacts.info(clientId, params)
      case 'x.ai/session/search':
        return await discovery.search(params)
      case 'x.ai/session/list':
      case 'x.ai/sessions/list':
        return await discovery.list(method, params)
      default:
        throw new RpcError(JSONRPC_METHOD_NOT_FOUND, 'method not found: ' + method)
    }
  }

  const handleNotification = (clientId: number, method: string, params: unknown): void => {
    switch (method) {
      case 'x.ai/yolo_mode_changed':
        interactions.notification(clientId, params)
        return
      case WIRE.sessionCancel:
        input.cancel(clientId, params)
        return
      case 'x.ai/queue/interject':
      case 'x.ai/queue/steer':
      case 'x.ai/queue/remove':
      case 'x.ai/queue/edit':
      case 'x.ai/queue/hold_edit':
      case 'x.ai/queue/release_edit':
      case 'x.ai/queue/reorder':
      case 'x.ai/queue/clear':
        input.control(clientId, method, params)
        return
      default:
        // Grok drops unknown ACP notifications (server.rs:1515).
        logger.warn('grok-leader: dropped notification ' + method)
    }
  }

  const tasks = createNativeTasks({
    sessions, owned: ownedRecord,
    discovery, flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
    jobs: record => presetServiceFor(record, 'jobs'),
    tools: record => {
      const runtime = record.agent.ctx.get('tools') as ToolRuntime | undefined
      return runtime === undefined ? undefined : { runtime, names: nativeCapabilities.toolNames(record) }
    },
    output: jobOutput, logger,
  })
  const children = createNativeChildren({
    sessions, owned: ownedRecord, agent: id => agents.get(id),
    subagents: record => presetServiceFor(record, 'subagents'),
    workflow: record => {
      const state = ctx.sessionProjections.stateOf(record.agent.session, 'dscodeWorkflows')
      if (state === undefined) throw internalError('workflow history projection is unavailable')
      return state
    },
    persistence, flush: async session => (ctx.get('sessions') as SessionsLike | undefined)?.flush(session),
    projectImages,
    notify: (record, method, params) => connections.get(record.clientId)?.notify(method, params),
    on: (name, listener) => ctx.on(name as never, listener as never),
    logger,
  })

  const nativeStatus = createNativeSessionStatus({
    sessions,
    owned: (clientId, id) => {
      const record = ownedRecord(clientId, id)
      if (record !== undefined) lifecycle.assertReady(record)
      return record
    },
    goals: record => presetServiceFor(record, 'goals') as NativeGoalAuthority | undefined,
    commands: dshCommands,
    projections: () => ctx.get('sessionProjections') as NativeStatusProjections | undefined,
    on: (name, listener) => ctx.on(name as never, listener as never),
  })

  const leaderHost = createLeaderLifecycle({
    sessions: registry, catalog: models, transport,
    owners: [discovery, sessionCommands, execution, asides, artifacts, input, interactions,
      sessionPresets, sessionModels, profilePlugins, children, nativeStatus, tasks],
    pollers: [tasks, children, nativeStatus], idleExitMs: config.idleExitMs,
    appExit: () => ctx.get('appExit') as ((code: number) => void) | undefined, logger,
  })
  // Register cleanup before listen can fail synchronously.
  ctx.effect(() => () => leaderHost.dispose(), 'grok-leader.socket')
  leaderHost.start()
}
