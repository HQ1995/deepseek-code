/** The flattened wire model catalog the TUI sees, and how requested or saved
 * selections resolve against it. Pure: the catalog owner gathers the native
 * provider/model reads and hands them to `assembleCatalog`. */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { invalidParams } from './acp.ts'
import type { CredentialInfo, ModelInfo } from './native-seams.ts'

/**
 * Fallback reasoning effort shown in the TUI before the user has explicitly
 * picked one. DeepSeek's own adapter defaults to high when omitted; this is
 * also the first canonical level in the bridge's advertised effort menu.
 */
const DEFAULT_REASONING_EFFORT = 'high'
/** Fallback effort menu when the llm service exposes no exact-model reasoning metadata. */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Separator used to disambiguate the same model id owned by different providers. */
const MODEL_ID_SEPARATOR = ':'

/** One advertised model row of the wire catalog. */
export interface CatalogModel {
  modelId: string
  name: string
  description?: string
  _meta?: { provider: string; supportsReasoningEffort?: boolean; reasoningEfforts?: string[]; reasoningEffort?: string; inputModalities?: string[]; acceptsImages?: boolean }
}

/** Provider roster row as listed by the harness llm service ({id, name?}) plus
 * the raw user-section profile fields the edit form prefills. `note` is a
 * display-only status the TUI relays verbatim (e.g. empty subscription
 * provider → its /dsh login pointer). */
export interface CatalogProvider {
  id: string
  name?: string
  displayName?: string
  apiKeyEnv?: string
  api?: string
  baseURL?: string
  credential?: CredentialInfo
  note?: string
}

/** Flattened wire catalog plus the provider ownership the bare model ids hide. */
export interface ModelCatalog {
  currentModelId: string
  providers: CatalogProvider[]
  /** Provider that owns currentModelId ('' when no current model). */
  currentProviderId: string
  availableModels: CatalogModel[]
  routesByModel: Map<string, { provider: string; model: string }>
  providerModelToWireId: Map<string, string>
}

/** One provider's native model listing and its exact-model metadata. */
export interface ProviderModels {
  provider: string
  models: ReadonlyArray<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>
  metadata: ReadonlyMap<string, ModelInfo>
}

type Selection = { provider: string; model: string; reasoningEffort?: string }

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Build the wire catalog id for a provider/model pair. */
const wireModelId = (provider: string, modelId: string): string => provider + MODEL_ID_SEPARATOR + modelId

/** Stable in-memory key for a provider/model effort. */
export function modelEffortKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

/** Keep a saved/session effort only when the exact advertised model accepts it. */
export const acceptedReasoningEffort = (model: CatalogModel | undefined, effort: unknown): string | undefined => {
  if (!nonEmptyString(effort) || model === undefined) return undefined
  if (model._meta?.supportsReasoningEffort === false) return undefined
  const supported = model._meta?.reasoningEfforts
  return supported === undefined || supported.includes(effort) ? effort : undefined
}

const firstNonEmpty = (...values: unknown[]): string | undefined => values.find(nonEmptyString)

/** Resolve a session selection from request overrides, deployment config, or
 * the supplied saved/session default. All-empty means provider onboarding. */
export function modelSelectionFromRequest(
  config: { provider?: string; model?: string },
  defaultSelection: Selection | undefined,
  meta: Record<string, unknown> | null | undefined,
): ModelSelectionRef['current'] {
  const provider = firstNonEmpty(meta?.provider, config.provider, defaultSelection?.provider)
  const model = firstNonEmpty(meta?.model, config.model, defaultSelection?.model)
  if (provider === undefined || model === undefined) return undefined
  const fromDefault = defaultSelection !== undefined && provider === defaultSelection.provider && model === defaultSelection.model
  const reasoningEffort = (typeof meta?.reasoningEffort === 'string' ? meta.reasoningEffort : undefined)
    ?? (fromDefault ? defaultSelection.reasoningEffort : undefined)
  return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) } }
}

/** Display-only provider status: the native configuration error, or a generic
 * pointer for an empty provider (the TUI relays notes verbatim, and the bridge
 * carries no plugin-specific knowledge of which login or key it wants). */
