/**
 * Grok leader-protocol unix-socket server driving harness agents.
 *
 * Outer envelope: grok leader framing (codec.ts / protocol.ts), verified
 * against the real TUI capture in tests/fixtures/grok-tui-messages.jsonl and
 * the contract in docs/grok-leader-protocol.md. Inner dialect:
 * ACP JSON-RPC strings mapped onto the harness services the ACP bridge drives
 * (agents.create/resume, agent.followup / whenIdle / cancel, session/event,
 * approval/request, sessions.flush, llm.listProviders/listModels,
 * sessionPersistence.list/load, agentDefaultModel.saveSelection). Divergences
 * from upstream grok behavior are marked at the code site with the grok
 * file:line they were verified against.
 * @module dscode
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installModelSelection, type Agent, type AgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import {
  admitEncodedImages,
  isImageAdmissionError,
  type AttachmentStore,
  type EncodedImageAttachment,
  type ImageAttachmentRef,
  type ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-approval'
import { load as loadYaml } from 'js-yaml'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { encodeJsonFrame, FrameDecoder } from './codec.ts'
import { LEADER_PROTOCOL_VERSION, RpcError, decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from './protocol.ts'
import { SessionListIndex } from './session-list.ts'
import { acpPromptToText, cacheHitPercent, parseJsonObject, promptHasUnsupportedContent, sessionEventToUpdates, textBlocks, toolKindForName, turnEndToStopReason, type GrokSessionUpdate, type ProjectedUpdate, type StopReasonWire, type ToolKindWire, type ToolResultContentBlock } from './projection.ts'

export { acpPromptToText, cacheHitPercent, promptHasUnsupportedContent, sessionEventToUpdates, toolKindForName, turnEndToStopReason }
export type { GrokSessionUpdate, ProjectedUpdate, StopReasonWire, ToolKindWire, ToolResultContentBlock }

interface DscodeModelSelectionEvent {
  provider: string
  model: string
  reasoningEffort?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable per-session provider/model/effort selection. Latest write wins. */
    'dscode/model-selected': DscodeModelSelectionEvent
    /** Pre-0.0.10 development logs used the unnamespaced event id. */
    'model/selected': DscodeModelSelectionEvent
  }
}

const MODEL_SELECTION_EVENT = 'dscode/model-selected' as const
const LEGACY_MODEL_SELECTION_EVENT = 'model/selected' as const
/**
 * Register the bridge's durable event vocabulary with dsh's persistence read
 * gate. Upstream deliberately ships the Set as a mutable export while deferring
 * a registration API ("a registration surface ... is deferred until such a
 * consumer exists" — dsh-session known-event-types); the declared type is
 * ReadonlySet, so this is the ONE sanctioned seam. Guard it against upstream
 * mutations: a frozen Set would silently drop registration and the persistence
 * layer would refuse every dscode session log containing a model-selected
 * event. Call once, before any session load/restore.
 */
const knownSessionEventTypes = KNOWN_SESSION_EVENT_TYPES as Set<string>
if (Object.isFrozen(knownSessionEventTypes)) {
  // Fail loudly at module load rather than letting resumed sessions hit
  // SessionFormatUnsupportedError later for an event we wrote ourselves.
  throw new Error('dsh session event vocabulary is frozen; dscode cannot register its model-selected event')
}
knownSessionEventTypes.add(MODEL_SELECTION_EVENT)
knownSessionEventTypes.add(LEGACY_MODEL_SELECTION_EVENT)
export const name = 'grok-leader'
/** The bridge cannot accept clients until agents and durable session discovery are ready. */
export const inject = ['agents', 'sessionPersistence', 'attachments']

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

// The TUI evicts a leader only when leader_binary_version is a strictly-older
// parseable semver than the client's own version (mod.rs should_evict). For the
// dsh backend that rule cannot converge — eviction respawns the same plugin —
// so the leader mirrors the client's advertised version back: equal versions
// never evict, whatever build the TUI reports (release pin, -dev suffix, or a
// bare cargo build). The fallback covers clients that omit a version.
const LEADER_BINARY_VERSION = '0.0.0'

const packageVersion = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@hqzhao95/dscode' && typeof manifest.version === 'string') return manifest.version
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('could not locate @hqzhao95/dscode package.json')
    dir = parent
  }
}

const PACKAGE_VERSION = packageVersion()

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
  sessionSetMode: 'session/set_mode',
  sessionClose: 'session/close',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  modelsList: 'x.ai/models/list',
  modelsUpdate: 'x.ai/models/update',
  sessionsList: 'x.ai/sessions/list',
  askUserQuestion: 'x.ai/ask_user_question',
  providersAdd: 'x.ai/providers/add',
  providersUpdate: 'x.ai/providers/update',
  providersRemove: 'x.ai/providers/remove',
} as const

/** The dsh settings namespace the llm-pi-ai plugin owns (packages/llm/llm-pi-ai). */
const PROVIDER_SETTINGS_NS = 'llm-pi-ai'
/** The dsh preset roster's user-default namespace. */
const PRESET_SETTINGS_NS = 'agent-presets'
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
 * Fallback reasoning effort shown in the TUI before the user has explicitly
 * picked one. DeepSeek's own adapter defaults to high when omitted; this is
 * also the first canonical level in the bridge's advertised effort menu.
 */
const DEFAULT_REASONING_EFFORT = 'high'
/** Fallback effort menu when the llm service exposes no exact-model reasoning metadata. */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Canonical levels accepted by dsh-llm-pi-ai's reasoningEfforts schema. */
const PI_AI_REASONING_EFFORTS = new Set(['off', 'minimal', ...DEFAULT_REASONING_EFFORTS])
/** Match dsh-llm-pi-ai's discovery response ceiling for caller-supplied URLs. */
const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024

type PiAiReasoningEfforts = Record<string, string | null>

interface DiscoveredProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: false | PiAiReasoningEfforts
}

/** Strictly translate common OpenAI-compatible /models reasoning extensions
 * into dsh-llm-pi-ai's canonical-level -> wire-value map. Unknown levels are
 * ignored instead of being persisted into a schema that would reject them. */
function endpointReasoningEfforts(entry: Record<string, unknown>): false | PiAiReasoningEfforts | undefined {
  const supports = entry.supports_reasoning_effort ?? entry.supportsReasoningEffort
  if (supports === false) return false
  const raw = entry.reasoning_efforts ?? entry.reasoningEfforts
  if (raw === false) return false
  const result: PiAiReasoningEfforts = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        if (PI_AI_REASONING_EFFORTS.has(item)) result[item] = item
        continue
      }
      if (item === null || typeof item !== 'object') continue
      const value = item as Record<string, unknown>
      const id = typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : typeof value.value === 'string' && value.value.length > 0
          ? value.value
          : undefined
      if (id === undefined || !PI_AI_REASONING_EFFORTS.has(id)) continue
      const explicitWire = value.wire_value ?? value.wireValue
      const wire = explicitWire === undefined && value.id !== undefined ? value.value : explicitWire
      if (wire === null && id === 'off') result[id] = null
      else if (typeof wire === 'string' && wire.length > 0) result[id] = wire
      else result[id] = id
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [id, wire] of Object.entries(raw as Record<string, unknown>)) {
      if (!PI_AI_REASONING_EFFORTS.has(id)) continue
      if (wire === null && id === 'off') result[id] = null
      else if (typeof wire === 'string' && wire.length > 0) result[id] = wire
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** Parse only per-model capability metadata; catalog identity still comes
 * from the official llm discovery seam. */
function endpointModelCapabilities(value: unknown): Map<string, false | PiAiReasoningEfforts> {
  const data = value !== null && typeof value === 'object'
    ? (value as { data?: unknown }).data
    : undefined
  if (!Array.isArray(data)) return new Map()
  const capabilities = new Map<string, false | PiAiReasoningEfforts>()
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0 || capabilities.has(id)) continue
    const reasoningEfforts = endpointReasoningEfforts(entry)
    if (reasoningEfforts !== undefined) capabilities.set(id, reasoningEfforts)
  }
  return capabilities
}

/** Read an untrusted model listing without buffering beyond the dsh ceiling. */
async function readBoundedModelListing(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MODEL_LIST_MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('model listing exceeds 4 MiB')
  }
  if (response.body === null) throw new Error('model listing has no response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MODEL_LIST_MAX_BYTES) throw new Error('model listing exceeds 4 MiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

/** Best-effort second read for endpoint capability extensions that dsh's
 * official discovery intentionally drops from LlmDiscoveredModel. */
async function discoverEndpointModelCapabilities(
  baseURL: string,
  apiKey?: string,
): Promise<Map<string, false | PiAiReasoningEfforts>> {
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...apiKey === undefined ? {} : { authorization: 'Bearer ' + apiKey },
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('model listing returned HTTP ' + String(response.status))
  return endpointModelCapabilities(await readBoundedModelListing(response))
}

/** Separator used to disambiguate the same model id owned by different providers. */
const MODEL_ID_SEPARATOR = ':'

/** Build the wire catalog id for a provider/model pair. */
function wireModelId(provider: string, modelId: string): string {
  return provider + MODEL_ID_SEPARATOR + modelId
}

/** Split a wire catalog id back into provider/model when it is provider-qualified. */
function parseWireModelId(wireId: string): { provider: string; model: string } | undefined {
  const index = wireId.indexOf(MODEL_ID_SEPARATOR)
  if (index <= 0 || index === wireId.length - 1) return undefined
  return { provider: wireId.slice(0, index), model: wireId.slice(index + 1) }
}

/** Stable in-memory key for a provider/model effort. */
function modelEffortKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

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

/** Durable model-facing prompt blocks accepted from the ACP composer. */
type DurablePromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

/** Validated ACP prompt before image bytes are committed to durable storage. */
interface ParsedPrompt {
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'resource_link'; name: unknown; uri: unknown }
    | { type: 'image'; image: EncodedImageAttachment }
  >
  text: string
  images: EncodedImageAttachment[]
}
/** grok AskUserQuestionExtResponse: tagged on `outcome`, snake_case variant names. */
type AskUserQuestionExtResponse =
  | { outcome: 'accepted'; answers: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { outcome: 'chat_about_this' | 'skip_interview'; partial_answers?: Record<string, string> }
  | { outcome: 'cancelled' }

/** Flattened wire catalog plus the provider ownership the bare model ids hide. */
interface ModelCatalog {
  currentModelId: string
  /** Provider roster as listed by the harness llm service ({id, name?}) plus
   * the raw user-section profile fields the edit form prefills. `note` is a
   * display-only status the TUI relays verbatim (e.g. empty subscription
   * provider → its /dsh login pointer). */
  providers: Array<{ id: string; name?: string; displayName?: string; apiKeyEnv?: string; api?: string; baseURL?: string; credential?: CredentialInfo; note?: string }>
  /** Provider that owns currentModelId ('' when no current model). */
  currentProviderId: string
  availableModels: Array<{ modelId: string; name: string; description?: string; _meta?: { provider: string; supportsReasoningEffort?: boolean; reasoningEfforts?: string[]; reasoningEffort?: string; inputModalities?: string[]; acceptsImages?: boolean } }>
  providerByModel: Map<string, string>
  providerModelToWireId: Map<string, string>
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
  /** Per-model effort memory scoped to this session (provider + raw model). */
  modelEfforts: Map<string, string>
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
  /** Disjoint prompt-side cache token buckets from dsh TokenUsage. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Counters the grok x.ai/session/info context reads. */
  turnCount: number
  toolCallCount: number
  messageCount: number
  compactionCount: number
  /** Pending tool-call facts keyed by callId, used to attach rawInput/rawOutput. */
  pendingToolCalls: Map<string, { name: string; arguments: unknown }>
  /** True once the current step streamed a text-delta; suppresses the assembled-message re-emit. */
  textStreamed: boolean
  /** Accepted user prompts, oldest first; served by x.ai/prompt_history. */
  prompts: string[]
  /** Serializes pre-enqueue image admission so later text prompts cannot overtake it. */
  promptAdmissionTail: Promise<void>
  /** FIFO of validated prompts waiting for the in-flight one to settle. */
  promptQueue: Array<{
    resolve: (value: PromptSettleResult) => void
    reject: (error: Error) => void
    /** Stable queue-row id: the request _meta.promptId or a minted uuid. */
    id: string
    text: string
    /** Durable model content; text is kept separately for queue/history display. */
    content: DurablePromptBlock[]
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
  /** True while the one idle-gated promotion wait is outstanding on
   *  `whenIdle`; dedups concurrent promotion requests. */
  promotionScheduled: boolean
  /** Prompts folded into the running turn as steering (follow-up steer).
   *  They settle with the host turn's stop reason at its turn end. */
  steered: Array<{ id: string; resolve: (value: PromptSettleResult) => void }>
}

/** RPC result of a settled session/prompt. `_meta.promptId` lets the pager
 *  attribute the response to its queue row directly (the grok shell's
 *  PromptResponse `_meta` shape) instead of inferring from RPC ids. */
interface PromptSettleResult {
  stopReason: StopReasonWire
  _meta: { sessionId: string; promptId: string }
}

/** Structural read of the persistence service: list and load only. */
interface PersistenceLike {
  list(signal?: AbortSignal): Promise<Array<{ id: string; createdAt: number; cwd?: string }>>
  load(id: SessionId): Promise<{ meta: { agentPreset?: string; cwd?: string }; events: readonly SessionEvent[] }>
}

/** Structural read of the user-questions service: provider registration only. */
interface UserQuestionsLike {
  registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void
}
/** Structural read of the dsh command registry (@deepseek-ai/dsh-commands):
 *  plugin-registered human commands surfaced as pager slash commands. */
interface CommandsLike {
  list(agent: Agent): ReadonlyArray<{ name: string; description: string; input?: { hint: string } }>
  execute(agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
}

/** Structural read of the llm service: provider and model catalogs only. */
interface LlmLike {
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>>
  /** Exact-route model metadata (used for adapter-configured effort and modality metadata). */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    provider: string
    id: string
    name?: string
    reasoning?: { defaultEffort?: string; efforts?: Array<{ id: string; name?: string }> }
    inputModalities?: readonly string[]
  }>
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

/** Non-secret credential facts safe to expose to configuration UIs. */
interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** Structural credential seam; references are resolved only for already
 * persisted endpoints, never for a brand-new caller-supplied URL. */
interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string; source?: string } | undefined>
  describe?(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
}

/** Structural write path of the official settings seam (ctx.settings.mutate). */
interface SettingsLike {
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<void>
  /** Read the raw user sections (ctx.settings.describe); optional for harnesses without it. */
  describe?(): Array<{ ns: string; user?: unknown }>
}

/** Raw user section of the llm-pi-ai namespace, when the settings service exposes it. */
export function providerUserSection(providerService: SettingsLike | undefined): Record<string, unknown> | undefined {
  const descriptor = providerService?.describe?.().find(entry => entry.ns === PROVIDER_SETTINGS_NS)
  const user = descriptor?.user
  return user !== null && typeof user === 'object' ? user as Record<string, unknown> : undefined
}

/** One provider's raw user profile ({} when the section does not name it). */
export function providerUserProfile(userSection: Record<string, unknown> | undefined, id: string): Record<string, unknown> {
  const providers = userSection?.providers
  const profile = providers !== null && typeof providers === 'object'
    ? (providers as Record<string, unknown>)[id]
    : undefined
  return profile !== null && typeof profile === 'object' ? profile as Record<string, unknown> : {}
}

export function hasUserProviderRoute(providerService: SettingsLike | undefined, id: string): boolean {
  const providers = providerUserSection(providerService)?.providers
  return providers !== null
    && typeof providers === 'object'
    && Object.prototype.hasOwnProperty.call(providers, id)
}

/** baseURLs of the provider routes already persisted in the user settings
 * section: the only endpoints a resolved env secret may be sent to. */
export function knownRouteBaseUrls(providerService: SettingsLike | undefined): string[] {
  const providers = providerUserSection(providerService)?.providers
  if (providers === null || typeof providers !== 'object') return []
  const urls: string[] = []
  for (const profile of Object.values(providers as Record<string, unknown>)) {
    if (profile === null || typeof profile !== 'object') continue
    const baseURL = (profile as { baseURL?: unknown }).baseURL
    if (typeof baseURL === 'string' && baseURL.length > 0) urls.push(baseURL)
  }
  return urls
}

/** Structural read of the session store: this bridge needs only one flush entry point. */
interface SessionsLike {
  flush(session: object): Promise<unknown>
}

/** Structural read of the default-model service. */
interface AgentDefaultModelLike {
  currentSelection?(): { provider: string; model: string; reasoningEffort?: string } | undefined
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** Resolve a session selection from request overrides, deployment config, or
 * the supplied saved/session default. All-empty means provider onboarding. */
function modelSelectionFromRequest(
  config: Pick<GrokLeaderConfig, 'provider' | 'model'>,
  defaultSelection: { provider: string; model: string; reasoningEffort?: string } | undefined,
  meta: Record<string, unknown> | null | undefined,
): ModelSelectionRef['current'] {
  const provider = nonEmptyString(meta?.provider)
    ? meta.provider
    : nonEmptyString(config.provider)
      ? config.provider
      : nonEmptyString(defaultSelection?.provider)
        ? defaultSelection.provider
        : undefined
  const model = nonEmptyString(meta?.model)
    ? meta.model
    : nonEmptyString(config.model)
      ? config.model
      : nonEmptyString(defaultSelection?.model)
        ? defaultSelection.model
        : undefined
  if (provider === undefined || model === undefined) return undefined
  const fromDefault = defaultSelection !== undefined
    && provider === defaultSelection.provider
    && model === defaultSelection.model
  const effort = typeof meta?.reasoningEffort === 'string' ? meta.reasoningEffort : undefined
  const reasoningEffort = effort
    ?? (fromDefault ? defaultSelection.reasoningEffort : undefined)
  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}

function modelEffortsForSelection(selection: ModelSelectionRef['current']): Map<string, string> {
  const efforts = new Map<string, string>()
  if (selection !== undefined && nonEmptyString(selection.reasoningEffort)) {
    efforts.set(modelEffortKey(selection.provider, selection.model), selection.reasoningEffort)
  }
  return efforts
}

/** Latest model choice recorded in one durable session log. */
function sessionModelSelectionFromLog(events: readonly SessionEvent[]): ModelSelectionRef['current'] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== MODEL_SELECTION_EVENT && event?.type !== LEGACY_MODEL_SELECTION_EVENT) continue
    const { provider, model, reasoningEffort } = event.data
    if (!nonEmptyString(provider) || !nonEmptyString(model)) continue
    return {
      provider,
      model,
      ...nonEmptyString(reasoningEffort)
        ? { reasoningEffort: ReasoningEffortId(reasoningEffort) }
        : {},
    }
  }
  return undefined
}

