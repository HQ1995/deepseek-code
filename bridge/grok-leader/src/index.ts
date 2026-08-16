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
import { unlinkSync } from 'node:fs'
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
}

export const Config: Schema<GrokLeaderConfig> = Schema.object({
  socketPath: Schema.string().default('/tmp/dsh-grok-leader.sock'),
  provider: Schema.string(),
  model: Schema.string(),
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
} as const

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
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: 'generic'; status: 'in_progress'; rawInput: string }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: 'completed' | 'error'; content?: Array<{ type: 'text'; text: string }>; error?: { name: string; code: string } }

/** grok AskUserQuestionExtResponse: tagged on `outcome`, snake_case variant names. */
type AskUserQuestionExtResponse =
  | { outcome: 'accepted'; answers: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { outcome: 'chat_about_this' | 'skip_interview'; partial_answers?: Record<string, string> }
  | { outcome: 'cancelled' }

/** Flattened wire catalog plus the provider ownership the bare model ids hide. */
interface ModelCatalog {
  currentModelId: string
  /** Provider roster as listed by the harness llm service ({id, name?}). */
  providers: Array<{ id: string; name?: string }>
  /** Provider that owns currentModelId ('' when no current model). */
  currentProviderId: string
  availableModels: Array<{ modelId: string; name: string; description?: string; _meta?: { provider: string } }>
  providerByModel: Map<string, string>
}

interface ClientConnection {
  readonly socket: Socket
  readonly clientId: number
  /** Pending reverse requests (permission, ask_user_question) keyed by JSON-RPC id. */
  readonly pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
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
  /** True once the current step streamed a text-delta; suppresses the assembled-message re-emit. */
  textStreamed: boolean
  /** Accepted user prompts, oldest first; served by x.ai/prompt_history. */
  prompts: string[]
  /** FIFO of validated prompts waiting for the in-flight one to settle.
   *  ponytail: plain per-session FIFO; no grok send-now/interject/reorder. */
  promptQueue: Array<{
    p: Record<string, unknown>
    resolve: (value: { stopReason: StopReasonWire }) => void
    reject: (error: Error) => void
  }>
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

  /** Rebuild the flattened wire catalog plus the provider ownership the bare ids hide. */
  const refreshCatalog = async (): Promise<ModelCatalog> => {
    const providers = llm === undefined ? [] : llm.listProviders().map(p => ({ id: p.id, ...p.name === undefined ? {} : { name: p.name } }))
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
          _meta: { provider: row.provider },
        })
      }
    }
    const requested = config.model
      ?? (ctx.get('agentDefaultModel') as { currentSelection?: () => { model: string } } | undefined)?.currentSelection?.().model
      ?? ''
    // A configured model absent from the catalog must not reach the client as
    // an unresolvable currentModelId; fall back to the catalog's first entry.
    let currentModelId = requested
    if (currentModelId !== '' && !providerByModel.has(currentModelId)) {
      currentModelId = availableModels[0]?.modelId ?? ''
      logger.warn('grok-leader: model "' + requested + '" is not in the catalog; falling back to "' + currentModelId + '"')
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

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
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
    if (process.env.DEEPSEEK_LEADER_DEBUG !== '0') {
      process.stderr.write('grok-leader wire out acp: ' + JSON.stringify(value).slice(0, 400) + '\n')
    }
    conn.socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(value) }))
  }

  const sendNotification = (conn: ClientConnection, method: string, params: unknown): void => {
    sendAcp(conn, { jsonrpc: '2.0', method, params })
  }

  /** Send a JSON-RPC request to one client and wait for its response. */
  const requestClient = <T>(conn: ClientConnection, method: string, params: unknown): Promise<T> => {
    const id = conn.nextRequestId++
    sendAcp(conn, { jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      conn.pending.set(String(id), { resolve: resolve as (value: unknown) => void, reject })
    })
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
        ...record.turnStartMs === undefined ? {} : { turnStartMs: record.turnStartMs },
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
    for (const item of sessionEventToUpdates(event, { replay, textStreamed: record.textStreamed })) {
      if (item.sessionUpdate === 'agent_message_chunk') {
        record.textStreamed = true
        updates.push({ ...item, totalTokens })
      } else {
        updates.push(item)
      }
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
        emitUpdate(conn, record, event.seq, item, false)
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
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError('turn failed: ' + errorChain(error)))
  })

  // Permission requests are a machine policy channel: one-shot choices only,
  // and an unknown client response never becomes a durable grant. YOLO
  // sessions pre-approve without a client roundtrip.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    if (record.yolo) return Promise.resolve('allowed-once' as const)
    const conn = connections.get(record.clientId)
    if (conn === undefined) return next()
    return requestClient<unknown>(conn, WIRE.requestPermission, {
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId, displayName: request.toolName },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then((outcome: unknown) => {
      const decision = outcome as { outcome?: { outcome?: string; optionId?: string } }
      if (decision.outcome?.outcome === 'cancelled') return 'cancelled'
      return decision.outcome?.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  // Human questions route to the client owning the asking agent.
  const questions = ctx.get('userQuestions') as UserQuestionsLike | undefined
  if (questions !== undefined) {
    const disposeProvider = questions.registerProvider({
      async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
        const record = request.agent === undefined ? undefined : ownedRecord(request.agent)
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
        })
        if (response.outcome !== 'accepted') {
          throw new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
        }
        const answers: AskUserQuestionAnswer['answers'] = []
        for (const [text, labels] of Object.entries(response.answers)) {
          const id = textToId.get(text)
          if (id === undefined) continue
          const notes = response.annotations?.[text]?.notes
          const selected = labels.filter(label => label !== 'Other')
          answers.push({ id, selected, ...(notes !== undefined && notes.length > 0 ? { custom: notes } : {}) })
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
      agentInfo: { name: 'deepseek-harness-grok-leader', version: '0.1.0-rc.5' },
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
  const presetRequestFromMeta = (meta: Record<string, unknown> | undefined): string | undefined => {
    if (meta === undefined) return undefined
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

  const newSession = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/new')
    const cwd = p.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalidParams('cwd must be an absolute path: ' + String(cwd))
    const mcpServers = p.mcpServers
    if (Array.isArray(mcpServers) && mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
    const additionalDirectories = p.additionalDirectories
    if (Array.isArray(additionalDirectories) && additionalDirectories.length > 0) throw invalidParams('additionalDirectories is not supported')
    const meta = p._meta as Record<string, unknown> | undefined
    // Clients may pin the session id through _meta.sessionId; absent one, mint it.
    const suppliedId = meta?.sessionId
    const sessionId = typeof suppliedId === 'string' && suppliedId.length > 0 ? SessionId(suppliedId) : SessionId(randomUUID())
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
      lastSeq: 0,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      textStreamed: false,
      prompts: [],
      promptQueue: [],
      inflight: undefined,
    }
    sessions.set(sessionId, record)
    // The pager parks on "Starting session…" until this arrives (the probe
    // worker's scripted fake sends it 50 ms after the session/new result;
    // docs/grok-tui-connect.md).
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      setTimeout(() => {
        if (connections.get(clientId) === conn) {
          sendNotification(conn, '_x.ai/mcp_initialized', { sessionId })
        }
      }, 50)
    }
    return { sessionId }
  }

  /**
   * Run one validated prompt: admit it, stream the echo, and settle at turn
   * end (or idle for a turnless slot). Reads the prompt content from p again
   * because the queued entry stores the raw request, not a decoded message.
   */
  const runPrompt = async (record: SessionRecord, p: Record<string, unknown>): Promise<{ stopReason: StopReasonWire }> => {
    const text = acpPromptToText(p.prompt)
    if (agents.get(record.agent.id) !== record.agent) {
      throw internalError('prompt was not queued: the agent was disposed outside the bridge')
    }
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const meta = p._meta as Record<string, unknown> | undefined
    const promptId = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : message.id
    const stopReason = await new Promise<StopReasonWire>((resolve, reject) => {
      const inflight: NonNullable<SessionRecord['inflight']> = {
        resolve, reject, messageId: message.id, promptId, turn: undefined, endReason: undefined,
      }
      record.inflight = inflight
      try {
        record.agent.followup(message)
      } catch (error: unknown) {
        record.inflight = undefined
        throw internalError('prompt was not queued: ' + (error instanceof Error ? error.message : String(error)))
      }
      // Echo the accepted prompt so it enters the client transcript, then let
      // the turn stream. Settlement happens at the correlated turn/end; a
      // turnless slot (admission discarded the prompt) settles cancelled at idle.
      const conn = connections.get(record.clientId)
      if (conn !== undefined) {
        emitUpdate(conn, record, undefined, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
        }, false)
      }
      void record.agent.whenIdle().then(() => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.resolve('cancelled')
      })
    })
    return { stopReason }
  }

  /** Start the next queued prompt once the in-flight one has settled. */
  const advancePromptQueue = (record: SessionRecord): void => {
    if (record.inflight !== undefined) return
    const entry = record.promptQueue.shift()
    if (entry === undefined) return
    void runPrompt(record, entry.p).then(entry.resolve, entry.reject).finally(() => advancePromptQueue(record))
  }

  /** Settle every queued (not-yet-run) prompt as cancelled (cancel/close/teardown). */
  const discardPromptQueue = (record: SessionRecord): void => {
    for (const entry of record.promptQueue.splice(0)) entry.resolve({ stopReason: 'cancelled' })
  }

  /** Enqueue a validated prompt and run it as soon as the session is idle. */
  const enqueuePrompt = (record: SessionRecord, p: Record<string, unknown>): Promise<{ stopReason: StopReasonWire }> =>
    new Promise((resolve, reject) => {
      record.promptQueue.push({ p, resolve, reject })
      advancePromptQueue(record)
    })

  const prompt = async (params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/prompt')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
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
    return await enqueuePrompt(record, p)
  }

  const cancel = (params: unknown): void => {
    const p = typeof params === 'object' && params !== null && !Array.isArray(params)
      ? params as Record<string, unknown>
      : undefined
    const sessionId = p !== undefined && typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (record === undefined) return
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    discardPromptQueue(record)
  }

  const loadSession = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/load')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    if (sessionId === undefined) throw invalidParams('session/load requires a sessionId')
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      // Live reload (preset switch re-mount): dispose the existing record
      // first so the same id can be re-attached under a different preset.
      sessions.delete(sessionId)
      existing.agent.cancel({ kind: 'user' })
      settlePrompt(existing, 'cancelled')
      discardPromptQueue(existing)
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
    const meta = p._meta as Record<string, unknown> | undefined
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
      lastSeq: 0,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      textStreamed: false,
      prompts: [],
      promptQueue: [],
      inflight: undefined,
    }
    sessions.set(sessionId, record)
    // Replay the persisted transcript with isReplay stamps BEFORE the response,
    // so the client renders history ahead of any live deltas. Live notifications
    // racing the replay are dropped by the high-water mark; buffering them for a
    // gap-free flush is deferred (server.rs MAX_BUFFERED_LIVE_PER_LOAD).
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      for (const event of inspection.events) {
        for (const item of mapEvent(record, event, true)) {
          emitUpdate(conn, record, event.seq, item, true)
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

  const setSessionModel = async (params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/set_model')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const modelId = p.modelId
    if (typeof modelId !== 'string' || modelId.length === 0) throw invalidParams('modelId must be a non-empty string')
    const meta = p._meta as Record<string, unknown> | undefined
    const reasoningEffort = meta?.reasoningEffort
    // TODO(verify): grok modelId is a global catalog id (agent.rs
    // SetSessionModelRequest); dsh needs a provider+model pair, so the provider
    // comes from the catalog's modelId -> provider mapping, then the agent's
    // own route, then config.provider.
    const current = await currentCatalog()
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
  const promptHistory = (params: unknown): { prompts: string[] } => {
    const p = paramRecord(params, 'x.ai/prompt_history')
    const scoped = typeof p.filter_session_id === 'string'
      ? SessionId(p.filter_session_id)
      : typeof p.session_id === 'string'
        ? SessionId(p.session_id)
        : undefined
    const record = scoped === undefined ? undefined : sessions.get(scoped)
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

  const closeSession = async (params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/close')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    discardPromptQueue(record)
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
        return await prompt(params)
      case WIRE.sessionLoad:
        return await loadSession(clientId, params)
      case WIRE.sessionList:
        return await listSessions()
      case WIRE.sessionSetModel:
        return await setSessionModel(params)
      case WIRE.sessionClose:
        return await closeSession(params)
      case WIRE.modelsList:
        return await modelsList()
      case 'x.ai/commands/list':
        return { commands: await availableCommands() }
      case 'x.ai/prompt_history':
        return promptHistory(params)
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
        const record = sessionId === undefined ? undefined : sessions.get(sessionId)
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

  const handleNotification = (method: string, params: unknown): void => {
    switch (method) {
      case WIRE.sessionCancel:
        cancel(params)
        return
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
      handleNotification(normalized, msg.params)
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

  const teardownClient = (clientId: number): void => {
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      connections.delete(clientId)
      for (const pending of conn.pending.values()) {
        pending.reject(new Error('grok client disconnected'))
      }
    }
    const records = [...sessions.values()].filter(record => record.clientId === clientId)
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
      discardPromptQueue(record)
      sessions.delete(record.agent.session.id)
      void record.dispose()
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
            leaderCapabilities: { controlV1: true, workspaceExposure: false, relaunchV1: false },
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
    }
    quiescing = (async () => {
      for (const conn of connections.values()) conn.socket.destroy()
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
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
  server.on('error', (error: NodeJS.ErrnoException) => {
    // Fail loud instead of unlinking a live leader's socket and stacking
    // orphaned listeners on the same path (that left TUIs connecting to dead
    // peers). The launcher owns the path: it removes stale files before start.
    process.stderr.write('grok-leader: socket error: ' + String(error) + '\n')
    process.exit(1)
  })
  server.listen(socketPath)

  ctx.effect(() => () => {
    server.close()
    void quiesce()
    try {
      unlinkSync(socketPath)
    } catch {
      // Socket file already removed; nothing to clean.
    }
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
  options: { replay: boolean; textStreamed: boolean },
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
    case 'tool/call':
      return [{
        sessionUpdate: 'tool_call',
        toolCallId: String(event.data.callId),
        title: event.data.name,
        kind: 'generic',
        status: 'in_progress',
        rawInput: event.data.arguments,
      }]
    case 'tool/result': {
      const block = event.data.message.content[0] as { type?: string; toolCallId?: unknown; content?: unknown } | undefined
      const contents = textBlocks(block?.content)
      return [{
        sessionUpdate: 'tool_call_update',
        toolCallId: String(block?.toolCallId),
        status: event.data.error === undefined ? 'completed' : 'error',
        ...contents.length > 0 ? { content: contents } : {},
        ...event.data.error === undefined ? {} : { error: { name: event.data.error.name, code: event.data.error.code } },
      }]
    }
    default:
      // TODO(verify): plan updates (grok SessionUpdate::Plan) and titles stay
      // off the wire until the dsh plan/title event mapping is specified.
      return []
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
