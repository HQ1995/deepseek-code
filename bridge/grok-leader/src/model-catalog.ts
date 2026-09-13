/** Provider/model catalog ownership. No socket, agent registry or Cordis dependency. */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { RpcError } from './protocol.ts'
import { JSONRPC_INVALID_PARAMS, invalidParams, internalError, paramRecord } from './acp.ts'

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
  request: typeof fetch = globalThis.fetch,
): Promise<Map<string, false | PiAiReasoningEfforts>> {
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const response = await request(url, {
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
export function parseWireModelId(wireId: string): { provider: string; model: string } | undefined {
  const index = wireId.indexOf(MODEL_ID_SEPARATOR)
  if (index <= 0 || index === wireId.length - 1) return undefined
  return { provider: wireId.slice(0, index), model: wireId.slice(index + 1) }
}

/** Stable in-memory key for a provider/model effort. */
export function modelEffortKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

/** Flattened wire catalog plus the provider ownership the bare model ids hide. */
export interface ModelCatalog {
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

/** Structural read of the llm service: provider and model catalogs only. */
export interface LlmLike {
  listProviders(): Array<{ id: string; name?: string }>
  listConfigurableProviders?(): Array<{ provider: string; displayName: string; settingsNs: string; error?: string }>
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
export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** Structural credential seam; references are resolved only for already
 * persisted endpoints, never for a brand-new caller-supplied URL. */
export interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string; source?: string } | undefined>
  describe?(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
}

/** Structural write path of the official settings seam (ctx.settings.mutate). */
export interface SettingsLike {
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

/** Structural read of the default-model service. */
export interface AgentDefaultModelLike {
  currentSelection?(): { provider: string; model: string; reasoningEffort?: string } | undefined
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}


const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Resolve a session selection from request overrides, deployment config, or
 * the supplied saved/session default. All-empty means provider onboarding. */
export function modelSelectionFromRequest(
  config: { provider?: string; model?: string },
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

/** Keep a saved/session effort only when the exact advertised model accepts it. */
export const acceptedReasoningEffort = (
  model: ModelCatalog['availableModels'][number] | undefined,
  effort: unknown,
): string | undefined => {
  if (!nonEmptyString(effort) || model === undefined) return undefined
  if (model._meta?.supportsReasoningEffort === false) return undefined
  const supported = model._meta?.reasoningEfforts
  return supported === undefined || supported.includes(effort) ? effort : undefined
}


/** Lazy capabilities reflect DSH's optional asynchronous module registration. */
export interface ModelCatalogDependencies {
  config: { provider?: string; model?: string }
  llm(): LlmLike | undefined
  settings(): SettingsLike | undefined
  getCredentials(): CredentialsLike | undefined
  getDefaultModel(): AgentDefaultModelLike | undefined
  isProviderInUse(provider: string): boolean
  onChanged(catalog: ModelCatalog, reason: 'discovery' | 'mutation'): void
  logger: { warn(message: string): void }
  fetch?: typeof fetch
  environment?: Readonly<NodeJS.ProcessEnv>
}

/** Own cached catalogs, accepted native reads/discoveries and provider writes.
 * Disposal closes admission/publication immediately and drains real work,
 * including the existing credential/route write and cleanup sequence. Native
 * persistence keeps its transaction/error policy; no abort pretends to undo an
 * accepted write. Live session selection remains caller-owned. */
export function createModelCatalog(dependencies: ModelCatalogDependencies) {
  const { config, llm, settings, getCredentials, getDefaultModel, isProviderInUse, onChanged, logger } = dependencies
  let closed = false
  let disposal: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  let catalog: ModelCatalog | undefined
  const discoveredModels = new Map<string, DiscoveredProviderModel[]>()
  const discoveredRoutes = new Map<string, string>()
  const assertOpen = (): void => {
    if (closed) throw internalError('the grok leader has been disposed')
  }
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    // Publication precedes lazy capability getters and native callbacks, which
    // may synchronously reenter disposal. Nested work belongs to its admission.
    try { resolve(operation()) } catch (error) { reject(error) }
    return result
  }
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(internalError('the grok leader has been disposed'))
    return track(async () => { const result = await operation(); assertOpen(); return result })
  }

  /** providerUserSection / providerUserProfile / hasUserProviderRoute /
   * knownRouteBaseUrls live at module scope (pure: no apply() state). */
  const providerExists = (providerService: SettingsLike | undefined, id: string): boolean =>
    hasUserProviderRoute(providerService, id)
    || llm()?.listProviders().some(provider => provider.id === id) === true

  /** Resolve a credential per operation, matching dsh's credential seam. */
  const resolveCredentialValue = async (ref: string | undefined): Promise<string | undefined> => {
    if (ref === undefined) return undefined
    const credentials = getCredentials()
    try {
      const value = await credentials?.resolve?.(ref)
      if (typeof value?.value === 'string' && value.value.length > 0) return value.value
    } catch (error) {
      logger.warn('grok-leader: could not resolve credential reference ' + ref + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    const value = (dependencies.environment ?? process.env)[ref]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** Describe one credential reference without exposing its value. */
  const describeCredential = async (ref: string | undefined): Promise<CredentialInfo | undefined> => {
    if (ref === undefined) return undefined
    const credentials = getCredentials()
    try {
      return await credentials?.describe?.(ref)
    } catch (error) {
      logger.warn('grok-leader: could not describe credential reference ' + ref + ': ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /** Rebuild the flattened wire catalog plus the provider ownership the bare ids hide. */
  const refreshCatalog = async (): Promise<ModelCatalog> => {
    assertOpen()
    const llmService = llm()
    const userSection = providerUserSection(settings())
    const activeProviders = llmService?.listProviders() ?? []
    const configured = new Map((llmService?.listConfigurableProviders?.() ?? []).map(row => [row.provider, row]))
    const providerRows = new Map(activeProviders.map(row => [row.id, row]))
    for (const row of configured.values()) {
      if (row.error !== undefined && !providerRows.has(row.provider)) {
        providerRows.set(row.provider, { id: row.provider, name: row.displayName })
      }
    }
    const rows = llmService === undefined
      ? []
      : await Promise.all(activeProviders.map(provider => track(async () => {
        assertOpen()
        const staticModels = await llmService.listModels(provider.id)
        const discovered = discoveredModels.get(provider.id)
        const models: Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }> = discovered === undefined
          ? staticModels
          : discovered.map(model => ({
            id: model.id,
            name: model.name ?? model.id,
          }))
        return { provider: provider.id, models }
      })))
    assertOpen()
    const modelCount = new Map(rows.map(row => [row.provider, row.models.length]))
    const providers = await Promise.all([...providerRows.values()].map(p => track(async () => {
      assertOpen()
      const profile = providerUserProfile(userSection, p.id)
      const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
      const credential = await describeCredential(apiKeyEnv)
      // Display-only status for an empty provider; generic on purpose (the
      // TUI relays notes verbatim, and the bridge carries no plugin-specific
      // knowledge of WHICH login or key a given provider wants).
      const note = configured.get(p.id)?.error ?? ((modelCount.get(p.id) ?? 0) > 0 ? undefined
        : 'no models yet — the provider may need a login or API key (its plugin may register a /login command)')
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
    })))
    assertOpen()
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
          assertOpen()
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
    const defaultModel = getDefaultModel()
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
    assertOpen()
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
    // A qualified wire id can infer its provider even without a saved route;
    // do not lose an explicit effort merely because candidate is undefined.
    const requestedEffort = typeof meta?.reasoningEffort === 'string' ? meta.reasoningEffort : candidate?.reasoningEffort
    const reasoningEffort = acceptedReasoningEffort(advertisedModel, requestedEffort)
      ?? acceptedReasoningEffort(advertisedModel, advertisedModel?._meta?.reasoningEffort)
    return {
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    }
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
        capabilities = await discoverEndpointModelCapabilities(baseURL, apiKey, dependencies.fetch)
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
    if (closed) return
    await providerService.mutate(PROVIDER_SETTINGS_NS, [{
      op: 'set',
      path: ['providers', id],
      value: { ...latest, models: nextModels },
    }])
  }

  /** Stale-while-revalidate: endpoint latency must never hold the first frame. */
  const scheduleDynamicCatalogRefresh = (): void => {
    if (closed) return
    const llmService = llm()
    const providerService = settings()
    if (closed || llmService?.discoverModels === undefined || providerService === undefined) return
    const userSection = providerUserSection(providerService)
    for (const provider of llmService.listProviders()) {
      if (closed) break
      const profile = providerUserProfile(userSection, provider.id)
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : undefined
      const api = typeof profile.api === 'string' ? profile.api : undefined
      if (baseURL === undefined || (api !== 'openai-completions' && api !== 'openai-responses')) continue
      const signature = dynamicRouteSignature(profile)
      if (discoveredModels.has(provider.id) || discoveredRoutes.get(provider.id) === signature) continue
      discoveredRoutes.set(provider.id, signature)
      void track(async () => {
        const discovered = await discoverProviderModels(provider.id, profile)
        if (closed || discoveredRoutes.get(provider.id) !== signature) return
        discoveredModels.set(provider.id, discovered)
        await persistDiscoveredProviderModels(providerService, provider.id, signature, discovered)
        if (closed || discoveredRoutes.get(provider.id) !== signature) return
        const refreshed = await refreshCatalog()
        if (closed) return
        onChanged(refreshed, 'discovery')
      }).catch(error => {
        logger.warn('grok-leader: background model discovery failed for ' + provider.id + '; using configured models: ' + (error instanceof Error ? error.message : String(error)))
      })
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
    while (!closed && settings() === undefined && Date.now() < deadline) {
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
      const credentials = getCredentials()
      if (credentials === undefined) throw internalError('cannot store the API key: no credentials service is configured')
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv as string : id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
      assertOpen()
      await credentials.set(ref, pastedKey)
      p.apiKeyEnv = ref
    } else assertOpen()
    await mutateProviderRoute(providerService, id, editableProfile(p), p, 'add')
    if (p.credentialSource === 'environment') {
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv : undefined
      await cleanupUnsharedCredential(providerService, ref, id)
    }
    const current = await refreshCatalog()
    assertOpen()
    scheduleDynamicCatalogRefresh()
    assertOpen()
    onChanged(current, 'mutation')
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
    const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim() : p.baseURL
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
    if (typeof baseURL === 'string') p.baseURL = baseURL
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
    const credentials = getCredentials()
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
        if (!closed) discoveredModels.set(id, models)
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
      const credentials = getCredentials()
      if (credentials === undefined) throw internalError('cannot store the API key: no credentials service is configured')
      const ref = nonEmpty(p.apiKeyEnv) ? p.apiKeyEnv as string : providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
      assertOpen()
      await credentials.set(ref, pastedKey)
      p.apiKeyEnv = ref
    } else assertOpen()
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
    assertOpen()
    scheduleDynamicCatalogRefresh()
    assertOpen()
    onChanged(current, 'mutation')
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
    const liveUse = isProviderInUse(id)
    if (current.currentProviderId === id || liveUse) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" is in use; switch to another provider first')
    }
    if (!hasUserProviderRoute(providerService, id)) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" has no removable user route')
    }
    assertOpen()
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }])
    } catch (error: unknown) {
      throw internalError('failed to remove provider "' + id + '": ' + (error instanceof Error ? error.message : String(error)))
    }
    await cleanupUnsharedCredential(providerService, credentialRef, id)
    discoveredModels.delete(id)
    discoveredRoutes.delete(id)
    const refreshed = await refreshCatalog()
    assertOpen()
    onChanged(refreshed, 'mutation')
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


  return {
    peek: () => catalog,
    current: () => admit(currentCatalog),
    refresh: () => admit(refreshCatalog),
    select: (...args: Parameters<typeof selectionForRequest>) => admit(() => selectionForRequest(...args)),
    list: () => admit(modelsList),
    add: (params: unknown) => admit(() => addProvider(params)),
    update: (params: unknown) => admit(() => updateProvider(params)),
    remove: (params: unknown) => admit(() => removeProvider(params)),
    initialize: () => admit(async () => {
      await settingsReady()
      assertOpen()
      const current = await refreshCatalog()
      scheduleDynamicCatalogRefresh()
      return current
    }),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => { while (pending.size > 0) await Promise.allSettled([...pending]) })
      discoveredModels.clear(); discoveredRoutes.clear(); catalog = undefined
      return disposal
    },
  }
}
