/** The official DeepSeek Messages adapter as an explicit /provider route.
 * dscode profiles stay provider-neutral: the `llm-deepseek` row ships
 * disabled, and adding this route enables it through the plugin manager. The
 * adapter reads its key per request from the credentials service, so a pasted
 * key works exactly like a pi-ai route's. No other route is touched. */
import { internalError, invalidParams } from './acp.ts'
import type { CredentialsLike, SettingsLike } from './native-seams.ts'
import type { PluginRows } from './plugin-rows.ts'

export const NATIVE_DEEPSEEK_PROVIDER = 'deepseek-official'
/** Wire marker for the add-provider form; never a pi-ai `api` value. */
export const NATIVE_DEEPSEEK_API = 'deepseek-native'
const ROW_ID = 'llm-deepseek'
const MODULE = '@deepseek-ai/dsh-llm-deepseek'
const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface NativeProviderForm {
  apiKeyEnv?: string
  /** Pasted key, stored in the credentials service under apiKeyEnv. */
  apiKey?: string
  /** Messages root; empty keeps the adapter default. */
  baseURL?: string
}

export interface NativeProviderDependencies {
  rows: PluginRows
  credentials(): CredentialsLike | undefined
  settings(): SettingsLike | undefined
}

/** Reject a malformed form before any credential or profile write. */
export function nativeProviderForm(request: Record<string, unknown>): NativeProviderForm {
  const text = (field: string): string | undefined => {
    const value = request[field]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw invalidParams(field + ' must be a string')
    return value.trim() === '' ? undefined : value.trim()
  }
  const apiKeyEnv = text('apiKeyEnv')
  if (apiKeyEnv !== undefined && !ENV_NAME.test(apiKeyEnv)) throw invalidParams('apiKeyEnv must be an environment variable name')
  const baseURL = text('baseURL')
  if (baseURL !== undefined) {
    let url: URL
    try { url = new URL(baseURL) } catch { throw invalidParams('baseURL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw invalidParams('baseURL must be an HTTP(S) root without credentials, query or fragment')
    }
  }
  const apiKey = typeof request.apiKey === 'string' && request.apiKey.trim() !== '' ? request.apiKey.trim() : undefined
  return { ...apiKeyEnv === undefined ? {} : { apiKeyEnv }, ...apiKey === undefined ? {} : { apiKey }, ...baseURL === undefined ? {} : { baseURL } }
}

export function createNativeProviders(dependencies: NativeProviderDependencies) {
  const ROW = { id: ROW_ID, module: MODULE, label: 'DeepSeek adapter' }
  /** The adapter's own settings section, as written by this module. */
  const section = (): Record<string, unknown> => {
    const user = dependencies.settings()?.describe?.().find(row => row.ns === ROW_ID)?.user
    return user !== null && typeof user === 'object' ? user as Record<string, unknown> : {}
  }

  return {
    /** Whether a form or roster row addresses this adapter rather than a pi-ai route. */
    owns(id: unknown, api?: unknown): boolean {
      return id === NATIVE_DEEPSEEK_PROVIDER || api === NATIVE_DEEPSEEK_API
    },
    /** Editable fields the roster reports for this route. */
    describe(): { api: string; apiKeyEnv: string; baseURL?: string } {
      const current = section()
      return {
        api: NATIVE_DEEPSEEK_API,
        apiKeyEnv: typeof current.apiKeyEnv === 'string' ? current.apiKeyEnv : DEFAULT_KEY_ENV,
        ...typeof current.baseURL === 'string' ? { baseURL: current.baseURL } : {},
      }
    },
    /** Store any pasted key, enable the row, then apply the form's settings.
     * Empty optional fields return to the adapter defaults. */
    async enable(form: NativeProviderForm): Promise<void> {
      const ref = form.apiKeyEnv ?? DEFAULT_KEY_ENV
      if (form.apiKey !== undefined) {
        const credentials = dependencies.credentials()
        if (credentials === undefined) throw internalError('the credentials service is unavailable; cannot store the pasted key')
        await credentials.set(ref, form.apiKey)
      }
      await dependencies.rows.set(ROW, true)
      const settings = dependencies.settings()
      if (settings === undefined) throw internalError('the settings service is unavailable; cannot configure the DeepSeek adapter')
      const ops = [
        form.apiKeyEnv === undefined || form.apiKeyEnv === DEFAULT_KEY_ENV
          ? { op: 'unset', path: ['apiKeyEnv'] } : { op: 'set', path: ['apiKeyEnv'], value: form.apiKeyEnv },
        form.baseURL === undefined ? { op: 'unset', path: ['baseURL'] } : { op: 'set', path: ['baseURL'], value: form.baseURL },
      ]
      await settings.mutate(ROW_ID, ops)
    },
    async disable(): Promise<void> {
      await dependencies.rows.set(ROW, false)
    },
  }
}

export type NativeProviders = ReturnType<typeof createNativeProviders>
