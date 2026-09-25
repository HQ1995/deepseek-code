/** Pure provider-list assembly for the model catalog: which providers the
 * roster lists, each provider's model list and display row, a draft route's
 * discovery request and the model rows its answer yields, and what clients
 * are sent from a snapshot. No native reads: model-catalog passes in what the
 * llm, settings and credential services returned. */
import type { EndpointCapabilities } from './model-endpoint.ts'
import { NATIVE_DEEPSEEK_NAME, NATIVE_MODEL_DESCRIPTIONS } from './native-provider.ts'
import type { CredentialInfo, LlmLike } from './native-seams.ts'
import type { DiscoveredProviderModel } from './provider-profile.ts'
import { nonEmpty } from './guards.ts'
import { modelEffortKey, type CatalogProvider, type ModelCatalog, type ProviderModels } from './wire-catalog.ts'

type Profile = Record<string, unknown>
/** The roster a provider mutation replies with. */
export type ProviderRoster = { providers: CatalogProvider[]; currentProviderId: string }
/** One provider's listing, or why the llm service could not list it. */
export type ProviderListing = ProviderModels & { failure?: string }

/** The client-visible content of one catalog snapshot. */
export const catalogSignature = (current: ModelCatalog): string =>
  JSON.stringify([current.currentModelId, current.currentProviderId, current.providers, current.availableModels])

/** Roster rows: every active provider, plus each configurable one whose
 * configuration failed, which stays visible with its diagnostic. */
export function rosterRows(active: ReturnType<LlmLike['listProviders']>, configurable: ReturnType<LlmLike['listConfigurableProviders']>) {
  const configured = new Map(configurable.map(row => [row.provider, row]))
  const rows = new Map<string, { id: string; name?: string }>(active.map(row => [row.id, row]))
  for (const row of configured.values()) {
    if (row.error !== undefined && !rows.has(row.provider)) rows.set(row.provider, { id: row.provider, name: row.displayName })
  }
  return { configured, rows }
}

/** A provider's models: a background discovery overrides the static listing;
 * the native adapter's models gain their descriptions. */
export function listedModels(
  listed: Awaited<ReturnType<LlmLike['listModels']>>, native: boolean, discovered: readonly DiscoveredProviderModel[] | undefined,
): ProviderModels['models'] {
  const staticModels = native ? listed.map(model => model.description !== undefined || NATIVE_MODEL_DESCRIPTIONS[model.id] === undefined
    ? model : { ...model, description: NATIVE_MODEL_DESCRIPTIONS[model.id] }) : listed
  return discovered === undefined ? staticModels : discovered.map(model => ({ id: model.id, name: model.name ?? model.id }))
}

/** One roster row: the llm service's identity plus the editable profile
 * fields and non-secret credential facts. */
export function providerRow(
  row: { id: string; name?: string }, native: boolean, profile: Profile, apiKeyEnv: string | undefined,
  credential: CredentialInfo | undefined, note: string | undefined,
): CatalogProvider {
  const name = native ? NATIVE_DEEPSEEK_NAME : row.name
  return {
    id: row.id,
    ...name === undefined ? {} : { name },
    ...typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {},
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    ...typeof profile.api === 'string' ? { api: profile.api } : {},
    ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
    ...credential === undefined ? {} : { credential },
    ...note === undefined ? {} : { note },
  }
}

/** The llm discovery request for one draft route. */
export const discoveryRequest = (id: string, draft: Profile, baseURL: string | undefined, apiKey: string | undefined) => ({
  provider: id,
  ...nonEmpty(draft.api) ? { api: draft.api } : {},
  ...baseURL === undefined ? {} : { baseURL },
  ...nonEmpty(apiKey) ? { apiKey } : {},
})

/** Discovered models with the endpoint's effort extensions, where probed. */
export const discoveredModelRows = (
  models: Awaited<ReturnType<NonNullable<LlmLike['discoverModels']>>>, capabilities: EndpointCapabilities,
): DiscoveredProviderModel[] => models.map(model => ({
  id: model.id,
  ...model.name === undefined ? {} : { name: model.name },
  ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
  ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
  ...capabilities.has(model.id) ? { reasoningEfforts: capabilities.get(model.id)! } : {},
}))

/** The provider roster a mutation replies with. */
export const rosterOf = (current: ModelCatalog): ProviderRoster => ({ providers: current.providers, currentProviderId: current.currentProviderId })

/** The `x.ai/models/list` reply. */
export const modelsListing = (current: ModelCatalog) => ({
  currentModelId: current.currentModelId,
  availableModels: current.availableModels,
  _meta: { currentProviderId: current.currentProviderId, providers: current.providers },
})

/** The name the picker shows for a model id a native service reports (a
 * teammate's bare `deepseek-flash`): exact with its provider, otherwise only
 * when every provider names that id alike. */
export function catalogModelName(catalog: ModelCatalog | undefined, id: string, provider?: string): string | undefined {
  const rows = catalog?.availableModels ?? []
  const wire = provider === undefined ? undefined : catalog?.providerModelToWireId.get(modelEffortKey(provider, id))
  if (wire !== undefined) return rows.find(row => row.modelId === wire)?.name
  const names = new Set(rows.filter(row => row.modelId === id || catalog?.routesByModel.get(row.modelId)?.model === id).map(row => row.name))
  return names.size === 1 ? [...names][0] : undefined
}
