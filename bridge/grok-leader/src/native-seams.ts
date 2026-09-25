/** Structural reads of the native DSH services the bridge consumes. Declared
 * once here so catalog, preset and composition code share one contract. */

/** Structural read of the llm service: provider and model catalogs only. */
export interface LlmLike {
  listProviders(): Array<{ id: string; name?: string }>
  listConfigurableProviders(): Array<{ provider: string; displayName: string; settingsNs: string; error?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>>
  /** Exact-route model metadata (used for adapter-configured effort and modality metadata). */
  resolveModelInfo(
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
export type ModelInfo = Awaited<ReturnType<LlmLike['resolveModelInfo']>>

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

/** One namespace as the settings service describes it (`SettingsDescriptor`):
 * a loaded plugin entry's live-editable fields. Only `ns` and `user` are
 * always read; the rest serve `/dsh config` and are checked where used. */
export interface SettingsNamespaceLike {
  ns: string
  /** The raw user section; a field present here is user-overridden. */
  user?: unknown
  /** The serialized form schema (`schema.toJSON()`). */
  schema?: unknown
  /** Resolved values: schema defaults, composition base, then the user layer. */
  value?: unknown
  /** The composition base with defaults resolved. */
  base?: unknown
  /** Send back as the expected revision so a stale edit is refused. */
  revision?: number
  /** When the owner applies changes (`live` in DSH 0.1.7-rc.2). */
  applies?: string
  /** Every `role('secret')` slot and whether it holds a value (redacted reads). */
  secrets?: ReadonlyArray<{ readonly path: readonly string[]; readonly set: boolean }>
}

/** Structural write path of the official settings seam (ctx.settings.mutate). */
export interface SettingsLike {
  /** Source-runtime startup/import completion; absent on older test adapters. */
  readonly ready?: Promise<void>
  /** Whether the profile accepts form edits; absent on test adapters. */
  readonly writable?: boolean
  mutate(ns: string, ops: unknown, expectedRevision?: number): Promise<void>
  /** Describe the namespaces (ctx.settings.describe); optional for harnesses without it. */
  describe?(options?: { redactSecrets?: boolean }): SettingsNamespaceLike[]
}

/** Structural read of the default-model service. */
export interface AgentDefaultModelLike {
  currentSelection?(): { provider: string; model: string; reasoningEffort?: string } | undefined
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** One Remote call as DSH's Typert gateway takes it in process: exact named
 * wire arguments, answered as the operator when the request names no peer. */
export interface RemoteInvocationLike {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  /** Injected only into a cancellation-aware method (one declaring `signal`). */
  readonly signal?: AbortSignal
}

/** Structural read of DSH's in-process Remote dispatcher (`ctx.typertGateway`). */
export interface TypertGatewayLike {
  /** The business value; rejects with a `RemoteError` (marked `isDSHRemoteError`) or the owner's own error. */
  invoke(request: RemoteInvocationLike): Promise<unknown>
}

/** The parts of a generated Remote invocation descriptor the bridge checks
 * its allowlist bindings against. */
export interface RemoteDescriptorLike {
  /** Absent for unary methods. */
  readonly mode?: 'stream'
  /** `context`: a `@RemoteScope` receiver resolved from the `wire` identity. */
  readonly invocation: { readonly kind: 'direct' } | { readonly kind: 'context'; readonly context: string; readonly wire: string }
  /** The lookup parameter a consuming Context fills with its own identity. */
  readonly scope?: { readonly context: string; readonly wire: string }
  readonly parameters: ReadonlyArray<{ readonly wire: string; readonly source: 'json' | 'lookup'; readonly lookup?: string }>
  readonly cancellation?: { readonly parameter: 'signal' }
}

/** Structural read of the Typert registry (`ctx.typert`): strict local definitions by endpoint. */
export interface TypertRegistryLike {
  readonly local: {
    get(endpoint: string): RemoteDescriptorLike | undefined
    /** Defined once and since withdrawn: the gateway refuses it rather than weakening validation. */
    hasSeen(endpoint: string): boolean
  }
}

/** Cordis registers the wrapper-to-instance symbol globally; it is read
 * structurally so modules keep no framework dependency of their own. */
const TRACEABLE_ORIGINAL = Symbol.for('cordis.original')

/** The live service instance beneath cordis lookup wrappers. Every
 * `ctx.get(name)` returns a fresh traceable proxy over the same instance, so a
 * cache keyed on the lookup result would miss on every call; a remount still
 * brings a different instance. */
export function nativeInstance<T extends object>(service: T): T {
  let owner = service as T & Record<symbol, unknown>
  for (;;) {
    const next = owner[TRACEABLE_ORIGINAL] as (T & Record<symbol, unknown>) | undefined
    if (next === undefined) return owner
    owner = next
  }
}