/** Rebuild per-model effort memory for one resumed/forked session. */
function sessionModelEffortsFromLog(
  events: readonly SessionEvent[],
  selection?: ModelSelectionRef['current'],
): Map<string, string> {
  const efforts = modelEffortsForSelection(selection)
  for (const event of events) {
    if (event.type !== MODEL_SELECTION_EVENT && event.type !== LEGACY_MODEL_SELECTION_EVENT) continue
    const { provider, model, reasoningEffort } = event.data
    if (!nonEmptyString(provider) || !nonEmptyString(model) || !nonEmptyString(reasoningEffort)) continue
    efforts.set(modelEffortKey(provider, model), reasoningEffort)
  }
  return efforts
}

/** Structural read of the preset roster: discovery plus per-agent composition. */
interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
  recompose(agentCtx: Context, id: string): Promise<unknown>
  composedPreset?(agentCtx: Context): string | undefined
  serviceForAgent?(agent: { ctx: Context }, name: string): unknown
}

/**
 * Mount the grok leader server.
 * @param ctx - Cordis context carrying the agent factory and harness services.
 * @param config - socket path and initial provider/model selection.
 */
/** Composition rows a third-party layer should not touch silently: the
 *  sandbox/approval/permission spine. Patch layers apply AFTER dsh-base, so
 *  an installed bundle can disable or reconfigure these — legal in dsh, but
 *  the user must see it before the layer is registered. */
const SENSITIVE_ROW_IDS = new Set(['sandbox', 'sandbox-policy', 'approval', 'permission-presets', 'credentials', 'settings'])

/** What one bundle's cordis.patch.yml does to the composition. */
export interface BundlePatchAnalysis {
  insertedRows: string[]
  overriddenRows: string[]
  disabledRows: string[]
  sensitiveRows: string[]
  jsExprCount: number
}

/** Statically analyze a bundle patch. Throws on anything loadProfile would
 *  choke on (non-array, non-mapping entries) — /dsh add uses that to refuse
 *  registration BEFORE the layer can brick the next boot. `!!js` tags are
 *  neutralized for parsing but counted: they are code that runs in the
 *  leader process at boot, before any plugin module loads. */
export function analyzeBundlePatch(patchText: string): BundlePatchAnalysis {
  const jsExprCount = (patchText.match(/!!js\b/g) ?? []).length
  const doc = loadYaml(patchText.replace(/!!js\b/g, ''))
  if (!Array.isArray(doc)) throw new Error('the patch is not a YAML array (loadProfile would refuse to boot this profile)')
  const analysis: BundlePatchAnalysis = { insertedRows: [], overriddenRows: [], disabledRows: [], sensitiveRows: [], jsExprCount }
  for (const entry of doc) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('a patch entry is not a mapping (loadProfile would refuse to boot this profile)')
    }
    const patch = entry as Record<string, unknown>
    if (Array.isArray(patch.insert)) {
      for (const row of patch.insert) {
        const r = row as { id?: unknown; name?: unknown } | null
        const id = String(r?.id ?? r?.name ?? '?')
        analysis.insertedRows.push(id)
        if (SENSITIVE_ROW_IDS.has(id)) analysis.sensitiveRows.push(id)
      }
      continue
    }
    if (typeof patch.id === 'string') {
      if (patch.disabled === true) analysis.disabledRows.push(patch.id)
      else analysis.overriddenRows.push(patch.id)
      if (SENSITIVE_ROW_IDS.has(patch.id)) analysis.sensitiveRows.push(patch.id)
    }
  }
  return analysis
}