export const providerNote = (configurationError: string | undefined, modelCount: number): string | undefined =>
  configurationError ?? (modelCount > 0 ? undefined
    : 'no models yet — the provider may need a login or API key (its plugin may register a /login command)')

/** One advertised row. An exact metadata resolver returning no reasoning means
 * the model does not expose selectable effort; only legacy llm seams with no
 * resolver get the compatibility vocabulary. */
function advertise(
  wireId: string,
  provider: string,
  model: ProviderModels['models'][number],
  info: ModelInfo | undefined,
  hasMetadataResolver: boolean,
): CatalogModel {
  const inputModalities = (info?.inputModalities ?? model.inputModalities)?.filter(nonEmptyString)
  const efforts = info?.reasoning?.efforts?.map(effort => effort.id).filter(nonEmptyString)
  return {
    modelId: wireId,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    _meta: {
      provider,
      supportsReasoningEffort: hasMetadataResolver ? (efforts?.length ?? 0) > 0 : true,
      acceptsImages: inputModalities?.includes('image') === true,
      ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] },
      ...efforts !== undefined && efforts.length > 0
        ? { reasoningEfforts: efforts }
        : !hasMetadataResolver ? { reasoningEfforts: [...DEFAULT_REASONING_EFFORTS] } : {},
    },
  }
}

interface Routes {
  availableModels: CatalogModel[]
  routesByModel: ModelCatalog['routesByModel']
  providerModelToWireId: ModelCatalog['providerModelToWireId']
  /** Adapter-configured default effort per provider/model key. */
  defaultEfforts: Map<string, string>
}

/** Flatten provider listings into unique wire ids. The first provider listing a
 * raw id keeps the bare id for compatibility; later providers with the same id
 * get a provider-qualified id (suffixed if that collides) so both stay selectable. */
function flattenRoutes(rows: readonly ProviderModels[], hasMetadataResolver: boolean): Routes {
  const routes: Routes = { availableModels: [], routesByModel: new Map(), providerModelToWireId: new Map(), defaultEfforts: new Map() }
  const reservedRawIds = new Set(rows.flatMap(row => row.models.map(model => model.id)))
  const rawModelOwners = new Map<string, string>()
  for (const row of rows) {
    for (const model of row.models) {
      const pairKey = modelEffortKey(row.provider, model.id)
      if (routes.providerModelToWireId.has(pairKey)) continue
      const existingOwner = rawModelOwners.get(model.id)
      let wireId = model.id
      if (existingOwner !== undefined && existingOwner !== row.provider) {
        const qualified = wireModelId(row.provider, model.id)
        wireId = qualified
        for (let suffix = 2; reservedRawIds.has(wireId) || routes.routesByModel.has(wireId); suffix++) wireId = `${qualified} (${suffix})`
      }
      rawModelOwners.set(model.id, existingOwner ?? row.provider)
      routes.providerModelToWireId.set(pairKey, wireId)
      routes.routesByModel.set(wireId, { provider: row.provider, model: model.id })
      const info = row.metadata.get(model.id)
      const defaultEffort = info?.reasoning?.defaultEffort
      if (nonEmptyString(defaultEffort)) routes.defaultEfforts.set(pairKey, defaultEffort)
      routes.availableModels.push(advertise(wireId, row.provider, model, info, hasMetadataResolver))
    }
  }
  return routes
}

/** Inputs to one catalog snapshot, gathered by the owner from native services. */
export interface CatalogSources {
  rows: readonly ProviderModels[]
  providers: CatalogProvider[]
  /** Whether the llm service resolves exact-model metadata. */
  hasMetadataResolver: boolean
  config: { provider?: string; model?: string }
  defaultSelection: Selection | undefined
}

/** Assemble a catalog snapshot. The current model is the requested one (config
 * or saved default), else the first advertised model; `missingRequested` names
 * a requested model the catalog no longer carries. The current model's
 * `_meta.reasoningEffort` carries the persisted choice, or the adapter default,
 * so the TUI status survives restarts. */
