/** The DSH host services this bridge reads, declared in one place. Every read
 * happens at call time: the settings provider, agent-default-model, the plugin
 * manager and other rows publish after `apply`, and teardown must not retain a
 * stale instance. Services the plugin injects statically (`agents`,
 * `sessionProjections`) are properties of the mount context and stay with the
 * composition root; this seam covers what may be absent, late or replaced. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { AgentDefaultModelLike, CredentialsLike, LlmLike, SettingsLike } from './native-seams.ts'
import type { BrowserStatus } from './browser-control.ts'
import type { ConfigEntryLike } from './execution-world.ts'
import type { NativeAsideRuntime } from './native-asides.ts'
import type { NativeToolSchemas } from './native-capabilities.ts'
import type { NativeExecutionHost, NativeTerminals } from './native-execution.ts'
import type { NativeGoalAuthority, NativeStatusProjections } from './native-session-status.ts'
import type { ScheduleServiceLike } from './native-tasks.ts'
import type { TeamServiceLike } from './native-team.ts'
import type { PluginManagerLike } from './plugin-rows.ts'
import type { LoaderEntryLike } from './plugin-status.ts'
import type { NativeSessionReferences, NativeSessionTitles } from './session-artifacts.ts'
import type { NativeCommands, NativeSkills } from './session-commands.ts'
import type { ScheduleDeliveryLike } from './session-controller.ts'
import type { SessionProjectionCacheLike, SessionQueryLike } from './session-discovery.ts'
import type { AgentPresetsLike } from './session-presets.ts'

/** Structural read of the session store: its flush entry point, and the
 * message projections plugins registered on it. */
export interface SessionsLike {
  flush(session: object): Promise<unknown>
  readonly messageProjections?: ReadonlyArray<{ readonly type: string }>
}
/** The permission-presets row: one named preset per session. */
export interface PermissionPresetsLike {
  set(session: Agent['session'], preset: string): void
}
/** dscode's own browser row (`dscodeBrowser`): live facts, and a start for open sessions. */
export interface BrowserRowLike {
  status(): BrowserStatus
  /** Start browsers for open sessions that have none, with the settings just written. */
  startOpen?(): Promise<void>
}
/** The one lookup this seam needs; a Cordis context satisfies it. */
export interface ServiceReads {
  get(name: string): unknown
}
/** Per-session native services the bridge reads by name, as their owners
 * consume them. A name outside this table resolves untyped (capability probes). */
export interface SessionServices {
  subagents: NativeAsideRuntime
  skills: NativeSkills
  goals: NativeGoalAuthority
  planMode: { set(agent: Agent, active: boolean): unknown }
  terminals: NativeTerminals
  subprocess: NativeExecutionHost
}

/** Each read names the service it resolves; none caches. The readers are
 * plain properties, so a caller may pass them on without binding. */
