/** Structural reads of the native DSH services the bridge consumes. Declared
 * once here so catalog, preset and composition code share one contract. */

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

/** Exact-model metadata as the llm service resolves it. */
export type ModelInfo = Awaited<ReturnType<NonNullable<LlmLike['resolveModelInfo']>>>

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
  /** Source-runtime startup/import completion; absent on older test adapters. */
  readonly ready?: Promise<void>
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<void>
  /** Read the raw user sections (ctx.settings.describe); optional for harnesses without it. */
  describe?(): Array<{ ns: string; user?: unknown }>
}

/** Structural read of the default-model service. */
export interface AgentDefaultModelLike {
  currentSelection?(): { provider: string; model: string; reasoningEffort?: string } | undefined
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