export function assembleCatalog(sources: CatalogSources): { catalog: ModelCatalog; missingRequested?: string } {
  const { rows, providers, hasMetadataResolver, config, defaultSelection } = sources
  const routes = flattenRoutes(rows, hasMetadataResolver)
  const requestedProvider = firstNonEmpty(config.provider, defaultSelection?.provider)
  const requestedRawModel = firstNonEmpty(config.model, defaultSelection?.model)
  const requested = requestedRawModel === undefined || requestedProvider === undefined
    ? requestedRawModel
    : routes.providerModelToWireId.get(modelEffortKey(requestedProvider, requestedRawModel)) ?? requestedRawModel
  // A fresh profile has no requested model and may have an empty catalog; the
  // first advertised model seeds the UI until an explicit selection persists.
  const seed = routes.availableModels[0]?.modelId ?? ''
  const candidate = requested ?? seed
  const missing = candidate !== '' && !routes.routesByModel.has(candidate)
  const currentModelId = missing ? seed : candidate
  const route = routes.routesByModel.get(currentModelId)
  const currentProviderId = route?.provider ?? ''
  const currentRawModel = route?.model ?? ''
  const current = routes.availableModels.find(model => model.modelId === currentModelId)
  const persisted = defaultSelection?.provider === currentProviderId && defaultSelection.model === currentRawModel
    ? defaultSelection.reasoningEffort
    : undefined
  const selectedEffort = acceptedReasoningEffort(current, persisted)
    ?? acceptedReasoningEffort(current, routes.defaultEfforts.get(modelEffortKey(currentProviderId, currentRawModel)))
    ?? (hasMetadataResolver ? undefined : acceptedReasoningEffort(current, DEFAULT_REASONING_EFFORT))
  const availableModels = selectedEffort === undefined || current?._meta === undefined
    ? routes.availableModels
    : routes.availableModels.map(model => model === current ? { ...model, _meta: { ...model._meta!, reasoningEffort: selectedEffort } } : model)
  return {
    catalog: {
      currentModelId, providers, currentProviderId, availableModels,
      routesByModel: routes.routesByModel, providerModelToWireId: routes.providerModelToWireId,
    },
    ...missing ? { missingRequested: String(requested) } : {},
  }
}

/** Resolve one session's requested/saved selection against a catalog snapshot.
 * `--model <wire-id>` infers its provider, and an existing configured provider
 * seeds a session even when the neutral deployment default is empty. Explicit
 * unknown models fail closed; stale saved routes fall back to the catalog seed. */
export function resolveSelection(
  current: ModelCatalog,
  config: { provider?: string; model?: string },
  defaultSelection: Selection | undefined,
  meta: Record<string, unknown> | null | undefined,
): ModelSelectionRef['current'] {
  const candidate = modelSelectionFromRequest(config, defaultSelection, meta)
  const explicitModel = nonEmptyString(meta?.model) ? meta.model : undefined
  const explicitProvider = nonEmptyString(meta?.provider) ? meta.provider : undefined
  let wireId: string | undefined
  if (explicitProvider === undefined && explicitModel !== undefined && current.routesByModel.has(explicitModel)) {
    wireId = explicitModel
  } else if (candidate !== undefined) {
    wireId = current.providerModelToWireId.get(modelEffortKey(candidate.provider, candidate.model))
      ?? (current.routesByModel.get(candidate.model)?.provider === candidate.provider ? candidate.model : undefined)
  }
  if (wireId === undefined && (explicitModel !== undefined || explicitProvider !== undefined)) {
    throw invalidParams('requested provider/model is not in the catalog: '
      + String(explicitProvider ?? '') + (explicitProvider === undefined ? '' : '/') + String(explicitModel ?? ''))
  }
  wireId ??= current.currentModelId === '' ? undefined : current.currentModelId
  const route = wireId === undefined ? undefined : current.routesByModel.get(wireId)
  if (route === undefined) return undefined
  const advertisedModel = current.availableModels.find(entry => entry.modelId === wireId)
  // A qualified wire id can infer its provider even without a saved route;
  // do not lose an explicit effort merely because candidate is undefined.
  const requestedEffort = typeof meta?.reasoningEffort === 'string' ? meta.reasoningEffort : candidate?.reasoningEffort
  const reasoningEffort = acceptedReasoningEffort(advertisedModel, requestedEffort)
    ?? acceptedReasoningEffort(advertisedModel, advertisedModel?._meta?.reasoningEffort)
  return {
    provider: route.provider,
    model: route.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}
