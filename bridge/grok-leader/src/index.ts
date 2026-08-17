/**
 * Grok leader-protocol unix-socket server driving harness agents.
 *
 * Outer envelope: grok leader framing (codec.ts / protocol.ts), verified
 * against the real TUI capture in tests/fixtures/grok-tui-messages.jsonl,
 * docs/grok-tui-connect.md, and docs/grok-leader-protocol.md. Inner dialect:
 * ACP JSON-RPC strings mapped onto the harness services the ACP bridge drives
 * (agents.create/resume, agent.followup / whenIdle / cancel, session/event,
 * approval/request, sessions.flush, llm.listProviders/listModels,
 * sessionPersistence.list/load, agentDefaultModel.saveSelection). Unclear grok
 * surfaces carry TODO(verify) markers with the grok file:line to check.
 * @module @deepseek-ai/dsh-grok-leader
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installModelSelection, type Agent, type AgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { encodeJsonFrame, FrameDecoder } from './codec.ts'
import { LEADER_PROTOCOL_VERSION, RpcError, decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from './protocol.ts'

export const name = 'grok-leader'
/** The bridge creates and owns agents; every other concern is carried by the agent composition. */
export const inject = ['agents']

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
  /** Grace before the host exits after the last client disconnects (ms). */
  idleExitMs?: number
}

export const Config: Schema<GrokLeaderConfig> = Schema.object({
  socketPath: Schema.string().default('/tmp/dsh-grok-leader.sock'),
  provider: Schema.string(),
  model: Schema.string(),
  combineQueuedPrompts: Schema.boolean(),
  idleExitMs: Schema.number().default(2000),
})

// Probe-verified against the real TUI: docs/grok-tui-connect.md records that
// leader_binary_version must be at least the client version or the client
// evicts and respawns the leader. TODO(verify): derive from the package
// version instead of pinning 1.0.4 (protocol.rs LEADER_VERSION mismatch rule).
const LEADER_BINARY_VERSION = '1.0.4'

/** How long an unregistered connection may sit before it is dropped (server.rs). */
const REGISTRATION_TIMEOUT_MS = 30_000

const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

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
  sessionClose: 'session/close',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  modelsList: 'x.ai/models/list',
  sessionsList: 'x.ai/sessions/list',
  askUserQuestion: 'x.ai/ask_user_question',
  providersAdd: 'x.ai/providers/add',
  providersUpdate: 'x.ai/providers/update',
  providersRemove: 'x.ai/providers/remove',
} as const

/** The dsh settings namespace the llm-pi-ai plugin owns (packages/llm/llm-pi-ai). */
const PROVIDER_SETTINGS_NS = 'llm-pi-ai'
/** Provider route ids are lowercase kebab-case, like settings namespace ids. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/
/** Wire protocols a declared provider route may name (llm-pi-ai supportedProtocols). */
const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
/**
 * The official seam refuses a declared route that resolves no models; that
 * error marks the retry path where the gateway is interrogated for its
 * catalog (catalog routes never hit it: they resolve their models first).
 */
const NO_MODELS_MARKER = 'resolves no models'

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
  code: {
    name: 'Code mode',
    description: 'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'Two-tool coding agent with persistent bash and str_replace_editor.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
}

/** The grok StopReason vocabulary (agent.rs StopReason). */
type StopReasonWire = 'end_turn' | 'max_tokens' | 'cancelled'

/** One streaming delta this bridge emits as a session/update notification. */
export type GrokSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: ToolKindWire; status: 'in_progress'; rawInput?: unknown }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: 'completed' | 'error'; content?: Array<ToolResultContentBlock>; rawOutput?: unknown; error?: { name: string; code: string } }

/** grok ACP ToolKind vocabulary the TUI renders for a tool call. */
export type ToolKindWire = 'execute' | 'read' | 'edit' | 'search' | 'fetch' | 'other'
/** grok ToolCallContent shapes the TUI understands (text or file diff). */
export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText?: string; newText: string }

/** grok AskUserQuestionExtResponse: tagged on `outcome`, snake_case variant names. */
type AskUserQuestionExtResponse =
  | { outcome: 'accepted'; answers: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { outcome: 'chat_about_this' | 'skip_interview'; partial_answers?: Record<string, string> }
  | { outcome: 'cancelled' }

/** Flattened wire catalog plus the provider ownership the bare model ids hide. */
interface ModelCatalog {
  currentModelId: string
  /** Provider roster as listed by the harness llm service ({id, name?}) plus
   * the raw user-section profile fields the edit form prefills. */
  providers: Array<{ id: string; name?: string; displayName?: string; apiKeyEnv?: string; api?: string; baseURL?: string }>
  /** Provider that owns currentModelId ('' when no current model). */
  currentProviderId: string
  availableModels: Array<{ modelId: string; name: string; description?: string; _meta?: { provider: string; supportsReasoningEffort?: boolean; reasoningEfforts?: string[]; reasoningEffort?: string } }>
  providerByModel: Map<string, string>
}

interface ClientConnection {
  readonly socket: Socket
  readonly clientId: number
  /** Pending reverse requests (permission, ask_user_question) keyed by JSON-RPC id. */
  readonly pending: Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    /** Owning session when known; cancel/close/load reject only its entries. */
    sessionId?: SessionId
  }>
  nextRequestId: number
}

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** Client that created or loaded this session; reverse requests route here. */
  clientId: number
  /** Runtime model selection installed into the agent scope. */
  selection: ModelSelectionRef
  /** YOLO sessions pre-approve permission requests without a client roundtrip. */
  yolo: boolean
  /** Highest forwarded dsh event seq; replay/live overlap dedup drops at or below it. */
  lastSeq: number
  /** Millisecond epoch when the current turn started, stamped into update _meta. */
  turnStartMs: number | undefined
  /** Monotonic per-session counter stamped into every update _meta.eventSeq. */
  eventSeq: number
  /** Cumulative session token accounting summed from assistant/message usage. */
  inputTokens: number
  outputTokens: number
  /** Counters the grok x.ai/session/info context reads. */
  turnCount: number
  toolCallCount: number
  messageCount: number
  /** Pending tool-call facts keyed by callId, used to attach rawInput/rawOutput. */
  pendingToolCalls: Map<string, { name: string; arguments: unknown }>
  /** True once the current step streamed a text-delta; suppresses the assembled-message re-emit. */
  textStreamed: boolean
  /** Accepted user prompts, oldest first; served by x.ai/prompt_history. */
  prompts: string[]
  /** FIFO of validated prompts waiting for the in-flight one to settle. */
  promptQueue: Array<{
    resolve: (value: { stopReason: StopReasonWire }) => void
    reject: (error: Error) => void
    /** Stable queue-row id: the request _meta.promptId or a minted uuid. */
    id: string
    text: string
    /** Edit counter: fresh rows start at 0 (grok QueueEntryMeta), edits bump by one. */
    version: number
    /** Per-prompt display texts when combine folded followers into this row (len >= 2). */
    combinedTexts?: string[]
  }>
  /** Queue row id of the prompt the agent is currently draining. */
  runningPromptId: string | undefined
  /** Plain text of the running prompt (queue/changed carries it; the running row is omitted from entries). */
  runningText: string | undefined
  /** Per-prompt display texts of a combined running turn (len >= 2). */
  runningCombinedTexts: string[] | undefined
  /** Stamps the next prompt_complete broadcast (send_now suppresses the cancelled marker). */
  cancelTrigger: string | undefined
  /** Queue rows parked under queue/hold_edit; advance and combine skip them. */
  editHolds: Set<string>
  /** Pending _x.ai/mcp_initialized notification timer; cleared on close/teardown. */
  mcpInitTimer: ReturnType<typeof setTimeout> | undefined
  inflight: {
    resolve: (reason: StopReasonWire) => void
    reject: (error: Error) => void
    messageId: string
    promptId: string
    turn: number | undefined
    endReason: TurnEndReason | undefined
  } | undefined
}

/** Structural read of the persistence service: list and load only. */
interface PersistenceLike {
  list(signal?: AbortSignal): Promise<Array<{ id: string; createdAt: number; cwd?: string }>>
  load(id: SessionId): Promise<{ meta: { agentPreset?: string }; events: readonly SessionEvent[] }>
}

/** Structural read of the user-questions service: provider registration only. */
interface UserQuestionsLike {
  registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void
}
/** Structural read of the llm service: provider and model catalogs only. */
interface LlmLike {
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; description?: string }>>
  /** Interrogate a draft provider for its model catalog (llm-pi-ai discovery). */
  discoverModels?(
    settingsNs: string,
    request: {
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    },
  ): Promise<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
}

/** Structural write path of the official settings seam (ctx.settings.mutate). */
interface SettingsLike {
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<void>
  /** Read the raw user sections (ctx.settings.describe); optional for harnesses without it. */
  describe?(): Array<{ ns: string; user?: unknown }>
}

/** Structural read of the session store: this bridge needs only one flush entry point. */
interface SessionsLike {
  flush(session: object): Promise<unknown>
}

