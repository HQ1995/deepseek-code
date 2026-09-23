/** Provider/model catalog ownership: cached snapshots, accepted native reads
 * and discoveries, and provider route writes. No socket, agent registry or
 * Cordis dependency. Pure rules live in wire-catalog (catalog shape and
 * selection) and provider-profile (llm-pi-ai routes); model-endpoint owns the
 * one outbound capability probe. */
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { RpcError } from './protocol.ts'
import { JSONRPC_INVALID_PARAMS, internalError, paramRecord } from './acp.ts'
import { discoverEndpointModelCapabilities, type EndpointCapabilities } from './model-endpoint.ts'
import type { AgentDefaultModelLike, CredentialInfo, CredentialsLike, LlmLike, ModelInfo, SettingsLike } from './native-seams.ts'
import {
  NO_MODELS_MARKER, PROVIDER_SETTINGS_NS, discoveredModelUpdate, editableProfile, hasUserProviderRoute, isDiscoverableApi,
  knownRouteBaseUrls, mergeEditable, nonEmpty, normalizeProviderForm, pastedApiKey, pastedKeyRef, providerUserProfile,
  providerUserSection, requireProviderId, routeSignature, sharesCredentialRef, type DiscoveredProviderModel,
} from './provider-profile.ts'
import {
  assembleCatalog, modelEffortKey, providerNote, resolveSelection, type CatalogProvider, type ModelCatalog, type ProviderModels,
} from './wire-catalog.ts'

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

