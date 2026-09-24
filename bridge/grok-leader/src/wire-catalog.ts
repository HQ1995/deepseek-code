/** The flattened wire model catalog the TUI sees, and how requested or saved
 * selections resolve against it. Pure: the catalog owner gathers the native
 * provider/model reads and hands them to `assembleCatalog`. */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { invalidParams } from './acp.ts'
import { nonEmpty } from './guards.ts'
import type { CredentialInfo, ModelInfo } from './native-seams.ts'

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

/** Build the wire catalog id for a provider/model pair. */
const wireModelId = (provider: string, modelId: string): string => provider + MODEL_ID_SEPARATOR + modelId

/** Stable in-memory key for a provider/model effort. */
export function modelEffortKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

/** Keep a saved/session effort only when the exact advertised model accepts it. */
export const acceptedReasoningEffort = (model: CatalogModel | undefined, effort: unknown): string | undefined => {
  if (!nonEmpty(effort) || model === undefined) return undefined
  if (model._meta?.supportsReasoningEffort === false) return undefined
  const supported = model._meta?.reasoningEfforts
  return supported === undefined || supported.includes(effort) ? effort : undefined
}

const firstNonEmpty = (...values: unknown[]): string | undefined => values.find(nonEmpty)

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

/** Longest listing failure a note carries; the TUI shows notes on one row. */
const NOTE_ERROR_LIMIT = 200

/** One provider's model listing failure as a single display line. */
const listingFailureNote = (error: string): string => {
  const line = error.replace(/\s+/g, ' ').trim()
  const text = line.length > NOTE_ERROR_LIMIT ? line.slice(0, NOTE_ERROR_LIMIT - 1) + '…' : line
  return 'could not list models: ' + (text === '' ? 'unknown error' : text)
}

/** Display-only provider status: the native configuration error, the error
 * its model listing failed with, or a generic pointer for an empty provider
 * (the TUI relays notes verbatim, and the bridge carries no plugin-specific
 * knowledge of which login or key it wants). */
export const providerNote = (configurationError: string | undefined, modelCount: number, listingError?: string): string | undefined =>
  configurationError ?? (listingError !== undefined ? listingFailureNote(listingError) : modelCount > 0 ? undefined
    : 'no models yet — the provider may need a login or API key (its plugin may register a /login command)')

/** One advertised row. Exact metadata without reasoning (or none resolved)
 * means the model exposes no selectable effort. */
function advertise(
  wireId: string,
  provider: string,
  model: ProviderModels['models'][number],
  info: ModelInfo | undefined,
): CatalogModel {
  const inputModalities = (info?.inputModalities ?? model.inputModalities)?.filter(nonEmpty)
  const efforts = info?.reasoning?.efforts?.map(effort => effort.id).filter(nonEmpty)
  return {
    modelId: wireId,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    _meta: {
      provider,
      supportsReasoningEffort: (efforts?.length ?? 0) > 0,
      acceptsImages: inputModalities?.includes('image') === true,
      ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] },
      ...efforts !== undefined && efforts.length > 0 ? { reasoningEfforts: efforts } : {},
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
function flattenRoutes(rows: readonly ProviderModels[]): Routes {
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
      if (nonEmpty(defaultEffort)) routes.defaultEfforts.set(pairKey, defaultEffort)
      routes.availableModels.push(advertise(wireId, row.provider, model, info))
    }
  }
  return routes
}

/** Inputs to one catalog snapshot, gathered by the owner from native services. */
export interface CatalogSources {
  rows: readonly ProviderModels[]
  providers: CatalogProvider[]
  config: { provider?: string; model?: string }
  defaultSelection: Selection | undefined
}

/** Assemble a catalog snapshot. The current model is the requested one (config
 * or saved default), else the first advertised model; `missingRequested` names
 * a requested model the catalog no longer carries. The current model's
 * `_meta.reasoningEffort` carries the persisted choice, or the adapter default,
 * so the TUI status survives restarts. */
export function assembleCatalog(sources: CatalogSources): { catalog: ModelCatalog; missingRequested?: string } {
  const { rows, providers, config, defaultSelection } = sources
  const routes = flattenRoutes(rows)
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

/** What to tell the user when a remembered (not explicitly requested) choice
 * is no longer in the catalog: `resolveSelection` then falls back to the
 * catalog's current model, which would otherwise switch a resumed session's
 * model and provider without a word. Undefined when nothing was replaced. */
export function unavailableSelectionNotice(
  remembered: Selection | undefined,
  resolved: ModelSelectionRef['current'],
  current: Pick<ModelCatalog, 'providerModelToWireId'> | undefined,
): string | undefined {
  if (remembered === undefined) return undefined
  if (resolved !== undefined && resolved.provider === remembered.provider && resolved.model === remembered.model) return undefined
  if (current?.providerModelToWireId.has(modelEffortKey(remembered.provider, remembered.model)) === true) return undefined
  const saved = 'Saved model ' + remembered.provider + '/' + remembered.model + ' is unavailable'
  return resolved === undefined
    ? saved + ' and no other model is available. /provider to add one.'
    : saved + '; using ' + resolved.provider + '/' + resolved.model + '. /model to change.'
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
  const explicitModel = nonEmpty(meta?.model) ? meta.model : undefined
  const explicitProvider = nonEmpty(meta?.provider) ? meta.provider : undefined
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
