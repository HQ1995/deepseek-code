/** Pure rules for llm-pi-ai provider routes: reading the user settings
 * section, validating the /provider form and deriving persisted profiles.
 * No I/O; the catalog owner performs every read and write. */
import { invalidParams } from './acp.ts'
import type { PiAiReasoningEfforts } from './model-endpoint.ts'
import type { SettingsLike } from './native-seams.ts'

/** The dsh settings namespace the llm-pi-ai plugin owns (packages/llm/llm-pi-ai). */
export const PROVIDER_SETTINGS_NS = 'llm-pi-ai'
/** Provider route ids are lowercase kebab-case, like settings namespace ids. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/
/** Wire protocols a declared provider route may name (llm-pi-ai supportedProtocols). */
const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
/** Editable form fields; an empty value means "unset" (the schema refuses ''). */
const EDITABLE_FIELDS = ['displayName', 'apiKeyEnv', 'api', 'baseURL'] as const
/**
 * The official seam refuses a declared route that resolves no models; that
 * error marks the retry path where the gateway is interrogated for its
 * catalog (catalog routes never hit it: they resolve their models first).
 */
export const NO_MODELS_MARKER = 'resolves no models'

/** One model a gateway listed for a route, as persisted in its profile. */
export interface DiscoveredProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: false | PiAiReasoningEfforts
}

type Profile = Record<string, unknown>

export const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** Raw user section of the llm-pi-ai namespace, when the settings service exposes it. */
export function providerUserSection(providerService: SettingsLike | undefined): Profile | undefined {
  const user = providerService?.describe?.().find(entry => entry.ns === PROVIDER_SETTINGS_NS)?.user
  return isRecord(user) ? user : undefined
}

/** One provider's raw user profile ({} when the section does not name it). */
export function providerUserProfile(userSection: Profile | undefined, id: string): Profile {
  const providers = userSection?.providers
  const profile = isRecord(providers) ? providers[id] : undefined
  return isRecord(profile) ? profile : {}
}

export function hasUserProviderRoute(providerService: SettingsLike | undefined, id: string): boolean {
  const providers = providerUserSection(providerService)?.providers
  return isRecord(providers) && Object.prototype.hasOwnProperty.call(providers, id)
}

/** baseURLs of the provider routes already persisted in the user settings
 * section: the only endpoints a resolved env secret may be sent to. */
export function knownRouteBaseUrls(providerService: SettingsLike | undefined): string[] {
  const providers = providerUserSection(providerService)?.providers
  if (!isRecord(providers)) return []
  return Object.values(providers)
    .map(profile => isRecord(profile) ? profile.baseURL : undefined)
    .filter(nonEmpty)
}

/** Whether another route than `excludedProviderId` still names `ref`. */
export function sharesCredentialRef(userSection: Profile | undefined, ref: string, excludedProviderId: string): boolean {
  const providers = userSection?.providers
  return isRecord(providers) && Object.entries(providers).some(([id, profile]) =>
    id !== excludedProviderId && isRecord(profile) && profile.apiKeyEnv === ref)
}

/** Refuse a route id that is not lowercase kebab-case; `label` names the field. */
export function requireProviderId(value: unknown, label: 'provider id' | 'providerId'): string {
  if (typeof value !== 'string' || !PROVIDER_ID_PATTERN.test(value)) {
    throw invalidParams(label + ' must be lowercase kebab-case (letters, digits, hyphens; starts with a letter)')
  }
  return value
}

/** Only the OpenAI-compatible protocols list models for gateway discovery. */
export const isDiscoverableApi = (api: unknown): boolean => api === 'openai-completions' || api === 'openai-responses'

function requireHttpBaseUrl(baseURL: string): void {
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

/** Reject malformed form fields before any settings write; returns the form
 * with a whitespace-normalized baseURL. */
export function normalizeProviderForm(form: Profile): Profile {
  for (const field of ['displayName', 'apiKeyEnv', 'baseURL', 'apiKey'] as const) {
    const value = form[field]
    if (value !== undefined && value !== null && typeof value !== 'string') throw invalidParams(field + ' must be a string')
  }
  const credentialSource = form.credentialSource
  if (credentialSource !== undefined && credentialSource !== 'saved' && credentialSource !== 'environment') {
    throw invalidParams('credentialSource must be saved or environment')
  }
  const api = form.api
  if (api !== undefined && api !== null && (typeof api !== 'string'
    || (api.length > 0 && !PROVIDER_APIS.includes(api as (typeof PROVIDER_APIS)[number])))) {
    throw invalidParams('api must be one of ' + PROVIDER_APIS.join(', '))
  }
  if (typeof form.baseURL !== 'string') return { ...form }
  const baseURL = form.baseURL.trim()
  if (baseURL.length > 0) requireHttpBaseUrl(baseURL)
  return { ...form, baseURL }
}

/** The literal key pasted into the form, if any. An environment-sourced
 * credential must not also carry a pasted key. */
export function pastedApiKey(form: Profile): string | undefined {
  const pasted = nonEmpty(form.apiKey) ? form.apiKey : undefined
  if (pasted !== undefined && form.credentialSource === 'environment') {
    throw invalidParams('apiKey must be empty when credentialSource is environment')
  }
  return pasted
}

/** The credential name a pasted key is stored under: the form's apiKeyEnv, or
 * one derived from the route id. */
export const pastedKeyRef = (form: Profile, id: string): string =>
  nonEmpty(form.apiKeyEnv) ? form.apiKeyEnv : id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'

/** The editable fields as a fresh profile (empty fields omitted). */
export const editableProfile = (form: Profile): Profile =>
  Object.fromEntries(EDITABLE_FIELDS.filter(field => nonEmpty(form[field])).map(field => [field, form[field]]))

/** Merge the form fields over the current profile: an absent key keeps the
 * current value, an explicit empty field unsets it. */
export function mergeEditable(current: Profile, form: Profile): Profile {
  const next: Profile = { ...current }
  for (const field of EDITABLE_FIELDS) {
    const value = form[field]
    if (value === undefined) continue
    if (nonEmpty(value)) next[field] = value
    else delete next[field]
  }
  return next
}

/** Identity of a dynamic route's discovery inputs. */
export const routeSignature = (profile: Profile): string =>
  JSON.stringify([profile.api ?? null, profile.baseURL ?? null, profile.apiKeyEnv ?? null])

const modelShape = (model: Profile): string => JSON.stringify([
  String(model.id ?? ''), model.name ?? null, model.contextWindow ?? null, model.maxTokens ?? null, model.reasoningEfforts ?? null,
])

/** The profile's model list after a background discovery, or undefined when
 * nothing should be written: the route changed since it was probed, it has no
 * explicit model list, or the discovered catalog matches what is stored.
 * Stored per-model overrides win over discovered values. */
export function discoveredModelUpdate(latest: Profile, signature: string, discovered: readonly DiscoveredProviderModel[]): Profile[] | undefined {
  if (routeSignature(latest) !== signature || !Array.isArray(latest.models)) return undefined
  const stored = latest.models as Profile[]
  const existingById = new Map(stored.map(model => [String(model.id ?? ''), model]))
  const next = discovered.map(model => ({
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
    ...existingById.get(model.id),
    id: model.id,
  }))
  return stored.map(modelShape).join('\u0000') === next.map(modelShape).join('\u0000') ? undefined : next
}