/** Structural read of the default-model service. */
interface AgentDefaultModelLike {
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** Structural read of the preset roster: list, resolve, and mount. */
interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/**
 * Mount the grok leader server.
 * @param ctx - Cordis context carrying the agent factory and harness services.
 * @param config - socket path and initial provider/model selection.
 */
export function apply(ctx: Context, config: GrokLeaderConfig): void {
  const agents = ctx.agents
  const llm = ctx.get('llm') as LlmLike | undefined
  const logger = ctx.logger
  // Read lazily like the other optional services: the settings provider
  // (dsh-settings-file) publishes asynchronously after apply.
  const settings = (): SettingsLike | undefined => ctx.get('settings') as SettingsLike | undefined
  // Read lazily: the persistence service mounts asynchronously, so the eager
  // ctx.get at apply time captured undefined and every session/load failed
  // with "session persistence is not configured" (same fix as agentPresets).
  const persistence = (): PersistenceLike | undefined => ctx.get('sessionPersistence')
  const agentDefaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  /** Read the preset roster on demand: it mounts asynchronously after apply. */
  const agentPresets = (): AgentPresetsLike | undefined => ctx.get('agentPresets') as AgentPresetsLike | undefined
  const sessions = new Map<SessionId, SessionRecord>()
  const connections = new Map<number, ClientConnection>()
  let clientSeq = 0
  let closed = false
  let catalog: ModelCatalog | undefined
  // grok's ui.combine_queued_prompts (default off); env override for dev shells.
  const combineQueued = config.combineQueuedPrompts === true || process.env.DEEPSEEK_LEADER_COMBINE_QUEUED === '1'
  const idleExitMs = config.idleExitMs ?? 2000
  /** x.ai/session/list rows served when the request carries no (or an oversized) limit. */
  const DEFAULT_SESSION_LIST_LIMIT = 50
  /** First user prompt per session id, memoized across x.ai/session/list calls. */
  const firstPromptCache = new Map<string, string>()
  /** First-prompt loads in flight; concurrent list calls share them and never
   * cache the '' placeholder as a successful title. */
  const firstPromptInFlight = new Set<string>()
  /** Cap the title cache: the oldest entry is evicted, read hits refresh recency. */
  const FIRST_PROMPT_CACHE_LIMIT = 100
  const cacheFirstPrompt = (sessionId: string, title: string): void => {
    firstPromptCache.delete(sessionId)
    // A '' miss is NOT a title: a session prompted after an empty list would
    // otherwise serve the poisoned empty string forever. Misses retry.
    if (title === '') return
    firstPromptCache.set(sessionId, title)
    while (firstPromptCache.size > FIRST_PROMPT_CACHE_LIMIT) {
      const oldest = firstPromptCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      firstPromptCache.delete(oldest)
    }
  }
  const cachedFirstPrompt = (sessionId: string): string | undefined => {
    const title = firstPromptCache.get(sessionId)
    if (title === undefined) return undefined
    firstPromptCache.delete(sessionId)
    firstPromptCache.set(sessionId, title)
    return title
  }
  const firstUserPrompt = (events: readonly SessionEvent[]): string => {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const data = event.data as { source?: unknown; content?: unknown }
      if ((data.source as { kind?: unknown } | undefined)?.kind !== 'user') continue
      if (!Array.isArray(data.content)) continue
      for (const block of data.content) {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) return b.text.trim()
      }
    }
    return ''
  }

  /** Raw user section of the llm-pi-ai namespace, when the settings service exposes it. */
  const providerUserSection = (providerService?: SettingsLike): Record<string, unknown> | undefined => {
    const descriptor = providerService?.describe?.().find(entry => entry.ns === PROVIDER_SETTINGS_NS)
    const user = descriptor?.user
    return user !== null && typeof user === 'object' ? user as Record<string, unknown> : undefined
  }

  /** One provider's raw user profile ({} when the section does not name it). */
  const providerUserProfile = (userSection: Record<string, unknown> | undefined, id: string): Record<string, unknown> => {
    const providers = userSection?.providers
    const profile = providers !== null && typeof providers === 'object'
      ? (providers as Record<string, unknown>)[id]
      : undefined
    return profile !== null && typeof profile === 'object' ? profile as Record<string, unknown> : {}
  }

  /** baseURLs of the provider routes already persisted in the user settings
   * section: the only endpoints a resolved env secret may be sent to. */
  const knownRouteBaseUrls = (): string[] => {
    const providers = providerUserSection(settings())?.providers
    if (providers === null || typeof providers !== 'object') return []
    const urls: string[] = []
    for (const profile of Object.values(providers as Record<string, unknown>)) {
      if (profile === null || typeof profile !== 'object') continue
      const baseURL = (profile as { baseURL?: unknown }).baseURL
      if (typeof baseURL === 'string' && baseURL.length > 0) urls.push(baseURL)
    }
    return urls
  }

  /** Rebuild the flattened wire catalog plus the provider ownership the bare ids hide. */
  const refreshCatalog = async (): Promise<ModelCatalog> => {
    const userSection = providerUserSection(settings())
    const providers = llm === undefined ? [] : llm.listProviders().map(p => {
      const profile = providerUserProfile(userSection, p.id)
      return {
        id: p.id,
        ...p.name === undefined ? {} : { name: p.name },
        ...typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {},
        ...typeof profile.apiKeyEnv === 'string' ? { apiKeyEnv: profile.apiKeyEnv } : {},
        ...typeof profile.api === 'string' ? { api: profile.api } : {},
        ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
      }
    })
    const rows = llm === undefined
      ? []
      : await Promise.all(llm.listProviders().map(async provider => ({
        provider: provider.id,
        models: await llm.listModels(provider.id),
      })))
    const providerByModel = new Map<string, string>()
    const availableModels: ModelCatalog['availableModels'] = []
    for (const row of rows) {
      for (const model of row.models) {
        // Deterministic dedup: the first provider that lists an id owns it.
        if (providerByModel.has(model.id)) continue
        providerByModel.set(model.id, row.provider)
        availableModels.push({
          modelId: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
          // dsh's llm catalog carries no per-model effort capability, so the
          // bridge advertises the canonical grok effort set and lets the
          // provider reject unsupported tiers at call time.
          _meta: {
            provider: row.provider,
            supportsReasoningEffort: true,
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        })
      }
    }
    const requested = config.model
      ?? (ctx.get('agentDefaultModel') as { currentSelection?: () => { model: string } | undefined } | undefined)?.currentSelection?.()?.model
      ?? ''
    // A configured model absent from the catalog must not reach the client as
    // an unresolvable currentModelId; fall back to the catalog's first entry.
    let currentModelId = requested
    if (currentModelId !== '' && !providerByModel.has(currentModelId)) {
      currentModelId = availableModels[0]?.modelId ?? ''
      logger.warn('grok-leader: model "' + requested + '" is not in the catalog; falling back to "' + currentModelId + '"')
    }
    // The pager reads the selected effort from the current model's
    // _meta.reasoningEffort on every models/list, so a /effort choice must
    // ride the catalog or it is forgotten across restarts.
    const selectedEffort = (ctx.get('agentDefaultModel') as
      { currentSelection?: () => { reasoningEffort?: string } | undefined } | undefined)?.currentSelection?.()?.reasoningEffort
    if (typeof selectedEffort === 'string' && selectedEffort.length > 0) {
      const current = availableModels.find(model => model.modelId === currentModelId)
      if (current !== undefined && current._meta !== undefined) {
        current._meta.reasoningEffort = selectedEffort
      }
    }
    catalog = {
      currentModelId,
      providers,
      currentProviderId: currentModelId === '' ? '' : providerByModel.get(currentModelId) ?? '',
      availableModels,
      providerByModel,
    }
    return catalog
  }

  /** The most recently refreshed catalog, rebuilt on first use. */
  const currentCatalog = (): Promise<ModelCatalog> => catalog === undefined
    ? refreshCatalog()
    : Promise.resolve(catalog)

  const ownedAgentRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  /** One client may only touch sessions it created or loaded; foreign ids
   * resolve exactly like unknown ids so a session's existence never leaks. */
  const ownedRecord = (clientId: number, sessionId: SessionId | undefined): SessionRecord | undefined => {
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
    return record?.clientId === clientId ? record : undefined
  }

  /** Cancel the _x.ai/mcp_initialized notification timer a record still owns. */
  const clearMcpInitTimer = (record: SessionRecord): void => {
    if (record.mcpInitTimer !== undefined) {
      clearTimeout(record.mcpInitTimer)
      record.mcpInitTimer = undefined
    }
  }

  const assertOpen = (): void => {
    if (closed) throw new RpcError(JSONRPC_INTERNAL_ERROR, 'the grok leader has been disposed')
  }

  const invalidParams = (detail: string): RpcError => new RpcError(JSONRPC_INVALID_PARAMS, detail)

  const internalError = (detail: string): RpcError => new RpcError(JSONRPC_INTERNAL_ERROR, detail)

  const settlePrompt = (record: SessionRecord, reason: StopReasonWire): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const sendAcp = (conn: ClientConnection, value: unknown): void => {
    if (process.env.DEEPSEEK_LEADER_DEBUG === '1') {
      process.stderr.write('grok-leader wire out acp: ' + JSON.stringify(value).slice(0, 400) + '\n')
    }
    conn.socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(value) }))
  }

  const sendNotification = (conn: ClientConnection, method: string, params: unknown): void => {
    sendAcp(conn, { jsonrpc: '2.0', method, params })
  }

  /** A client that never answers a reverse request is rejected after this long. */
  const REVERSE_REQUEST_TIMEOUT_MS = 60_000

  /** Send a JSON-RPC request to one client and wait for its response. */
  const requestClient = <T>(conn: ClientConnection, method: string, params: unknown, sessionId?: SessionId): Promise<T> => {
    const id = conn.nextRequestId++
    sendAcp(conn, { jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(String(id))
        reject(new RpcError(JSONRPC_INTERNAL_ERROR, 'client did not answer ' + method + ' within 60s'))
      }, REVERSE_REQUEST_TIMEOUT_MS)
      conn.pending.set(String(id), {
        resolve: (value: unknown) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
        ...sessionId === undefined ? {} : { sessionId },
      })
    })
  }

  /** Reject the reverse requests a closed/cancelled session still waits on. */
  const rejectPendingFor = (clientId: number, sessionId: SessionId): void => {
    const conn = connections.get(clientId)
    if (conn === undefined) return
    for (const [id, pending] of conn.pending) {
      if (pending.sessionId !== sessionId) continue
      conn.pending.delete(id)
      pending.reject(new RpcError(JSONRPC_INTERNAL_ERROR, 'session ' + String(sessionId) + ' is no longer active'))
    }
  }

  const settlePending = (conn: ClientConnection, value: unknown): void => {
    const msg = value as { id?: unknown; result?: unknown; error?: { code: number; message: string } }
    const pending = conn.pending.get(String(msg.id))
    if (pending === undefined) return
    conn.pending.delete(String(msg.id))
    if (msg.error !== undefined) {
      pending.reject(new RpcError(msg.error.code, msg.error.message))
    } else {
      pending.resolve(msg.result)
    }
  }

  /**
   * Forward one update with the leader _meta stamp. The eventSeq monotonic
   * counter plus the per-session dsh-seq high-water make replay/live overlap
   * deduplicable on the client side (server.rs eventId dedup).
   */
  const emitUpdate = (
    conn: ClientConnection,
    record: SessionRecord,
    sourceSeq: number | undefined,
    item: GrokSessionUpdate & { totalTokens?: number },
    isReplay: boolean,
    agentTimestampMs?: number,
  ): void => {
    if (sourceSeq !== undefined) {
      if (sourceSeq <= record.lastSeq) return
      record.lastSeq = sourceSeq
    }
    const eventSeq = record.eventSeq
    record.eventSeq = eventSeq + 1
    const inflight = record.inflight
    const { totalTokens, ...update } = item
    sendNotification(conn, WIRE.sessionUpdate, {
      sessionId: record.agent.session.id,
      update,
      _meta: {
        eventSeq,
        ...inflight === undefined ? {} : { promptId: inflight.promptId },
        ...isReplay ? { isReplay: true } : {},
        ...totalTokens === undefined ? {} : { totalTokens },
        ...agentTimestampMs === undefined ? {} : { agentTimestampMs },
        ...record.turnStartMs === undefined ? {} : { streamStartMs: record.turnStartMs, turnStartMs: record.turnStartMs },
      },
    })
  }

  /** Accumulate the token and counter facts one session event contributes. */
  const noteEvent = (record: SessionRecord, event: SessionEvent): void => {
    if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage !== undefined) {
        record.inputTokens += usage.inputTokens
        record.outputTokens += usage.outputTokens
      }
      record.messageCount += 1
    } else if (event.type === 'tool/call') {
      record.toolCallCount += 1
      record.pendingToolCalls.set(String(event.data.callId), {
        name: event.data.name,
        arguments: parseJsonObject(event.data.arguments),
      })
    } else if (event.type === 'user/message' && (event.data.source as { kind?: unknown }).kind === 'user') {
      record.messageCount += 1
    } else if (event.type === 'turn/end') {
      record.turnCount += 1
    }
  }

  /** Map one event to wire updates, attaching the cumulative token total to agent text. */
  const mapEvent = (
    record: SessionRecord,
    event: SessionEvent,
    replay: boolean,
  ): Array<GrokSessionUpdate & { totalTokens?: number }> => {
    if (event.type === 'step/start') record.textStreamed = false
    noteEvent(record, event)
    const totalTokens = record.inputTokens + record.outputTokens
    const updates: Array<GrokSessionUpdate & { totalTokens?: number }> = []
    for (const item of sessionEventToUpdates(event, {
      replay,
      textStreamed: record.textStreamed,
      toolCall: (callId) => record.pendingToolCalls.get(callId),
    })) {
      if (item.sessionUpdate === 'agent_message_chunk') {
        record.textStreamed = true
        updates.push({ ...item, totalTokens })
      } else {
        updates.push(item)
      }
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0] as { toolCallId?: unknown } | undefined
      if (block !== undefined) record.pendingToolCalls.delete(String(block.toolCallId))
    }
    return updates
  }

  // Translate the session firehose into grok streaming deltas. Committed text,
  // reasoning deltas, tool calls, and tool results stream; titles, plans, and
  // retry markers are presentation or trace data and stay off the wire.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    try {
      if (event.type === 'turn/start') {
        record.turnStartMs = event.time
      }
      for (const item of mapEvent(record, event, false)) {
        emitUpdate(conn, record, event.seq, item, false, event.time)
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          record.inflight = undefined
          inflight.reject(internalError('turn failed: ' + event.data.reason.error.message))
        } else {
          // The grok PromptResponse settles at turn end, not whole-agent idle.
          settlePrompt(record, turnEndToStopReason(event.data.reason))
        }
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedAgentRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedAgentRecord(agent)
    const inflight = record?.inflight
    // Reject only when this error names the in-flight turn; an error for any
    // other turn (or before a turn was claimed) must not settle this prompt.
    if (record === undefined || inflight === undefined || inflight.turn !== turn) return
    record.inflight = undefined
    inflight.reject(internalError('turn failed: ' + errorChain(error)))
  })

  // Permission requests are a machine policy channel: one-shot choices only,
  // and an unknown client response never becomes a durable grant. YOLO
  // sessions pre-approve without a client roundtrip.
  ctx.on('approval/request', (request, next) => {
    const record = ownedAgentRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    if (record.yolo) return Promise.resolve('allowed-once' as const)
    const conn = connections.get(record.clientId)
    if (conn === undefined) return next()
    // Validate instead of blind-casting: a malformed client payload must fail
    // closed to a rejection, never crash the approval path.
    const permissionDecision = (outcome: unknown): 'allowed-once' | 'cancelled' | 'rejected' => {
      if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return 'rejected'
      const envelope = outcome as { outcome?: unknown }
      if (typeof envelope.outcome !== 'object' || envelope.outcome === null || Array.isArray(envelope.outcome)) return 'rejected'
      const inner = envelope.outcome as { outcome?: unknown; optionId?: unknown }
      if (inner.outcome === 'cancelled') return 'cancelled'
      if (inner.outcome !== 'selected') return 'rejected'
      return inner.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    }
    return requestClient<unknown>(conn, WIRE.requestPermission, {
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId, displayName: request.toolName },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }, record.agent.session.id).then(permissionDecision).catch((error: unknown) => {
      // A disconnect/cancel/timeout rejects the pending request; fail closed
      // instead of surfacing an unhandled rejection.
      logger.warn('grok-leader: permission request failed: ' + errorChain(error))
      return 'rejected'
    })
  })

  // Human questions route to the client owning the asking agent.
  const questions = ctx.get('userQuestions') as UserQuestionsLike | undefined
  if (questions !== undefined) {
    const disposeProvider = questions.registerProvider({
      async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
        const record = request.agent === undefined ? undefined : ownedAgentRecord(request.agent)
        const conn = record === undefined ? undefined : connections.get(record.clientId)
        if (record === undefined || conn === undefined) {
          throw new UserQuestionError('no connected grok client owns this agent', 'NO_CLIENT')
        }
        // grok keys accepted answers by question text, so remember each text's dsh id.
        const textToId = new Map<string, string>()
        const grokQuestions = request.questions.map((question) => {
          textToId.set(question.question, question.id)
          return {
            question: question.question,
            options: (question.options ?? []).map(option => ({
              label: option.label,
              description: option.description ?? '',
            })),
            ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
            ...(question.id !== undefined ? { id: question.id } : {}),
          }
        })
        // The ACP ext_method reverse request rides the wrapped wire form: a
        // top-level `_x.ai/ask_user_question` with method + params nested one
        // level (server.rs method_of / interaction_inner_params). dsh does not
        // expose the tool call id, so mint an opaque one the client echoes back.
        const response = await requestClient<AskUserQuestionExtResponse>(conn, '_x.ai/ask_user_question', {
          method: WIRE.askUserQuestion,
          params: {
            sessionId: record.agent.session.id,
            toolCallId: randomUUID(),
            questions: grokQuestions,
            mode: 'default',
          },
        }, record.agent.session.id)
        // Validate the tagged wire shape instead of blind casts: anything but
        // a well-formed accepted payload reads as a user cancellation.
        if (typeof response !== 'object' || response === null || Array.isArray(response)) {
          throw new UserQuestionError('malformed ask_user_question response', 'ASK_CANCELLED')
        }
        if (response.outcome !== 'accepted') {
          throw new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
        }
        if (typeof response.answers !== 'object' || response.answers === null || Array.isArray(response.answers)) {
          throw new UserQuestionError('malformed ask_user_question answers', 'ASK_CANCELLED')
        }
        const annotationsRaw = response.annotations
        const annotations = annotationsRaw !== undefined && typeof annotationsRaw === 'object' && !Array.isArray(annotationsRaw)
          ? annotationsRaw as Record<string, { notes?: unknown }>
          : undefined
        const answers: AskUserQuestionAnswer['answers'] = []
        for (const [text, labels] of Object.entries(response.answers)) {
          const id = textToId.get(text)
          if (id === undefined) continue
          // ACP accepts both "value" and ["value"] per answer entry.
          const rawLabels = Array.isArray(labels) ? labels : labels === undefined ? [] : [labels]
          const notes = annotations?.[text]?.notes
          const selected = rawLabels.filter((label): label is string => typeof label === 'string' && label !== 'Other')
          answers.push({ id, selected, ...(typeof notes === 'string' && notes.length > 0 ? { custom: notes } : {}) })
        }
        return { answers }
      },
    })
    ctx.effect(() => disposeProvider, 'grok-leader.userQuestions')
  }

  /** Normalize the two ext wire forms (server.rs method_of): direct x.ai/foo or wrapped _x.ai/foo. */
  const normalizeMethod = (msg: { method: string; params?: unknown }): string => {
    const top = msg.method
    if (top.startsWith('_')) {
      const params = msg.params as { method?: unknown } | null | undefined
      if (params !== null && params !== undefined && typeof params.method === 'string') return params.method
      return top.slice(1)
    }
    return top
  }

  /** Validate request params and read them as a record. */
  const paramRecord = (params: unknown, method: string): Record<string, unknown> => {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw invalidParams(method + ' params must be an object')
    }
    return params as Record<string, unknown>
  }

  /**
   * Slash commands advertised to the grok TUI. The only real bridge command is
   * /preset, sourced from the live preset roster; grok built-ins (/compact, …)
   * are not implemented here and stay off the wire. ponytail: advertising only,
   * /preset is not executed as a preset switch — it reaches the model as text.
   */
  const availableCommands = async (): Promise<Array<{ name: string; description: string; input?: { hint: string } }>> => {
    const roster = agentPresets()
    const presets = roster === undefined ? [] : await roster.list()
    if (presets.length === 0) return []
    return [{
      name: 'preset',
      description: 'Switch the active agent preset',
      input: { hint: presets.map(preset => preset.id).join(' | ') },
    }]
  }

  const initializeResponse = async (): Promise<unknown> => {
    await settingsReady()
    const current = await refreshCatalog()
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, close: {} },
      },
      // Advertise the api-key method so the pager's fail-closed empty-list
      // auth gate treats the leader as authenticated; the harness providers
      // own credentials, so the bridge answers authenticate with no meta.
      authMethods: [{ id: 'xai.api_key', name: 'API key' }],
      agentInfo: { name: 'deepseek-harness-grok-leader', version: '0.1.0-rc.6' },
      // cancelRewind is false: the bridge cancels turns but does not implement
      // the client-side rewind composer restore, so it stays unadvertised.
      // modelState flattens provider-scoped dsh model ids into one global
      // catalog of modelId strings (agent.rs SessionModelState); the
      // leader-side providerByModel map keeps provider ownership for
      // session/set_model.
      _meta: {
        grokShell: true,
        cancelRewind: false,
        sessionRecap: false,
        availableCommands: await availableCommands(),
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

  /**
   * Map the grok agent-selection meta to a dsh preset id. The TUI sends
   * _meta.agentProfile as a string built-in name or an inline JSON definition
   * (pager effects/helpers.rs SessionFlags::to_meta; the shell parses both in
   * upload/turn.rs parse_agent_profile_from_meta). _meta.agentPreset is the
   * dsh-native spelling and wins.
   * @param meta - session/new or session/load _meta.
   * @returns the requested preset id, or undefined for the roster default.
   */
  const presetRequestFromMeta = (meta: Record<string, unknown> | null | undefined): string | undefined => {
    if (meta === undefined || meta === null) return undefined
    const native = meta.agentPreset
    if (native !== undefined) {
      if (typeof native !== 'string') throw invalidParams('_meta.agentPreset must be a string preset id')
      return native
    }
    const profile = meta.agentProfile
    if (profile === undefined) return undefined
    if (typeof profile === 'string') return profile
    if (typeof profile === 'object' && profile !== null && !Array.isArray(profile)) {
      // TODO(verify): an inline grok AgentDefinition (upload/turn.rs:286,
      // AgentDefinition::from_json) has no dsh equivalent; reject instead of
      // silently falling back to the default agent.
      throw invalidParams('_meta.agentProfile JSON definitions are not supported; send a preset id string')
    }
    // Mirrors the grok shell: non-string/non-object values are ignored
    // (upload/turn.rs parse_agent_profile_from_meta warn path).
    return undefined
  }

  /**
   * Resolve the requested preset through the roster and prepare its mount.
   * Without a roster, composition stays with the host plane and no preset is
   * recorded (mirrors the apiproxy composeAgent contract).
   * @param presetRequest - requested preset id, or undefined for the default.
   * @returns the id to record on the session header and the scoped mount.
   */
  const composePreset = async (presetRequest: string | undefined): Promise<{
    agentPreset: string | undefined
    mount: ((agentCtx: Context) => Promise<void>) | undefined
  }> => {
    const roster = agentPresets()
    if (roster === undefined) return { agentPreset: undefined, mount: undefined }
    let resolved: { id: string }
    try {
      resolved = await roster.resolve(presetRequest)
    } catch (error: unknown) {
      // Grok built-in profile names (grok-build-plan, …) have no dsh
      // counterpart and arrive on every session/new from this TUI snapshot;
      // fall back to the roster default instead of failing the session.
      process.stderr.write('grok-leader: unknown preset request fell back to the default: ' + String(error) + '\n')
      resolved = await roster.resolve(undefined)
    }
    return {
      agentPreset: resolved.id,
      mount: agentCtx => roster.mount(agentCtx, resolved.id).then(() => {}),
    }
  }

  /**
   * Resolve a preset id only when it names a real preset in the roster.
   * Returns undefined for an unknown id (or no roster) so callers can fall
   * back to the persisted header preset instead of swallowing the error into
   * the default, which composePreset would do.
   */
  const resolvePresetId = async (request: string): Promise<string | undefined> => {
    const roster = agentPresets()
    if (roster === undefined) return undefined
    try {
      return (await roster.resolve(request)).id
    } catch {
      return undefined
    }
  }

  /** session/new and session/load share the workspace gate: an absolute cwd
   * and no MCP servers (an empty array only; any other mcpServers value is
   * invalid, never silently ignored). Returns the validated cwd. */
  const validateWorkspaceParams = (p: Record<string, unknown>): string => {
    const cwd = p.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalidParams('cwd must be an absolute path: ' + String(cwd))
    const mcpServers = p.mcpServers
    if (mcpServers !== undefined) {
      if (!Array.isArray(mcpServers)) throw invalidParams('mcpServers must be an array')
      if (mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
    }
    return cwd
  }

  const newSession = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/new')
    const cwd = validateWorkspaceParams(p)
    const additionalDirectories = p.additionalDirectories
    if (Array.isArray(additionalDirectories) && additionalDirectories.length > 0) throw invalidParams('additionalDirectories is not supported')
    const meta = p._meta as Record<string, unknown> | null | undefined
    // Clients may pin the session id through _meta.sessionId; absent one, mint it.
    const suppliedId = meta?.sessionId
    const sessionId = typeof suppliedId === 'string' && suppliedId.length > 0 ? SessionId(suppliedId) : SessionId(randomUUID())
    // A pinned id that is already live must not silently replace the record:
    // that would strand the old agent and re-route its reverse channels.
    if (sessions.has(sessionId)) {
      throw invalidParams('session id is already in use: ' + String(sessionId))
    }
    // TODO(verify): the grok leader also injects autoMode, modelId,
    // clientIdentifier, codeNavEnabled, and client terminal/fs routing from the
    // registration capabilities (server.rs:671-770). Only yoloMode and
    // agentProfile/agentPreset are wired.
    const preset = await composePreset(presetRequestFromMeta(meta))
    // Seed the per-agent selection with the harness default so the persona
    // template ("powered by the {{model}} model") can assemble before the TUI
    // ever sends session/set_model.
    const defaultModel = ctx.get('agentDefaultModel') as
      { currentSelection?: () => { provider: string; model: string } } | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const selection: ModelSelectionRef = {
      current: {
        provider: config.provider ?? defaultSelection?.provider ?? 'deepseek-official',
        model: config.model ?? defaultSelection?.model ?? 'deepseek-v4-flash',
      },
      assembled: undefined,
    }
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset },
      },
      agentOptions: agentOptions(config),
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selection)
        return preset.mount === undefined ? undefined : preset.mount(agentCtx)
      },
    })
    if (closed) {
      await handle.dispose()
      throw internalError('the grok leader was disposed during session/new')
    }
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      clientId,
      selection,
      yolo: meta?.yoloMode === true,
      // -1 admits a first event at seq 0 through the seq <= lastSeq replay gate.
      lastSeq: -1,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      pendingToolCalls: new Map(),
      textStreamed: false,
      prompts: [],
      promptQueue: [],
      runningPromptId: undefined,
      runningText: undefined,
      runningCombinedTexts: undefined,
      cancelTrigger: undefined,
      editHolds: new Set(),
      mcpInitTimer: undefined,
      inflight: undefined,
    }
    sessions.set(sessionId, record)
    // The pager parks on "Starting session…" until this arrives (the probe
    // worker's scripted fake sends it 50 ms after the session/new result;
    // docs/grok-tui-connect.md).
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      record.mcpInitTimer = setTimeout(() => {
        record.mcpInitTimer = undefined
        // Notify only while this record still owns the session and the client:
        // a close/teardown clears the timer, and a reload re-parents the id.
        if (ownedRecord(clientId, sessionId) === record && connections.get(clientId) === conn) {
          sendNotification(conn, '_x.ai/mcp_initialized', { sessionId })
        }
      }, 50)
    }
    return { sessionId }
  }

  /** Terminal signal for one settled turn (grok x.ai/session/prompt_complete rail). */
  const emitPromptComplete = (record: SessionRecord, id: string, stopReason: StopReasonWire): void => {
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    sendNotification(conn, 'x.ai/session/prompt_complete', {
      sessionId: record.agent.session.id,
      promptId: id,
      stopReason,
      ...record.cancelTrigger === undefined ? {} : { cancelTrigger: record.cancelTrigger },
    })
    record.cancelTrigger = undefined
  }

  /** Broadcast the live queue to the pager: pending rows plus the running prompt. */
  const broadcastQueueChanged = (record: SessionRecord): void => {
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    sendNotification(conn, 'x.ai/queue/changed', {
      sessionId: record.agent.session.id,
      entries: record.promptQueue.map((entry, index) => ({
        id: entry.id,
        version: entry.version,
        kind: 'prompt',
        text: entry.text,
        position: index,
      })),
      ...record.runningPromptId === undefined ? {} : {
        runningPromptId: record.runningPromptId,
        runningText: record.runningText,
        runningKind: 'prompt',
        ...record.runningCombinedTexts === undefined ? {} : { runningCombinedTexts: record.runningCombinedTexts },
      },
    })
  }

  /**
   * Run one validated prompt: admit it, stream the echo, and settle at turn
   * end (or idle for a turnless slot).
   */
  const runPrompt = async (record: SessionRecord, id: string, text: string, combinedTexts?: string[]): Promise<{ stopReason: StopReasonWire }> => {
    if (agents.get(record.agent.id) !== record.agent) {
      throw internalError('prompt was not queued: the agent was disposed outside the bridge')
    }
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    record.runningPromptId = id
    record.runningText = combinedTexts === undefined || combinedTexts[0] === undefined ? text : combinedTexts[0]
    record.runningCombinedTexts = combinedTexts
    let stopReason: StopReasonWire | undefined
    let failure: unknown
    try {
      stopReason = await new Promise<StopReasonWire>((resolve, reject) => {
        const inflight: NonNullable<SessionRecord['inflight']> = {
          resolve, reject, messageId: message.id, promptId: id, turn: undefined, endReason: undefined,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
        } catch (error: unknown) {
          record.inflight = undefined
          reject(internalError('prompt was not queued: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
      // Echo the accepted prompt so it enters the client transcript, then let
      // the turn stream. Settlement happens at the correlated turn/end; a
      // turnless slot (admission discarded the prompt) settles cancelled at idle.
      broadcastQueueChanged(record)
      const conn = connections.get(record.clientId)
      if (conn !== undefined) {
        emitUpdate(conn, record, undefined, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
        }, false, Date.now())
      }
      void record.agent.whenIdle().then(() => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.resolve('cancelled')
      }, (error: unknown) => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.reject(internalError('agent idle wait failed: ' + errorChain(error)))
      })
      })
    } catch (error: unknown) {
      failure = error
      // A throw from the echo/broadcast above rejects the promise with the
      // inflight still set; clearing it here guarantees advancePromptQueue is
      // never stalled behind a settled failure.
      record.inflight = undefined
    }
    // Cleanup on BOTH paths: a followup rejection or a rejected turn must not
    // strand runningPromptId or stall the queued successors.
    record.runningPromptId = undefined
    record.runningText = undefined
    record.runningCombinedTexts = undefined
    if (failure === undefined && stopReason !== undefined) emitPromptComplete(record, id, stopReason)
    if (record.promptQueue.length > 0) {
      // Promote only once the agent is truly idle: the harness discards a
      // followup admitted from inside the turn/end event handler (its loop
      // has not finished the turn yet), which settled the queued prompt as
      // cancelled without a turn.
      advanceWhenIdle(record)
    } else {
      broadcastQueueChanged(record)
    }
    if (failure !== undefined) throw failure
    // A settled prompt must always carry a stop reason; an undefined one here
    // means the settlement path broke, and a silent non-null assertion would
    // lie to the pager about how the turn ended.
    if (stopReason === undefined) throw internalError('prompt settled without a stop reason')
    return { stopReason }
  }

  /** Start the next queued prompt once the in-flight one has settled. */
  const advancePromptQueue = (record: SessionRecord): void => {
    if (record.inflight !== undefined) return
    const front = record.promptQueue[0]
    if (front === undefined) return
    // A held front parks the whole queue (grok maybe_start_running_task):
    // nothing promotes until queue/release_edit clears the hold.
    if (record.editHolds.has(front.id)) return
    // grok combine: with 2+ queued prompts, fold the followers into the front
    // (text joined with blank lines; followers resolve as removed). Every bridge
    // entry is a validated text prompt, so the grok gates (images/bash/skills)
    // are satisfied trivially. ponytail: config-gated, default off.
    if (combineQueued && record.promptQueue.length >= 2) {
      const segments = [front.text]
      // Held followers never fold into the front; the run stops at the first
      // held row (xai_prompt_queue::can_merge_follower).
      while (record.promptQueue.length >= 2 && !record.editHolds.has(record.promptQueue[1]!.id)) {
        const follower = record.promptQueue.splice(1, 1)[0]!
        segments.push(follower.text)
        follower.resolve({ stopReason: 'cancelled' })
      }
      if (segments.length >= 2) front.combinedTexts = segments
    }
    const entry = record.promptQueue.shift()!
    const runText = entry.combinedTexts === undefined ? entry.text : entry.combinedTexts.join('\n\n')
    void runPrompt(record, entry.id, runText, entry.combinedTexts).then(entry.resolve, entry.reject)
  }

  /** Promote the next queued prompt once the agent reports idle.
   *
   * The idle gate is load-bearing: the harness discards a followup admitted
   * from inside its turn/end event handler, so a promotion must wait for the
   * next idle signal. The live-record guard mirrors the settle path: a closed,
   * reloaded, or re-parented session must not resurrect queued prompts through
   * a stale agent reference. Every promotion (settle or queue-mutation) routes
   * through here so no path can bypass the gate. */
  const advanceWhenIdle = (record: SessionRecord): void => {
    void record.agent.whenIdle().then(() => {
      if (closed || sessions.get(record.agent.session.id) !== record) return
      advancePromptQueue(record)
    }, (error: unknown) => {
      logger.warn('grok-leader: idle wait failed for ' + String(record.agent.session.id) + ': ' + errorChain(error))
    })
  }

  /** Settle every queued (not-yet-run) prompt as cancelled (cancel/close/teardown). */
  const discardPromptQueue = (record: SessionRecord): void => {
    // A discarded row can never be promoted, so its edit hold must not linger
    // and accidentally park a future row that reuses the same id.
    record.editHolds.clear()
    for (const entry of record.promptQueue.splice(0)) entry.resolve({ stopReason: 'cancelled' })
  }

  /** Enqueue a validated prompt and run it as soon as the session is idle. */
  const enqueuePrompt = (record: SessionRecord, p: Record<string, unknown>, text: string): Promise<{ stopReason: StopReasonWire }> =>
    new Promise((resolve, reject) => {
      const meta = p._meta as Record<string, unknown> | null | undefined
      const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
      // Fresh rows start at version 0 (grok QueueEntryMeta); edits bump by one.
      record.promptQueue.push({ resolve, reject, id, text, version: 0 })
      advancePromptQueue(record)
      broadcastQueueChanged(record)
    })

  const prompt = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/prompt')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const blocks = p.prompt
    if (promptHasUnsupportedContent(blocks)) {
      throw invalidParams('only text and resource_link prompt content is supported')
    }
    const text = acpPromptToText(blocks)
    if (text.trim().length === 0) throw invalidParams('empty prompt')
    // A prompt joins the session history at acceptance, mirroring the grok
    // shell's queue-time history append.
    record.prompts.push(text)
    return await enqueuePrompt(record, p, text)
  }

  const cancel = (clientId: number, params: unknown): void => {
    const p = typeof params === 'object' && params !== null && !Array.isArray(params)
      ? params as Record<string, unknown>
      : undefined
    const sessionId = p !== undefined && typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) return
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    discardPromptQueue(record)
    rejectPendingFor(clientId, record.agent.session.id)
    broadcastQueueChanged(record)
  }

  const loadSession = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/load')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    if (sessionId === undefined) throw invalidParams('session/load requires a sessionId')
    validateWorkspaceParams(p)
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      // A live session has exactly one owning connection. The owner's own
      // load is the preset-switch live reload; a foreign client never
      // displaces a live owner and reads exactly like an unknown id (the
      // session's existence must not leak). Once the owner's socket is gone
      // the session is re-attachable: that is the TUI reconnect path, where a
      // leader respawn hands the client a fresh clientId before it re-loads.
      if (existing.clientId !== clientId && connections.get(existing.clientId) !== undefined) {
        throw invalidParams('unknown session: ' + String(sessionId))
      }
      // Dispose the existing record first so the same id can be re-attached
      // under a different preset (or by the reconnecting owner).
      sessions.delete(sessionId)
      existing.agent.cancel({ kind: 'user' })
      settlePrompt(existing, 'cancelled')
      discardPromptQueue(existing)
      // The OLD owner's outstanding reverse requests must not outlive the
      // takeover; the same-owner reload rejects its own pending roundtrips.
      rejectPendingFor(existing.clientId, sessionId)
      clearMcpInitTimer(existing)
      const store = ctx.get('sessions') as SessionsLike | undefined
      if (store !== undefined) await store.flush(existing.agent.session)
      await existing.dispose()
    }
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    const inspection = await store.load(sessionId)
    // An explicitly requested preset id that names a real preset wins over
    // the persisted header preset (preset switch); otherwise the persisted
    // value wins, then the roster default for headers that predate presets.
    const meta = p._meta as Record<string, unknown> | null | undefined
    const explicit = presetRequestFromMeta(meta)
    const presetRequest = explicit === undefined
      ? inspection.meta.agentPreset
      : (await resolvePresetId(explicit)) ?? inspection.meta.agentPreset
    const preset = await composePreset(presetRequest)
    const defaultModel = ctx.get('agentDefaultModel') as
      { currentSelection?: () => { provider: string; model: string } } | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const selection: ModelSelectionRef = {
      current: {
        provider: config.provider ?? defaultSelection?.provider ?? 'deepseek-official',
        model: config.model ?? defaultSelection?.model ?? 'deepseek-v4-flash',
      },
      assembled: undefined,
    }
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(config),
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selection)
        return preset.mount === undefined ? undefined : preset.mount(agentCtx)
      },
    })
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      clientId,
      selection,
      // TODO(verify): yoloMode/autoMode on session/load meta (server.rs:671-770).
      yolo: false,
      // -1 admits a first replayed event at seq 0 through the seq <= lastSeq gate.
      lastSeq: -1,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      pendingToolCalls: new Map(),
      textStreamed: false,
      prompts: [],
      promptQueue: [],
      runningPromptId: undefined,
      runningText: undefined,
      runningCombinedTexts: undefined,
      cancelTrigger: undefined,
      editHolds: new Set(),
      mcpInitTimer: undefined,
      inflight: undefined,
    }
    sessions.set(sessionId, record)
    // Rebuild the up-arrow history from the persisted user prompts so
    // x.ai/prompt_history serves them after resume.
    for (const event of inspection.events) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: unknown } }).source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      const text = textBlocks(event.data.content).map(block => block.text).join('')
      if (text.trim().length > 0) record.prompts.push(text)
    }
    // Replay the persisted transcript with isReplay stamps BEFORE the response,
    // so the client renders history ahead of any live deltas. Live notifications
    // racing the replay are dropped by the high-water mark; buffering them for a
    // gap-free flush is deferred (server.rs MAX_BUFFERED_LIVE_PER_LOAD).
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      for (const event of inspection.events) {
        // Keep turnStartMs current so replayed updates carry streamStartMs
        // and the pager renders ThinkingBlock durations on resume.
        if (event.type === 'turn/start') record.turnStartMs = event.time
        for (const item of mapEvent(record, event, true)) {
          emitUpdate(conn, record, event.seq, item, true, event.time)
        }
      }
    }
    return {}
  }

  const listSessions = async (): Promise<unknown> => {
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    const headers = await store.list()
    // TODO(verify): SessionInfo field set (agent.rs SessionInfo): title is
    // empty and the cwd filter plus cursor pagination are not implemented.
    return {
      sessions: headers.filter(header => header.cwd !== undefined).map(header => ({
        sessionId: header.id,
        cwd: header.cwd,
        updatedAt: new Date(header.createdAt).toISOString(),
      })),
    }
  }

  const setSessionModel = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/set_model')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const modelId = p.modelId
    if (typeof modelId !== 'string' || modelId.length === 0) throw invalidParams('modelId must be a non-empty string')
    const meta = p._meta as Record<string, unknown> | null | undefined
    const reasoningEffort = meta?.reasoningEffort
    // TODO(verify): grok modelId is a global catalog id (agent.rs
    // SetSessionModelRequest); dsh needs a provider+model pair, so the provider
    // comes from the catalog's modelId -> provider mapping, then the agent's
    // own route, then config.provider.
    const current = await currentCatalog()
    // Never persist an unresolvable selection: a modelId the client has not
    // been offered cannot name a provider route.
    if (!current.providerByModel.has(modelId)) {
      throw invalidParams('modelId is not in the catalog: ' + modelId)
    }
    const provider = current.providerByModel.get(modelId) ?? record.agent.options.provider ?? config.provider ?? ''
    const selection = {
      provider,
      model: modelId,
      ...typeof reasoningEffort === 'string' && reasoningEffort.length > 0
        ? { reasoningEffort: ReasoningEffortId(reasoningEffort) }
        : {},
    }
    record.selection.current = selection
    if (agentDefaultModel !== undefined) await agentDefaultModel.saveSelection(selection)
    // The catalog may have fallen back to a different provider's model (or the
    // persisted default may have moved providers); refresh so the next
    // models/list (and initialize _meta) reports the provider that now owns
    // the current model. Without this a re-spawned TUI shows the pre-switch
    // provider scope.
    if (catalog !== undefined) await refreshCatalog()
    return {}
  }

  /**
   * Interrogate the gateway for one draft provider's catalog, for the case the
   * official seam refused: a route the installed pi-ai catalog does not
   * describe must name its models. The key comes from the environment the
   * form named (v1 auth is env-key only); a miss probes unauthenticated. A
   * resolved secret only travels to a baseURL this bridge already knows; a
   * brand-new endpoint receives the env NAME, never the resolved value.
   */
  const discoverProviderModels = async (
    id: string,
    p: Record<string, unknown>,
  ): Promise<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>> => {
    // Method call, not a detached const: the llm service method reads
    // this.discoveries (a detached reference would lose the receiver).
    if (llm === undefined || llm.discoverModels === undefined) {
      throw internalError('cannot add provider "' + id + '": the installed catalog does not describe it and no model discovery is configured')
    }
    const apiKeyEnv = typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : undefined
    const baseURL = typeof p.baseURL === 'string' ? p.baseURL : undefined
    // Exfil guard: the resolved env value may only be handed to an endpoint
    // whose baseURL is already a persisted provider route (re-provide under a
    // known endpoint). Anything else — including a brand-new baseURL — gets
    // the env NAME so the gateway can resolve it locally without shipping the
    // secret to a client-chosen host.
    const apiKey = apiKeyEnv === undefined
      ? undefined
      : baseURL !== undefined && knownRouteBaseUrls().includes(baseURL)
        ? process.env[apiKeyEnv]
        : apiKeyEnv
    let models
    try {
      models = await llm.discoverModels(PROVIDER_SETTINGS_NS, {
        provider: id,
        ...typeof p.api === 'string' ? { api: p.api } : {},
        ...baseURL === undefined ? {} : { baseURL },
        ...apiKey === undefined || apiKey === '' ? {} : { apiKey },
      })
    } catch (error: unknown) {
      throw internalError('cannot add provider "' + id + '": model discovery failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (models.length === 0) {
      throw internalError('cannot add provider "' + id + '": its endpoint listed no models')
    }
    return models.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }))
  }

  /**
   * Wait (bounded) for the settings service, then one extra macrotask so a
   * freshly published document's namespace owners (llm-pi-ai) can register
   * their routes. The first catalog snapshot must not race the settings boot:
   * an early initialize otherwise serves a roster missing every profile route.
   */
  const settingsReady = async (): Promise<void> => {
    const deadline = Date.now() + 5000
    while (settings() === undefined && Date.now() < deadline) {
      await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 10) })
    }
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
  }

  /**
   * Add one provider route to the dsh settings document through the official
   * settings seam (ctx.settings.mutate on the llm-pi-ai namespace), never by
   * writing settings.yaml directly. A duplicate route id is refused; a route
   * the installed catalog does not describe gets its models from gateway
   * discovery. On success the refreshed provider roster comes back so the TUI
   * can update /provider immediately.
   */
  const addProvider = async (params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'x.ai/providers/add')
    const id = p.id
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
      throw invalidParams('provider id must be lowercase kebab-case (letters, digits, hyphens; starts with a letter)')
    }
    validateProviderForm(p)
    const providerService = settings()
    if (providerService === undefined) throw internalError('the settings service is not configured')
    if (llm !== undefined && llm.listProviders().some(provider => provider.id === id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" already exists')
    }
    await mutateProviderRoute(providerService, id, editableProfile(p), p, 'add')
    const current = await refreshCatalog()
    return { providers: current.providers, currentProviderId: current.currentProviderId }
  }

  /** Reject malformed form fields before any settings write. */
  const validateProviderForm = (p: Record<string, unknown>): void => {
    for (const field of ['displayName', 'apiKeyEnv', 'baseURL'] as const) {
      const value = p[field]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw invalidParams(field + ' must be a string')
      }
    }
    const api = p.api
    if (api !== undefined && api !== null && (typeof api !== 'string' || !PROVIDER_APIS.includes(api as (typeof PROVIDER_APIS)[number]))) {
      throw invalidParams('api must be one of ' + PROVIDER_APIS.join(', '))
    }
    const baseURL = p.baseURL
    if (typeof baseURL === 'string' && baseURL.length > 0) {
      let parsed: URL
      try {
        parsed = new URL(baseURL)
      } catch {
        throw invalidParams('baseURL must be an absolute http/https URL: ' + baseURL)
      }
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
        throw invalidParams('baseURL must be http/https with no userinfo: ' + baseURL)
      }
    }
  }

  // An empty optional field means "unset": the official schema resolves an
  // absent key to the catalog default, while an empty string is refused.
  const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

  /** The four form fields as a fresh profile (empty fields omitted). */
  const editableProfile = (p: Record<string, unknown>): Record<string, unknown> => ({
    ...nonEmpty(p.displayName) ? { displayName: p.displayName } : {},
    ...nonEmpty(p.apiKeyEnv) ? { apiKeyEnv: p.apiKeyEnv } : {},
    ...nonEmpty(p.api) ? { api: p.api } : {},
    ...nonEmpty(p.baseURL) ? { baseURL: p.baseURL } : {},
  })

  /** Merge the form fields over the current profile; empty fields unset. */
  const mergeEditable = (current: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...current }
    for (const field of ['displayName', 'apiKeyEnv', 'api', 'baseURL'] as const) {
      const value = p[field]
      if (value === undefined) continue // absent key keeps the current profile value
      if (typeof value === 'string' && value.length > 0) next[field] = value
      else delete next[field] // an explicit empty field unsets
    }
    return next
  }

  /**
   * Write one provider profile through the official seam. A refusal that
   * names the no-models case retries once with the gateway-discovered
   * catalog (same retry providers/add always had).
   */
  const mutateProviderRoute = async (
    providerService: SettingsLike,
    id: string,
    profile: Record<string, unknown>,
    draft: Record<string, unknown>,
    verb: 'add' | 'update',
  ): Promise<void> => {
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'set', path: ['providers', id], value: profile }])
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // A route the installed catalog does not describe must spell out its
      // models; the official validation names exactly that case. Ask the
      // gateway and retry the same write with the discovered catalog.
      if (!message.includes(NO_MODELS_MARKER)) {
        throw internalError('failed to ' + verb + ' provider "' + id + '": ' + message)
      }
      const models = await discoverProviderModels(id, draft)
      try {
        await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'set', path: ['providers', id], value: { ...profile, models } }])
      } catch (retryError: unknown) {
        throw internalError('failed to ' + verb + ' provider "' + id + '": ' + (retryError instanceof Error ? retryError.message : String(retryError)))
      }
    }
  }

  /**
   * Update one provider route's editable fields through the same official
   * seam. The current user profile is merged so fields the form does not
   * edit (models) survive; empty optional fields revert to the catalog
   * default, exactly as providers/add treats them.
   */
  const updateProvider = async (params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'x.ai/providers/update')
    const providerId = p.providerId
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
      throw invalidParams('providerId must be lowercase kebab-case (letters, digits, hyphens; starts with a letter)')
    }
    validateProviderForm(p)
    const providerService = settings()
    if (providerService === undefined) throw internalError('the settings service is not configured')
    if (llm === undefined || !llm.listProviders().some(provider => provider.id === providerId)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + providerId + '" does not exist')
    }
    const currentProfile = providerUserProfile(providerUserSection(providerService), providerId)
    const next = mergeEditable(currentProfile, p)
    await mutateProviderRoute(providerService, providerId, next, p, 'update')
    const current = await refreshCatalog()
    return { providers: current.providers, currentProviderId: current.currentProviderId }
  }

  /**
   * Remove one provider route through the official seam. The provider that
   * owns the current/default model is refused: the TUI must switch away
   * first, so a removal can never orphan the active selection.
   */
  const removeProvider = async (params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'x.ai/providers/remove')
    const id = p.id
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
      throw invalidParams('provider id must be lowercase kebab-case (letters, digits, hyphens; starts with a letter)')
    }
    const providerService = settings()
    if (providerService === undefined) throw internalError('the settings service is not configured')
    if (llm === undefined || !llm.listProviders().some(provider => provider.id === id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" does not exist')
    }
    const current = await refreshCatalog()
    if (current.currentProviderId === id) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" is in use; switch to another provider first')
    }
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }])
    } catch (error: unknown) {
      throw internalError('failed to remove provider "' + id + '": ' + (error instanceof Error ? error.message : String(error)))
    }
    const refreshed = await refreshCatalog()
    return { providers: refreshed.providers, currentProviderId: refreshed.currentProviderId }
  }

  const modelsList = async (): Promise<unknown> => {
    const current = await refreshCatalog()
    return {
      currentModelId: current.currentModelId,
      availableModels: current.availableModels,
      _meta: {
        currentProviderId: current.currentProviderId,
        providers: current.providers,
      },
    }
  }

  /** One session's accepted prompts, most-recent-first (scrollback/up-arrow). */
  const promptHistory = (clientId: number, params: unknown): { prompts: string[] } => {
    const p = paramRecord(params, 'x.ai/prompt_history')
    const scoped = typeof p.filter_session_id === 'string'
      ? SessionId(p.filter_session_id)
      : typeof p.session_id === 'string'
        ? SessionId(p.session_id)
        : undefined
    const record = ownedRecord(clientId, scoped)
    if (scoped !== undefined && record === undefined) throw invalidParams('unknown session: ' + String(scoped))
    return { prompts: record === undefined ? [] : [...record.prompts].reverse() }
  }

  /**
   * The dsh preset roster as the grok bundle persona list. The TUI renders
   * one persona per preset; selecting one sends its name back as
   * _meta.agentProfile, which composePreset maps to the preset id.
   */
  const bundleStatus = async (): Promise<unknown> => {
    const roster = agentPresets()
    const presets = roster === undefined ? [] : await roster.list()
    return {
      hasCache: presets.length > 0,
      personas: presets.map(preset => preset.id),
      roles: [],
      agents: [],
      skills: [],
      personaDetails: presets.map((preset) => {
        const shipped = preset.trust === 'system' ? SHIPPED_PRESET_DISPLAY[preset.id] : undefined
        const name = shipped?.name ?? preset.name ?? preset.id
        const description = shipped?.description ?? preset.description
        return {
          name,
          ...description === undefined ? {} : { description },
          hasInputs: false,
          hasOutputs: false,
        }
      }),
      roleDetails: [],
    }
  }

  const closeSession = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/close')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    discardPromptQueue(record)
    rejectPendingFor(clientId, record.agent.session.id)
    clearMcpInitTimer(record)
    sessions.delete(record.agent.session.id)
    const store = ctx.get('sessions') as SessionsLike | undefined
    if (store !== undefined) await store.flush(record.agent.session)
    await record.dispose()
    return {}
  }

  const dispatchRequest = async (clientId: number, method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case WIRE.initialize:
        return await initializeResponse()
      case WIRE.authenticate:
        return {}
      case WIRE.sessionNew:
        return await newSession(clientId, params)
      case WIRE.sessionPrompt:
        return await prompt(clientId, params)
      case WIRE.sessionLoad:
        return await loadSession(clientId, params)
      case WIRE.sessionList:
        return await listSessions()
      case WIRE.sessionSetModel:
        return await setSessionModel(clientId, params)
      case WIRE.sessionClose:
        return await closeSession(clientId, params)
      case WIRE.modelsList:
        return await modelsList()
      case WIRE.providersAdd:
        return await addProvider(params)
      case WIRE.providersUpdate:
        return await updateProvider(params)
      case WIRE.providersRemove:
        return await removeProvider(params)
      case 'x.ai/commands/list':
        return { commands: await availableCommands() }
      case 'x.ai/prompt_history':
        return promptHistory(clientId, params)
      case 'x.ai/marketplace/list':
        return { sources: [] }
      case 'x.ai/billing':
        return { config: null, onDemandEnabled: false, subscriptionTier: null }
      case 'x.ai/bundle/status':
        return await bundleStatus()
      case 'x.ai/suggestPrompt':
        return { suggestion: null, generation: (params as { generation?: number } | undefined)?.generation ?? 0 }
      case 'x.ai/session/info': {
        const p = paramRecord(params, 'x.ai/session/info')
        const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
        const record = ownedRecord(clientId, sessionId)
        if (sessionId !== undefined && record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
        const total = 100000
        const used = record === undefined ? 0 : record.inputTokens + record.outputTokens
        return {
          result: {
            sessionId: record?.agent.session.id ?? '',
            cwd: record?.agent.session.header.cwd ?? '',
            turns: record?.turnCount ?? 0,
            turnIndex: record === undefined ? 0 : Math.max(0, record.turnCount - 1),
            model: null,
            context: {
              used, total, systemPromptTokens: 0, toolDefinitionsCount: 0,
              toolDefinitionsTokens: 0, compactionCount: 0, turnCount: record?.turnCount ?? 0,
              toolCallCount: record?.toolCallCount ?? 0, messageCount: record?.messageCount ?? 0,
              messageTokens: used, freeTokens: total - used, usagePct: Math.min(100, Math.round((used / total) * 100)),
            },
          },
        }
      }
      case 'x.ai/session/list': {
        const lp = paramRecord(params, 'x.ai/session/list')
        const query = typeof lp.query === 'string' ? lp.query.toLowerCase() : undefined
        const cwd = typeof lp.cwd === 'string' ? lp.cwd : undefined
        const requested = typeof lp.limit === 'number' && lp.limit > 0 ? Math.floor(lp.limit) : DEFAULT_SESSION_LIST_LIMIT
        const limit = Math.min(requested, DEFAULT_SESSION_LIST_LIMIT)
        const store = ctx.get('sessionPersistence')
        const headers = store === undefined ? [] : await store.list()
        // Backfill display titles BEFORE the query filter so picker search can
        // match prompt text. Misses stay uncached (retried on the next list)
        // and the in-flight set stops concurrent list calls stacking loads.
        if (store !== undefined) {
          await Promise.all(headers.map(async header => {
            if (firstPromptCache.has(header.id) || firstPromptInFlight.has(header.id)) return
            firstPromptInFlight.add(header.id)
            try {
              const inspection = await store.load(SessionId(header.id))
              cacheFirstPrompt(header.id, firstUserPrompt(inspection.events))
            } catch {
              // A broken artifact must not sink the list; the miss is retried.
            } finally {
              firstPromptInFlight.delete(header.id)
            }
          }))
        }
        let rows = headers.map(header => ({
          sessionId: header.id,
          cwd: header.cwd ?? '',
          createdAt: new Date(header.createdAt).toISOString(),
          // No cheap updatedAt on the header; createdAt keeps old rows within the picker window.
          updatedAt: new Date(header.createdAt).toISOString(),
          firstPrompt: cachedFirstPrompt(header.id) ?? '',
          // Chat-kind rows skip the TUI's local-store gate (grok's own session
          // docs, which dsh sessions never enter) and load straight via session/load.
          _meta: { 'x.ai/session': { kind: 'chat' } },
        }))
        if (cwd !== undefined) rows = rows.filter(row => row.cwd === cwd)
        if (query !== undefined && query.length > 0) rows = rows.filter(row => (row.sessionId + ' ' + row.cwd + ' ' + row.firstPrompt).toLowerCase().includes(query))
        rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        rows = rows.slice(0, limit)
        return { sessions: rows }
      }
      case 'x.ai/sessions/list': {
        const persistence = ctx.get('sessionPersistence')
        const headers = persistence === undefined ? [] : await persistence.list()
        return {
          result: {
            sessions: headers.map(header => ({
              sessionId: header.id,
              cwd: header.cwd ?? '',
              isWorktree: false,
              yolo: false,
              activity: 'dormant',
              resident: false,
              lastChangeUnixMs: header.createdAt,
            })),
          },
        }
      }
      default:
        throw new RpcError(JSONRPC_METHOD_NOT_FOUND, 'method not found: ' + method)
    }
  }

  const handleNotification = (clientId: number, method: string, params: unknown): void => {
    // Ext notifications ride as {method:'_x.ai/foo', params:{method:'x.ai/foo', params:{...}}}.
    const outer = params as Record<string, unknown> | undefined
    const unwrapped = outer !== undefined && typeof outer.params === 'object' && outer.params !== null
      && (outer.method === undefined || outer.method === method)
      ? outer.params as Record<string, unknown>
      : outer
    const queueRecord = (p: Record<string, unknown>): SessionRecord | undefined => {
      if (typeof p.sessionId !== 'string') return undefined
      return ownedRecord(clientId, SessionId(p.sessionId))
    }
    const queueEntry = (record: SessionRecord, id: unknown): { index: number; entry: SessionRecord['promptQueue'][number] } | undefined => {
      if (typeof id !== 'string') return undefined
      const index = record.promptQueue.findIndex(entry => entry.id === id)
      return index < 0 ? undefined : { index, entry: record.promptQueue[index]! }
    }
    const queueMutate = (record: SessionRecord): void => {
      broadcastQueueChanged(record)
    }
    switch (method) {
      case WIRE.sessionCancel:
        cancel(clientId, params)
        return
      case 'x.ai/queue/interject': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        // The client supplies the version it last saw (absent = 0, the version
        // of never-edited rows); a mismatch is a benign no-op + resync.
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(record, p.id)
        if (located === undefined || located.entry.version !== expectedVersion) {
          if (typeof p.id === 'string') record.editHolds.delete(p.id)
          advanceWhenIdle(record)
          queueMutate(record)
          advancePromptQueue(record)
          return
        }
        const [entry] = record.promptQueue.splice(located.index, 1)
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          entry.text = p.newText
          entry.combinedTexts = undefined
          entry.version = entry.version + 1
        }
        record.promptQueue.unshift(entry)
        record.editHolds.delete(entry.id)
        // grok send-now: cancel the running turn and run this prompt next.
        // cancelTrigger='send_now' suppresses the pager's Turn-cancelled marker.
        if (record.inflight !== undefined) {
          record.cancelTrigger = 'send_now'
          record.agent.cancel({ kind: 'user' })
          settlePrompt(record, 'cancelled')
        } else {
          advanceWhenIdle(record)
        }
        queueMutate(record)
        return
      }
      case 'x.ai/queue/remove': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(record, p.id)
        if (located !== undefined && located.entry.version !== expectedVersion) {
          // Stale version: leave the row untouched and resync the client.
          record.editHolds.delete(located.entry.id)
          advanceWhenIdle(record)
          queueMutate(record)
          advancePromptQueue(record)
          return
        }
        if (located !== undefined) {
          const [entry] = record.promptQueue.splice(located.index, 1)
          entry.resolve({ stopReason: 'cancelled' })
          record.editHolds.delete(entry.id)
          queueMutate(record)
          // Removing a held front must not strand the rows behind it.
          advancePromptQueue(record)
          return
        }
        if (record.runningPromptId === p.id) {
          record.agent.cancel({ kind: 'user' })
          settlePrompt(record, 'cancelled')
          record.editHolds.delete(String(p.id))
        }
        advanceWhenIdle(record)
        queueMutate(record)
        return
      }
      case 'x.ai/queue/edit': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        const located = queueEntry(record, p.id)
        if (located === undefined) return
        // Every path drops the hold (grok handle_edit_queued_prompt): a stale
        // or blank edit must not leave promotion parked.
        record.editHolds.delete(located.entry.id)
        // The TUI sends no version for edit (grok edits LWW); honor one when a
        // client pins it: a stale version no-ops + resyncs like remove/interject.
        if (typeof p.expectedVersion === 'number' && located.entry.version !== p.expectedVersion) {
          advanceWhenIdle(record)
          queueMutate(record)
          return
        }
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          located.entry.text = p.newText
          located.entry.combinedTexts = undefined
          located.entry.version = located.entry.version + 1
        }
        advanceWhenIdle(record)

        queueMutate(record)
        return
      }
      case 'x.ai/queue/hold_edit': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        if (typeof p.id === 'string') record.editHolds.add(p.id)
        return
      }
      case 'x.ai/queue/release_edit': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        if (typeof p.id !== 'string' || !record.editHolds.delete(p.id)) return
        // Unblocks a front parked under edit hold (grok SessionCommand::ReleaseEdit).
        advanceWhenIdle(record)
        return
      }
      case 'x.ai/queue/reorder': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        const orderedIds = Array.isArray(p.orderedIds) ? p.orderedIds.filter((id): id is string => typeof id === 'string') : []
        let changed = false
        if (orderedIds.length > 0) {
          const byId = new Map(record.promptQueue.map(entry => [entry.id, entry]))
          const next: typeof record.promptQueue = []
          for (const id of orderedIds) {
            const entry = byId.get(id)
            if (entry === undefined) continue
            next.push(entry)
            byId.delete(id)
          }
          for (const entry of record.promptQueue) if (byId.has(entry.id)) next.push(entry)
          changed = next.length === record.promptQueue.length
            && next.some((entry, index) => entry !== record.promptQueue[index])
          record.promptQueue.splice(0, record.promptQueue.length, ...next)
        }
        if (changed) advanceWhenIdle(record)
        queueMutate(record)
        // Reordering can move a held front out of the lead; unblock the new front.
        advancePromptQueue(record)
        return
      }
      case 'x.ai/queue/clear': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        discardPromptQueue(record)
        queueMutate(record)
        return
      }
      default:
        // Grok drops unknown ACP notifications (server.rs:1515).
        logger.warn('grok-leader: dropped notification ' + method)
    }
  }

  const handleAcp = async (conn: ClientConnection, raw: string): Promise<void> => {
    let value: unknown
    try {
      value = JSON.parse(raw.trimEnd())
    } catch (error: unknown) {
      logger.warn('grok-leader: dropping unparseable acp payload: ' + String(error))
      return
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      logger.warn('grok-leader: dropping non-object acp payload')
      return
    }
    const msg = value as Record<string, unknown>
    const method = typeof msg.method === 'string' ? msg.method : undefined
    if (method === undefined) {
      settlePending(conn, value)
      return
    }
    const normalized = normalizeMethod({ method, params: msg.params })
    const id = msg.id
    if (id === undefined) {
      handleNotification(conn.clientId, normalized, msg.params)
      return
    }
    try {
      const result = await dispatchRequest(conn.clientId, normalized, msg.params)
      sendAcp(conn, { jsonrpc: '2.0', id, result })
    } catch (error: unknown) {
      const rpc = error instanceof RpcError ? error : new RpcError(JSONRPC_INTERNAL_ERROR, errorChain(error))
      sendAcp(conn, { jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message } })
    }
  }

  /** Grace timer that exits the host after the last client disconnects.
   *  dsh is a foreground CLI process, not grok's daemon: with no clients the
   *  leader has nothing to serve, so it quiesces and asks the launcher for a
   *  bounded exit (ctx.appExit). Sessions persist on disk and the TUI
   *  respawns a fresh leader on the next start, so nothing is lost.
   *  ponytail: 2s grace covers accidental reconnects; grok's 30s zombie
   *  timer is deliberately NOT reused here. */
  /** In-flight per-client teardowns (flush + dispose); the idle exit awaits them. */
  const teardowns = new Set<Promise<void>>()
  let idleExitTimer: ReturnType<typeof setTimeout> | undefined
  const cancelIdleExit = (): void => {
    if (idleExitTimer !== undefined) {
      clearTimeout(idleExitTimer)
      idleExitTimer = undefined
    }
  }
  const scheduleIdleExit = (): void => {
    cancelIdleExit()
    if (connections.size > 0) return
    idleExitTimer = setTimeout(() => {
      idleExitTimer = undefined
      // appExit(0) takes the host down; it must not beat a teardown that is
      // still flushing persisted state.
      void (async () => {
        if (teardowns.size > 0) await Promise.allSettled([...teardowns])
        await quiesce()
      })().catch((failure: unknown) => {
        logger.warn('grok-leader: quiesce failed: ' + errorChain(failure))
      }).finally(() => {
        const exit = ctx.get('appExit') as ((code: number) => void) | undefined
        if (exit === undefined) {
          logger.warn('grok-leader: the host exposes no appExit; the leader will stay up with no clients')
        } else {
          exit(0)
        }
      })
    }, idleExitMs)
  }

  const teardownClient = (clientId: number): void => {
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      connections.delete(clientId)
      scheduleIdleExit()
      for (const pending of conn.pending.values()) {
        pending.reject(new Error('grok client disconnected'))
      }
    }
    const records = [...sessions.values()].filter(record => record.clientId === clientId)
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
      discardPromptQueue(record)
      clearMcpInitTimer(record)
      sessions.delete(record.agent.session.id)
      // Flush persisted state before disposal, like closeSession; a flush
      // failure is logged but must not strand the disposal. The promise is
      // tracked so the idle exit waits for every teardown before appExit.
      const store = ctx.get('sessions') as SessionsLike | undefined
      const teardown = (async () => {
        if (store !== undefined) {
          try {
            await store.flush(record.agent.session)
          } catch (error: unknown) {
            logger.warn('grok-leader: session flush failed for ' + String(record.agent.session.id) + ': ' + errorChain(error))
          }
        }
        await record.dispose()
      })()
      teardowns.add(teardown)
      void teardown.then(() => {
        teardowns.delete(teardown)
      }, (error: unknown) => {
        teardowns.delete(teardown)
        logger.warn('grok-leader: session teardown failed for ' + String(record.agent.session.id) + ': ' + errorChain(error))
      })
    }
  }

  const handleSocket = (socket: Socket): void => {
    const conn: ClientConnection = { socket, clientId: ++clientSeq, pending: new Map(), nextRequestId: 0 }
    const decoder = new FrameDecoder()
    let registered = false
    // Wire tracing behind DEEPSEEK_LEADER_DEBUG=1.
    const debugWire = process.env.DEEPSEEK_LEADER_DEBUG === '1'
    const wireLog = (dir: 'in' | 'out', msg: unknown): void => {
      if (!debugWire) return
      const record = msg as { type?: unknown; payload?: unknown; method?: unknown }
      const body = record.type === 'acp' && typeof record.payload === 'string'
        ? record.payload.slice(0, 400)
        : JSON.stringify(msg).slice(0, 200)
      process.stderr.write('grok-leader wire ' + dir + ': ' + body + '\n')
    }
    const send = (msg: ServerMessage): void => {
      wireLog('out', msg)
      // One write() per frame: node serializes per-socket writes in order.
      socket.write(encodeJsonFrame(encodeServerMessage(msg)))
    }
    socket.setTimeout(REGISTRATION_TIMEOUT_MS)
    socket.on('timeout', () => {
      if (!registered) {
        // Envelope error code 3 per docs/grok-leader-protocol.md section 2.2.
        send({ type: 'error', code: 3, message: 'Registration timeout' })
        socket.destroy()
      }
    })
    socket.on('error', (error: unknown) => {
      logger.debug('grok-leader: socket error: ' + String(error))
    })
    socket.on('data', (chunk) => {
      let frames: Uint8Array[]
      try {
        frames = decoder.push(chunk)
      } catch (error: unknown) {
        logger.warn('grok-leader: frame decode failed: ' + String(error))
        socket.destroy()
        return
      }
      for (const frame of frames) {
        void handleFrame(frame).catch((error: unknown) => {
          process.stderr.write('grok-leader: message handler failed: ' + String(error) + '\n')
          logger.warn('grok-leader: message handler failed: ' + String(error))
        })
      }
    })
    socket.on('close', () => {
      teardownClient(conn.clientId)
    })

    const handleFrame = async (frame: Uint8Array): Promise<void> => {
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder().decode(frame))
      } catch {
        send({ type: 'error', code: -32700, message: 'invalid JSON frame' })
        socket.destroy()
        return
      }
      let msg: ClientMessage
      try {
        msg = decodeClientMessage(value)
      } catch (error: unknown) {
        send({ type: 'error', code: -32600, message: error instanceof Error ? error.message : String(error) })
        socket.destroy()
        return
      }
      wireLog('in', msg)
      if (!registered && msg.type !== 'register') {
        // Envelope error code 1 per docs/grok-leader-protocol.md section 2.2.
        send({ type: 'error', code: 1, message: 'Expected Register message' })
        return
      }
      switch (msg.type) {
        case 'register': {
          if (registered) {
            // Mirrors server.rs: a second registration is a client bug.
            send({ type: 'error', code: 2, message: 'Already registered' })
            break
          }
          registered = true
          connections.set(conn.clientId, conn)
          cancelIdleExit()
          socket.setTimeout(0)
          // Probe-verified reply (docs/grok-tui-connect.md): ready plus a
          // leader_binary_version at least the client version keeps the TUI
          // attached; it otherwise evicts and respawns the leader.
          send({
            type: 'registered',
            clientId: conn.clientId,
            ready: true,
            leaderProtocolVersion: LEADER_PROTOCOL_VERSION,
            leaderBinaryVersion: LEADER_BINARY_VERSION,
            // TODO(verify): mirror of the captured stub; control commands all
            // answer ControlResult errors until GetLeaderInfo/CpuProfileStatus
            // are implemented (protocol.rs ControlCommand).
            leaderCapabilities: { controlV1: false, workspaceExposure: false, relaunchV1: false },
          })
          break
        }
        case 'ping':
          send({ type: 'pong' })
          break
        case 'acp':
          await handleAcp(conn, msg.payload)
          break
        case 'control':
          send({
            type: 'controlResult',
            requestId: msg.requestId,
            result: { Err: { code: 'internal_error', message: 'control commands are not implemented by this leader' } },
          })
          break
        case 'disconnect':
          socket.end()
          break
      }
    }
  }

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
      discardPromptQueue(record)
      clearMcpInitTimer(record)
    }
    quiescing = (async () => {
      for (const conn of connections.values()) conn.socket.destroy()
      // Flush persisted state before disposal, like closeSession.
      const store = ctx.get('sessions') as SessionsLike | undefined
      const disposals = await Promise.allSettled(records.map(async record => {
        if (store !== undefined) await store.flush(record.agent.session)
        await record.dispose()
      }))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(failures, 'grok leader teardown failed for ' + String(failures.length) + ' session(s): ' + detail)
      }
    })()
    return quiescing
  }

  const socketPath = config.socketPath ?? '/tmp/dsh-grok-leader.sock'
  const server: Server = createServer((socket) => { handleSocket(socket) })
  let socketFailure: NodeJS.ErrnoException | undefined
  server.on('error', (error: NodeJS.ErrnoException) => {
    // Fail loud instead of unlinking a live leader's socket and stacking
    // orphaned listeners on the same path (that left TUIs connecting to dead
    // peers). The launcher owns the path: it removes stale files before start.
    process.stderr.write('grok-leader: socket error: ' + String(error) + '\n')
    logger.warn('grok-leader: socket error: ' + String(error))
    socketFailure = error
    // Stop accepting work and drain the plugin, but keep the rest of the
    // process alive; the failure re-throws from the effect on disposal.
    void quiesce().catch((failure: unknown) => {
      logger.warn('grok-leader: quiesce failed: ' + errorChain(failure))
    })
  })
  server.listen(socketPath, () => {
    // The launcher owns the socket's parent directory; the bridge only
    // tightens the socket file itself so other local users cannot hijack it.
    try {
      chmodSync(socketPath, 0o600)
    } catch (error: unknown) {
      logger.warn('grok-leader: socket chmod failed: ' + String(error))
    }
  })

  ctx.effect(() => () => {
    cancelIdleExit()
    server.close()
    if (socketFailure?.code !== 'EADDRINUSE') {
      try {
        unlinkSync(socketPath)
      } catch {
        // Socket file already removed; nothing to clean.
      }
    }
    // Await the drain so disposal finishes flushing and disposing sessions,
    // and catch its rejection with a logged warning. A fatal listener failure
    // still re-throws from the returned promise so the cordis host fails this
    // plugin cleanly instead of process.exit(1) taking the whole dsh down.
    const failure = socketFailure
    return quiesce().then(() => {
      if (failure !== undefined) throw failure
    }, (quiesceFailure: unknown) => {
      logger.warn('grok-leader: quiesce failed: ' + errorChain(quiesceFailure))
      if (failure !== undefined) throw failure
    })
  }, 'grok-leader.socket')
}

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