export interface HostServices {
  /** The settings provider (dsh-settings-file) publishes asynchronously after apply. */
  settings(): SettingsLike | undefined
  llm(): LlmLike | undefined
  credentials(): CredentialsLike | undefined
  /** Depends on the settings provider and can mount after apply; an eager
   * capture would make session/set_model silently skip saveSelection (and
   * /effort would not persist). */
  agentDefaultModel(): AgentDefaultModelLike | undefined
  /** Injected before apply, so the socket never opens before it mounts; still
   * read per call so teardown retains no stale instance. */
  persistence(): SessionPersistence | undefined
  attachments(): AttachmentStore | undefined
  /** The session store's flush; a missing store flushes nothing. */
  flush(session: object): Promise<unknown>
  /** Whether a plugin registered a message projection for an event type on
   * the session store: a durable decision that changes model-visible messages. */
  messageProjection(type: string): boolean
  /** The dsh plugin command registry, when the composition mounts it. */
  commands(): NativeCommands | undefined
  /** The Host Schedule service, once it is up. */
  schedule(): (ScheduleServiceLike & ScheduleDeliveryLike) | undefined
  /** Present only in a profile launched by dsh. */
  profileContext(): ProfileContext | undefined
  pluginManager(): PluginManagerLike | undefined
  /** The Cordis Loader's composition rows, as plugin health reads them. */
  loader(): { entries(): Iterable<LoaderEntryLike> } | undefined
  configEditor(): { entries(): Iterable<ConfigEntryLike> } | undefined
  /** dsh-ssh keeps a lost connection's error on the service (`failure`); it
   * never reconnects. A connection that never came up leaves no service. */
  ssh(): { failure?: unknown } | undefined
  sessionTitles(): NativeSessionTitles | undefined
  sessionReferences(): NativeSessionReferences | undefined
  /** The optional full-text session query engine. */
  sessionQuery(): SessionQueryLike | undefined
  /** The persisted projection cache: zero-I/O listing reads. */
  sessionProjectionCache(): SessionProjectionCacheLike | undefined
  /** The projection registry as the status observer reads it. */
  sessionProjections(): NativeStatusProjections | undefined
  permissionPresets(): PermissionPresetsLike | undefined
  /** The native Agent Teams runtime; it serves every session, Team or not. */
  agentTeams(): TeamServiceLike | undefined
  /** dscode's isolated browser row, while it is enabled. */
  browser(): BrowserRowLike | undefined
  /** dscode's inspector row, while it is enabled. */
  inspector(): { url: string; captureFetch: boolean } | undefined
  /** app-boot's process exit, when this leader runs under it. */
  appExit(): ((code: number) => void) | undefined
  /** The tool registry scoped to one agent: its preset's tools. */
  agentTools(agent: Agent): NativeToolSchemas | undefined
  /** A native service for one session: the preset's own scope first, then
   * the agent's context, then the host. */
  presetService<K extends keyof SessionServices>(agent: Agent, name: K): SessionServices[K] | undefined
  presetService(agent: Agent, name: string): unknown
}

export interface HostServiceDependencies {
  /** The preset roster, read on demand: it mounts asynchronously after apply. */
  roster(): Pick<AgentPresetsLike, 'serviceFor'> | undefined
}

export function createHostServices(ctx: ServiceReads, dependencies: HostServiceDependencies): HostServices {
  const read = <T>(name: string) => () => ctx.get(name) as T | undefined
  return {
    settings: read<SettingsLike>('settings'),
    llm: read<LlmLike>('llm'),
    credentials: read<CredentialsLike>('credentials'),
    agentDefaultModel: read<AgentDefaultModelLike>('agentDefaultModel'),
    persistence: read<SessionPersistence>('sessionPersistence'),
    attachments: read<AttachmentStore>('attachments'),
    flush: async session => read<SessionsLike>('sessions')()?.flush(session),
    messageProjection: type => read<SessionsLike>('sessions')()?.messageProjections?.some(projection => projection.type === type) === true,
    commands: read<NativeCommands>('commands'),
    schedule: read<ScheduleServiceLike & ScheduleDeliveryLike>('schedule'),
    profileContext: read<ProfileContext>('profileContext'),
    pluginManager: read<PluginManagerLike>('pluginManager'),
    loader: read<{ entries(): Iterable<LoaderEntryLike> }>('loader'),
    configEditor: read<{ entries(): Iterable<ConfigEntryLike> }>('configEditor'),
    ssh: read<{ failure?: unknown }>('ssh'),
    sessionTitles: read<NativeSessionTitles>('sessionTitle'),
    sessionReferences: read<NativeSessionReferences>('sessionReferenceResolver'),
    sessionQuery: read<SessionQueryLike>('sessionQuery'),
    sessionProjectionCache: read<SessionProjectionCacheLike>('sessionProjectionCache'),
    sessionProjections: read<NativeStatusProjections>('sessionProjections'),
    permissionPresets: read<PermissionPresetsLike>('permissionPresets'),
    agentTeams: read<TeamServiceLike>('agentTeams'),
    browser: read<BrowserRowLike>('dscodeBrowser'),
    inspector: read<{ url: string; captureFetch: boolean }>('dscodeInspector'),
    appExit: read<(code: number) => void>('appExit'),
    agentTools: agent => agent.ctx.get('tools') as NativeToolSchemas | undefined,
    presetService: ((agent: Agent, name: string): unknown =>
      dependencies.roster()?.serviceFor?.(agent, name) ?? agent.ctx.get(name) ?? ctx.get(name)) as HostServices['presetService'],
  }
}