/** Minimal shell-style tokenizer for slash commands (quotes and backslash). */
export function parseCommandLine(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  let started = false
  for (const char of input) {
    if (escaped) {
      token += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else token += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (escaped) throw new Error('unterminated escape')
  if (quote !== undefined) throw new Error('unterminated quote')
  if (started) tokens.push(token)
  return tokens
}

/** Structural view of cordis internals for runtime capability attribution.
 *  All public in cordis 4.x (reflect.store, registry, fiber.getEffects) —
 *  the same recipe the harness's own tool-cordis inspect helpers use. */
interface FiberLike {
  name?: string
  state?: unknown
  parent?: { fiber?: FiberLike }
  getEffects?(): Array<{ label?: string; children?: unknown[] }>
}
interface CordisInternals {
  reflect: { store: Record<symbol, { name: string; fiber: FiberLike; value: unknown }> }
  registry: Map<unknown, { name?: string; fibers: Iterable<FiberLike> }>
}

/** Service names dscode has a rendering rail for, with the human meaning. */
const KNOWN_RAILS: Record<string, string> = {
  llm: 'LLM providers/models (surface in /provider and /model)',
  commands: 'slash commands (auto-surface in the TUI)',
  userQuestions: 'interactive questions (TUI pickers)',
  tools: 'model-facing tools (approval-gated)',
  agentPresets: 'agent presets (/preset)',
}

/** Fiber-parentage subtree test — object identity, never uid (uids collide
 *  across registries; see agent-presets mount.ts). */
function withinFiber(fiber: FiberLike, root: FiberLike): boolean {
  let current: FiberLike | undefined = fiber
  while (current !== undefined) {
    if (current === root) return true
    const parent: FiberLike | undefined = current.parent?.fiber
    if (parent === undefined || parent === current) return false
    current = parent
  }
  return false
}

/** Two-layer runtime capability report for one loaded plugin: the mechanical
 *  layer lists every service its fibers provided (semantics unknown, named
 *  as-is); the rail layer expands the subset dscode understands. Returns
 *  undefined when no live fiber matches (not loaded yet, or a plain dep). */
export function inspectPluginRuntime(ctx: Context, packageName: string): string | undefined {
  const internals = ctx as unknown as CordisInternals
  const roots: FiberLike[] = []
  for (const runtime of internals.registry.values()) {
    const name = runtime.name
    if (name === undefined) continue
    if (name !== packageName && !name.startsWith(packageName + '/')) continue
    for (const fiber of runtime.fibers) roots.push(fiber)
  }
  if (roots.length === 0) return undefined
  const store = internals.reflect.store
  const provided: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (roots.some(root => withinFiber(impl.fiber, root))) provided.push(impl.name)
  }
  const effectLabels = new Map<string, number>()
  for (const root of roots) {
    for (const effect of root.getEffects?.() ?? []) {
      const label = effect.label ?? '(unlabeled)'
      effectLabels.set(label, (effectLabels.get(label) ?? 0) + 1)
    }
  }
  const lines = [packageName + ' — live in this leader (' + String(roots.length) + ' plugin instance(s)):']
  if (provided.length > 0) {
    lines.push('  provides services: ' + provided.join(', '))
    for (const name of provided) {
      if (KNOWN_RAILS[name] !== undefined) lines.push('    · ' + name + ' → ' + KNOWN_RAILS[name])
    }
  } else {
    lines.push('  provides no services (consumer-only plugin)')
  }
  if (effectLabels.size > 0) {
    const shown = [...effectLabels.entries()].slice(0, 12)
      .map(([label, count]) => count > 1 ? label + ' ×' + String(count) : label)
    lines.push('  registered effects: ' + shown.join(', ') + (effectLabels.size > 12 ? ', …' : ''))
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: GrokLeaderConfig): void {
  const agents = ctx.agents
  const llm = (): LlmLike | undefined => ctx.get('llm') as LlmLike | undefined
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
  const persistence = (): PersistenceLike | undefined => ctx.get('sessionPersistence')
  // Read lazily too: agent-default-model depends on the settings provider and
  // can mount after apply, so an eager capture would make session/set_model
  // silently skip saveSelection (and /effort would not persist).
  const agentDefaultModel = (): AgentDefaultModelLike | undefined => ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  /** Read the preset roster on demand: it mounts asynchronously after apply. */
  const agentPresets = (): AgentPresetsLike | undefined => ctx.get('agentPresets') as AgentPresetsLike | undefined
  /** Persist a real, explicitly selected preset as the default for future sessions. */
  const persistPresetDefault = async (preset: string): Promise<void> => {
    const service = settings()
    if (service === undefined) throw internalError('the settings service is not configured')
    const descriptor = service.describe?.().find(entry => entry.ns === PRESET_SETTINGS_NS)
    const user = descriptor?.user
    if (user !== null && typeof user === 'object'
      && (user as Record<string, unknown>).default === preset) return
    try {
      await service.mutate(PRESET_SETTINGS_NS, [{ op: 'set', path: ['default'], value: preset }])
    } catch (error) {
      throw internalError('failed to remember preset "' + preset + '": '
        + (error instanceof Error ? error.message : String(error)))
    }
  }
  const sessions = new Map<SessionId, SessionRecord>()
  const connections = new Map<number, ClientConnection>()
  const persistedSessionIdInUse = async (sessionId: SessionId): Promise<boolean> => {
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    return (await store.list()).some(header => header.id === sessionId)
  }
  let clientSeq = 0
  let closed = false
  let catalog: ModelCatalog | undefined
  /** Fresh model catalogs pulled once per provider from OpenAI-compatible /models endpoints. */
  const discoveredModels = new Map<string, DiscoveredProviderModel[]>()
  /** One background discovery attempt per exact route signature. */
  const discoveredRoutes = new Map<string, string>()
  // grok's ui.combine_queued_prompts (default off); env override for dev shells.
  const combineQueued = config.combineQueuedPrompts === true || process.env.DSCODE_COMBINE_QUEUED === '1'
  // Explicit config wins; the env override serves dev shells; the default is
  // queue (grok parity). 'steer' folds follow-ups into the running turn.
  const followUpSteer = (config.followUpBehavior ?? process.env.DSCODE_FOLLOW_UP ?? 'queue') === 'steer'
  const idleExitMs = config.idleExitMs ?? 2000
  /** x.ai/session/list rows served when the request carries no (or an oversized) limit. */
  const DEFAULT_SESSION_LIST_LIMIT = 50
  /** First-prompt / title / activity index for the session picker and live log. */
  const sessionListIndex = new SessionListIndex()

  /** providerUserSection / providerUserProfile / hasUserProviderRoute /
   * knownRouteBaseUrls live at module scope (pure: no apply() state). */
  const providerExists = (providerService: SettingsLike | undefined, id: string): boolean =>
    hasUserProviderRoute(providerService, id)
    || llm()?.listProviders().some(provider => provider.id === id) === true

  /** Resolve a credential per operation, matching dsh's credential seam. */
  const resolveCredentialValue = async (ref: string | undefined): Promise<string | undefined> => {
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    try {
      const value = await credentials?.resolve?.(ref)
      if (typeof value?.value === 'string' && value.value.length > 0) return value.value
    } catch (error) {
      logger.warn('grok-leader: could not resolve credential reference ' + ref + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    const value = process.env[ref]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** Describe one credential reference without exposing its value. */
  const describeCredential = async (ref: string | undefined): Promise<CredentialInfo | undefined> => {
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    try {
      return await credentials?.describe?.(ref)
    } catch (error) {
      logger.warn('grok-leader: could not describe credential reference ' + ref + ': ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  // The one-time COMPAT SHIM (/dsh login + /dsh code for the pre-registry
  // subscriptions plugin) is RETIRED: @hqzhao95/dsh-subscriptions-commands
  // registers /login, /logout, /code, /subscriptions-status through the dsh
  // command registry, so they auto-surface as slash commands with zero
  // bridge involvement. The bridge carries no plugin-specific code.

  /** Keep a saved/session effort only when the exact advertised model accepts it. */
  const acceptedReasoningEffort = (
    model: ModelCatalog['availableModels'][number] | undefined,
    effort: unknown,
  ): string | undefined => {
    if (!nonEmptyString(effort) || model === undefined) return undefined
    if (model._meta?.supportsReasoningEffort === false) return undefined
    const supported = model._meta?.reasoningEfforts
    return supported === undefined || supported.includes(effort) ? effort : undefined
  }

  /** Rebuild the flattened wire catalog plus the provider ownership the bare ids hide. */
  const refreshCatalog = async (): Promise<ModelCatalog> => {
    const llmService = llm()
    const userSection = providerUserSection(settings())
    const rows = llmService === undefined
      ? []
      : await Promise.all(llmService.listProviders().map(async provider => {
        const staticModels = await llmService.listModels(provider.id)
        const discovered = discoveredModels.get(provider.id)
        const models: Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }> = discovered === undefined
          ? staticModels
          : discovered.map(model => ({
            id: model.id,
            name: model.name ?? model.id,
          }))
        return { provider: provider.id, models }
      }))
    const modelCount = new Map(rows.map(row => [row.provider, row.models.length]))
    const providers = llmService === undefined ? [] : await Promise.all(llmService.listProviders().map(async p => {
      const profile = providerUserProfile(userSection, p.id)
      const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
      const credential = await describeCredential(apiKeyEnv)
      // Display-only status for an empty provider; generic on purpose (the
      // TUI relays notes verbatim, and the bridge carries no plugin-specific
      // knowledge of WHICH login or key a given provider wants).
      const note = (modelCount.get(p.id) ?? 0) > 0 ? undefined
        : 'no models yet — the provider may need a login or API key (its plugin may register a /login command)'
      return {
        id: p.id,
        ...p.name === undefined ? {} : { name: p.name },
        ...typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {},
        ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
        ...typeof profile.api === 'string' ? { api: profile.api } : {},
        ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
        ...credential === undefined ? {} : { credential },
        ...note === undefined ? {} : { note },
      }
    }))
    const providerByModel = new Map<string, string>()
    const providerModelToWireId = new Map<string, string>()
    const rawModelOwners = new Map<string, string>()
    const defaultEffortByModel = new Map<string, string>()
    const availableModels: ModelCatalog['availableModels'] = []
    for (const row of rows) {
      for (const model of row.models) {
        const pairKey = modelEffortKey(row.provider, model.id)
        if (providerModelToWireId.has(pairKey)) continue
        // The first provider that lists a raw id keeps the bare id for
        // backward compatibility; later providers that also carry the same
        // id get a provider-qualified wire id so both remain selectable.
        const existingOwner = rawModelOwners.get(model.id)
        const wireId = existingOwner === undefined || existingOwner === row.provider
          ? model.id
          : wireModelId(row.provider, model.id)
        rawModelOwners.set(model.id, existingOwner ?? row.provider)
        providerModelToWireId.set(pairKey, wireId)
        providerByModel.set(wireId, row.provider)
        // Prefer the adapter's exact-model reasoning metadata over the old
        // one-size-fits-all grok menu, so a provider that has no low/medium/
        // xhigh does not advertise them.
        const resolveModelInfo = llmService?.resolveModelInfo
        const hasMetadataResolver = resolveModelInfo !== undefined
        let reasoning: { defaultEffort?: string; efforts?: Array<{ id: string; name?: string }> } | undefined
        let inputModalities = model.inputModalities
          ?.filter((modality): modality is string => typeof modality === 'string' && modality.length > 0)
        if (resolveModelInfo !== undefined) {
          try {
            const info = await resolveModelInfo.call(llmService, row.provider, model.id)
            reasoning = info.reasoning
            if (info.inputModalities !== undefined) {
              inputModalities = info.inputModalities
                .filter((modality): modality is string => typeof modality === 'string' && modality.length > 0)
            }
          } catch (error) {
            logger.warn('grok-leader: could not resolve model metadata for ' + row.provider + '/' + model.id + ': ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        const efforts = reasoning?.efforts
          ?.map(effort => effort.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        if (typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort.length > 0) {
          defaultEffortByModel.set(pairKey, reasoning.defaultEffort)
        }
        availableModels.push({
          modelId: wireId,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
          _meta: {
            provider: row.provider,
            // An exact metadata resolver returning no reasoning means the
            // model does not expose selectable effort. Only legacy llm seams
            // with no resolver get the compatibility vocabulary.
            supportsReasoningEffort: hasMetadataResolver
              ? (efforts?.length ?? 0) > 0
              : true,
            acceptsImages: inputModalities?.includes('image') === true,
            ...(inputModalities === undefined
              ? {}
              : { inputModalities: [...inputModalities] }),
            ...(efforts !== undefined && efforts.length > 0
              ? { reasoningEfforts: efforts }
              : !hasMetadataResolver
                ? { reasoningEfforts: [...DEFAULT_REASONING_EFFORTS] }
                : {}),
          },
        })
      }
    }
    const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const requestedProvider = nonEmptyString(config.provider)
      ? config.provider
      : nonEmptyString(defaultSelection?.provider)
        ? defaultSelection.provider
        : undefined
    const requestedRawModel = nonEmptyString(config.model)
      ? config.model
      : nonEmptyString(defaultSelection?.model)
        ? defaultSelection.model
        : undefined
    const requested = requestedRawModel === undefined
      ? undefined
      : requestedProvider === undefined
        ? requestedRawModel
        : providerModelToWireId.get(modelEffortKey(requestedProvider, requestedRawModel)) ?? requestedRawModel
    // A fresh profile has no requested model and may have an empty catalog.
    // Once the user adds a provider, the first advertised model becomes the
    // UI seed until they make (and persist) an explicit selection.
    let currentModelId = requested ?? availableModels[0]?.modelId ?? ''
    if (currentModelId !== '' && !providerByModel.has(currentModelId)) {
      currentModelId = availableModels[0]?.modelId ?? ''
      logger.warn('grok-leader: model "' + requested + '" is not in the catalog; falling back to "' + currentModelId + '"')
    }
    const currentProviderId = currentModelId === '' ? '' : providerByModel.get(currentModelId) ?? ''
    const currentParsed = parseWireModelId(currentModelId)
    const currentRawModel = currentParsed !== undefined && currentProviderId === currentParsed.provider
      ? currentParsed.model
      : currentModelId
    // The pager reads the selected effort from the current model's
    // _meta.reasoningEffort on every models/list, so a /effort choice must
    // ride the catalog or it is forgotten across restarts. When the user has
    // not chosen one yet, surface the adapter-configured default (DeepSeek's
    // adapter defaults to high) so the status bar is not empty on first run.
    const currentModel = availableModels.find(model => model.modelId === currentModelId)
    const persistedEffort = defaultSelection?.provider === currentProviderId
      && defaultSelection.model === currentRawModel
      ? defaultSelection.reasoningEffort
      : undefined
    const adapterDefault = defaultEffortByModel.get(modelEffortKey(currentProviderId, currentRawModel))
    const selectedEffort = acceptedReasoningEffort(currentModel, persistedEffort)
      ?? acceptedReasoningEffort(currentModel, adapterDefault)
      ?? (llmService?.resolveModelInfo === undefined
        ? acceptedReasoningEffort(currentModel, DEFAULT_REASONING_EFFORT)
        : undefined)
    if (selectedEffort !== undefined && currentModel?._meta !== undefined) {
      currentModel._meta.reasoningEffort = selectedEffort
    }
    catalog = {
      currentModelId,
      providers,
      currentProviderId,
      availableModels,
      providerByModel,
      providerModelToWireId,
    }
    return catalog
  }

  /** The most recently refreshed catalog, rebuilt on first use. */
  const currentCatalog = (): Promise<ModelCatalog> => catalog === undefined
    ? refreshCatalog()
    : Promise.resolve(catalog)

  /** Reconcile live selections after a background capability refresh. A
   * temporarily unavailable catalog may have omitted a remembered effort at
   * session creation; once the exact model advertises it, restore that choice
   * before the next step. If refreshed metadata rejects the active effort,
   * remove it instead of letting a later turn fail before network I/O. */
  const reconcileSessionReasoningEfforts = (current: ModelCatalog): void => {
    for (const record of sessions.values()) {
      const selection = record.selection.current
      if (selection === undefined) continue
      const key = modelEffortKey(selection.provider, selection.model)
      const wireId = current.providerModelToWireId.get(key)
      if (wireId === undefined) continue
      const advertised = current.availableModels.find(model => model.modelId === wireId)
      const remembered = record.modelEfforts.get(key)
      const requested = selection.reasoningEffort ?? remembered
      const accepted = acceptedReasoningEffort(advertised, requested)
      if (accepted === undefined && requested !== undefined) record.modelEfforts.delete(key)
      if (accepted === selection.reasoningEffort) continue
      record.selection.current = {
        provider: selection.provider,
        model: selection.model,
        ...accepted === undefined ? {} : { reasoningEffort: ReasoningEffortId(accepted) },
      }
    }
  }

  /** Resolve one session's requested/saved selection against the live
   * catalog. This lets `--model <wire-id>` infer its provider and lets an
   * existing configured provider seed a session even when the neutral
   * deployment default is empty. Explicit unknown models fail closed; stale
   * saved routes fall back to the catalog seed. */
  const selectionForRequest = async (
    defaultSelection: { provider: string; model: string; reasoningEffort?: string } | undefined,
    meta: Record<string, unknown> | null | undefined,
  ): Promise<ModelSelectionRef['current']> => {
    const current = await currentCatalog()
    const candidate = modelSelectionFromRequest(config, defaultSelection, meta)
    const explicitModel = nonEmptyString(meta?.model) ? meta.model : undefined
    const explicitProvider = nonEmptyString(meta?.provider) ? meta.provider : undefined
    let wireId: string | undefined
    if (explicitProvider === undefined
      && explicitModel !== undefined
      && current.providerByModel.has(explicitModel)) {
      wireId = explicitModel
    } else if (candidate !== undefined) {
      wireId = current.providerModelToWireId.get(modelEffortKey(candidate.provider, candidate.model))
        ?? (current.providerByModel.get(candidate.model) === candidate.provider ? candidate.model : undefined)
    }
    if (wireId === undefined && (explicitModel !== undefined || explicitProvider !== undefined)) {
      throw invalidParams('requested provider/model is not in the catalog: '
        + String(explicitProvider ?? '') + (explicitProvider === undefined ? '' : '/') + String(explicitModel ?? ''))
    }
    wireId ??= current.currentModelId === '' ? undefined : current.currentModelId
    if (wireId === undefined) return undefined
    const provider = current.providerByModel.get(wireId)
    if (provider === undefined) return undefined
    const parsed = parseWireModelId(wireId)
    const model = parsed !== undefined && parsed.provider === provider ? parsed.model : wireId
    const advertisedModel = current.availableModels.find(entry => entry.modelId === wireId)
    const reasoningEffort = acceptedReasoningEffort(advertisedModel, candidate?.reasoningEffort)
      ?? acceptedReasoningEffort(advertisedModel, advertisedModel?._meta?.reasoningEffort)
    return {
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    }
  }

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
    if (process.env.DSCODE_DEBUG === '1') {
      process.stderr.write('grok-leader wire out acp: ' + JSON.stringify(value).slice(0, 400) + '\n')
    }
    conn.socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(value) }))
  }

  const sendNotification = (conn: ClientConnection, method: string, params: unknown): void => {
    // ACP extension methods ride the wire with a '_' prefix: the pager's
    // agent-client-protocol decode strips it before dispatching to the
    // x.ai/* handlers and DROPS unprefixed unknown methods as
    // method_not_found. session/update is the sole typed (non-extension)
    // notification this bridge emits.
    const wire = method === WIRE.sessionUpdate || method.startsWith('_') ? method : '_' + method
    sendAcp(conn, { jsonrpc: '2.0', method: wire, params })
  }

  /** A client that never answers a reverse request is rejected after this long. */
  const REVERSE_REQUEST_TIMEOUT_MS = 60_000

  /**
   * Send a JSON-RPC request to one client and wait for its response.
   * `timeoutMs` overrides the default 60s budget; pass `Infinity` to wait
   * indefinitely (used for ask_user_question, which must hang until the
   * human answers — a bounded window here would surface a "user didn't
   * answer" tool failure the agent cannot distinguish from a real answer).
   */
  const requestClient = <T>(
    conn: ClientConnection,
    method: string,
    params: unknown,
    sessionId?: SessionId,
    timeoutMs?: number,
  ): Promise<T> => {
    const id = conn.nextRequestId++
    sendAcp(conn, { jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs ?? REVERSE_REQUEST_TIMEOUT_MS)
        ? setTimeout(() => {
            conn.pending.delete(String(id))
            reject(new RpcError(JSONRPC_INTERNAL_ERROR, 'client did not answer ' + method + ' within ' + (timeoutMs ?? REVERSE_REQUEST_TIMEOUT_MS) + 'ms'))
          }, timeoutMs ?? REVERSE_REQUEST_TIMEOUT_MS)
        : undefined
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
   * Admit a dsh event once, before projecting its items. Replay/live overlap
   * dedup happens at event granularity: several wire updates can come from one
   * event (a user/message with many text blocks), and gating inside emitUpdate
   * would drop every item after the first. Returns false when this seq was
   * already forwarded (replay of a still-live session).
   */
  const admitEvent = (record: SessionRecord, seq: number): boolean => {
    if (seq <= record.lastSeq) return false
    record.lastSeq = seq
    return true
  }

  /**
   * Forward one update with the leader _meta stamp. The eventSeq monotonic
   * counter plus the per-session dsh-seq high-water make replay/live overlap
   * deduplicable on the client side (server.rs eventId dedup).
   * Event-to-wire admission is `admitEvent` — this only serializes.
   */
  const emitUpdate = (
    conn: ClientConnection,
    record: SessionRecord,
    item: ProjectedUpdate,
    isReplay: boolean,
    agentTimestampMs?: number,
  ): void => {
    const eventSeq = record.eventSeq
    record.eventSeq = eventSeq + 1
    const inflight = record.inflight
    const { totalTokens, cacheHitPercent, ...update } = item
    sendNotification(conn, WIRE.sessionUpdate, {
      sessionId: record.agent.session.id,
      update,
      _meta: {
        eventSeq,
        ...inflight === undefined ? {} : { promptId: inflight.promptId },
        ...isReplay ? { isReplay: true } : {},
        ...totalTokens === undefined ? {} : { totalTokens },
        ...cacheHitPercent === undefined ? {} : { cacheHitPercent },
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
        record.cacheReadTokens += usage.cacheReadTokens ?? 0
        record.cacheWriteTokens += usage.cacheWriteTokens ?? 0
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
    } else if (String(event.type) === 'compaction/end') {
      record.compactionCount += 1
    } else if (event.type === 'turn/end') {
      record.turnCount += 1
    }
  }

  /** Map one event to wire updates, attaching the cumulative token total to agent text. */
  const mapEvent = (
    record: SessionRecord,
    event: SessionEvent,
    replay: boolean,
  ): Array<ProjectedUpdate> => {
    if (event.type === 'step/start') record.textStreamed = false
    noteEvent(record, event)
    const totalTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens
    const hitPercent = cacheHitPercent(record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens)
    const updates: Array<ProjectedUpdate> = []
    for (const item of sessionEventToUpdates(event, {
      replay,
      textStreamed: record.textStreamed,
      toolCall: (callId) => record.pendingToolCalls.get(callId),
    })) {
      if (item.sessionUpdate === 'agent_message_chunk') {
        if (item.content.text.length > 0) record.textStreamed = true
        updates.push({ ...item, totalTokens, ...hitPercent === undefined ? {} : { cacheHitPercent: hitPercent } })
      } else {
        updates.push(item)
      }
    }
    // Streamed responses suppress their assembled assistant message. Emit one
    // empty content chunk so the terminal usage still reaches the TUI without
    // creating another scrollback block.
    if (event.type === 'assistant/message' && event.data.usage !== undefined
      && !updates.some(item => item.sessionUpdate === 'agent_message_chunk')) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        totalTokens,
        ...hitPercent === undefined ? {} : { cacheHitPercent: hitPercent },
      })
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
    sessionListIndex.recordEvent(session.header.id, session.header.createdAt, event)
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    try {
      // Live events admit until a replayed seq catches up; settle logic below
      // still runs unconditionally in finally.
      if (admitEvent(record, event.seq)) {
        if (event.type === 'turn/start') {
          record.turnStartMs = event.time
        }
        if (event.type === 'todo/write') {
          const data = event.data as { todos?: Array<{ content?: unknown; status?: unknown }> }
          const entries = (data.todos ?? []).map(todo => ({
            content: String(todo.content ?? ''),
            priority: 'medium',
            status: todo.status === 'in_progress' ? 'in_progress' : todo.status === 'completed' ? 'completed' : 'pending',
          }))
          emitUpdate(conn, record, { sessionUpdate: 'plan', entries }, false, event.time)
        }
        for (const item of mapEvent(record, event, false)) {
          emitUpdate(conn, record, item, false, event.time)
        }
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
          // The pager's question card has one multiline heading slot. Preserve
          // dsh's separate short header and supporting detail instead of
          // dropping them at the adapter boundary.
          const displayQuestion = [question.header, question.question, question.detail]
            .filter(nonEmptyString)
            .join('\n')
          textToId.set(displayQuestion, question.id)
          return {
            question: displayQuestion,
            options: (question.options ?? []).map(option => ({
              label: option.label,
              description: option.description ?? '',
            })),
            ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
            ...(question.id !== undefined ? { id: question.id } : {}),
          }
        })
        // The ACP ext_method reverse request carries the typed payload FLATLY
        // under params: the pager's handle_ask_user_question does
        // `from_str(ext.request.params)` straight into AskUserQuestionExtRequest
        // (uses crate fixtures/tests serialize `{sessionId,toolCallId,
        // questions,mode}` — camelCase, no `method` wrapper). The earlier
        // wrapped `{method, params}` two-level form made the pager's serde
        // reject with `missing field 'sessionId'`, so keep the method in the
        // JSON-RPC method slot and the fields flat. dsh does not expose the
        // tool call id, so mint an opaque one the client echoes back.
        const response = await requestClient<AskUserQuestionExtResponse>(conn, '_x.ai/ask_user_question', {
          sessionId: record.agent.session.id,
          toolCallId: randomUUID(),
          questions: grokQuestions,
          mode: 'default',
          // Wait for the human answer indefinitely (`Infinity` disables the
          // reverse-request timeout). A bounded window would surface a
          // "client did not answer" tool failure that the agent cannot
          // distinguish from a real user decision; the question stays up in
          // the TUI until answered, cancelled, or its session is torn down
          // (which rejectPendingFor reports as a proper cancellation).
        }, record.agent.session.id, Infinity)
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
   * Bridge-owned slash commands advertised over ACP: /dsh (plugin
   * management, executed in prompt()) and /preset (from the live preset
   * roster). Plugin-registered commands are appended per session by
   * commandCatalog(). The TUI's builtin /preset picker shadows the advert;
   * headless/other ACP clients use the bridge's raw /preset handler.
   */
  const availableCommands = async (): Promise<Array<{ name: string; description: string; input?: { hint: string } }>> => {
    const commands: Array<{ name: string; description: string; input?: { hint: string } }> = [{
      name: 'dsh',
      description: 'Manage dsh plugins',
      input: { hint: 'plugins | add [--trust] <package> | remove <name> | inspect <name>' },
    }]
    const roster = agentPresets()
    const presets = roster === undefined ? [] : await roster.list()
    if (presets.length > 0) {
      commands.push({
        name: 'preset',
        description: 'Switch the active agent preset',
        input: { hint: presets.map(preset => preset.id).join(' | ') },
      })
    }
    return commands
  }

  const initializeResponse = async (): Promise<unknown> => {
    await settingsReady()
    const current = await refreshCatalog()
    scheduleDynamicCatalogRefresh()
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
      agentInfo: { name: 'deepseek-harness-grok-leader', version: PACKAGE_VERSION },
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
    if (typeof profile === 'object' && profile !== null && !Array.isArray(profile)) {
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
      // Only the two known grok-build profiles may bridge to the deployment
      // default. A user-provided typo must fail instead of silently selecting a
      // different tool composition.
      if (presetRequest === undefined || !GROK_PROFILE_FALLBACKS.has(presetRequest)) {
        throw invalidParams('unknown agent preset "' + String(presetRequest) + '": ' + (error instanceof Error ? error.message : String(error)))
      }
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

  /** The composition a persisted/live session actually runs, newest switch winning. */
  const sessionPresetFromLog = (
    header: { agentPreset?: string },
    events: readonly SessionEvent[],
  ): string | undefined => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'agent-preset/selected') continue
      const selected = (event.data as { agentPreset?: unknown }).agentPreset
      if (typeof selected === 'string' && selected.length > 0) return selected
    }
    return header.agentPreset
  }

  /** A preset may change only before the session has produced model-visible history. */
  const presetSwitchLocked = (events: readonly SessionEvent[]): boolean =>
    events.some(event => event.type === 'user/message'
      || event.type === 'assistant/message'
      || event.type === 'tool/result')

  const appendPresetSelection = (record: SessionRecord, agentPreset: string): void => {
    record.agent.session.append('agent-preset/selected', { agentPreset })
  }

  /** Fail closed for CLI metadata this bridge cannot currently enforce. */
  const validateSessionMeta = (
    meta: Record<string, unknown> | null | undefined,
    method: string,
  ): void => {
    if (meta === undefined || meta === null) return
    if (meta.yoloMode !== undefined && typeof meta.yoloMode !== 'boolean') {
      throw invalidParams('_meta.yoloMode must be a boolean')
    }
    if (meta.autoMode !== undefined && typeof meta.autoMode !== 'boolean') {
      throw invalidParams('_meta.autoMode must be a boolean')
    }
    if (meta.askUserQuestion !== undefined && typeof meta.askUserQuestion !== 'boolean') {
      throw invalidParams('_meta.askUserQuestion must be a boolean')
    }
    if (meta.permissionMode !== undefined && typeof meta.permissionMode !== 'string') {
      throw invalidParams('_meta.permissionMode must be a string')
    }
    if (meta.sandbox !== undefined && typeof meta.sandbox !== 'string') {
      throw invalidParams('_meta.sandbox must be a string')
    }
    if (meta.noReplay !== undefined && typeof meta.noReplay !== 'boolean') {
      throw invalidParams('_meta.noReplay must be a boolean')
    }
    if (meta.rememberAgentPreset !== undefined && typeof meta.rememberAgentPreset !== 'boolean') {
      throw invalidParams('_meta.rememberAgentPreset must be a boolean')
    }
    if (meta.subagents === false) {
      throw invalidParams('--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead')
    }
    const unsupported: string[] = []
    if (meta.autoMode === true) unsupported.push('autoMode')
    if (meta.askUserQuestion === false) unsupported.push('askUserQuestion')
    if (typeof meta.permissionMode === 'string'
      && !SUPPORTED_PERMISSION_MODES.has(meta.permissionMode)) {
      unsupported.push('permissionMode=' + JSON.stringify(meta.permissionMode))
    }
    if (typeof meta.sandbox === 'string' && meta.sandbox !== 'off' && meta.sandbox !== 'none') {
      unsupported.push('sandbox=' + JSON.stringify(meta.sandbox))
    }
    for (const key of ['systemPromptOverride', 'rules', 'tools', 'disallowedTools'] as const) {
      if (meta[key] !== undefined) unsupported.push(key)
    }
    if (unsupported.length > 0) {
      throw invalidParams(method + ' cannot enforce _meta.' + unsupported.join(', _meta.') + '; refusing to run with silently weakened CLI settings')
    }
  }

  /** session/new and session/load share the workspace gate: an absolute cwd
   * and a well-formed mcpServers array. The bridge advertises
   * mcpCapabilities { http: false, sse: false } and has no MCP plumbing, but
   * the grok TUI auto-discovers servers (e.g. ~/.claude.json) and sends them
   * anyway; a discovered-but-unserved server must not brick every session.
   * A non-array value is still malformed and rejects; a non-empty array is
   * accepted and ignored with a logged warning (never silent). */
  const validateWorkspaceParams = (p: Record<string, unknown>): string => {
    const cwd = p.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalidParams('cwd must be an absolute path: ' + String(cwd))
    const mcpServers = p.mcpServers
    if (mcpServers !== undefined) {
      if (!Array.isArray(mcpServers)) throw invalidParams('mcpServers must be an array')
      if (mcpServers.length > 0) logger.warn('grok-leader: ignoring ' + String(mcpServers.length) + ' MCP server(s); MCP is not supported by this bridge')
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
    validateSessionMeta(meta, 'session/new')
    // Clients may pin the session id through _meta.sessionId; absent one, mint it.
    const suppliedId = meta?.sessionId
    const sessionId = typeof suppliedId === 'string' && suppliedId.length > 0 ? SessionId(suppliedId) : SessionId(randomUUID())
    // A pinned id that is already live must not silently replace the record:
    // that would strand the old agent and re-route its reverse channels.
    if (sessions.has(sessionId)
      || (typeof suppliedId === 'string' && await persistedSessionIdInUse(sessionId))) {
      throw invalidParams('session id is already in use: ' + String(sessionId))
    }
    // Verified divergence: upstream inject_session_request_context
    // (server.rs) also stamps autoMode, modelId, clientIdentifier,
    // codeNavEnabled, and client terminal/fs routing into session/new from the
    // registration capabilities. dsh sessions have no codeNav / terminal / fs
    // routing concepts, so only yoloMode and agentProfile/agentPreset are
    // wired here; the rest is deliberately absent, not unverified.
    const presetRequest = presetRequestFromMeta(meta)
    const preset = await composePreset(presetRequest)
    const explicitPreset = presetRequest !== undefined && preset.agentPreset === presetRequest
      ? preset.agentPreset
      : undefined
    // Seed from the saved global default when one exists. A provider-neutral
    // fresh profile deliberately leaves selection.current undefined until the
    // user adds a provider and picks a model.
    const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const rememberedSelection = modelSelectionFromRequest(config, defaultSelection, meta)
    const selection: ModelSelectionRef = {
      current: await selectionForRequest(defaultSelection, meta),
      assembled: undefined,
    }
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset },
      },
      agentOptions: agentOptions(config, selection.current),
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
      modelEfforts: modelEffortsForSelection(rememberedSelection ?? selection.current),
      yolo: meta?.yoloMode === true,
      // -1 admits a first event at seq 0 through the seq <= lastSeq replay gate.
      lastSeq: -1,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      compactionCount: 0,
      pendingToolCalls: new Map(),
      textStreamed: false,
      prompts: [],
      promptAdmissionTail: Promise.resolve(),
      promptQueue: [],
      runningPromptId: undefined,
      runningText: undefined,
      runningCombinedTexts: undefined,
      cancelTrigger: undefined,
      editHolds: new Set(),
      mcpInitTimer: undefined,
      inflight: undefined,
      promotionScheduled: false,
      steered: [],
    }
    try {
      applyPermissionMode(
        record,
        typeof meta?.permissionMode === 'string' ? meta.permissionMode : undefined,
        typeof meta?.yoloMode === 'boolean' ? meta.yoloMode : undefined,
      )
    } catch (error) {
      await handle.dispose()
      throw error
    }
    if (explicitPreset !== undefined && meta?.rememberAgentPreset === true) {
      try {
        await persistPresetDefault(explicitPreset)
      } catch (error) {
        await handle.dispose()
        throw error
      }
    }
    sessions.set(sessionId, record)
    void broadcastAvailableCommands(record)
    // The pager parks on "Starting session…" until this arrives (the probe
    // worker's scripted fake sends it 50 ms after the session/new result;
    // see docs/grok-leader-protocol.md).
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

  /** Queue-snapshot sequence, strictly increasing across every broadcast the
   *  leader emits. Epoch-seeded so a restarted leader outranks its
   *  predecessor's snapshots without a pager-side reset handshake; the pager
   *  drops any snapshot whose seq is not strictly newer for its session.
   *  The x1024 scale means a successor could only fall behind if the
   *  predecessor sustained over 1024 broadcasts per millisecond of its own
   *  lifetime — far beyond what per-broadcast JSON encoding and socket writes
   *  allow; the +1024 headstart covers even a same-millisecond succession.
   *  A clock that steps backwards between leaders is out of this seed's
   *  reach, so the pager also clears its watermarks whenever the leader
   *  connection is re-established (watermarks are connection-scoped).
   *  Stays integer-exact: 2^53 / (Date.now() * 1024) leaves millennia of
   *  headroom. */
  let queueSeq = Date.now() * 1024 + 1024

  /** Broadcast the live queue to the pager: pending rows plus the running prompt. */
  const broadcastQueueChanged = (record: SessionRecord): void => {
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    sendNotification(conn, 'x.ai/queue/changed', {
      sessionId: record.agent.session.id,
      seq: ++queueSeq,
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

  /** The settle result a resolved prompt RPC carries back to the pager. */
  const promptSettled = (record: SessionRecord, promptId: string, stopReason: StopReasonWire): PromptSettleResult =>
    ({ stopReason, _meta: { sessionId: String(record.agent.session.id), promptId } })

  /**
   * Run one validated prompt: admit it, stream the echo, and settle at turn
   * end (or idle for a turnless slot).
   */
  const runPrompt = async (
    record: SessionRecord,
    id: string,
    text: string,
    content: DurablePromptBlock[],
    combinedTexts?: string[],
  ): Promise<PromptSettleResult> => {
    if (agents.get(record.agent.id) !== record.agent) {
      throw internalError('prompt was not queued: the agent was disposed outside the bridge')
    }
    const message = createUserMessage({ content, source: { kind: 'user' } })
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
        emitUpdate(conn, record, {
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
    // Steered follow-ups rode this turn: settle them with its outcome. They
    // never had a turn of their own, so no prompt_complete is emitted for them.
    for (const steered of record.steered.splice(0)) {
      steered.resolve(promptSettled(record, steered.id, stopReason ?? 'cancelled'))
    }
    if (record.promptQueue.length > 0) {
      promoteWhenIdle(record)
    } else {
      broadcastQueueChanged(record)
    }
    if (failure !== undefined) throw failure
    // A settled prompt must always carry a stop reason; an undefined one here
    // means the settlement path broke, and a silent non-null assertion would
    // lie to the pager about how the turn ended.
    if (stopReason === undefined) throw internalError('prompt settled without a stop reason')
    return promptSettled(record, id, stopReason)
  }

  /** Start the next queued prompt once the in-flight one has settled. */
  const advancePromptQueue = (record: SessionRecord): void => {
    // A settling prompt (inflight resolved, cleanup pending) still owns the
    // running slot: promoting now would emit the promotion broadcast before
    // the settling prompt's prompt_complete, breaking the grok wire order.
    // The settle path re-requests promotion after its cleanup.
    if (record.inflight !== undefined || record.runningPromptId !== undefined) return
    const front = record.promptQueue[0]
    if (front === undefined) return
    // A held front parks the whole queue (grok maybe_start_running_task):
    // nothing promotes until queue/release_edit clears the hold.
    if (record.editHolds.has(front.id)) return
    // grok combine: fold only adjacent text-only rows. Images are durable
    // message content and must retain their own per-message admission boundary.
    if (combineQueued && record.promptQueue.length >= 2
      && !front.content.some(block => block.type === 'image')) {
      const segments = [front.text]
      // Held or image-bearing followers stop the merge at that row.
      while (record.promptQueue.length >= 2
        && !record.editHolds.has(record.promptQueue[1]!.id)
        && !record.promptQueue[1]!.content.some(block => block.type === 'image')) {
        const follower = record.promptQueue.splice(1, 1)[0]!
        segments.push(follower.text)
        follower.resolve(promptSettled(record, follower.id, 'cancelled'))
      }
      if (segments.length >= 2) front.combinedTexts = segments
    }
    const entry = record.promptQueue.shift()!
    const runText = entry.combinedTexts === undefined ? entry.text : entry.combinedTexts.join('\n\n')
    const runContent = entry.combinedTexts === undefined
      ? entry.content
      : [{ type: 'text' as const, text: runText }]
    void runPrompt(record, entry.id, runText, runContent, entry.combinedTexts).then(entry.resolve, entry.reject)
  }

  /** Promote the next queued prompt without racing the harness turn lifecycle.
   *
   * The single promotion entry point: settle, enqueue, and every queue
   * mutation route through here, so no path can start a followup from inside
   * the harness's turn/end handling (the harness discards a followup admitted
   * there). An agent reporting `status === 'idle'` has retired its driver —
   * no turn/end handler can be on the stack — so the idle path promotes
   * synchronously, keeping its enqueue → running broadcast order. (Load-
   * bearing agent-loop ordering: kick() flips status to idle before the
   * driver promise that whenIdle awaits resolves, so a settling prompt's
   * cleanup always runs before anyone observes idle for that turn.) Any other
   * state schedules exactly one `whenIdle` wait (`promotionScheduled` dedups;
   * the settle path re-requests promotion, so a wait that fires while a turn
   * is still in flight never strands the queue). The live-record guard
   * mirrors the settle path: a closed, reloaded, or re-parented session must
   * not resurrect queued prompts through a stale agent reference. */
  const promoteWhenIdle = (record: SessionRecord): void => {
    if (record.promotionScheduled) return
    if (record.inflight === undefined && record.agent.status === 'idle') {
      advancePromptQueue(record)
      return
    }
    record.promotionScheduled = true
    void record.agent.whenIdle().then(() => {
      record.promotionScheduled = false
      if (closed || sessions.get(record.agent.session.id) !== record) return
      advancePromptQueue(record)
    }, (error: unknown) => {
      record.promotionScheduled = false
      logger.warn('grok-leader: idle wait failed for ' + String(record.agent.session.id) + ': ' + errorChain(error))
    })
  }

  /** Settle every queued (not-yet-run) prompt as cancelled (cancel/close/teardown). */
  const discardPromptQueue = (record: SessionRecord): void => {
    // A discarded row can never be promoted, so its edit hold must not linger
    // and accidentally park a future row that reuses the same id.
    record.editHolds.clear()
    for (const entry of record.promptQueue.splice(0)) entry.resolve(promptSettled(record, entry.id, 'cancelled'))
  }

  /** Enqueue a validated prompt and run it as soon as the session is idle. */
  const enqueuePrompt = (record: SessionRecord, p: Record<string, unknown>, text: string, content: DurablePromptBlock[]): Promise<PromptSettleResult> =>
    new Promise((resolve, reject) => {
      const meta = p._meta as Record<string, unknown> | null | undefined
      const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
      if (meta?.sendNow === true && record.inflight !== undefined) {
        // grok send-now for a composer prompt (_meta.sendNow): cancel the
        // running turn and run this prompt next, ahead of the queue —
        // mirroring x.ai/queue/interject's front-jump for queued rows. The
        // send_now trigger suppresses the pager's "Turn cancelled" marker.
        record.promptQueue.unshift({ resolve, reject, id, text, content, version: 0 })
        record.cancelTrigger = 'send_now'
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        broadcastQueueChanged(record)
        return
      }
      // Per-prompt routing: _meta.followUp overrides the configured default,
      // so one keystroke can steer a single follow-up while plain sends keep
      // queueing (or vice versa). Unknown values fall back to the default.
      const steerThis = meta?.followUp === 'steer' ? true : meta?.followUp === 'queue' ? false : followUpSteer
      if (steerThis && record.inflight !== undefined) {
        // Follow-up steer (grok ui.follow_up_behavior=steer): fold the prompt
        // into the running turn at the harness's next step boundary instead of
        // parking it behind a whole (possibly minutes-long) turn. The row is
        // confirmed to the pager once — so its optimistic echo retires by id —
        // and then leaves the queue as it joins the live turn; its RPC settles
        // with the host turn (see the steered drain in runPrompt).
        record.promptQueue.push({ resolve, reject, id, text, content, version: 0 })
        broadcastQueueChanged(record)
        record.promptQueue.pop()
        try {
          record.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
        } catch (error: unknown) {
          broadcastQueueChanged(record)
          reject(internalError('prompt was not steered: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
        record.steered.push({ id, resolve })
        // Echo into the live turn's stream: steered text belongs to the
        // running transcript, mirroring runPrompt's admission echo.
        const conn = connections.get(record.clientId)
        if (conn !== undefined) {
          emitUpdate(conn, record, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text },
          }, false, Date.now())
        }
        broadcastQueueChanged(record)
        return
      }
      // Fresh rows start at version 0 (grok QueueEntryMeta); edits bump by one.
      record.promptQueue.push({ resolve, reject, id, text, content, version: 0 })
      const runningBefore = record.runningPromptId
      promoteWhenIdle(record)
      // The idle fast path already broadcast the promoted state from inside
      // runPrompt (with this row included); a second identical snapshot would
      // only burn a seq and a client wakeup.
      if (record.runningPromptId === runningBefore) broadcastQueueChanged(record)
    })

  // ── /dsh: in-TUI dsh plugin management ─────────────────────────────
  //
  // Advertised through availableCommands, so the pager sends "/dsh ..." as a
  // plain prompt (ACP pass-through) and this bridge interprets it instead of
  // the model. Replies stream as turnless agent messages and settle through
  // the prompt RPC — no prompt_complete is emitted, so a /dsh issued while a
  // real turn runs can never finalize that turn on the pager.

  /** The dsh profile directory this bridge is installed in: the directory
   *  holding the node_modules we were loaded from, a DSH_PROFILE_DIR
   *  override (tests), or the default dscode profile. `undefined`
   *  in a source checkout with no installed profile. */
  const dshProfileDir = (): string | undefined => {
    const override = process.env.DSH_PROFILE_DIR
    if (override !== undefined && override.length > 0) return override
    const self = fileURLToPath(import.meta.url)
    const marker = sep + 'node_modules' + sep
    const idx = self.indexOf(marker)
    if (idx > 0) return self.slice(0, idx)
    const fallback = join(homedir(), '.dsh', 'profiles', 'dscode')
    return existsSync(join(fallback, 'package.json')) ? fallback : undefined
  }

  const execFileAsync = promisify(execFile)

  /** Stream a turnless agent message into the session transcript. */
  const notifySession = (record: SessionRecord, message: string): void => {
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    emitUpdate(conn, record, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: message },
    }, false, Date.now())
  }

  const presetServiceFor = (record: SessionRecord, name: string): unknown =>
    agentPresets()?.serviceForAgent?.(record.agent, name)
      ?? record.agent.ctx.get(name)
      ?? ctx.get(name)

  const toolNamesFor = (record: SessionRecord): Set<string> => {
    const tools = record.agent.ctx.get('tools') as { schemas(scope?: unknown): Array<{ name: string }> } | undefined
    return new Set((tools === undefined ? [] : tools.schemas(record.agent)).map(schema => schema.name))
  }

  const capabilitiesFor = (record: SessionRecord): string[] => {
    const capabilities: string[] = []
    const names = toolNamesFor(record)
    if (['subagent', 'subagent_fork', 'list_agents', 'send_message'].some(name => names.has(name))
      && presetServiceFor(record, 'subagents') !== undefined) {
      capabilities.push('subagents')
    }
    if (names.has('skill') && presetServiceFor(record, 'skills') !== undefined) capabilities.push('skills')
    if (names.has('exit_plan_mode') && presetServiceFor(record, 'planMode') !== undefined) capabilities.push('plan')
    if (['get_goal', 'create_goal', 'update_goal'].some(name => names.has(name))
      && presetServiceFor(record, 'goals') !== undefined) capabilities.push('goal')
    if (['job_output', 'job_list', 'job_kill'].some(name => names.has(name))
      && presetServiceFor(record, 'jobs') !== undefined) capabilities.push('jobs')
    if (['workflow', 'ralph'].some(name => names.has(name))
      && presetServiceFor(record, 'workflowEngine') !== undefined) capabilities.push('workflow')
    if (names.has('todo_write')) capabilities.push('todo')
    if (names.has('schedule_create')) capabilities.push('schedule')
    return capabilities
  }

  const readProfileManifest = async (dir: string): Promise<{ dependencies: Record<string, string>; bundles: string[]; raw: Record<string, unknown> }> => {
    const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const dependencies = (raw.dependencies ?? {}) as Record<string, string>
    const dsh = (raw.dsh ?? {}) as { profile?: { bundles?: string[] } }
    return { dependencies, bundles: dsh.profile?.bundles ?? [], raw }
  }

  const writeProfileBundles = async (dir: string, raw: Record<string, unknown>, bundles: string[]): Promise<void> => {
    const dsh = (raw.dsh ?? (raw.dsh = {})) as Record<string, unknown>
    const profile = (dsh.profile ?? (dsh.profile = {})) as Record<string, unknown>
    profile.bundles = bundles
    const target = join(dir, 'package.json')
    const temporary = join(dir, '.package.json.' + String(process.pid) + '.' + randomUUID() + '.tmp')
    try {
      await writeFile(temporary, JSON.stringify(raw, null, 2) + '\n')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** The dsh plugin command registry, when the composition mounts it. */
  const dshCommands = (): CommandsLike | undefined => ctx.get('commands') as CommandsLike | undefined

  /** Advertise builtin + plugin-registered commands to one session (ACP
   *  available_commands_update). Plugin commands come from the dsh command
   *  registry, so any plugin's ctx.commands.register() surfaces as a pager
   *  slash command with completion — no bridge or TUI change per plugin. */
  const commandCatalog = async (record?: SessionRecord): Promise<Array<{ name: string; description: string; input?: { hint: string } }>> => {
    const commands = await availableCommands()
    if (record === undefined) return commands
    const registry = dshCommands()
    const fromPlugins = registry === undefined ? [] : registry.list(record.agent).map(command => ({
      name: command.name,
      description: command.description,
      ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
    }))
    const claimed = new Set(commands.map(command => command.name.toLowerCase()))
    for (const command of fromPlugins) {
      if (claimed.has(command.name.toLowerCase())) continue
      claimed.add(command.name.toLowerCase())
      commands.push(command)
    }
    return commands
  }

  const broadcastAvailableCommands = async (record: SessionRecord): Promise<void> => {
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    // Sent directly, not through emitUpdate: a roster refresh is ambient, not
    // a turn event, so it must not consume eventSeq or carry a promptId.
    sendNotification(conn, WIRE.sessionUpdate, {
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: await commandCatalog(record),
        meta: { capabilities: capabilitiesFor(record) },
      },
    })
  }

  /** Refresh model state for one live session. An unselected onboarding
   * session receives the new catalog with an empty current id; the client can
   * then choose a provider without the bridge pretending a model was active. */
  const notifyModelsUpdate = (record: SessionRecord): void => {
    const current = catalog
    if (current === undefined) return
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    const selection = record.selection.current
    const selectedId = selection === undefined
      ? ''
      : current.providerModelToWireId.get(modelEffortKey(selection.provider, selection.model))
        ?? ''
    const availableModels = current.availableModels.map(model => {
      if (selection === undefined || model.modelId !== selectedId || model._meta === undefined) return model
      return {
        ...model,
        _meta: {
          ...model._meta,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        },
      }
    })
    const params = {
      currentModelId: selectedId,
      availableModels,
      _meta: {
        currentProviderId: selection?.provider ?? '',
        providers: current.providers,
      },
    }
    sendNotification(conn, WIRE.modelsUpdate, params)
  }

  /** Provider mutations change one process-wide catalog, so every connected
   * session must receive the same refreshed roster and model list. */
  const broadcastModelsUpdate = (): void => {
    for (const record of sessions.values()) notifyModelsUpdate(record)
  }

  // Live refresh: a plugin registering or removing commands re-advertises to
  // every open session (observer failures never veto registry mutations).
  // The event is declared by @deepseek-ai/dsh-commands, an optional
  // composition member this bridge reads structurally; the cast keeps that
  // optionality without importing its type augmentation.
  ;(ctx as unknown as { on(event: string, listener: () => void): void }).on('commands/change', () => {
    for (const record of sessions.values()) void broadcastAvailableCommands(record)
  })

  type BundleInspection =
    | { kind: 'plain' }
    | { kind: 'bundle'; analysis: BundlePatchAnalysis }
    | { kind: 'broken'; error: string }

  const CORE_PLUGIN_NAMES = new Set(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dscode', '@deepseek-ai/dsh-grok-leader'])

  /** Inspect one freshly installed package: plain dependency, valid bundle
   *  (with its patch analysis), or a bundle whose patch would brick the boot. */
  const inspectInstalledBundle = async (
    dir: string,
    name: string,
  ): Promise<BundleInspection> => {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'))
    try {
      const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
      const patchRel = manifest.dsh?.bundle?.patch
      if (patchRel === undefined) return { kind: 'plain' }
      const patchText = await readFile(join(pkgDir, patchRel), 'utf8')
      return { kind: 'bundle', analysis: analyzeBundlePatch(patchText) }
    } catch (error) {
      return { kind: 'broken', error: errorChain(error) }
    }
  }

  const npmInstall = async (dir: string, specs: string[]): Promise<void> => {
    await execFileAsync('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      ...specs,
    ], { cwd: dir, timeout: 180_000 })
  }

  const npmUninstall = async (dir: string, names: string[]): Promise<void> => {
    await execFileAsync('npm', [
      'uninstall',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      ...names,
    ], { cwd: dir, timeout: 180_000 })
  }

  const normalizeAuditSpec = (profileDir: string, spec: string): string => {
    if (spec.startsWith('file:')) {
      const path = spec.slice('file:'.length)
      return 'file:' + (isAbsolute(path) ? path : resolve(profileDir, path))
    }
    if (spec.startsWith('./') || spec.startsWith('../')) return resolve(profileDir, spec)
    return spec
  }

  /** Install without lifecycle scripts into an isolated directory and inspect
   * every requested root package before the real profile is mutated. */
  const auditPluginSpecs = async (
    profileDir: string,
    specs: string[],
  ): Promise<Array<{ name: string; info: BundleInspection }>> => {
    const stage = await mkdtemp(join(tmpdir(), 'dscode-plugin-audit-'))
    try {
      await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n')
      await npmInstall(stage, specs.map(spec => normalizeAuditSpec(profileDir, spec)))
      const manifest = await readProfileManifest(stage)
      const names = Object.keys(manifest.dependencies)
      if (names.length === 0) throw new Error('npm installed no root package for: ' + specs.join(', '))
      return await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(stage, name) })))
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  const bundleRequiresTrust = (info: BundleInspection): boolean => info.kind === 'bundle'

  /** Human summary of a bundle's composition delta. */
  const describeAnalysis = (name: string, analysis: BundlePatchAnalysis): string => {
    const lines = [name + ' contributes a composition layer:']
    if (analysis.insertedRows.length > 0) lines.push('  + inserts ' + String(analysis.insertedRows.length) + ' row(s): ' + analysis.insertedRows.join(', '))
    if (analysis.overriddenRows.length > 0) lines.push('  ~ overrides: ' + analysis.overriddenRows.join(', '))
    if (analysis.disabledRows.length > 0) lines.push('  - disables: ' + analysis.disabledRows.join(', '))
    if (analysis.sensitiveRows.length > 0) lines.push('  ⚠ touches security rows: ' + analysis.sensitiveRows.join(', ') + ' (sandbox/approval spine — make sure you trust this)')
    if (analysis.jsExprCount > 0) lines.push('  ⚠ contains ' + String(analysis.jsExprCount) + ' !!js expression(s) — code that runs at leader boot')
    if (lines.length === 1) lines.push('  (empty layer)')
    return lines.join('\n')
  }

  const runDshCommand = async (record: SessionRecord, p: Record<string, unknown>, text: string): Promise<PromptSettleResult> => {
    const meta = p._meta as Record<string, unknown> | null | undefined
    const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
    const settle = (message: string): PromptSettleResult => {
      notifySession(record, message)
      return promptSettled(record, id, 'end_turn')
    }
    const usage = 'Usage: /dsh plugins | /dsh add [--trust] <package|git-url|file:path> | /dsh remove <name> | /dsh inspect <name>'
    let words: string[]
    try {
      words = parseCommandLine(text).slice(1)
    } catch (error) {
      return settle('Could not parse /dsh command: ' + (error instanceof Error ? error.message : String(error)))
    }
    const [verb, ...rest] = words
    const dir = dshProfileDir()
    if (dir === undefined) {
      return settle('dsh plugin management is unavailable: no installed leader profile was found (running from a source checkout?). Use: dsh plugin --profile dscode add <package>')
    }
    try {
      switch (verb) {
        case undefined:
        case 'plugins':
        case 'list': {
          const { dependencies, bundles } = await readProfileManifest(dir)
          const lines = bundles.map(name => {
            const core = name === '@deepseek-ai/dsh-base' || name === '@hqzhao95/dscode' || name === 'dscode' || name === '@deepseek-ai/dsh-grok-leader' ? ' (core)' : ''
            const version = dependencies[name] === undefined ? '' : ' ' + dependencies[name]
            return '- ' + name + version + core
          })
          return settle('Plugins in ' + dir + ':\n' + lines.join('\n') + '\n\n' + usage)
        }
        case 'add': {
          const trusted = rest.includes('--trust')
          const specs = rest.filter(part => part !== '--trust' && part.length > 0)
          if (specs.length === 0) return settle('Missing package. ' + usage)
          const option = specs.find(spec => spec.startsWith('-'))
          if (option !== undefined) return settle('Unsupported npm option "' + option + '". Package specs may not start with "-".')
          notifySession(record, 'Auditing ' + specs.join(' ') + ' in an isolated npm stage (install scripts disabled)...')
          const staged = await auditPluginSpecs(dir, specs)
          const core = staged.find(entry => CORE_PLUGIN_NAMES.has(entry.name))
          if (core !== undefined) return settle(core.name + ' is a core component; use dscode update instead of /dsh add.')
          const broken = staged.find(entry => entry.info.kind === 'broken')
          if (broken !== undefined && broken.info.kind === 'broken') {
            return settle('Refused ' + broken.name + ' before profile mutation: its bundle cannot be inspected.\n' + broken.info.error)
          }
          const stagedReport = staged.map(({ name, info }) => info.kind === 'plain'
            ? name + ': declares no dsh.bundle — it will remain a plain dependency.'
            : info.kind === 'bundle'
              ? describeAnalysis(name, info.analysis)
              : '').filter(Boolean)
          const executableBundle = staged.some(entry => bundleRequiresTrust(entry.info))
          if (executableBundle && !trusted) {
            return settle('Not installed. Review the requested composition changes:\n\n'
              + stagedReport.join('\n\n')
              + '\n\nIf you trust this code, rerun: /dsh add --trust ' + specs.map(spec => JSON.stringify(spec)).join(' '))
          }
          notifySession(record, 'Installing audited package(s) into the leader profile with npm (lifecycle scripts disabled)...')
          await npmInstall(dir, specs)
          const manifest = await readProfileManifest(dir)
          const names = staged.map(entry => entry.name)
          const actual = await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(dir, name) })))
          const invalid = actual.find(entry => entry.info.kind === 'broken' || (!trusted && bundleRequiresTrust(entry.info)))
          if (invalid !== undefined) {
            // The staged and real package differed. Disable every touched root
            // before returning so an existing bundle cannot brick the next boot.
            await writeProfileBundles(dir, manifest.raw, manifest.bundles.filter(bundle => !names.includes(bundle)))
            const reason = invalid.info.kind === 'broken'
              ? invalid.info.error
              : 'the installed package introduced an executable bundle after staging'
            return settle('Installed dependency was left disabled because post-install verification failed for ' + invalid.name + ':\n' + reason)
          }
          const bundles = new Set(manifest.bundles)
          const report: string[] = []
          for (const { name, info } of actual) {
            if (info.kind === 'plain') {
              bundles.delete(name)
              report.push(name + ': declares no dsh.bundle — installed as a plain dependency, not a profile layer.')
              continue
            }
            if (info.kind === 'broken') continue
            bundles.add(name)
            report.push(describeAnalysis(name, info.analysis))
          }
          await writeProfileBundles(dir, manifest.raw, [...bundles])
          return settle('Installed or updated ' + names.join(', ') + '.\n\n' + report.join('\n\n') + '\n\nRestart dscode to load it (the leader exits with its last client).')
        }
        case 'inspect': {
          const name = rest[0]
          if (name === undefined) return settle('Missing plugin name. ' + usage)
          const runtime = inspectPluginRuntime(ctx, name)
          if (runtime !== undefined) return settle(runtime)
          const manifest = await readProfileManifest(dir)
          if (manifest.dependencies[name] !== undefined) {
            return settle(name + ' is installed but has no live plugin instance in this leader (restart dscode to load it, or it is a plain dependency / composition-only bundle).')
          }
          return settle(name + ' is not installed. Installed: ' + Object.keys(manifest.dependencies).join(', '))
        }
        case 'remove': {
          const name = rest[0]
          if (name === undefined) return settle('Missing plugin name. ' + usage)
          if (rest.length !== 1) return settle('Usage: /dsh remove <name>')
          if (CORE_PLUGIN_NAMES.has(name)) {
            return settle(name + ' is a core component of this leader; refusing to remove it.')
          }
          const manifest = await readProfileManifest(dir)
          if (manifest.dependencies[name] === undefined) {
            return settle(name + ' is not installed. Installed: ' + Object.keys(manifest.dependencies).join(', '))
          }
          // Unregister first: a failed npm cleanup then leaves an inert package,
          // never a profile entry pointing at a missing dependency.
          await writeProfileBundles(dir, manifest.raw, manifest.bundles.filter(bundle => bundle !== name))
          try {
            await npmUninstall(dir, [name])
          } catch (error) {
            return settle('Unregistered ' + name + ', but npm could not remove the inert dependency: '
              + (error instanceof Error ? error.message : String(error)))
          }
          return settle('Removed ' + name + '.\nRestart dscode to unload it.')
        }
        default:
          return settle('Unknown /dsh subcommand "' + String(verb) + '". ' + usage)
      }
    } catch (error: unknown) {
      return settle('/dsh ' + String(verb) + ' failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const settleBridgeCommand = (
    record: SessionRecord,
    p: Record<string, unknown>,
    message: string,
  ): PromptSettleResult => {
    const meta = p._meta as Record<string, unknown> | null | undefined
    const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
    notifySession(record, message)
    return promptSettled(record, id, 'end_turn')
  }

  /** Headless ACP clients use the advertised raw command; the TUI uses its picker. */
  const runPresetCommand = async (record: SessionRecord, p: Record<string, unknown>, text: string): Promise<PromptSettleResult> => {
    const roster = agentPresets()
    if (roster === undefined) return settleBridgeCommand(record, p, 'Preset management is unavailable in this composition.')
    const requested = text.replace(/^\/preset\s*/, '').trim()
    if (requested.length === 0) {
      const presets = await roster.list()
      return settleBridgeCommand(record, p, 'Usage: /preset <id>\nAvailable: ' + presets.map(preset => preset.id).join(', '))
    }
    if (/\s/.test(requested)) return settleBridgeCommand(record, p, 'Usage: /preset <id>')
    const resolved = await resolvePresetId(requested)
    if (resolved === undefined) return settleBridgeCommand(record, p, 'Unknown preset "' + requested + '".')
    const current = roster.composedPreset?.(record.agent.ctx)
      ?? sessionPresetFromLog(record.agent.session.header, record.agent.session.events)
    if (current === resolved) {
      await persistPresetDefault(resolved)
      return settleBridgeCommand(record, p, 'Preset "' + resolved + '" is active and is now the default for new sessions.')
    }
    if (record.runningPromptId !== undefined || presetSwitchLocked(record.agent.session.events)) {
      return settleBridgeCommand(record, p, 'agent-preset-locked: a preset can only be changed before the session has produced history')
    }
    await roster.recompose(record.agent.ctx, resolved)
    try {
      appendPresetSelection(record, resolved)
    } catch (error) {
      if (current !== undefined) await roster.recompose(record.agent.ctx, current).catch(() => undefined)
      throw error
    }
    const store = ctx.get('sessions') as SessionsLike | undefined
    if (store !== undefined) await store.flush(record.agent.session)
    await persistPresetDefault(resolved)
    void broadcastAvailableCommands(record)
    return settleBridgeCommand(record, p, 'Switched to preset "' + resolved + '" and made it the default for new sessions.')
  }

  const unsupportedSlashCommands: Record<string, string> = {
    delete: '/delete is not supported yet; use /exit to close without deleting durable history.',
    remember: '/remember is not supported by the dsh memory runtime yet.',
    mcps: '/mcps management is not supported by this bridge yet.',
    skills: '/skills management is not supported by this bridge yet.',
  }
  const imageMediaTypes: Record<ImageMediaType, true> = {
    'image/png': true,
    'image/jpeg': true,
    'image/webp': true,
    'image/gif': true,
  }

  /** Validate ACP prompt blocks without committing image bytes. */
  const parsePrompt = (value: unknown): ParsedPrompt => {
    if (!Array.isArray(value)) throw invalidParams('session/prompt prompt must be an array')
    if (promptHasUnsupportedContent(value)) {
      throw invalidParams('only text, resource_link, and image prompt content is supported')
    }
    const blocks: ParsedPrompt['blocks'] = []
    const images: EncodedImageAttachment[] = []
    for (const raw of value) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw invalidParams('prompt content blocks must be objects')
      }
      const block = raw as Record<string, unknown>
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw invalidParams('text prompt content requires text')
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'resource_link') {
        blocks.push({ type: 'resource_link', name: block.name, uri: block.uri })
      } else {
        if (typeof block.data !== 'string' || typeof block.mimeType !== 'string'
          || !Object.hasOwn(imageMediaTypes, block.mimeType)) {
          throw invalidParams('image prompt content requires canonical base64 data and a supported mimeType')
        }
        const image: EncodedImageAttachment = {
          data: block.data,
          mediaType: block.mimeType as ImageMediaType,
        }
        blocks.push({ type: 'image', image })
        images.push(image)
      }
    }
    return { blocks, images, text: acpPromptToText(value) }
  }

  /** Commit one validated prompt's images, preserving ACP block order. */
  const durablePromptContent = async (parsed: ParsedPrompt): Promise<DurablePromptBlock[]> => {
    const attachments = ctx.get('attachments') as AttachmentStore | undefined
    if (attachments === undefined) throw internalError('image attachment storage is not configured')
    let refs: readonly ImageAttachmentRef[]
    try {
      refs = await admitEncodedImages(attachments, parsed.images)
    } catch (error) {
      if (isImageAdmissionError(error)) throw invalidParams(error.message)
      throw internalError('image attachment storage failed: ' + errorChain(error))
    }
    let imageIndex = 0
    return parsed.blocks.map((block): DurablePromptBlock => {
      if (block.type === 'text') return block
      if (block.type === 'resource_link') {
        return { type: 'text', text: acpPromptToText([block]) }
      }
      return { type: 'image', attachment: refs[imageIndex++]! }
    })
  }


  const prompt = async (clientId: number, params: unknown): Promise<unknown> => {
    assertOpen()
    const p = paramRecord(params, 'session/prompt')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const parsed = parsePrompt(p.prompt)
    const text = parsed.text.trim().length > 0 ? parsed.text : parsed.images.length > 0 ? '[Image]' : ''
    if (text.length === 0) throw invalidParams('empty prompt')
    // A prompt joins the session history at acceptance, mirroring the grok
    // shell's queue-time history append.
    record.prompts.push(text)
    // /dsh is a bridge command (advertised via availableCommands, delivered
    // as an ACP pass-through prompt): interpret it here, never in the model.
    if (/^\/dsh(\s|$)/.test(text.trim())) {
      if (parsed.images.length > 0) throw invalidParams('/dsh does not accept image attachments')
      return runDshCommand(record, p, text.trim())
    }
    if (/^\/preset(\s|$)/.test(text.trim())) {
      if (parsed.images.length > 0) throw invalidParams('/preset does not accept image attachments')
      return await runPresetCommand(record, p, text.trim())
    }
    const slashName = /^\/([^\s]+)/.exec(text.trim())?.[1]?.toLowerCase()
    const unsupported = slashName === undefined ? undefined : unsupportedSlashCommands[slashName]
    if (unsupported !== undefined) {
      if (parsed.images.length > 0) throw invalidParams('/' + slashName + ' does not accept image attachments')
      return settleBridgeCommand(record, p, unsupported)
    }
    // Plugin-registered slash commands own image admission. Unknown slash text
    // still reaches the model unchanged (grok pass-through semantics).
    if (text.trim().startsWith('/')) {
      const registry = dshCommands()
      if (registry !== undefined) {
        const execution = await registry.execute(
          record.agent,
          text.trim(),
          parsed.images,
          new AbortController().signal,
        )
        if (execution !== undefined) {
          const meta = p._meta as Record<string, unknown> | null | undefined
          const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
          const body = execution.result.text ?? (execution.result.kind === 'success' ? 'done' : 'command failed')
          notifySession(record, execution.result.kind === 'error' ? 'error: ' + body : body)
          return promptSettled(record, id, 'end_turn')
        }
      }
    }
    if (slashName === 'compact') {
      if (parsed.images.length > 0) throw invalidParams('/compact does not accept image attachments')
      return settleBridgeCommand(record, p, 'Manual compaction is unavailable in the selected preset.')
    }
    if (record.selection.current === undefined) {
      throw invalidParams('no model selected; use /provider to add or choose a provider first')
    }
    const previousAdmission = record.promptAdmissionTail
    let releaseAdmission = (): void => {}
    record.promptAdmissionTail = new Promise<void>((resolveAdmission) => {
      releaseAdmission = resolveAdmission
    })
    await previousAdmission
    let settlement: Promise<PromptSettleResult>
    try {
      if (closed || sessions.get(record.agent.session.id) !== record) {
        throw invalidParams('unknown session: ' + String(record.agent.session.id))
      }
      if (parsed.images.length > 0) {
        const selected = record.selection.current
        const current = await currentCatalog()
        const wireId = current.providerModelToWireId.get(modelEffortKey(selected.provider, selected.model))
        const advertised = current.availableModels.find(model => model.modelId === wireId)
        if (advertised?._meta?.acceptsImages !== true) {
          throw invalidParams('selected model does not support image input: '
            + selected.provider + '/' + selected.model)
        }
      }
      const content = parsed.images.length === 0
        ? parsed.blocks.map((block): DurablePromptBlock => {
            if (block.type === 'text') return block
            if (block.type === 'resource_link') {
              return { type: 'text', text: acpPromptToText([block]) }
            }
            throw internalError('image prompt admission state drifted')
          })
        : await durablePromptContent(parsed)
      settlement = enqueuePrompt(record, p, text, content)
    } finally {
      releaseAdmission()
    }
    return await settlement
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
    // A live session has exactly one owning connection. A foreign client never
    // displaces a live owner and reads exactly like an unknown id.
    if (existing !== undefined && existing.clientId !== clientId && connections.get(existing.clientId) !== undefined) {
      throw invalidParams('unknown session: ' + String(sessionId))
    }
    const meta = p._meta as Record<string, unknown> | null | undefined
    validateSessionMeta(meta, 'session/load')
    const noReplay = meta?.noReplay === true
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    let inspection: { meta: { agentPreset?: string }; events: readonly SessionEvent[] } = existing === undefined
      ? await store.load(sessionId)
      : { meta: existing.agent.session.header, events: existing.agent.session.events }
    const explicit = presetRequestFromMeta(meta)
    const explicitPreset = explicit === undefined ? undefined : await resolvePresetId(explicit)
    if (explicit !== undefined && explicitPreset === undefined && !GROK_PROFILE_FALLBACKS.has(explicit)) {
      throw invalidParams('unknown agent preset "' + explicit + '"')
    }
    const persistedPreset = sessionPresetFromLog(inspection.meta, inspection.events)
    const roster = agentPresets()
    const livePreset = existing === undefined
      ? undefined
      : roster?.composedPreset?.(existing.agent.ctx)
        ?? sessionPresetFromLog(existing.agent.session.header, existing.agent.session.events)
    const currentPreset = livePreset ?? persistedPreset
    const switchingPreset = explicitPreset !== undefined && explicitPreset !== currentPreset
    if (switchingPreset) {
      const events = existing?.agent.session.events ?? inspection.events
      if (presetSwitchLocked(events)) {
        throw invalidParams('agent-preset-locked: a preset can only be changed before the session has produced history')
      }
      if (existing !== undefined) {
        if (roster === undefined) throw internalError('agent preset roster is not configured')
        await roster.recompose(existing.agent.ctx, explicitPreset)
        try {
          appendPresetSelection(existing, explicitPreset)
        } catch (error) {
          if (currentPreset !== undefined) await roster.recompose(existing.agent.ctx, currentPreset).catch(() => undefined)
          throw error
        }
      }
    }
    if (explicitPreset !== undefined && meta?.rememberAgentPreset === true) {
      await persistPresetDefault(explicitPreset)
    }
    const presetRequest = explicitPreset ?? currentPreset
    const preset = await composePreset(presetRequest)

    if (existing !== undefined) {
      // Dispose only after a requested switch has committed its composition and
      // durable selection event. A failed validation leaves the live agent intact.
      existing.agent.cancel({ kind: 'user' })
      settlePrompt(existing, 'cancelled')
      discardPromptQueue(existing)
      rejectPendingFor(existing.clientId, sessionId)
      clearMcpInitTimer(existing)
      await existing.agent.whenIdle()
      const liveStore = ctx.get('sessions') as SessionsLike | undefined
      if (liveStore !== undefined) await liveStore.flush(existing.agent.session)
      inspection = {
        meta: existing.agent.session.header,
        events: existing.agent.session.events,
      }
      await existing.dispose()
      sessions.delete(sessionId)
    }
    const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const sessionSelection = sessionModelSelectionFromLog(inspection.events)
    const rememberedSelection = modelSelectionFromRequest(config, sessionSelection ?? defaultSelection, meta)
    const selection: ModelSelectionRef = {
      current: await selectionForRequest(sessionSelection ?? defaultSelection, meta),
      assembled: undefined,
    }
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(config, selection.current),
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
      modelEfforts: sessionModelEffortsFromLog(inspection.events, rememberedSelection ?? selection.current),
      yolo: meta?.yoloMode === true,
      // -1 admits a first replayed event at seq 0 through the seq <= lastSeq gate.
      lastSeq: -1,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      compactionCount: 0,
      pendingToolCalls: new Map(),
      textStreamed: false,
      prompts: [],
      promptAdmissionTail: Promise.resolve(),
      promptQueue: [],
      runningPromptId: undefined,
      runningText: undefined,
      runningCombinedTexts: undefined,
      cancelTrigger: undefined,
      editHolds: new Set(),
      mcpInitTimer: undefined,
      inflight: undefined,
      promotionScheduled: false,
      steered: [],
    }
    if (switchingPreset && existing === undefined && explicitPreset !== undefined) {
      try {
        appendPresetSelection(record, explicitPreset)
      } catch (error) {
        await handle.dispose()
        throw error
      }
    }
    try {
      applyPermissionMode(
        record,
        typeof meta?.permissionMode === 'string' ? meta.permissionMode : undefined,
        typeof meta?.yoloMode === 'boolean' ? meta.yoloMode : undefined,
      )
    } catch (error) {
      await handle.dispose()
      throw error
    }
    sessions.set(sessionId, record)
    void broadcastAvailableCommands(record)
    // Rebuild the up-arrow history from the persisted user prompts so
    // x.ai/prompt_history serves them after resume.
    for (const event of inspection.events) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: unknown } }).source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      const text = textBlocks(event.data.content).map(block => block.text).join('')
      if (text.trim().length > 0) record.prompts.push(text)
    }
    // Rebuild projection state from the persisted transcript. Interactive
    // clients receive replay updates before the response; headless clients set
    // noReplay so prior assistant text cannot contaminate the current result.
    const conn = connections.get(clientId)
    for (const event of inspection.events) {
      // Keep turnStartMs current so replayed updates carry streamStartMs
      // and the pager renders ThinkingBlock durations on resume.
      if (event.type === 'turn/start') record.turnStartMs = event.time
      const items = mapEvent(record, event, true)
      if (!noReplay && conn !== undefined) {
        if (!admitEvent(record, event.seq)) continue
        for (const item of items) {
          emitUpdate(conn, record, item, true, event.time)
        }
      } else {
        record.lastSeq = Math.max(record.lastSeq, event.seq)
      }
    }
    return {}
  }

  const listSessions = async (): Promise<unknown> => {
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    const headers = await store.list()
    // Legacy `session/list` minimal payload. Upstream SessionInfo carries
    // title/_meta (row.rs); the TUI's preferred `x.ai/session/list` handler
    // below does backfill title, firstPrompt, summary, cwd filter, and limit —
    // this method only serves clients that still call the bare ACP name, so it
    // stays minimal rather than duplicating the richer path.
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
    const explicitEffort = typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? reasoningEffort
      : undefined
    // grok modelId is a global catalog id; dsh needs a provider+model pair, so
    // the provider resolves from the catalog's modelId -> provider mapping,
    // then the agent's own route, then config.provider (implemented below).
    const current = await currentCatalog()
    // Never persist an unresolvable selection: a modelId the client has not
    // been offered cannot name a provider route.
    if (!current.providerByModel.has(modelId)) {
      throw invalidParams('modelId is not in the catalog: ' + modelId)
    }
    const advertisedModel = current.availableModels.find(model => model.modelId === modelId)
    if (explicitEffort !== undefined) {
      const efforts = advertisedModel?._meta?.reasoningEfforts
      if (advertisedModel?._meta?.supportsReasoningEffort === false
        || (efforts !== undefined && !efforts.includes(explicitEffort))) {
        throw invalidParams('reasoningEffort "' + explicitEffort + '" is not supported by model ' + modelId)
      }
    }
    const parsed = parseWireModelId(modelId)
    const provider = parsed !== undefined && current.providerByModel.get(modelId) === parsed.provider
      ? parsed.provider
      : current.providerByModel.get(modelId) ?? record.agent.options.provider ?? config.provider ?? ''
    const rawModel = parsed !== undefined && provider === parsed.provider ? parsed.model : modelId
    // Reasoning vocabularies belong to exact provider/model routes. Remembering
    // by raw id alone leaks an effort to another provider exposing the same id.
    const effortKey = modelEffortKey(provider, rawModel)
    if (explicitEffort !== undefined) record.modelEfforts.set(effortKey, explicitEffort)
    const rememberedEffort = record.modelEfforts.get(effortKey)
    const effectiveEffort = explicitEffort
      ?? acceptedReasoningEffort(advertisedModel, rememberedEffort)
    if (explicitEffort === undefined && rememberedEffort !== undefined && effectiveEffort === undefined) {
      record.modelEfforts.delete(effortKey)
    }
    const selection = {
      provider,
      model: rawModel,
      ...effectiveEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveEffort) },
    }
    // Commit the session-specific choice before advertising success. This log
    // is distinct from agent-default-model: resume restores the session's own
    // route, while a brand-new session inherits the latest global default.
    record.agent.session.append(MODEL_SELECTION_EVENT, {
      provider,
      model: rawModel,
      ...effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort },
    })
    record.selection.current = selection
    const defaultModel = agentDefaultModel()
    if (defaultModel !== undefined) await defaultModel.saveSelection(selection)
    const sessionStore = ctx.get('sessions') as SessionsLike | undefined
    if (sessionStore !== undefined) await sessionStore.flush(record.agent.session)
    // The catalog may have fallen back to a different provider's model (or the
    // persisted default may have moved providers); refresh so the next
    // models/list (and initialize _meta) reports the provider that now owns
    // the current model. Without this a re-spawned TUI shows the pre-switch
    // provider scope.
    if (catalog !== undefined) {
      await refreshCatalog()
      notifyModelsUpdate(record)
    }
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
  async function discoverProviderModels(
    id: string,
    p: Record<string, unknown>,
  ): Promise<DiscoveredProviderModel[]> {
    const llmService = llm()
    // Method call, not a detached const: the llm service method reads
    // this.discoveries (a detached reference would lose the receiver).
    if (llmService === undefined || llmService.discoverModels === undefined) {
      throw internalError('cannot add provider "' + id + '": the installed catalog does not describe it and no model discovery is configured')
    }
    const apiKeyEnv = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv : undefined
    const baseURL = nonEmpty(p.baseURL) ? p.baseURL : undefined
    const knownEndpoint = baseURL !== undefined && knownRouteBaseUrls(settings()).includes(baseURL)
    // Exfil guard: the resolved env value may only be handed to an endpoint
    // whose baseURL is already a persisted provider route (re-provide under a
    // known endpoint). Anything else — including a brand-new baseURL — gets
    // the env NAME so the gateway can resolve it locally without shipping the
    // secret to a client-chosen host.
    const apiKey = apiKeyEnv === undefined
      ? undefined
      : knownEndpoint
        ? await resolveCredentialValue(apiKeyEnv)
        : apiKeyEnv
    let models
    try {
      models = await llmService.discoverModels(PROVIDER_SETTINGS_NS, {
        provider: id,
        ...nonEmpty(p.api) ? { api: p.api } : {},
        ...baseURL === undefined ? {} : { baseURL },
        ...apiKey === undefined || apiKey === '' ? {} : { apiKey },
      })
    } catch (error: unknown) {
      throw internalError('cannot add provider "' + id + '": model discovery failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (models.length === 0) {
      throw internalError('cannot add provider "' + id + '": its endpoint listed no models')
    }
    let capabilities = new Map<string, false | PiAiReasoningEfforts>()
    const api = nonEmpty(p.api) ? p.api : undefined
    if (knownEndpoint
      && baseURL !== undefined
      && (api === 'openai-completions' || api === 'openai-responses')
      && llmService.resolveModelInfo !== undefined) {
      try {
        capabilities = await discoverEndpointModelCapabilities(baseURL, apiKey)
      } catch (error) {
        logger.warn('grok-leader: model capability discovery failed for ' + id + '; keeping catalog metadata: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return models.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...capabilities.has(model.id) ? { reasoningEfforts: capabilities.get(model.id)! } : {},
    }))
  }

  const dynamicRouteSignature = (profile: Record<string, unknown>): string =>
    JSON.stringify([profile.api ?? null, profile.baseURL ?? null, profile.apiKeyEnv ?? null])

  /** Persist a background discovery only if the route is still the one probed. */
  const persistDiscoveredProviderModels = async (
    providerService: SettingsLike,
    id: string,
    signature: string,
    discovered: DiscoveredProviderModel[],
  ): Promise<void> => {
    const latest = providerUserProfile(providerUserSection(providerService), id)
    if (dynamicRouteSignature(latest) !== signature || !Array.isArray(latest.models)) return
    const existingById = new Map<string, Record<string, unknown>>(
      (latest.models as Array<Record<string, unknown>>).map(model => [String(model.id ?? ''), model]),
    )
    const nextModels = discovered.map(model => ({
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
      ...existingById.get(model.id),
      id: model.id,
    }))
    const modelShape = (model: Record<string, unknown>): string =>
      JSON.stringify([
        String(model.id ?? ''),
        model.name ?? null,
        model.contextWindow ?? null,
        model.maxTokens ?? null,
        model.reasoningEfforts ?? null,
      ])
    const currentShapes = (latest.models as Array<Record<string, unknown>>).map(modelShape)
    const nextShapes = nextModels.map(modelShape)
    if (currentShapes.join('\u0000') === nextShapes.join('\u0000')) return
    await providerService.mutate(PROVIDER_SETTINGS_NS, [{
      op: 'set',
      path: ['providers', id],
      value: { ...latest, models: nextModels },
    }])
  }

  /** Stale-while-revalidate: endpoint latency must never hold the first frame. */
  const scheduleDynamicCatalogRefresh = (): void => {
    const llmService = llm()
    const providerService = settings()
    if (closed || llmService?.discoverModels === undefined || providerService === undefined) return
    const userSection = providerUserSection(providerService)
    for (const provider of llmService.listProviders()) {
      const profile = providerUserProfile(userSection, provider.id)
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : undefined
      const api = typeof profile.api === 'string' ? profile.api : undefined
      if (baseURL === undefined || (api !== 'openai-completions' && api !== 'openai-responses')) continue
      const signature = dynamicRouteSignature(profile)
      if (discoveredModels.has(provider.id) || discoveredRoutes.get(provider.id) === signature) continue
      discoveredRoutes.set(provider.id, signature)
      void (async () => {
        try {
          const discovered = await discoverProviderModels(provider.id, profile)
          if (closed || discoveredRoutes.get(provider.id) !== signature) return
          discoveredModels.set(provider.id, discovered)
          await persistDiscoveredProviderModels(providerService, provider.id, signature, discovered)
          if (closed || discoveredRoutes.get(provider.id) !== signature) return
          const refreshed = await refreshCatalog()
          reconcileSessionReasoningEfforts(refreshed)
          broadcastModelsUpdate()
        } catch (error) {
          logger.warn('grok-leader: background model discovery failed for ' + provider.id + '; using configured models: ' + (error instanceof Error ? error.message : String(error)))
        }
      })()
    }
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
    if (providerExists(providerService, id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" already exists')
    }
    // Paste-a-key path: a literal apiKey lands in the credentials service
    // ($DSH_HOME/.credentials.yaml via dsh-credentials-local), NEVER in the
    // settings document. The route references it by name (apiKeyEnv, derived
    // from the id when blank). The credentials service preserves its own
    // documented precedence: inherited launch env first, managed file next,
    // then project/user .env layers.
    const pastedKey = p.apiKey
    if (p.credentialSource === 'environment'
      && typeof pastedKey === 'string'
      && pastedKey.length > 0) {
      throw invalidParams('apiKey must be empty when credentialSource is environment')
    }
    if (typeof pastedKey === 'string' && pastedKey.length > 0) {
      const credentials = ctx.get('credentials') as CredentialsLike | undefined
      if (credentials === undefined) throw internalError('cannot store the API key: no credentials service is configured')
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv as string : id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
      await credentials.set(ref, pastedKey)
      p.apiKeyEnv = ref
    }
    await mutateProviderRoute(providerService, id, editableProfile(p), p, 'add')
    if (p.credentialSource === 'environment') {
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv : undefined
      await cleanupUnsharedCredential(providerService, ref, id)
    }
    const current = await refreshCatalog()
    scheduleDynamicCatalogRefresh()
    broadcastModelsUpdate()
    return { providers: current.providers, currentProviderId: current.currentProviderId }
  }

  /** Reject malformed form fields before any settings write. */
  const validateProviderForm = (p: Record<string, unknown>): void => {
    for (const field of ['displayName', 'apiKeyEnv', 'baseURL', 'apiKey'] as const) {
      const value = p[field]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw invalidParams(field + ' must be a string')
      }
    }
    const credentialSource = p.credentialSource
    if (credentialSource !== undefined
      && credentialSource !== 'saved'
      && credentialSource !== 'environment') {
      throw invalidParams('credentialSource must be saved or environment')
    }
    const api = p.api
    if (api !== undefined && api !== null && (typeof api !== 'string'
      || (api.length > 0 && !PROVIDER_APIS.includes(api as (typeof PROVIDER_APIS)[number])))) {
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

  /** Remove an unshared file-backed credential after its provider route has
   * already changed. Cleanup is best-effort: a route mutation must never look
   * failed because a read-only environment layer shadows the stored ref. */
  const cleanupUnsharedCredential = async (
    providerService: SettingsLike,
    ref: string | undefined,
    excludedProviderId: string,
  ): Promise<void> => {
    if (ref === undefined) return
    const providers = providerUserSection(providerService)?.providers
    if (providers !== null && typeof providers === 'object') {
      const shared = Object.entries(providers as Record<string, unknown>).some(([id, profile]) =>
        id !== excludedProviderId
        && profile !== null
        && typeof profile === 'object'
        && (profile as Record<string, unknown>).apiKeyEnv === ref)
      if (shared) return
    }
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials?.describe === undefined || credentials.unset === undefined) return
    try {
      const info = await credentials.describe(ref)
      if (info.source === 'file' && info.writable) await credentials.unset(ref)
    } catch (error) {
      logger.warn('grok-leader: could not clean unused credential reference ' + ref + ': ' + (error instanceof Error ? error.message : String(error)))
    }
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
        discoveredModels.set(id, models)
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
    if (!providerExists(providerService, providerId)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + providerId + '" does not exist')
    }
    const currentProfile = providerUserProfile(providerUserSection(providerService), providerId)
    const previousCredentialRef = nonEmpty(currentProfile.apiKeyEnv) ? currentProfile.apiKeyEnv : undefined
    // Same paste-a-key path as add: key → credentials store, name → route.
    const pastedKey = p.apiKey
    if (p.credentialSource === 'environment'
      && typeof pastedKey === 'string'
      && pastedKey.length > 0) {
      throw invalidParams('apiKey must be empty when credentialSource is environment')
    }
    if (typeof pastedKey === 'string' && pastedKey.length > 0) {
      const credentials = ctx.get('credentials') as CredentialsLike | undefined
      if (credentials === undefined) throw internalError('cannot store the API key: no credentials service is configured')
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv as string : providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
      await credentials.set(ref, pastedKey)
      p.apiKeyEnv = ref
    }
    const next = mergeEditable(currentProfile, p)
    const nextCredentialRef = nonEmpty(next.apiKeyEnv) ? next.apiKeyEnv : undefined
    await mutateProviderRoute(providerService, providerId, next, p, 'update')
    if (previousCredentialRef !== nextCredentialRef) {
      await cleanupUnsharedCredential(providerService, previousCredentialRef, providerId)
    }
    if (p.credentialSource === 'environment') {
      await cleanupUnsharedCredential(providerService, nextCredentialRef, providerId)
    }
    discoveredModels.delete(providerId)
    discoveredRoutes.delete(providerId)
    const current = await refreshCatalog()
    scheduleDynamicCatalogRefresh()
    broadcastModelsUpdate()
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
    if (!providerExists(providerService, id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" does not exist')
    }
    const profile = providerUserProfile(providerUserSection(providerService), id)
    const credentialRef = nonEmpty(profile.apiKeyEnv) ? profile.apiKeyEnv : undefined
    const current = await refreshCatalog()
    const liveUse = [...sessions.values()].find(record => record.selection.current?.provider === id)
    if (current.currentProviderId === id || liveUse !== undefined) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" is in use; switch to another provider first')
    }
    if (!hasUserProviderRoute(providerService, id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" has no removable user route')
    }
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }])
    } catch (error: unknown) {
      throw internalError('failed to remove provider "' + id + '": ' + (error instanceof Error ? error.message : String(error)))
    }
    await cleanupUnsharedCredential(providerService, credentialRef, id)
    discoveredModels.delete(id)
    discoveredRoutes.delete(id)
    const refreshed = await refreshCatalog()
    broadcastModelsUpdate()
    return { providers: refreshed.providers, currentProviderId: refreshed.currentProviderId }
  }

  const modelsList = async (): Promise<unknown> => {
    const current = await refreshCatalog()
    scheduleDynamicCatalogRefresh()
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
    const defaultPersona = roster === undefined ? undefined : (await roster.resolve(undefined)).id
    return {
      hasCache: presets.length > 0,
      personas: presets.map(preset => preset.id),
      ...defaultPersona === undefined ? {} : { defaultPersona },
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

  const forkSession = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/session/fork')
    validateSessionMeta(p, 'x.ai/session/fork')
    const sourceId = typeof p.sourceSessionId === 'string' ? SessionId(p.sourceSessionId) : undefined
    if (sourceId === undefined) throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
    const liveSource = sessions.get(sourceId)
    if (liveSource !== undefined && ownedRecord(clientId, sourceId) !== liveSource) {
      throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
    }
    let sourceHeader: { agentPreset?: string; cwd?: string }
    let events: readonly SessionEvent[]
    if (liveSource !== undefined) {
      sourceHeader = liveSource.agent.session.header
      events = liveSource.agent.session.events
    } else {
      const store = persistence()
      if (store === undefined) throw internalError('session persistence is not configured')
      try {
        const inspection = await store.load(sourceId)
        sourceHeader = inspection.meta
        events = inspection.events
      } catch {
        throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
      }
    }
    const newCwd = typeof p.newCwd === 'string' && isAbsolute(p.newCwd) ? p.newCwd : sourceHeader.cwd
    if (typeof newCwd !== 'string' || !isAbsolute(newCwd)) throw invalidParams('newCwd must be an absolute path')
    const suppliedId = typeof p.newSessionId === 'string' && p.newSessionId.length > 0 ? p.newSessionId : undefined
    const sessionId = suppliedId === undefined ? SessionId(randomUUID()) : SessionId(suppliedId)
    if (sessions.has(sessionId)
      || (suppliedId !== undefined && await persistedSessionIdInUse(sessionId))) {
      throw invalidParams('session id is already in use: ' + String(sessionId))
    }
    const last = events.at(-1)
    // dsh's fork refuses to end inside an open turn; mirror that fail-closed.
    if (last?.type === 'turn/start') throw invalidParams('cannot fork while a turn is open')
    const seed = [...events]
    const preset = await composePreset(sessionPresetFromLog(sourceHeader, events))
    const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
    const defaultSelection = defaultModel?.currentSelection?.()
    const sessionSelection = sessionModelSelectionFromLog(events)
    const rememberedSelection = modelSelectionFromRequest(config, sessionSelection ?? defaultSelection, p)
    const selection: ModelSelectionRef = {
      current: await selectionForRequest(sessionSelection ?? defaultSelection, p),
      assembled: undefined,
    }
    const handle = await agents.create({
      sessionId,
      seed,
      meta: {
        cwd: newCwd,
        parentSession: sourceId,
        seedLength: seed.length,
        ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset },
      },
      agentOptions: agentOptions(config, selection.current),
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selection)
        return preset.mount === undefined ? undefined : preset.mount(agentCtx)
      },
    })
    if (closed) {
      await handle.dispose()
      throw internalError('the grok leader was disposed during session/fork')
    }
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      clientId,
      selection,
      modelEfforts: sessionModelEffortsFromLog(events, rememberedSelection ?? selection.current),
      yolo: p.yoloMode === true,
      lastSeq: -1,
      turnStartMs: undefined,
      eventSeq: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      compactionCount: 0,
      pendingToolCalls: new Map(),
      textStreamed: false,
      prompts: [],
      promptAdmissionTail: Promise.resolve(),
      promptQueue: [],
      runningPromptId: undefined,
      runningText: undefined,
      runningCombinedTexts: undefined,
      cancelTrigger: undefined,
      editHolds: new Set(),
      mcpInitTimer: undefined,
      inflight: undefined,
      promotionScheduled: false,
      steered: [],
    }
    try {
      applyPermissionMode(
        record,
        typeof p.permissionMode === 'string' ? p.permissionMode : undefined,
        typeof p.yoloMode === 'boolean' ? p.yoloMode : undefined,
      )
    } catch (error) {
      await handle.dispose()
      throw error
    }
    sessions.set(sessionId, record)
    void broadcastAvailableCommands(record)
    const conn = connections.get(clientId)
    if (conn !== undefined) {
      record.mcpInitTimer = setTimeout(() => {
        record.mcpInitTimer = undefined
        if (ownedRecord(clientId, sessionId) === record && connections.get(clientId) === conn) {
          sendNotification(conn, '_x.ai/mcp_initialized', { sessionId })
        }
      }, 50)
    }
    return { newSessionId: String(sessionId) }
  }

  const listMcpServers = (record: SessionRecord | undefined): { servers: Array<Record<string, unknown>> } => {
    const tools = record?.agent.ctx.get('tools') as
      | { schemas(scope?: unknown): Array<{ name: string }> }
      | undefined
    const schemas = tools === undefined ? [] : tools.schemas(record?.agent)
    const counts = new Map<string, number>()
    for (const schema of schemas) {
      if (!schema.name.startsWith('mcp__')) continue
      const rest = schema.name.slice('mcp__'.length)
      const idx = rest.lastIndexOf('__')
      if (idx <= 0 || idx + 2 >= rest.length) continue
      const server = rest.slice(0, idx)
      counts.set(server, (counts.get(server) ?? 0) + 1)
    }
    return {
      servers: [...counts.entries()].map(([name, toolCount]) => ({
        name,
        displayName: name,
        source: 'local',
        sourceLabel: 'plugin: dsh',
        session: {
          enabled: true,
          status: 'connected',
          tools: [],
          authRequired: false,
          setupRequired: false,
        },
        _meta: { toolCount },
      })),
    }
  }

  const listSkills = async (record: SessionRecord | undefined): Promise<{ skills: Array<Record<string, unknown>> }> => {
    const skillsService = record?.agent.ctx.get('skills') as
      | {
          list(): Promise<Array<{
            name: string
            description: string
            whenToUse?: string
            invocation?: { userInvocable?: boolean; modelInvocable?: boolean }
            source?: string
            provider?: string
            path?: string
          }>>
        }
      | undefined
    const rows = skillsService === undefined ? [] : await skillsService.list()
    return {
      skills: rows.map(skill => ({
        name: skill.name,
        display_name: skill.name,
        description: skill.description,
        has_user_specified_description: false,
        when_to_use: skill.whenToUse,
        short_description: skill.description,
        path: skill.path ?? '',
        scope: 'plugin',
        user_invocable: skill.invocation?.userInvocable ?? true,
        enabled: true,
      })),
    }
  }

  const setSessionMode = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/set_mode')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const modeId = typeof p.modeId === 'string' ? p.modeId : ''
    // dsh's plan-mode service is mounted per agent preset; only plan/default
    // map cleanly. Anything not "plan" is treated as leaving plan mode.
    const active = modeId === 'plan'
    const planMode = presetServiceFor(record, 'planMode') as
      | { set(agent: unknown, active: boolean): unknown }
      | undefined
    if (planMode === undefined) throw internalError('plan mode is not available in this agent preset')
    planMode.set(record.agent, active)
    return {}
  }

  const btw = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/btw')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const question = typeof p.question === 'string' ? p.question : ''
    if (question.trim().length === 0) throw invalidParams('empty btw question')
    if (!capabilitiesFor(record).includes('subagents')) {
      throw internalError('/btw is not available in the selected agent preset')
    }
    const subagents = presetServiceFor(record, 'subagents') as
      | {
          start(
            provider: string,
            request: {
              parent: unknown
              prompt: Array<{ type: 'text'; text: string }>
              signal: AbortSignal
              label?: string
            },
          ): Promise<{
            result: Promise<{ output: Array<{ type?: string; text?: string }>; stopReason: { kind?: string } | string }>
            dispose(): Promise<void>
          }>
          list?(): string[]
        }
      | undefined
    if (subagents === undefined) {
      throw internalError('subagents are not available in this agent preset')
    }
    const providers = typeof subagents.list === 'function' ? subagents.list() : []
    const provider = providers.includes('spawn') ? 'spawn' : providers.includes('fork') ? 'fork' : providers[0]
    if (provider === undefined) {
      throw internalError('no subagent provider is registered')
    }
    const controller = new AbortController()
    const run = await subagents.start(provider, {
      parent: record.agent,
      prompt: [{ type: 'text', text: question }],
      signal: controller.signal,
      label: 'btw',
    })
    try {
      const result = await run.result
      const answer = (result.output ?? []).map(block => block.text ?? '').join('').trim()
      return { result: { answer: answer.length > 0 ? answer : '(no answer)' } }
    } finally {
      controller.abort()
      await run.dispose().catch(() => undefined)
    }
  }

  const renameSession = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/session/rename')
    const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
    const record = ownedRecord(clientId, sessionId)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    const titleService = ctx.get('sessionTitle') as
      | { rename(session: unknown, title: string): unknown; refresh?(session: unknown): Promise<unknown> }
      | undefined
    if (titleService === undefined) throw internalError('session title service is not configured')
    const resetToAuto = p.reset_to_auto === true || p.resetToAuto === true
    if (resetToAuto) {
      if (titleService.refresh === undefined) throw internalError('session title refresh is not available')
      await titleService.refresh(record.agent.session)
      return {}
    }
    const title = typeof p.title === 'string' ? p.title : ''
    if (title.trim().length === 0) throw invalidParams('title must be a non-empty string')
    titleService.rename(record.agent.session, title)
    return {}
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
      case WIRE.sessionSetMode:
        return await setSessionMode(clientId, params)
      case 'x.ai/session/fork':
        return await forkSession(clientId, params)
      case 'x.ai/session/rename':
        return await renameSession(clientId, params)
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
      case 'x.ai/btw':
        return await btw(clientId, params)
      case 'x.ai/interject': {
        // Mid-turn interjection (grok ext method): merge the text into the
        // running turn at the harness's next step boundary WITHOUT cancelling
        // it — the no-loss sibling of send-now. On an idle session the parked
        // steering wakes a turn of its own (dsh steer semantics). The
        // originator already painted a local block; the
        // x.ai/session/interjection broadcast is deduped there by
        // interjectionId and renders the text on every other attached pane.
        const p = paramRecord(params, 'x.ai/interject')
        const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
        const record = ownedRecord(clientId, sessionId)
        if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
        const text = typeof p.text === 'string' ? p.text : ''
        if (text.trim().length === 0) throw invalidParams('empty interjection')
        record.prompts.push(text)
        record.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        const conn = connections.get(record.clientId)
        if (conn !== undefined) {
          sendNotification(conn, 'x.ai/session/interjection', {
            sessionId: String(record.agent.session.id),
            text,
            ...typeof p.interjectionId === 'string' ? { interjectionId: p.interjectionId } : {},
          })
        }
        return {}
      }
      case 'x.ai/commands/list': {
        const p = paramRecord(params, 'x.ai/commands/list')
        const rawSessionId = typeof p.sessionId === 'string'
          ? p.sessionId
          : typeof p.session_id === 'string'
            ? p.session_id
            : undefined
        const sessionId = rawSessionId === undefined ? undefined : SessionId(rawSessionId)
        const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
        if (sessionId !== undefined && record === undefined) throw invalidParams('unknown session: ' + rawSessionId)
        return { commands: await commandCatalog(record) }
      }
      case 'x.ai/prompt_history':
        return promptHistory(clientId, params)
      case 'x.ai/marketplace/list':
        return { sources: [] }
      case 'x.ai/skills/list': {
        const p = paramRecord(params, 'x.ai/skills/list')
        const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
        const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
        return await listSkills(record)
      }
      case 'x.ai/mcp/list': {
        const p = paramRecord(params, 'x.ai/mcp/list')
        const sessionId = typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined
        const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
        return listMcpServers(record)
      }
      case 'x.ai/workflows/list':
        // TODO(deepseek): enumerate dsh workflow runs from the workflow engine.
        return { workflows: [] }
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
        const used = record === undefined
          ? 0
          : record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens
        return {
          result: {
            sessionId: record?.agent.session.id ?? '',
            cwd: record?.agent.session.header.cwd ?? '',
            turns: record?.turnCount ?? 0,
            turnIndex: record === undefined ? 0 : Math.max(0, record.turnCount - 1),
            model: null,
            context: {
              used, total, systemPromptTokens: 0, toolDefinitionsCount: 0,
              toolDefinitionsTokens: 0, compactionCount: record?.compactionCount ?? 0, turnCount: record?.turnCount ?? 0,
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
        const store = persistence()
        if (store === undefined) throw internalError('session persistence is not configured')
        const headers = await store.list()
        // Backfill display titles BEFORE the query filter so picker search can
        // match prompt text. Misses stay uncached (retried on the next list)
        // and the in-flight set stops concurrent list calls stacking loads.
        await Promise.all(headers.map(async header => {
          if (!sessionListIndex.beginInspection(header.id)) return
          try {
            const inspection = await store.load(SessionId(header.id))
            sessionListIndex.recordInspection(header.id, header.createdAt, inspection.events)
          } catch {
            // A broken artifact must not sink the list; the miss is retried.
          } finally {
            sessionListIndex.finishInspection(header.id)
          }
        }))
        let rows = headers.map(header => {
          const projection = sessionListIndex.projection(header.id, header.createdAt)
          const title = projection.title
          return {
            sessionId: header.id,
            cwd: header.cwd ?? '',
            createdAt: new Date(header.createdAt).toISOString(),
            updatedAt: new Date(projection.updatedAt).toISOString(),
            firstPrompt: projection.firstPrompt,
            title,
            summary: title,
            // Chat-kind rows skip the TUI's local-store gate (grok's own session
            // docs, which dsh sessions never enter) and load straight via session/load.
            _meta: { 'x.ai/session': { kind: 'chat' } },
          }
        })
        if (cwd !== undefined) {
          rows = rows.filter(row => row.cwd === cwd
            || (query !== undefined && row.sessionId.toLowerCase() === query))
        }
        if (query !== undefined && query.length > 0) {
          rows = rows.filter(row => (row.sessionId + ' ' + row.cwd + ' ' + row.title + ' ' + row.firstPrompt).toLowerCase().includes(query))
        }
        rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        rows = rows.slice(0, limit)
        return { sessions: rows }
      }
      case 'x.ai/sessions/list': {
        const store = persistence()
        if (store === undefined) throw internalError('session persistence is not configured')
        const headers = await store.list()
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

  const SUPPORTED_PERMISSION_MODES = new Set(['default', 'workspace-write', 'plan', 'bypassPermissions', 'always-approve'])

  const applyPermissionMode = (record: SessionRecord, mode: string | undefined, yolo: boolean | undefined): void => {
    if (mode === undefined && yolo === undefined) return
    const effectiveMode = mode === undefined || SUPPORTED_PERMISSION_MODES.has(mode) ? mode : 'default'
    if (mode !== undefined && effectiveMode !== mode) {
      logger.warn('grok-leader: unsupported permission mode notification "' + mode + '" failed closed to default')
    }
    // An explicit permission mode wins over the legacy yolo bit. In
    // particular, bypassPermissions must remain full access even though the
    // pager emits yoloMode:false alongside every permissionMode value.
    const fullAccess = effectiveMode === undefined
      ? yolo === true
      : effectiveMode === 'bypassPermissions' || effectiveMode === 'always-approve'
    record.yolo = fullAccess
    const permission = ctx.get('permissionPresets') as
      | { set(session: unknown, preset: string): unknown }
      | undefined
    const preset = fullAccess
      ? 'danger-full-access'
      : effectiveMode !== undefined || yolo === false
        ? 'workspace-write'
        : undefined
    if (preset !== undefined && permission !== undefined) permission.set(record.agent.session, preset)
    const planMode = record.agent.ctx.get('planMode') as
      | { set(agent: unknown, active: boolean): unknown }
      | undefined
    if (effectiveMode === 'plan' && planMode === undefined) {
      throw invalidParams('permissionMode "plan" is not available in the selected agent preset')
    }
    if (planMode !== undefined) planMode.set(record.agent, effectiveMode === 'plan')
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
      case 'x.ai/yolo_mode_changed': {
        const unwrappedYolo = params as Record<string, unknown> | undefined
        const pYolo = unwrappedYolo !== undefined && typeof unwrappedYolo.params === 'object' && unwrappedYolo.params !== null
          ? unwrappedYolo.params as Record<string, unknown>
          : unwrappedYolo
        const sessionId = typeof pYolo?.sessionId === 'string' ? SessionId(pYolo.sessionId) : undefined
        const record = sessionId === undefined ? undefined : ownedRecord(clientId, sessionId)
        if (record !== undefined) {
          try {
            applyPermissionMode(
              record,
              typeof pYolo?.permission_mode === 'string' ? pYolo.permission_mode : undefined,
              typeof pYolo?.yolo_mode === 'boolean' ? pYolo.yolo_mode : undefined,
            )
          } catch (error) {
            logger.warn('grok-leader: permission mode notification failed: ' + errorChain(error))
          }
        }
        return
      }
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
          promoteWhenIdle(record)
          queueMutate(record)
          return
        }
        const [entry] = record.promptQueue.splice(located.index, 1)
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          entry.text = p.newText
          entry.content = [
            { type: 'text', text: p.newText },
            ...entry.content.filter((block): block is Extract<DurablePromptBlock, { type: 'image' }> => block.type === 'image'),
          ]
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
          promoteWhenIdle(record)
        }
        queueMutate(record)
        return
      }
      case 'x.ai/queue/steer': {
        if (unwrapped === undefined) return
        const p = unwrapped
        const record = queueRecord(p)
        if (record === undefined) return
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(record, p.id)
        if (located === undefined || located.entry.version !== expectedVersion) {
          if (typeof p.id === 'string') record.editHolds.delete(p.id)
          promoteWhenIdle(record)
          queueMutate(record)
          return
        }
        // Steer is only meaningful into a live turn; otherwise keep the row
        // queued and let it run normally (grok InterjectQueuedPrompt no-op).
        if (record.inflight === undefined) {
          promoteWhenIdle(record)
          queueMutate(record)
          return
        }
        const [entry] = record.promptQueue.splice(located.index, 1)
        record.editHolds.delete(entry.id)
        const text = entry.combinedTexts === undefined ? entry.text : entry.combinedTexts.join('\n\n')
        const content = entry.combinedTexts === undefined
          ? entry.content
          : [{ type: 'text' as const, text }]
        try {
          record.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
        } catch (error) {
          // Put the row back so a failed steer never loses the queued message.
          record.promptQueue.splice(located.index, 0, entry)
          queueMutate(record)
          entry.reject(internalError('prompt was not steered: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
        record.steered.push({ id: entry.id, resolve: entry.resolve })
        const conn = connections.get(record.clientId)
        if (conn !== undefined) {
          emitUpdate(conn, record, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text },
          }, false, Date.now())
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
          promoteWhenIdle(record)
          queueMutate(record)
          return
        }
        if (located !== undefined) {
          const [entry] = record.promptQueue.splice(located.index, 1)
          entry.resolve(promptSettled(record, entry.id, 'cancelled'))
          record.editHolds.delete(entry.id)
          queueMutate(record)
          // Removing a held front must not strand the rows behind it.
          promoteWhenIdle(record)
          return
        }
        if (record.runningPromptId === p.id) {
          record.agent.cancel({ kind: 'user' })
          settlePrompt(record, 'cancelled')
          record.editHolds.delete(String(p.id))
        }
        promoteWhenIdle(record)
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
          promoteWhenIdle(record)
          queueMutate(record)
          return
        }
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          located.entry.text = p.newText
          located.entry.content = [
            { type: 'text', text: p.newText },
            ...located.entry.content.filter((block): block is Extract<DurablePromptBlock, { type: 'image' }> => block.type === 'image'),
          ]
          located.entry.combinedTexts = undefined
          located.entry.version = located.entry.version + 1
        }
        promoteWhenIdle(record)

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
        promoteWhenIdle(record)
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
        if (changed) promoteWhenIdle(record)
        queueMutate(record)
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
    // Wire tracing behind DSCODE_DEBUG=1.
    const debugWire = process.env.DSCODE_DEBUG === '1'
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
        // Envelope error code 3; see docs/grok-leader-protocol.md.
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
        // Envelope error code 1; see docs/grok-leader-protocol.md.
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
          // Mirror the client's advertised version: the eviction rule compares
          // this string against the client's own version, and equal versions
          // never evict (see LEADER_BINARY_VERSION above).
          const advertised = msg.capabilities?.clientVersion
          const mirror = typeof advertised === 'string' && advertised.length > 0
            ? advertised
            : LEADER_BINARY_VERSION
          send({
            type: 'registered',
            clientId: conn.clientId,
            ready: true,
            leaderProtocolVersion: LEADER_PROTOCOL_VERSION,
            leaderBinaryVersion: mirror,
            // controlV1 is false because every control command answers a
            // ControlResult error below (GetLeaderInfo/CpuProfileStatus are
            // unimplemented — protocol.rs ControlCommand); the TUI then never
            // sends them. Captured-stub semantics, verified against should_evict.
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

  // Bridge dsh background jobs into the TUI's /tasks notifications.
  const jobs = ctx.get('jobs') as
    | {
        list(owner?: unknown): Array<Record<string, unknown>>
        onJobsChanged?(listener: (owner: unknown) => void): unknown
      }
    | undefined
  if (jobs !== undefined && typeof jobs.onJobsChanged === 'function') {
    const emitJobsForRecord = (record: SessionRecord): void => {
      const conn = connections.get(record.clientId)
      if (conn === undefined) return
      const cwd = record.agent.session.header.cwd ?? ''
      const systemTime = (ms: number | undefined): unknown => {
        const value = ms ?? Date.now()
        const secs = Math.floor(value / 1000)
        const nanos = (value % 1000) * 1_000_000
        return { secs_since_epoch: secs, nanos_since_epoch: nanos }
      }
      for (const job of jobs.list(record.agent)) {
        const id = String(job.id ?? '')
        const label = String(job.label ?? '')
        const status = String(job.status ?? 'running')
        if (status === 'running' || status === 'stopping') {
          sendNotification(conn, 'x.ai/task_backgrounded', {
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'task_backgrounded',
              tool_call_id: id,
              task_id: id,
              command: label,
              cwd,
              output_file: '',
              description: label,
            },
          })
        } else {
          sendNotification(conn, 'x.ai/task_completed', {
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'task_completed',
              task_snapshot: {
                task_id: id,
                command: label,
                display_command: label,
                cwd,
                start_time: systemTime(typeof job.startedAt === 'number' ? job.startedAt : undefined),
                end_time: typeof job.finishedAt === 'number' ? systemTime(job.finishedAt) : null,
                output: '',
                output_file: '',
                truncated: false,
                exit_code: status === 'completed' ? 0 : 1,
                signal: null,
                completed: true,
                kind: 'bash',
                output_total_bytes: 0,
              },
            },
          })
        }
      }
    }
    const emitForOwner = (owner: unknown): void => {
      for (const record of sessions.values()) {
        if (owner === undefined || record.agent === owner) emitJobsForRecord(record)
      }
    }
    jobs.onJobsChanged(emitForOwner)
    for (const record of sessions.values()) emitJobsForRecord(record)
  }

  // Bridge dsh subagent lifecycle events into the TUI's subagent notifications.
  type SubagentRunInfoLike = { runId: unknown; provider: string; id: unknown; local: boolean }
  type SubagentRunEndInfoLike = SubagentRunInfoLike & {
    stopReason?: { kind?: string }
    lastAssistantMessage?: unknown
  }
  // Durable child_session_id -> parent session id, recorded at spawn. The
  // `subagent/end` edge arrives AFTER the child Agent has been disposed
  // (settled), so `agents.get(childId)` is already undefined by then and the
  // parent cannot be resolved from the live registry; this map is the only
  // reliable parent lookup for the finish notification. Without it the TUI's
  // `SubagentFinished` never arrives, `SubagentInfo.finished` stays false, and
  // a completed (ready) subagent is presented as still running forever.
  const spawnedChildParents = new Map<string, string>()
  const subagentStartHandler = (info: SubagentRunInfoLike): void => {
    const childId = String(info.id)
    const agents = ctx.get('agents') as
      | { get(id: unknown): { session: { header: { parentSession?: unknown } } } | undefined }
      | undefined
    const child = agents?.get(info.id)
    const parentId = child?.session.header.parentSession
    const record = typeof parentId === 'string' ? sessions.get(SessionId(parentId)) : undefined
    if (record === undefined) return
    // Remember the parent for the finish edge (see map comment above).
    if (typeof parentId === 'string') spawnedChildParents.set(childId, parentId)
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    sendNotification(conn, 'x.ai/session_notification', {
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: childId,
        parent_session_id: String(record.agent.session.id),
        child_session_id: childId,
        subagent_type: info.provider || 'general-purpose',
        description: info.provider || 'subagent',
      },
    })
  }
  const subagentEndHandler = (info: SubagentRunEndInfoLike): void => {
    const childId = String(info.id)
    const agents = ctx.get('agents') as
      | { get(id: unknown): { session: { header: { parentSession?: unknown } } } | undefined }
      | undefined
    const child = agents?.get(info.id)
    // Prefer the spawn-time mapping: the child Agent is already disposed when
    // `subagent/end` fires, so the live-registry lookup below fails exactly
    // when this notification matters most. Fall back to the live Agent only
    // for children this bridge did not spawn (e.g. parent attached later).
    const parentId = spawnedChildParents.get(childId) ?? child?.session.header.parentSession
    spawnedChildParents.delete(childId)
    const record = typeof parentId === 'string' ? sessions.get(SessionId(parentId)) : undefined
    if (record === undefined) return
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    const kind = info.stopReason?.kind
    const status = kind === 'completed' || kind === 'max-tokens' ? 'completed'
      : kind === 'interrupted' || kind === 'aborted' || kind === 'cancelled' ? 'cancelled'
        : 'failed'
    sendNotification(conn, 'x.ai/session_notification', {
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: childId,
        child_session_id: childId,
        status,
        error: status === 'failed' ? 'subagent failed' : undefined,
        tool_calls: 0,
        turns: 0,
        duration_ms: 0,
        tokens_used: 0,
        output: undefined,
      },
    })
  }
  ;(ctx as unknown as { on(event: string, listener: (info: SubagentRunInfoLike) => void): void }).on('subagent/start', subagentStartHandler)
  ;(ctx as unknown as { on(event: string, listener: (info: SubagentRunEndInfoLike) => void): void }).on('subagent/end', subagentEndHandler)

  // Bridge dsh goal changes into the TUI's GoalUpdated notifications.
  type GoalChangedLike = {
    operation: string
    ref?: { id?: unknown; revision?: unknown }
    goal?: {
      id?: unknown
      revision?: unknown
      objective?: unknown
      phase?: unknown
      blockedReason?: { code?: unknown; message?: unknown }
      maxGoalRounds?: unknown
      roundsStarted?: unknown
      createdAt?: unknown
      updatedAt?: unknown
    }
  }
  const goalChangedHandler = (payload: { agent: unknown; change: GoalChangedLike }): void => {
    const agent = payload.agent as { session?: { id?: unknown } } | undefined
    const sessionId = agent?.session?.id
    const record = typeof sessionId === 'string' ? sessions.get(SessionId(sessionId)) : undefined
    if (record === undefined) return
    const conn = connections.get(record.clientId)
    if (conn === undefined) return
    const goal = payload.change.goal
    if (goal === undefined) {
      // Clear tombstone.
      sendNotification(conn, 'x.ai/session_notification', {
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: 'goal_updated',
          goal_id: String(payload.change.ref?.id ?? ''),
          objective: '',
          status: 'cleared',
          phase: 'idle',
          elapsed_ms: 0,
          total_deliverables: 0,
          completed_deliverables: 0,
          total_worker_rounds: 0,
          total_verify_rounds: 0,
        },
      })
      return
    }
    const phase = String(goal.phase ?? 'active')
    const status = phase === 'complete' ? 'complete' : phase === 'blocked' ? 'blocked' : phase === 'paused' ? 'user_paused' : 'active'
    sendNotification(conn, 'x.ai/session_notification', {
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'goal_updated',
        goal_id: String(goal.id ?? ''),
        objective: String(goal.objective ?? ''),
        status,
        phase: 'idle',
        elapsed_ms: 0,
        total_deliverables: 0,
        completed_deliverables: 0,
        total_worker_rounds: typeof goal.roundsStarted === 'number' ? goal.roundsStarted : 0,
        total_verify_rounds: 0,
      },
    })
  }
  ;(ctx as unknown as { on(event: string, listener: (payload: { agent: unknown; change: GoalChangedLike }) => void): void }).on('goal/changed', goalChangedHandler)

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

/** Materialize the resolved route into AgentOptions so dsh subagents inherit it. */
function agentOptions(
  config: GrokLeaderConfig,
  selection?: { provider: string; model: string },
): Pick<AgentOptions, 'provider' | 'model'> {
  const provider = selection?.provider ?? config.provider
  const model = selection?.model ?? config.model
  return {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}
