import { createNativeCapabilities } from './native-capabilities.ts'
import { listMcpServers } from './mcp.ts'
import { createLeaderLifecycle } from './leader-lifecycle.ts'
import { createNativeAsides } from './native-asides.ts'
import { createSessionInput } from './session-input.ts'
import { createSessionArtifacts } from './session-artifacts.ts'
import { createNativeExecution } from './native-execution.ts'
import { createSessionCommands } from './session-commands.ts'
import { createSessionDiscovery } from './session-discovery.ts'
import { createNativeInteractions } from './native-interactions.ts'
import { createSessionLifecycle, type SessionRecord } from './session-lifecycle.ts'
import { createPresetCatalog } from './preset-catalog.ts'
import { createSessionPresets } from './session-presets.ts'
import { presetHistoryProjection } from './preset-history.ts'
import { workflowProjection } from './workflows.ts'
import { legacyRemindersProjection } from './legacy-reminders.ts'
import { createSessionController, provideSessionController } from './session-controller.ts'
import { createSessionModels } from './session-models.ts'
// Keep durable event augmentations reachable through the published type entry.
export type {} from './session-models.ts'
export type {} from './preset-history.ts'
export type {} from './workflows.ts'
export type {} from './legacy-reminders.ts'
import { createNativeSessionStatus } from './native-session-status.ts'
import { createNativeChildren } from './native-children.ts'
import { createNativeTasks } from './native-tasks.ts'
import { createSessionRegistry } from './session-registry.ts'
import { PACKAGE_VERSION } from './package-location.ts'
import { createProfilePlugins, inspectPluginRuntime } from './profile-plugins.ts'
export { analyzeBundlePatch } from './profile-plugins.ts'
import { protectTerminalSignals } from './terminal-signal.ts'
import { internalError, paramRecord, sessionIdParam } from './acp.ts'
import { errorMessage } from './guards.ts'
import { createModelCatalog } from './model-catalog.ts'
import { createNativeProviders } from './native-provider.ts'
import { createPluginRows } from './plugin-rows.ts'
import { createPluginStatus } from './plugin-status.ts'
import { createBrowserControl } from './browser-control.ts'
import { createNativeTeam } from './native-team.ts'
import { TEAM_TOOLS_MODULE } from './team-presets.ts'
import { configuredRemote, executionWorld, remoteUnavailable, SSH_FAILURE, type RemoteConnection, type RemoteLike } from './execution-world.ts'
import { createHostServices } from './host-services.ts'
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
import { homedir } from 'node:os'
import { createLeaderTransport } from './leader-transport.ts'
import { WIRE, createLeaderRoutes, initializeReply, registerFixedReplies, type RequestRoute } from './leader-routes.ts'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installLegacySessionMigration } from './session-migration.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-settings'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RpcError } from './protocol.ts'
import { jobOutputSnapshot } from './job-output.ts'
import { createImageOutputProjector } from './image-output.ts'
import { exportSessionArchive } from './session-export.ts'

export { cacheHitPercent, decodeTokensPerSecond, emptyDecodeSpeed, sessionEventToUpdates, type GrokSessionUpdate, type ToolResultContentBlock } from './projection.ts'

export const name = 'grok-leader'
/** Agents, maintained policy state and durable discovery must exist before accepting clients. */
export const inject = ['agents', 'sessionPersistence', 'sessionProjections', 'attachments']

/** Leader socket when the config names none. */
const DEFAULT_SOCKET_PATH = '/tmp/dsh-grok-leader.sock'

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
  socketPath: Schema.string().default(DEFAULT_SOCKET_PATH),
  provider: Schema.string(),
  model: Schema.string(),
  combineQueuedPrompts: Schema.boolean(),
  followUpBehavior: Schema.union(['queue', 'steer'] as const),
  idleExitMs: Schema.number().default(2000),
})

/**
 * Mount the grok leader server.
 * @param ctx - Cordis context carrying the agent factory and harness services.
 * @param config - socket path and initial provider/model selection.
 */
