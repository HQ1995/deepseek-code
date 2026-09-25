/** ACP method routing: a small registry from wire method to the owner that
 * answers it. The composition root registers the core routes today; the
 * registry is the seam through which feature rows can later register their
 * own `x.ai/*` methods without editing a central switch. */
import { JSONRPC_METHOD_NOT_FOUND, internalError } from './acp.ts'
import { RpcError } from './protocol.ts'
import type { ExecutionWorld } from './execution-world.ts'
import type { ModelCatalog } from './wire-catalog.ts'

/** Wire method names of the embedded ACP dialect (agent-client-protocol 0.10.4). */
export const WIRE = {
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
  modelsList: 'x.ai/models/list',
  providersAdd: 'x.ai/providers/add',
  providersUpdate: 'x.ai/providers/update',
  providersRemove: 'x.ai/providers/remove',
} as const

/** Answers a request. A returned promise is awaited; a plain value is the
 * reply as is, in the same turn, so sync owners keep their reply ordering. */
export type RequestRoute = (clientId: number, params: unknown, method: string) => unknown
/** Handles a notification; nothing is replied. */
export type NotificationRoute = (clientId: number, params: unknown, method: string) => void

/** One method's handlers. A method sent as the kind it lacks is unknown:
 * a request answers METHOD_NOT_FOUND, a notification is dropped. */
export interface LeaderRoute {
  request?: RequestRoute
  notification?: NotificationRoute
}

export interface LeaderRoutes {
  /** Route one wire method; the returned function removes this registration
   * (and nothing registered after it). A method is owned by one registration. */
  register(method: string, route: LeaderRoute): () => void
  request(clientId: number, method: string, params: unknown): Promise<unknown>
  notification(clientId: number, method: string, params: unknown): void
}

export function createLeaderRoutes(host: { logger: { warn(message: string): void } }): LeaderRoutes {
  const routes = new Map<string, LeaderRoute>()
  return {
    register(method, route) {
      if (routes.has(method)) throw new Error('leader route already registered: ' + method)
      routes.set(method, route)
      return () => { if (routes.get(method) === route) routes.delete(method) }
    },
    async request(clientId, method, params) {
      const route = routes.get(method)
      if (route?.request === undefined) throw new RpcError(JSONRPC_METHOD_NOT_FOUND, 'method not found: ' + method)
      const result = route.request(clientId, params, method)
      return result instanceof Promise ? await result : result
    },
    notification(clientId, method, params) {
      const route = routes.get(method)
      // Grok drops unknown ACP notifications (server.rs:1515).
      if (route?.notification === undefined) { host.logger.warn('grok-leader: dropped notification ' + method); return }
      route.notification(clientId, params, method)
    },
  }
}

/** Methods no owner implements that the TUI still sends: each answers a
 * fixed shape (built fresh per call) or a final error, never METHOD_NOT_FOUND. */
export function registerFixedReplies(routes: Pick<LeaderRoutes, 'register'>): void {
  const replies: Record<string, RequestRoute> = {
    [WIRE.authenticate]: () => ({}),
    'x.ai/marketplace/list': () => ({ sources: [] }),
    // The extension modal always offers these tabs; an unimplemented method
    // renders as "couldn't load hooks/plugins: method not found". No config
    // is loaded in the dsh-backed leader, so answer with the empty shape.
    'x.ai/hooks/list': () => ({ hooks: [], projectTrusted: false, loadErrors: [] }),
    'x.ai/plugins/list': () => ({ plugins: [] }),
    // Legacy template catalog. Native run history is pushed via workflow_updated.
    'x.ai/workflows/list': () => ({ workflows: [] }),
    'x.ai/billing': () => ({ config: null, onDemandEnabled: false, subscriptionTier: null }),
    'x.ai/suggestPrompt': (_clientId, params) => ({ suggestion: null, generation: (params as { generation?: number } | undefined)?.generation ?? 0 }),
    // The dashboard's delete (Ctrl+X twice) still sends this. DSH has no
    // session delete, so say why instead of "method not found". An error
    // without `data` (grok's delete failures are internal errors too): the
    // TUI's toast prints the message and would append any data as JSON.
    'x.ai/session/delete': () => { throw internalError('dscode sessions cannot be deleted; DSH keeps them. Archive is not supported yet.') },
  }
  for (const [method, request] of Object.entries(replies)) routes.register(method, { request })
}

/** What the `initialize` reply reads at request time; everything else in it is fixed. */
export interface InitializeFacts {
  version: string
  /** Where this profile's tools run; a remote world tells the TUI that session paths are not host paths. */
  world: ExecutionWorld
  /** The advertised command catalog (`x.ai/commands/list` shape). */
  commands: unknown
  catalog: Pick<ModelCatalog, 'currentModelId' | 'availableModels' | 'currentProviderId' | 'providers'>
}

/** The `initialize` reply (agent-client-protocol 0.10.4 InitializeResponse
 * plus the grok `_meta` extension), built fresh per call. */
export function initializeReply(facts: InitializeFacts): unknown {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { embeddedContext: false },
      mcpCapabilities: { http: true },
      sessionCapabilities: { list: {}, close: {} },
    },
    // Advertise the api-key method so the pager's fail-closed empty-list
    // auth gate treats the leader as authenticated; the harness providers
    // own credentials, so the bridge answers authenticate with no meta.
    authMethods: [{ id: 'xai.api_key', name: 'API key' }],
    agentInfo: { name: 'deepseek-harness-grok-leader', version: facts.version },
    // cancelRewind is false: the bridge cancels turns but does not implement
    // the client-side rewind composer restore, so it stays unadvertised.
    // modelState flattens provider-scoped dsh model ids into one global
    // catalog of modelId strings (agent.rs SessionModelState); the
    // leader-side routesByModel map keeps provider ownership for
    // session/set_model.
    _meta: {
      grokShell: true,
      dscodeExecutionWorld: facts.world,
      cancelRewind: false,
      sessionRecap: false,
      // x.ai/remote/invoke: allowlisted DSH Remote methods (grok-leader-protocol.md).
      dscodeRemote: 1,
      availableCommands: facts.commands,
      modelState: {
        currentModelId: facts.catalog.currentModelId,
        availableModels: facts.catalog.availableModels,
        // SessionModelState carries only currentModelId/availableModels; the
        // provider roster and current-provider id ride in modelState._meta
        // (the ACP extension point the pager reads back as ModelState meta).
        _meta: {
          currentProviderId: facts.catalog.currentProviderId,
          providers: facts.catalog.providers,
        },
      },
    },
  }
}