type Profile = Record<string, unknown>
type ProviderRoster = { providers: CatalogProvider[]; currentProviderId: string }

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

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

  const providerExists = (providerService: SettingsLike | undefined, id: string): boolean =>
    hasUserProviderRoute(providerService, id)
    || llm()?.listProviders().some(provider => provider.id === id) === true

  const requireSettings = (): SettingsLike => {
    const providerService = settings()
    if (providerService === undefined) throw internalError('the settings service is not configured')
    return providerService
  }

  /** Resolve a credential per operation, matching dsh's credential seam. */
  const resolveCredentialValue = async (ref: string | undefined): Promise<string | undefined> => {
    if (ref === undefined) return undefined
    const credentials = getCredentials()
    try {
      const value = await credentials?.resolve?.(ref)
      if (nonEmpty(value?.value)) return value.value
    } catch (error) {
      logger.warn('grok-leader: could not resolve credential reference ' + ref + ': ' + message(error))
    }
    const value = (dependencies.environment ?? process.env)[ref]
    return nonEmpty(value) ? value : undefined
  }

  /** Describe one credential reference without exposing its value. */
  const describeCredential = async (ref: string | undefined): Promise<CredentialInfo | undefined> => {
    if (ref === undefined) return undefined
    const credentials = getCredentials()
    try {
      return await credentials?.describe?.(ref)
    } catch (error) {
      logger.warn('grok-leader: could not describe credential reference ' + ref + ': ' + message(error))
      return undefined
    }
  }

  /** One provider's models (a background discovery overrides the static
   * listing) and their exact metadata, read sequentially inside the drain. */
  const readProviderModels = (llmService: LlmLike, provider: string): Promise<ProviderModels> => track(async () => {
    assertOpen()
    const staticModels = await llmService.listModels(provider)
    const discovered = discoveredModels.get(provider)
    const models = discovered === undefined ? staticModels : discovered.map(model => ({ id: model.id, name: model.name ?? model.id }))
    const metadata = new Map<string, ModelInfo>()
    if (llmService.resolveModelInfo !== undefined) {
      for (const model of models) {
        assertOpen()
        if (metadata.has(model.id)) continue
        try { metadata.set(model.id, await llmService.resolveModelInfo(provider, model.id)) }
        catch (error) {
          logger.warn('grok-leader: could not resolve model metadata for ' + provider + '/' + model.id + ': ' + message(error))
        }
      }
    }
    return { provider, models, metadata }
  })

  /** One roster row: the llm service's identity plus the editable profile
   * fields and non-secret credential facts. */
  const describeProvider = (
    row: { id: string; name?: string },
    userSection: Profile | undefined,
    note: string | undefined,
  ): Promise<CatalogProvider> => track(async () => {
    assertOpen()
    const profile = providerUserProfile(userSection, row.id)
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    const credential = await describeCredential(apiKeyEnv)
    return {
      id: row.id,
      ...row.name === undefined ? {} : { name: row.name },
      ...typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {},
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
      ...typeof profile.api === 'string' ? { api: profile.api } : {},
      ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
      ...credential === undefined ? {} : { credential },
      ...note === undefined ? {} : { note },
    }
  })

  /** Rebuild the flattened wire catalog plus the provider ownership the bare
   * ids hide. Every provider branch stays in the accepted-work drain, even
   * when a sibling rejects early. */
  const refreshCatalog = async (): Promise<ModelCatalog> => {
    assertOpen()
    const llmService = llm()
    const userSection = providerUserSection(settings())
    const activeProviders = llmService?.listProviders() ?? []
    const configured = new Map((llmService?.listConfigurableProviders?.() ?? []).map(row => [row.provider, row]))
    // A configurable provider whose configuration failed stays visible with its diagnostic.
    const rosterRows = new Map<string, { id: string; name?: string }>(activeProviders.map(row => [row.id, row]))
    for (const row of configured.values()) {
      if (row.error !== undefined && !rosterRows.has(row.provider)) rosterRows.set(row.provider, { id: row.provider, name: row.displayName })
    }
    const rows = llmService === undefined ? [] : await Promise.all(activeProviders.map(provider => readProviderModels(llmService, provider.id)))
    assertOpen()
    const modelCount = new Map(rows.map(row => [row.provider, row.models.length]))
    const providers = await Promise.all([...rosterRows.values()].map(row =>
      describeProvider(row, userSection, providerNote(configured.get(row.id)?.error, modelCount.get(row.id) ?? 0))))
    assertOpen()
    const assembled = assembleCatalog({
      rows, providers, config,
      hasMetadataResolver: llmService?.resolveModelInfo !== undefined,
      defaultSelection: getDefaultModel()?.currentSelection?.(),
    })
    if (assembled.missingRequested !== undefined) {
      logger.warn('grok-leader: model "' + assembled.missingRequested + '" is not in the catalog; falling back to "' + assembled.catalog.currentModelId + '"')
    }
    assertOpen()
    catalog = assembled.catalog
    return catalog
  }

  /** The most recently refreshed catalog, rebuilt on first use. */
  const currentCatalog = (): Promise<ModelCatalog> => catalog === undefined ? refreshCatalog() : Promise.resolve(catalog)

  /** Resolve one session's requested/saved selection against the live catalog. */
  const selectionForRequest = async (
    defaultSelection: { provider: string; model: string; reasoningEffort?: string } | undefined,
    meta: Record<string, unknown> | null | undefined,
  ): Promise<ModelSelectionRef['current']> => resolveSelection(await currentCatalog(), config, defaultSelection, meta)

  /** The credential a discovery request may carry. Exfil guard: a resolved env
   * value only travels to a baseURL that is already a persisted provider route;
   * any other endpoint, including a brand-new one, receives the env NAME so the
   * gateway can resolve it locally without shipping the secret to a
   * client-chosen host. */
  const discoveryApiKey = async (apiKeyEnv: string | undefined, knownEndpoint: boolean): Promise<string | undefined> =>
    apiKeyEnv === undefined ? undefined : knownEndpoint ? await resolveCredentialValue(apiKeyEnv) : apiKeyEnv

  /** Endpoint effort extensions for an OpenAI-compatible route already known
   * to this bridge; a failed probe keeps the native catalog metadata. */
  const probeEndpointCapabilities = async (
    id: string, llmService: LlmLike, draft: Profile, knownEndpoint: boolean, apiKey: string | undefined,
  ): Promise<EndpointCapabilities> => {
    if (!knownEndpoint || !nonEmpty(draft.baseURL) || !isDiscoverableApi(draft.api) || llmService.resolveModelInfo === undefined) return new Map()
    try {
      return await discoverEndpointModelCapabilities(draft.baseURL, apiKey, dependencies.fetch)
    } catch (error) {
      logger.warn('grok-leader: model capability discovery failed for ' + id + '; keeping catalog metadata: ' + message(error))
      return new Map()
    }
  }

  /**
   * Interrogate the gateway for one draft provider's catalog, for the case the
   * official seam refused: a route the installed pi-ai catalog does not
   * describe must name its models. The key comes from the environment the
   * form named (v1 auth is env-key only); a miss probes unauthenticated.
   */
  const discoverProviderModels = async (id: string, draft: Profile): Promise<DiscoveredProviderModel[]> => {
    const llmService = llm()
    // Method call, not a detached const: the llm service method reads
    // this.discoveries (a detached reference would lose the receiver).
    if (llmService === undefined || llmService.discoverModels === undefined) {
      throw internalError('cannot add provider "' + id + '": the installed catalog does not describe it and no model discovery is configured')
    }
    const baseURL = nonEmpty(draft.baseURL) ? draft.baseURL : undefined
    const knownEndpoint = baseURL !== undefined && knownRouteBaseUrls(settings()).includes(baseURL)
    const apiKey = await discoveryApiKey(nonEmpty(draft.apiKeyEnv) ? draft.apiKeyEnv : undefined, knownEndpoint)
    let models
    try {
      models = await llmService.discoverModels(PROVIDER_SETTINGS_NS, {
        provider: id,
        ...nonEmpty(draft.api) ? { api: draft.api } : {},
        ...baseURL === undefined ? {} : { baseURL },
        ...nonEmpty(apiKey) ? { apiKey } : {},
      })
    } catch (error: unknown) {
      throw internalError('cannot add provider "' + id + '": model discovery failed: ' + message(error))
    }
    if (models.length === 0) throw internalError('cannot add provider "' + id + '": its endpoint listed no models')
    const capabilities = await probeEndpointCapabilities(id, llmService, draft, knownEndpoint, apiKey)
    return models.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...capabilities.has(model.id) ? { reasoningEfforts: capabilities.get(model.id)! } : {},
    }))
  }

  /** Persist a background discovery only if the route is still the one probed. */
  const persistDiscoveredProviderModels = async (
    providerService: SettingsLike, id: string, signature: string, discovered: DiscoveredProviderModel[],
  ): Promise<void> => {
    const latest = providerUserProfile(providerUserSection(providerService), id)
    const models = discoveredModelUpdate(latest, signature, discovered)
    if (models === undefined || closed) return
    await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'set', path: ['providers', id], value: { ...latest, models } }])
  }

  /** Discover, persist and publish one dynamic route unless it changed meanwhile. */
  const refreshDynamicRoute = async (providerService: SettingsLike, id: string, profile: Profile, signature: string): Promise<void> => {
    const stale = (): boolean => closed || discoveredRoutes.get(id) !== signature
    const discovered = await discoverProviderModels(id, profile)
    if (stale()) return
    discoveredModels.set(id, discovered)
    await persistDiscoveredProviderModels(providerService, id, signature, discovered)
    if (stale()) return
    const refreshed = await refreshCatalog()
    if (closed) return
    onChanged(refreshed, 'discovery')
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
      if (typeof profile.baseURL !== 'string' || !isDiscoverableApi(profile.api)) continue
      const signature = routeSignature(profile)
      if (discoveredModels.has(provider.id) || discoveredRoutes.get(provider.id) === signature) continue
      discoveredRoutes.set(provider.id, signature)
      void track(() => refreshDynamicRoute(providerService, provider.id, profile, signature)).catch(error => {
        logger.warn('grok-leader: background model discovery failed for ' + provider.id + '; using configured models: ' + message(error))
      })
    }
  }

  /**
   * Wait for the native settings import before taking the first catalog
   * snapshot. Service publication precedes legacy route/default migration.
   */
  const settingsReady = async (): Promise<void> => {
    const deadline = Date.now() + 5000
    while (!closed && settings() === undefined && Date.now() < deadline) {
      await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 10) })
    }
    await settings()?.ready
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
  }

  /** Paste-a-key path: a literal apiKey lands in the credentials service
   * ($DSH_HOME/.credentials.yaml via dsh-credentials-local), NEVER in the
   * settings document; the route references it by name. The credentials
   * service keeps its documented precedence: inherited launch env first,
   * managed file next, then project/user .env layers. Returns the form with
   * the stored reference as apiKeyEnv. */
  const storePastedKey = async (form: Profile, id: string): Promise<Profile> => {
    const pasted = pastedApiKey(form)
    if (pasted === undefined) {
      assertOpen()
      return form
    }
    const credentials = getCredentials()
    if (credentials === undefined) throw internalError('cannot store the API key: no credentials service is configured')
    const ref = pastedKeyRef(form, id)
    assertOpen()
    await credentials.set(ref, pasted)
    return { ...form, apiKeyEnv: ref }
  }

  /** Remove an unshared file-backed credential after its provider route has
   * already changed. Cleanup is best-effort: a route mutation must never look
   * failed because a read-only environment layer shadows the stored ref. */
  const cleanupUnsharedCredential = async (providerService: SettingsLike, ref: string | undefined, excludedProviderId: string): Promise<void> => {
    if (ref === undefined || sharesCredentialRef(providerUserSection(providerService), ref, excludedProviderId)) return
    const credentials = getCredentials()
    if (credentials?.describe === undefined || credentials.unset === undefined) return
    try {
      const info = await credentials.describe(ref)
      if (info.source === 'file' && info.writable) await credentials.unset(ref)
    } catch (error) {
      logger.warn('grok-leader: could not clean unused credential reference ' + ref + ': ' + message(error))
    }
  }

  /**
   * Write one provider profile through the official seam. A refusal that
   * names the no-models case retries once with the gateway-discovered
   * catalog (same retry providers/add always had).
   */
  const mutateProviderRoute = async (
    providerService: SettingsLike, id: string, profile: Profile, draft: Profile, verb: 'add' | 'update',
  ): Promise<void> => {
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'set', path: ['providers', id], value: profile }])
      return
    } catch (error: unknown) {
      if (!message(error).includes(NO_MODELS_MARKER)) throw internalError('failed to ' + verb + ' provider "' + id + '": ' + message(error))
    }
    const models = await discoverProviderModels(id, draft)
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'set', path: ['providers', id], value: { ...profile, models } }])
      if (!closed) discoveredModels.set(id, models)
    } catch (retryError: unknown) {
      throw internalError('failed to ' + verb + ' provider "' + id + '": ' + message(retryError))
    }
  }

  /** Refresh after an accepted route change and publish the new roster. */
  const publishMutation = async (scheduleDiscovery: boolean): Promise<ProviderRoster> => {
    const current = await refreshCatalog()
    assertOpen()
    if (scheduleDiscovery) {
      scheduleDynamicCatalogRefresh()
      assertOpen()
    }
    onChanged(current, 'mutation')
    return { providers: current.providers, currentProviderId: current.currentProviderId }
  }

  /**
   * Add one provider route to the dsh settings document through the official
   * settings seam (ctx.settings.mutate on the llm-pi-ai namespace), never by
   * writing settings.yaml directly. A duplicate route id is refused; a route
   * the installed catalog does not describe gets its models from gateway
   * discovery. On success the refreshed provider roster comes back so the TUI
   * can update /provider immediately.
   */
  const addProvider = async (params: unknown): Promise<ProviderRoster> => {
    assertOpen()
    const request = paramRecord(params, 'x.ai/providers/add')
    const id = requireProviderId(request.id, 'provider id')
    const normalized = normalizeProviderForm(request)
    const providerService = requireSettings()
    if (providerExists(providerService, id)) throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" already exists')
    const form = await storePastedKey(normalized, id)
    await mutateProviderRoute(providerService, id, editableProfile(form), form, 'add')
    if (form.credentialSource === 'environment') {
      await cleanupUnsharedCredential(providerService, nonEmpty(form.apiKeyEnv) ? form.apiKeyEnv : undefined, id)
    }
    return publishMutation(true)
  }

  /**
   * Update one provider route's editable fields through the same official
   * seam. The current user profile is merged so fields the form does not
   * edit (models) survive; empty optional fields revert to the catalog
   * default, exactly as providers/add treats them.
   */
  const updateProvider = async (params: unknown): Promise<ProviderRoster> => {
    assertOpen()
    const request = paramRecord(params, 'x.ai/providers/update')
    const providerId = requireProviderId(request.providerId, 'providerId')
    const normalized = normalizeProviderForm(request)
    const providerService = requireSettings()
    if (!providerExists(providerService, providerId)) throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + providerId + '" does not exist')
    const currentProfile = providerUserProfile(providerUserSection(providerService), providerId)
    const previousCredentialRef = nonEmpty(currentProfile.apiKeyEnv) ? currentProfile.apiKeyEnv : undefined
    const form = await storePastedKey(normalized, providerId)
    const next = mergeEditable(currentProfile, form)
    const nextCredentialRef = nonEmpty(next.apiKeyEnv) ? next.apiKeyEnv : undefined
    await mutateProviderRoute(providerService, providerId, next, form, 'update')
    if (previousCredentialRef !== nextCredentialRef) await cleanupUnsharedCredential(providerService, previousCredentialRef, providerId)
    if (form.credentialSource === 'environment') await cleanupUnsharedCredential(providerService, nextCredentialRef, providerId)
    discoveredModels.delete(providerId)
    discoveredRoutes.delete(providerId)
    return publishMutation(true)
  }

  /**
   * Remove one provider route through the official seam. The provider that
   * owns the current/default model is refused: the TUI must switch away
   * first, so a removal can never orphan the active selection.
   */
  const removeProvider = async (params: unknown): Promise<ProviderRoster> => {
    assertOpen()
    const id = requireProviderId(paramRecord(params, 'x.ai/providers/remove').id, 'provider id')
    const providerService = requireSettings()
    if (!providerExists(providerService, id)) throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" does not exist')
    const profile = providerUserProfile(providerUserSection(providerService), id)
    const credentialRef = nonEmpty(profile.apiKeyEnv) ? profile.apiKeyEnv : undefined
    const current = await refreshCatalog()
    const liveUse = isProviderInUse(id)
    if (current.currentProviderId === id || liveUse) {
      throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" is in use; switch to another provider first')
    }
    if (!hasUserProviderRoute(providerService, id)) throw new RpcError(JSONRPC_INVALID_PARAMS, 'provider "' + id + '" has no removable user route')
    assertOpen()
    try {
      await providerService.mutate(PROVIDER_SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }])
    } catch (error: unknown) {
      throw internalError('failed to remove provider "' + id + '": ' + message(error))
    }
    await cleanupUnsharedCredential(providerService, credentialRef, id)
    discoveredModels.delete(id)
    discoveredRoutes.delete(id)
    return publishMutation(false)
  }

  const modelsList = async (): Promise<unknown> => {
    const current = await refreshCatalog()
    scheduleDynamicCatalogRefresh()
    return {
      currentModelId: current.currentModelId,
      availableModels: current.availableModels,
      _meta: { currentProviderId: current.currentProviderId, providers: current.providers },
    }
  }

  return {
    peek: () => catalog,
    /** Publish an acknowledged default choice without repeating discovery.
     * Resolve against the latest catalog: a concurrent refresh may change wire
     * IDs. Updates the cached snapshot in place, as holders of it observe. */
    selected(selection: Pick<ModelSelection, 'provider' | 'model'>): void {
      assertOpen()
      const wireId = catalog?.providerModelToWireId.get(modelEffortKey(selection.provider, selection.model))
      if (catalog !== undefined && wireId !== undefined) {
        catalog.currentModelId = wireId
        catalog.currentProviderId = selection.provider
      }
    },
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