export function apply(ctx: Context, config: GrokLeaderConfig): void {
  const agents = ctx.agents
  ctx.sessionProjections.register(presetHistoryProjection)
  ctx.sessionProjections.register(workflowProjection)
  ctx.sessionProjections.register(legacyRemindersProjection)
  protectTerminalSignals(ctx)
  const jobOutput = jobOutputSnapshot
  const projectImages = createImageOutputProjector(ctx)
  // Every optional host service is read at call time through this one seam.
  const host = createHostServices(ctx, { roster: () => agentPresets() })
  ctx.effect(() => installLegacySessionMigration(host.persistence()))
  const logger = ctx.logger
  // The configured SSH row decides the world, connected or not.
  const remote = (): RemoteLike | undefined => configuredRemote(host.configEditor()?.entries() ?? [])
  const world = () => executionWorld(remote())
  const sshState = (): RemoteConnection => {
    const ssh = host.ssh()
    if (ssh === undefined) {
      const failure = (globalThis as Record<symbol, unknown>)[SSH_FAILURE]
      return { state: 'failed', ...typeof failure === 'string' ? { reason: failure } : {} }
    }
    return ssh.failure instanceof Error ? { state: 'lost', reason: ssh.failure.message } : { state: 'connected' }
  }
  const remoteProblem = () => remoteUnavailable(remote(), sshState())
  // Build provenance banner: three caches can pin stale bridge code (the
  // profile's node_modules copy, a live leader process, a stale lib build),
  // and "which build is actually serving" has been unanswerable from logs.
  // The loaded file's own mtime IS its build time; stderr reaches the
  // launcher's leader log unconditionally.
  try {
    const self = fileURLToPath(import.meta.url)
    process.stderr.write('grok-leader: loaded ' + self + ' (built ' + statSync(self).mtime.toISOString() + ')\n')
  } catch { /* provenance only; never block mounting */ }
  /** Read the preset roster on demand: it mounts asynchronously after apply. */
  const agentPresets = createPresetCatalog(ctx)
  const registry = createSessionRegistry<SessionRecord>({
    clientIsLive: id => connections.get(id)?.closed === false,
    flush: host.flush,
    cancelRequests: (clientId, sessionId) => interactions.cancel(clientId, sessionId),
    unblocked: record => { sessionController.deliverable(record) },
    logger,
  })
  const sessions = registry.records
  const sessionPresets = createSessionPresets<SessionRecord>({
    roster: agentPresets, settings: host.settings, owned: registry.owned,
    isLive: record => !registry.closed && registry.ownedAgent(record.agent) === record,
    flush: host.flush,
    history: record => {
      const state = ctx.sessionProjections.stateOf(record.agent.session, 'dscodePresetHistory')
      if (state === undefined) throw internalError('preset history projection is unavailable')
      return state
    },
    unblocked: record => { sessionController.deliverable(record) },
  })
  const transport = createLeaderTransport({
    socketPath: config.socketPath ?? DEFAULT_SOCKET_PATH,
    version: PACKAGE_VERSION,
    async request(clientId, method, params) {
      try { return await routes.request(clientId, method, params) }
      catch (error) { throw error instanceof RpcError ? error : internalError(errorChain(error)) }
    },
    notification: (clientId, method, params) => { routes.notification(clientId, method, params) },
    registered: () => { leaderHost.registered() },
    disconnected: clientId => { leaderHost.disconnected(clientId) },
    failed: error => { leaderHost.failed(error) },
    logger,
  })
  const connections = transport.clients
  // Shipped-disabled rows (native DeepSeek adapter, browser) toggle through the
  // plugin manager and are applied to the live Loader without hmr.
  const pluginRows = createPluginRows({
    pluginManager: host.pluginManager,
    reload: async requiredIds => {
      const profile = host.profileContext()
      if (profile === undefined) throw new Error('no profile context: restart dscode to apply the change')
      await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh', requiredIds)
    },
  })
  // Plugin health: bundles this start skipped (told once to the next opened
  // session), and rows that did not activate (for /doctor).
  const pluginStatus = createPluginStatus({ manager: host.pluginManager, loader: host.loader, profile: host.profileContext, logger })
  const models = createModelCatalog({
    config,
    llm: host.llm,
    settings: host.settings,
    getCredentials: host.credentials,
    native: createNativeProviders({
      rows: pluginRows,
      credentials: host.credentials,
      settings: host.settings,
    }),
    getDefaultModel: host.agentDefaultModel,
    isProviderInUse: id => sessionModels.isProviderInUse(id),
    onChanged: (current, reason) => sessionModels.changed(current, reason),
    logger,
  })
  // The settings service announces recomposed namespaces and profile reloads;
  // the catalog keeps its provider-section snapshot until one of them lands.
  // Those, the llm adapter topology and the credential seam (dsh-credentials,
  // not a bridge dependency) are the sources DSH's model picker reloads on:
  // each schedules one debounced rebuild, published to clients if it changed.
  ctx.on('settings/document-updated', ns => { models.settingsChanged(ns) })
  ctx.on('app-boot/config-reload', () => { models.settingsChanged() })
  ctx.on('llm/adapters-updated', () => { models.sourcesChanged() })
  for (const event of ['credentials/reference-updated', 'credentials/record-updated']) {
    ctx.on(event as never, (() => { models.sourcesChanged() }) as never)
  }
  const sessionModels = createSessionModels({
    sessions, owned: (clientId, id) => lifecycle.writable(clientId, id), config, catalog: models, defaults: host.agentDefaultModel,
    clients: () => connections.keys(),
    notify: (clientId, method, params) => connections.get(clientId)?.notify(method, params),
    flush: host.flush,
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
    permissionPresets: host.permissionPresets,
    planMode: record => host.presetService(record.agent, 'planMode'),
    on: (name, listener, options) => ctx.on(name as never, listener as never, options), logger,
    // Wired before `input` exists; approvals only arrive once sessions do.
    rejectionFeedback: (record, text): Promise<unknown> | undefined => input.rejectionFeedback(record, text),
  })
  // DSH's Host Schedule service delivers reminders through `sessionController`,
  // which only the Web app provides. dscode delivers into a session a TUI has
  // open and ready here; the registry, presets and lifecycle report each session
  // that becomes ready, and a reminder that fell due meanwhile is retried then.
  const sessionReady = (record: SessionRecord): boolean => {
    if (!registry.acceptsInput(record) || connections.get(record.clientId)?.closed !== false || agents.get(record.agent.id) !== record.agent) return false
    try { lifecycle.assertReady(record); return true } catch { return false }
  }
  const sessionController = createSessionController<SessionRecord>({
    record: id => sessions.get(id), ready: sessionReady,
    schedule: host.schedule, logger,
  })
  provideSessionController(ctx, sessionController, logger)
  const discovery = createSessionDiscovery({
    persistence: host.persistence, query: host.sessionQuery, projectionCache: host.sessionProjectionCache,
    log: message => logger.warn(message),
    owns: session => sessions.get(session.header.id)?.agent.session === session,
    onEvent: listener => ctx.on('session/event', listener),
    onCreated: listener => ctx.on('session/created', listener),
  })
  const lifecycle = createSessionLifecycle({
    agents, registry, models: sessionModels, presets: sessionPresets, persistence: host.persistence, discovery, world,
    remoteUnavailable: remoteProblem,
    flush: host.flush,
    client: id => connections.get(id),
    queue: { combineQueued, followUpSteer },
    permissions: interactions,
    contextValues: record => nativeStatus.contextValues(record), projectImages, logger,
    unblocked: record => { sessionController.deliverable(record) },
    notice: pluginStatus.notice,
    views: {
      status: (record, replay) => nativeStatus.snapshot(record, replay), mode: record => nativeStatus.mode(record),
      children: (record, replay) => children.snapshot(record, replay),
      tasks: record => tasks.snapshot(record),
      commands: record => { void sessionCommands.refresh(record) },
    },
  })

  const ownedAgentRecord = registry.ownedAgent
  const ownedRecord = registry.owned

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    ownedAgentRecord(agent)?.output.assistant(frame)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') ownedAgentRecord(agent)?.queue.agentIdle()
  })

  // Translate the session firehose into grok streaming deltas: committed text,
  // reasoning, tool calls and results, Todo plans, and retry/failure states. The
  // output runs first, so a failed turn's typed failure precedes its rejection.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    nativeStatus.refresh(record)
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
    const catalog = await models.initialize()
    return initializeReply({ version: PACKAGE_VERSION, world: world(), commands: (await sessionCommands.catalog()).commands, catalog })
  }

  const nativeCapabilities = createNativeCapabilities<SessionRecord>({
    tools: record => host.agentTools(record.agent),
    hasService: (record, name) => host.presetService(record.agent, name) !== undefined,
  })

  // Agent Teams: the host runtime serves every session; only sessions on a
  // preset that mounts the Team tools have a Team to show.
  const hasTeam = (record: SessionRecord) => nativeCapabilities.toolNames(record).has('spawn_teammate')
  const nativeTeam = createNativeTeam<SessionRecord>({ service: host.agentTeams, hasTeam, agent: record => record.agent, modelName: models.modelName })
  const teamMembers = (record: SessionRecord) => {
    if (!hasTeam(record)) return undefined
    try { return host.agentTeams()?.listMembers(record.agent).filter(member => member.role === 'teammate') } catch (error) {
      logger.warn('grok-leader: Agent Team roster unavailable: ' + errorMessage(error))
      return undefined
    }
  }

  const profilePlugins = createProfilePlugins({
    inspectRuntime: name => inspectPluginRuntime(ctx, name),
    installAnchor: () => host.profileContext()?.installAnchor,
    pluginManager: host.pluginManager,
    switches: pluginRows, skipped: pluginStatus.skipped,
  })
  const sessionCommands = createSessionCommands<SessionRecord>({
    sessions, owned: ownedRecord, client: id => connections.get(id),
    registry: host.commands, roster: agentPresets,
    skills: record => host.presetService(record.agent, 'skills'),
    capabilities: nativeCapabilities.capabilities, profile: profilePlugins, preset: sessionPresets.command,
    team: nativeTeam,
    browser: createBrowserControl({
      rows: pluginRows, settings: host.settings,
      status: () => host.browser()?.status(),
      startOpen: async () => { await host.browser()?.startOpen?.() },
    }),
    children: { command: (clientId, params) => children.command(clientId, params) },
    goals: { goal: (clientId, params) => nativeStatus.goal(clientId, params) },
    on: (name, listener) => ctx.on(name as never, listener as never), logger,
  })

  const input = createSessionInput<SessionRecord>({
    owned: ownedRecord, assertReady: lifecycle.assertReady,
    commands: sessionCommands, models,
    attachments: host.attachments,
    notify: (record, method, params) => connections.get(record.clientId)?.notify(method, params),
    cancelHuman: interactions.cancel,
    goal: { pauseGoal: record => nativeStatus.pauseGoal(record), refresh: record => nativeStatus.refresh(record) },
    remoteUnavailable: remoteProblem,
  })

  const execution = createNativeExecution<SessionRecord>({
    owned: ownedRecord, profileDirectory: profilePlugins.directory,
    inspector: host.inspector,
    browser: () => host.browser()?.status(),
    remote: () => { const configured = remote(); return configured === undefined ? undefined : { ...configured, connected: sshState().state === 'connected' } },
    hostTeamRows: async () => (await host.pluginManager()?.listPlugins() ?? [])
      .filter(row => row.enabled && row.moduleName === TEAM_TOOLS_MODULE).map(row => row.patchId ?? row.entryId),
    plugins: () => pluginStatus.findings(),
    terminals: record => host.presetService(record.agent, 'terminals'),
    subprocess: record => host.presetService(record.agent, 'subprocess'),
    toolNames: nativeCapabilities.toolNames,
  })

  const asides = createNativeAsides<SessionRecord>({
    owned: ownedRecord, canDelegate: record => nativeCapabilities.capabilities(record).includes('subagents'),
    subagents: record => host.presetService(record.agent, 'subagents'),
  })

  const artifacts = createSessionArtifacts<SessionRecord>({
    owned: ownedRecord, client: id => connections.get(id),
    titles: host.sessionTitles, references: host.sessionReferences,
    // Archives are written on this computer: a remote cwd names no host directory.
    archive: (id, cwd, filename, signal) => exportSessionArchive(ctx, id, world().kind === 'local' ? cwd : homedir(), filename, signal),
  })

  const tasks = createNativeTasks({
    sessions, owned: ownedRecord,
    jobs: record => host.presetService(record.agent, 'jobs'),
    toolNames: record => host.agentTools(record.agent) === undefined ? undefined : nativeCapabilities.toolNames(record),
    schedule: host.schedule,
    legacyReminders: record => ctx.sessionProjections.stateOf(record.agent.session, 'dscodeLegacyReminders'),
    ready: sessionReady,
    output: jobOutput, logger,
  })
  ctx.on('schedule/changed', () => { tasks.scheduleChanged() })
  // The socket accepts sessions before the Schedule service is up, and
  // `schedule/changed` fires only on writes: a session opened earlier gets its
  // Tasks rows, and its due reminders their delivery, once the service appears.
  ctx.inject(['schedule'], () => {
    tasks.scheduleChanged()
    sessionController.deliverable()
  })
  const children = createNativeChildren({
    sessions, owned: ownedRecord, agent: id => agents.get(id),
    subagents: record => host.presetService(record.agent, 'subagents'),
    jobs: record => host.presetService(record.agent, 'jobs'),
    workflow: record => {
      const state = ctx.sessionProjections.stateOf(record.agent.session, 'dscodeWorkflows')
      if (state === undefined) throw internalError('workflow history projection is unavailable')
      return state
    },
    persistence: host.persistence, flush: host.flush,
    projectImages,
    notify: (record, method, params) => connections.get(record.clientId)?.notify(method, params),
    teamMembers,
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
    goals: record => host.presetService(record.agent, 'goals'),
    commands: host.commands,
    projections: host.sessionProjections,
    on: (name, listener) => ctx.on(name as never, listener as never),
  })

  // ACP routes, grouped by owner. Registered only now that every owner they
  // name is constructed; each route reads its owner at call time (as a method
  // call, keeping `this`) and builds any literal reply fresh per call.
  const routes = createLeaderRoutes({ logger })
  const requests = (table: Record<string, RequestRoute>): void => {
    for (const [method, request] of Object.entries(table)) routes.register(method, { request })
  }
  routes.register(WIRE.initialize, { request: () => initializeResponse() })
  registerFixedReplies(routes)
  requests({ // Session lifecycle, discovery and prompt history.
    [WIRE.sessionNew]: (clientId, params) => lifecycle.new(clientId, params),
    [WIRE.sessionLoad]: (clientId, params) => lifecycle.load(clientId, params),
    [WIRE.sessionClose]: (clientId, params) => lifecycle.close(clientId, params),
    'x.ai/session/fork': (clientId, params) => lifecycle.fork(clientId, params),
    'x.ai/rewind/points': (clientId, params) => lifecycle.points(clientId, params),
    'x.ai/rewind/execute': (clientId, params) => lifecycle.rewind(clientId, params),
    'x.ai/prompt_history': (clientId, params) => lifecycle.history(clientId, params),
    [WIRE.sessionList]: () => discovery.list(WIRE.sessionList),
    'x.ai/session/list': (_clientId, params) => discovery.list('x.ai/session/list', params),
    'x.ai/sessions/list': (_clientId, params) => discovery.list('x.ai/sessions/list', params),
    'x.ai/session/search': (_clientId, params) => discovery.search(params),
  })
  requests({ // Session artifacts.
    'x.ai/session/export': (clientId, params) => artifacts.archive(clientId, params),
    'x.ai/session/references': (clientId, params) => artifacts.references(clientId, params),
    'x.ai/session/rename': (clientId, params) => artifacts.rename(clientId, params),
    'x.ai/session/info': (clientId, params) => artifacts.info(clientId, params),
  })
  requests({ // Composer input, models and permission modes.
    [WIRE.sessionPrompt]: (clientId, params) => input.prompt(clientId, params),
    'x.ai/session/cancel_prompt': (clientId, params) => input.cancelPrompt(clientId, params),
    'x.ai/interject': (clientId, params) => input.interject(clientId, params),
    [WIRE.sessionSetModel]: (clientId, params) => sessionModels.set(clientId, params),
    [WIRE.modelsList]: () => models.list(),
    [WIRE.providersAdd]: (_clientId, params) => models.add(params),
    [WIRE.providersUpdate]: (_clientId, params) => models.update(params),
    [WIRE.providersRemove]: (_clientId, params) => models.remove(params),
    [WIRE.sessionSetMode]: (clientId, params) => interactions.mode(clientId, params),
  })
  requests({ // Native features: goals, tasks and reminders, children, asides, execution.
    'x.ai/task/output': (clientId, params) => tasks.output(clientId, params),
    'x.ai/task/kill': (clientId, params) => tasks.kill(clientId, params),
    'x.ai/scheduler/list': (clientId, params, method) => tasks.reminders(clientId, method, params),
    'x.ai/scheduler/create': (clientId, params, method) => tasks.reminders(clientId, method, params),
    'x.ai/scheduler/delete': (clientId, params, method) => tasks.reminders(clientId, method, params),
    'x.ai/subagent/history': (clientId, params) => children.history(clientId, params),
    'x.ai/subagent/cancel': (clientId, params) => children.cancel(clientId, params),
    'x.ai/subagent/inbox': (clientId, params) => children.inbox(clientId, params),
    'x.ai/btw': (clientId, params) => asides.btw(clientId, params),
    'x.ai/doctor': (clientId, params) => execution.doctor(clientId, params),
    'x.ai/terminals': (clientId, params) => execution.terminals(clientId, params),
  })
  requests({ // Commands, skills, presets and MCP servers.
    'x.ai/commands/list': (clientId, params) => sessionCommands.catalog(clientId, params),
    'x.ai/commands/run': (clientId, params) => sessionCommands.run(clientId, params),
    'x.ai/skills/list': (clientId, params) => sessionCommands.skills(clientId, params),
    'x.ai/presets': (clientId, params) => sessionPresets.controls(clientId, params),
    'x.ai/bundle/status': () => sessionPresets.status(),
    'x.ai/mcp/list': (clientId, params) => {
      const p = paramRecord(params, 'x.ai/mcp/list')
      const sessionId = sessionIdParam(p.sessionId)
      const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
      return listMcpServers(ctx, record?.agent)
    },
  })
  routes.register('x.ai/yolo_mode_changed', { notification: (clientId, params) => { interactions.notification(clientId, params) } })
  routes.register(WIRE.sessionCancel, { notification: (clientId, params) => { input.cancel(clientId, params) } })
  for (const method of ['x.ai/queue/interject', 'x.ai/queue/steer', 'x.ai/queue/remove', 'x.ai/queue/edit',
    'x.ai/queue/hold_edit', 'x.ai/queue/release_edit', 'x.ai/queue/reorder', 'x.ai/queue/clear']) {
    routes.register(method, { notification: (clientId, params) => { input.control(clientId, method, params) } })
  }

  const leaderHost = createLeaderLifecycle({
    sessions: registry, catalog: models, transport,
    owners: [discovery, sessionCommands, execution, asides, artifacts, input, interactions,
      sessionPresets, sessionModels, profilePlugins, children, nativeStatus, tasks, sessionController],
    pollers: [tasks, children, nativeStatus],
    // A leader whose remote connection is gone exits at once, so restarting dscode reconnects.
    idleExitMs: () => remoteProblem() === undefined ? config.idleExitMs ?? 2000 : 0,
    appExit: host.appExit, logger,
  })
  // Register cleanup before listen can fail synchronously.
  ctx.effect(() => () => leaderHost.dispose(), 'grok-leader.socket')
  leaderHost.start()
}