/**
 * Whether a prompt carries content beyond text and resource_link blocks.
 * @param prompt - prompt content blocks to inspect.
 * @returns true when any block is neither text nor resource_link.
 */
export function promptHasUnsupportedContent(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return true
  return prompt.some((block) => {
    const t = (block as Record<string, unknown>).type
    return t !== 'text' && t !== 'resource_link'
  })
}

/**
 * Map one harness session event to the streaming deltas the grok client
 * renders. Assistant text and reasoning stream from assistant/chunk deltas;
 * the assembled assistant/message is a fallback for providers that never
 * streamed. Tool calls and tool results stream; user messages map only on
 * replay because the bridge echoes the accepted prompt itself.
 * @param event - harness session event.
 * @param options.replay - true while replaying a persisted transcript.
 * @param options.textStreamed - true once this step already streamed its text.
 * @returns zero or more wire-shaped updates.
 */
export function sessionEventToUpdates(
  event: SessionEvent,
  options: {
    replay: boolean
    textStreamed: boolean
    toolCall?: (callId: string) => { name: string; arguments: unknown } | undefined
  },
): Array<GrokSessionUpdate> {
  if (!options.replay && event.type === 'user/message') return []
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source as { kind?: unknown }
      if (source.kind !== 'user') return []
      return textBlocks(event.data.content).map(content => ({
        sessionUpdate: 'user_message_chunk',
        content,
      }))
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk as { type?: string; text?: string }
      if (typeof chunk.text !== 'string' || chunk.text.length === 0) return []
      if (chunk.type === 'text-delta') {
        return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } }]
      }
      if (chunk.type === 'reasoning-delta') {
        return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } }]
      }
      return []
    }
    case 'assistant/message': {
      // Text deltas already streamed this step; re-emitting the assembled
      // content would duplicate them in the TUI. Keep it only as the fallback.
      if (options.textStreamed) return []
      return textBlocks(event.data.message.content).map(content => ({
        sessionUpdate: 'agent_message_chunk',
        content,
      }))
    }
    case 'tool/call': {
      const args = parseJsonObject(event.data.arguments)
      return [{
        sessionUpdate: 'tool_call',
        toolCallId: String(event.data.callId),
        title: event.data.name,
        kind: toolKindForName(event.data.name, args),
        status: 'in_progress',
        rawInput: rawInputForTool(event.data.name, args),
      }]
    }
    case 'tool/result': {
      const block = event.data.message.content[0] as { type?: string; toolCallId?: unknown; content?: unknown } | undefined
      const callId = String(block?.toolCallId)
      const prior = options.toolCall?.(callId)
      const contents: ToolResultContentBlock[] = [
        ...textBlocks(block?.content),
        ...diffBlocksFromMeta(event.data.meta),
      ]
      const rawOutput = typedRawOutput(prior, event.data.meta, contents, event.data.error !== undefined)
      return [{
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: event.data.error === undefined ? 'completed' : 'error',
        ...contents.length > 0 ? { content: contents } : {},
        ...rawOutput === undefined ? {} : { rawOutput },
        ...event.data.error === undefined ? {} : { error: { name: event.data.error.name, code: event.data.error.code } },
      }]
    }
    default:
      // TODO(verify): plan updates (grok SessionUpdate::Plan) and titles stay
      // off the wire until the dsh plan/title event mapping is specified.
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
function parseJsonObject(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // Keep rawInput absent rather than a string: grok's typed tool blocks
    // expect raw_input to be a JSON object.
  }
  return undefined
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
    blocks.push({
      type: 'diff',
      path: typeof diff.path === 'string' ? diff.path : '',
      ...typeof diff.oldText === 'string' ? { oldText: diff.oldText } : {},
      newText: diff.newText,
    })
  }
  return blocks
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
function textFromContents(contents: Array<{ type: 'text'; text: string } | { type: 'diff'; path: string; oldText?: string; newText: string }>): string {
  return contents
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Build grok `ToolOutput::Bash` from the model-facing text result. */
function bashRawOutput(
  prior: { name: string; arguments: unknown } | undefined,
  text: string,
  isError: boolean,
): Record<string, unknown> | undefined {
  if (prior === undefined) return undefined
  const args = (prior.arguments ?? {}) as { command?: unknown; description?: unknown }
  const output = Buffer.from(text, 'utf8')
  return {
    type: 'Bash',
    output: Array.from(output),
    output_for_prompt: text,
    exit_code: isError ? 1 : 0,
    command: typeof args.command === 'string' ? args.command : '',
    truncated: false,
    signal: null,
    timed_out: false,
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
  if (typeof m.path !== 'string' || !Array.isArray(m.lines)) return undefined
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
      ...typeof m.totalLines === 'number' ? { total_lines: m.totalLines } : { total_lines: lines.length },
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
  return {
    type: 'WebFetch',
    Content: {
      url: typeof m.url === 'string' ? m.url : typeof args.url === 'string' ? args.url : '',
      content: text,
      content_type: 'text',
      status_code: typeof m.statusCode === 'number' ? m.statusCode : 200,
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
  contents: Array<{ type: 'text'; text: string } | { type: 'diff'; path: string; oldText?: string; newText: string }>,
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

function textBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
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

/** Build per-agent options from plugin config without assigning absent optional fields. */
function agentOptions(config: GrokLeaderConfig): Pick<AgentOptions, 'provider' | 'model'> {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}
