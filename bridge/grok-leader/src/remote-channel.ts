/** The generic remote channel. `x.ai/remote/invoke {sessionId?, endpoint,
 * args}` runs one allowlisted DSH Remote method (`endpoint` is its
 * `<namespace>/<method>`) through the in-process Typert gateway, as the
 * operator (no HTTP server), and answers the official result shape
 * `{ok: true, value?} | {ok: false, error: {code, message, details}}`. The
 * endpoint is one field because the leader wire reads a top-level `method`
 * param of an `_x.ai/*` request as the wrapped method name.
 *
 * Default deny: REMOTE_ALLOWLIST, in this source, is the only grant, and a
 * client cannot widen it. A session-bound entry needs an owned, ready session,
 * runs in that session's work scope (close and reload abort and drain it) and
 * gets the owned id where its generated definition binds an identity; a
 * client-supplied identity is refused. Bridge refusals stay JSON-RPC -32602;
 * what the gateway or the method answers comes back in the result. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { errorMessage, isRecord } from './guards.ts'
import type { RemoteDescriptorLike, TypertGatewayLike, TypertRegistryLike } from './native-seams.ts'
import type { SessionOperation, SessionWork } from './session-work.ts'

/** Where an entry's session identity goes: the lookup or `@RemoteScope` wire
 * its generated definition binds ('scope'), nowhere ('host'), or a dotted path
 * inside `args` for a method that carries the session in its request body. */
export type RemoteBinding = 'scope' | 'host' | { readonly field: string }
export interface RemoteEntry {
  /** `<namespace>/<method>`, as the generated definition exports it. */
  readonly endpoint: string
  readonly bind: RemoteBinding
  /** A mutation runs as session input, must accept a cancellation signal and
   * is awaited to its real completion; a read may answer at its timeout. */
  readonly mutates: boolean
  /** Defaults to 10 s; at most 60 s. */
  readonly timeoutMs?: number
}

/** Every Remote method the TUI may call. Methods stay out when the bridge
 * applies its own policy around the same capability (preset selection,
 * commands, plugin management, code runners) or when they read across
 * sessions (the schedule catalog). v1 binds root sessions only. */
export const REMOTE_ALLOWLIST: readonly RemoteEntry[] = Object.freeze([
  // The `@` reference picker: other sessions, ranked by workspace affinity.
  Object.freeze({ endpoint: 'sessionReferenceResolver/candidates', bind: 'scope', mutates: false } as const),
])

export const REMOTE_LIMITS = {
  argsBytes: 64 * 1024, argsDepth: 32, resultBytes: 1024 * 1024, timeoutMs: 10_000, maxTimeoutMs: 60_000, inFlight: 8, queued: 32,
} as const

export type RemoteResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

const METHOD = 'x.ai/remote/invoke'
/** The lookup wires a session binds through; the bridge alone fills them. */
const IDENTITY_WIRES = ['agentId', 'sessionId']
const segment = (value: unknown): value is string =>
  typeof value === 'string' && value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
const failure = (code: string, message: string, details: object = {}): RemoteResult => ({ ok: false, error: { code, message, details } })
const TOO_LARGE = 'too-large', BINARY = 'binary'

/** Why a value does not cross the leader wire unchanged as JSON, if it does
 * not. An `undefined` field is absent on the wire, as in DSH's `/api`. */
function jsonProblem(value: unknown, limit: number): string | undefined {
  let bytes = 0
  const ancestors = new Set<object>()
  const visit = (item: unknown, inArray: boolean): string | undefined => {
    if (bytes > limit) return TOO_LARGE
    if (item === null || typeof item === 'boolean') { bytes += 5; return undefined }
    if (typeof item === 'string') { bytes += item.length + 2; return undefined }
    if (typeof item === 'number') { bytes += 1; return Number.isFinite(item) ? undefined : 'a non-finite number' }
    if (item === undefined) return inArray ? 'undefined in an array' : undefined
    if (typeof item !== 'object') return 'a ' + typeof item
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item instanceof SharedArrayBuffer || item instanceof Blob) return BINARY
    if (ancestors.has(item)) return 'a cycle'
    const prototype: unknown = Object.getPrototypeOf(item)
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return 'a ' + String((item as { constructor?: { name?: unknown } }).constructor?.name ?? 'class') + ' instance'
    }
    ancestors.add(item)
    // Array.from visits holes too, as undefined.
    const entries: Array<[string, unknown]> = Array.isArray(item) ? Array.from(item, (element: unknown, index) => [String(index), element]) : Object.entries(item)
    for (const [key, child] of entries) {
      bytes += Array.isArray(item) ? 1 : key.length + 3
      const problem = visit(child, Array.isArray(item))
      if (problem !== undefined) return problem
    }
    ancestors.delete(item)
    return undefined
  }
  return visit(value, false)
}

/** A business value as the result's success branch, or why it cannot be one. */
export function encodeRemoteValue(value: unknown, endpoint: string, limit: number = REMOTE_LIMITS.resultBytes): RemoteResult {
  if (value === undefined) return { ok: true }
  const tooLarge = () => failure('dscode/result-too-large', `${endpoint} answered more than ${String(limit)} bytes of JSON`, { endpoint, limit })
  const problem = jsonProblem(value, limit)
  if (problem === TOO_LARGE) return tooLarge()
  if (problem !== undefined) {
    return failure('gateway/result-invalid', `${endpoint} answered ${problem === BINARY ? 'binary data' : problem}, which the leader wire carries only as JSON`,
      { endpoint, field: 'result' })
  }
  const text = JSON.stringify(value)
  return Buffer.byteLength(text) > limit ? tooLarge() : { ok: true, value: JSON.parse(text) as unknown }
}

/** A thrown value as the result's error branch: a RemoteError, known by its
 * structural `isDSHRemoteError` marker, keeps its code and JSON details;
 * anything else is `gateway/internal` with its message only. */
export function remoteFailure(error: unknown): RemoteResult {
  if (isRecord(error) && error.isDSHRemoteError === true && typeof error.code === 'string') {
    const details = isRecord(error.details) && jsonProblem(error.details, REMOTE_LIMITS.argsBytes) === undefined
      ? JSON.parse(JSON.stringify(error.details)) as object : {}
    return failure(error.code, typeof error.message === 'string' ? error.message : error.code, details)
  }
  return failure('gateway/internal', errorMessage(error))
}

/** Client args: a JSON object within the depth and size caps, naming no identity. */
function clientArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidParams(METHOD + ' args must be an object')
  const depth = (item: unknown, level: number): void => {
    if (typeof item !== 'object' || item === null) return
    if (level > REMOTE_LIMITS.argsDepth) throw invalidParams(`remote args nest deeper than ${String(REMOTE_LIMITS.argsDepth)} levels`)
    for (const child of Object.values(item)) depth(child, level + 1)
  }
  depth(value, 1)
  if (Buffer.byteLength(JSON.stringify(value)) > REMOTE_LIMITS.argsBytes) throw invalidParams('remote args exceed 64 KiB')
  for (const wire of IDENTITY_WIRES) if (Object.hasOwn(value, wire)) throw invalidParams(`args.${wire} is bound by the bridge, not the client`)
  return value
}

interface Binding { wire?: string; field?: readonly string[]; identity?: 'agent' | 'session' }

/** Where this entry puts the owned identity, checked against the generated
 * definition; a string says why the two disagree. */
function bindingOf(entry: RemoteEntry, descriptor: RemoteDescriptorLike): Binding | string {
  if (descriptor.mode !== undefined) return 'it is a stream method'
  if (entry.mutates && descriptor.cancellation === undefined) return 'a mutation must accept a cancellation signal'
  const lookups = descriptor.parameters.filter(parameter => parameter.source === 'lookup')
  const context = descriptor.invocation.kind === 'context' ? descriptor.invocation : undefined
  if (entry.bind === 'scope') {
    const wire = descriptor.scope?.wire ?? context?.wire
    if (wire === undefined) return 'it binds no session scope'
    if (lookups.length + (context === undefined ? 0 : 1) !== 1) return 'it looks up more than the session'
    const key = context?.wire === wire ? context.context : lookups.find(parameter => parameter.wire === wire)?.lookup
    return key === 'agent' || key === 'session' ? { wire, identity: key } : `its ${wire} is no agent or session identity`
  }
  if (lookups.length > 0 || context !== undefined || descriptor.scope !== undefined) return 'it looks up a Host object'
  if (entry.bind === 'host') return {}
  const field = entry.bind.field.split('.')
  return descriptor.parameters.some(parameter => parameter.wire === field[0] && parameter.source === 'json')
    ? { field, identity: 'session' } : `it has no ${String(field[0])} argument`
}

/** The wire args: the client's, with the owned identity where the binding puts it. */
function boundArgs(args: Record<string, unknown>, binding: Binding, agent: Agent | undefined): Record<string, unknown> {
  if (binding.identity === undefined || agent === undefined) return args
  const id = binding.identity === 'agent' ? agent.id : agent.session.id
  if (binding.wire !== undefined) return { ...args, [binding.wire]: id }
  const path = binding.field!, root: Record<string, unknown> = { ...args }
  let parent = root
  for (const [index, key] of path.entries()) {
    const last = index === path.length - 1, current = parent[key]
    if (last) {
      if (current !== undefined) throw invalidParams(`args.${path.join('.')} is bound by the bridge, not the client`)
      parent[key] = id
    } else {
      if (current !== undefined && !isRecord(current)) throw invalidParams(`args.${path.slice(0, index + 1).join('.')} must be an object`)
      parent = parent[key] = { ...current }
    }
  }
  return root
}

function checkAllowlist(allowlist: readonly RemoteEntry[]): Map<string, RemoteEntry> {
  const entries = new Map<string, RemoteEntry>()
  for (const entry of allowlist) {
    const [ns, method, extra] = entry.endpoint.split('/')
    const timeout = entry.timeoutMs ?? REMOTE_LIMITS.timeoutMs
    if (!segment(ns) || !segment(method) || extra !== undefined || entries.has(entry.endpoint)
      || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > REMOTE_LIMITS.maxTimeoutMs
      || (typeof entry.bind === 'object' && entry.bind.field.split('.').some(key => key === ''))) {
      throw new Error('invalid remote allowlist entry: ' + JSON.stringify(entry))
    }
    entries.set(entry.endpoint, entry)
  }
  return entries
}

/** Per-client admission: at most `inFlight` calls run at once and `queued`
 * more wait in order. Past that the oldest waiter is dropped: a type-ahead
 * client has moved on from it, and the newest call is the one it needs. */
function createLanes(shutdown: AbortSignal) {
  interface Waiter { start(): void; drop(error: unknown): void }
  const lanes = new Map<number, { running: number; waiting: Waiter[] }>()
  /** Resolves with the slot's release once the call may run. */
  return (clientId: number, client: AbortSignal): Promise<() => void> => {
    const lane = lanes.get(clientId) ?? { running: 0, waiting: [] }
    lanes.set(clientId, lane)
    const release = () => {
      lane.running--
      const next = lane.waiting.shift()
      if (next !== undefined) next.start()
      else if (lane.running === 0 && lanes.get(clientId) === lane) lanes.delete(clientId)
    }
    if (lane.running < REMOTE_LIMITS.inFlight) { lane.running++; return Promise.resolve(release) }
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.any([client, shutdown])
      const abandon = () => {
        const index = lane.waiting.indexOf(waiter)
        if (index >= 0) lane.waiting.splice(index, 1)
        waiter.drop(shutdown.aborted ? internalError('the remote channel has been disposed') : invalidParams('client disconnected'))
      }
      const waiter: Waiter = {
        start: () => { signal.removeEventListener('abort', abandon); lane.running++; resolve(release) },
        drop: error => { signal.removeEventListener('abort', abandon); reject(error) },
      }
      lane.waiting.push(waiter)
      signal.addEventListener('abort', abandon, { once: true })
      if (signal.aborted) abandon()
      else if (lane.waiting.length > REMOTE_LIMITS.queued) {
        lane.waiting.shift()!.drop(invalidParams(`dropped: more than ${String(REMOTE_LIMITS.queued)} remote calls were waiting; the newest are kept`))
      }
    })
  }
}

interface RemoteSession { agent: Agent; clientId: number; work: Pick<SessionWork, 'read' | 'run'> }
export interface RemoteChannelHost<S extends RemoteSession> {
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  /** Full input readiness: initialized and not reloading. */
  assertReady(record: S): void
  client(clientId: number): { readonly signal: AbortSignal } | undefined
  gateway(): TypertGatewayLike | undefined
  typert(): TypertRegistryLike | undefined
}
interface Request<S> {
  entry: RemoteEntry; namespace: string; method: string; args: Record<string, unknown>
  client: { readonly signal: AbortSignal }; record?: S
  /** The native call, settled or not: it holds the client's slot until it settles. */
  native?: Promise<unknown>
}
type Outcome = { value: unknown } | { error: unknown } | { timedOut: true }

/** `x.ai/remote/invoke` over DSH's in-process gateway; see the module comment. */
export function createRemoteChannel<S extends RemoteSession>(host: RemoteChannelHost<S>, allowlist: readonly RemoteEntry[] = REMOTE_ALLOWLIST) {
  const allowed = checkAllowlist(allowlist)
  const pending = new Set<Promise<unknown>>(), shutdown = new AbortController(), acquire = createLanes(shutdown.signal)
  let closed = false, disposal: Promise<void> | undefined

  const admit = (clientId: number, params: unknown): Request<S> => {
    const p = paramRecord(params, METHOD)
    const [namespace, method, extra] = typeof p.endpoint === 'string' ? p.endpoint.split('/') : []
    if (!segment(namespace) || !segment(method) || extra !== undefined) throw invalidParams(METHOD + ' requires an endpoint <namespace>/<method>')
    const endpoint = namespace + '/' + method, entry = allowed.get(endpoint)
    if (entry === undefined) throw invalidParams('remote endpoint is not allowed: ' + endpoint)
    const args = clientArgs(p.args ?? {}), client = host.client(clientId)
    if (client === undefined) throw invalidParams('client disconnected')
    const request: Request<S> = { entry, namespace, method, args, client }
    if (entry.bind === 'host') {
      if (p.sessionId !== undefined) throw invalidParams(endpoint + ' takes no sessionId')
      return request
    }
    if (typeof p.sessionId !== 'string' || p.sessionId === '') throw invalidParams(endpoint + ' requires an owned sessionId')
    const record = host.owned(clientId, sessionIdParam(p.sessionId))
    if (record === undefined) throw invalidParams('unknown session: ' + p.sessionId)
    host.assertReady(record)
    return { ...request, record }
  }

  const call = async (request: Request<S>, signals: AbortSignal[], scope?: SessionOperation): Promise<RemoteResult> => {
    const { entry } = request, endpoint = entry.endpoint
    const gateway = host.gateway(), typert = host.typert()
    scope?.assertActive()
    if (gateway === undefined || typert === undefined) return failure('dscode/remote-unavailable', 'DSH\'s Remote gateway is not running; run /doctor', { endpoint })
    const descriptor = typert.local.get(endpoint)
    if (descriptor === undefined) {
      return typert.local.hasSeen(endpoint)
        ? failure('gateway/definition-unavailable', endpoint + ': its strict definition was withdrawn', { endpoint })
        : failure('gateway/invocation-unavailable', endpoint + ': no active plugin exports this Remote method', { endpoint })
    }
    const binding = bindingOf(entry, descriptor)
    if (typeof binding === 'string') return failure('dscode/binding-mismatch', `${endpoint} cannot be bound as allowlisted: ${binding}`, { endpoint })
    const lookups = descriptor.parameters.filter(parameter => parameter.source === 'lookup').map(parameter => parameter.wire)
    if (descriptor.invocation.kind === 'context') lookups.push(descriptor.invocation.wire)
    for (const wire of lookups) if (Object.hasOwn(request.args, wire)) throw invalidParams(`args.${wire} is bound by the bridge, not the client`)
    const args = boundArgs(request.args, binding, request.record?.agent)
    const timeoutMs = entry.timeoutMs ?? REMOTE_LIMITS.timeoutMs, timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([...signals, shutdown.signal, timeout])
    const cancelled = () => failure('gateway/cancelled', `Remote invocation "${endpoint}" was aborted: ` + (timeout.aborted ? `timed out after ${String(timeoutMs)} ms`
      : shutdown.signal.aborted ? 'the leader is shutting down' : request.client.signal.aborted ? 'the client disconnected' : 'the session closed'))
    if (signal.aborted) return cancelled()
    const native = new Promise<unknown>(resolve => { resolve(gateway.invoke({ namespace: request.namespace, method: request.method, args, signal })) })
      .then((value): Outcome => ({ value }), (error: unknown): Outcome => ({ error }))
    request.native = native
    // A read may answer at its timeout; a mutation waits for the native call.
    const timedOut = new Promise<Outcome>(resolve => {
      const stop = () => { resolve({ timedOut: true }) }
      timeout.addEventListener('abort', stop, { once: true })
      void native.then(() => { timeout.removeEventListener('abort', stop) })
    })
    const outcome = entry.mutates ? await native : await Promise.race([native, timedOut])
    if ('value' in outcome) return encodeRemoteValue(outcome.value, endpoint)
    return 'error' in outcome && !signal.aborted ? remoteFailure(outcome.error) : cancelled()
  }

  const run = (request: Request<S>): Promise<RemoteResult> => {
    const record = request.record
    if (record === undefined) return call(request, [request.client.signal])
    const work = request.entry.mutates ? record.work.run : record.work.read
    return work(scope => call(request, [scope.signal, request.client.signal], scope))
  }

  return {
    invoke(clientId: number, params: unknown): Promise<RemoteResult> {
      if (closed) return Promise.reject(internalError('the remote channel has been disposed'))
      let request: Request<S>
      try { request = admit(clientId, params) } catch (error) { return Promise.reject(error) }
      const result = acquire(clientId, request.client.signal).then(release => {
        let answer: Promise<RemoteResult>
        try { answer = run(request) } catch (error) { answer = Promise.reject(error) }
        // A read that answered at its timeout keeps its slot until the native call settles.
        void answer.then(() => request.native, () => request.native).then(release)
        return answer
      })
      // Shutdown drains the replies.
      pending.add(result)
      void result.then(() => { pending.delete(result) }, () => { pending.delete(result) })
      return result
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => { while (pending.size > 0) await Promise.allSettled([...pending]) })
      shutdown.abort()
      return disposal
    },
  }
}

export type RemoteChannel = ReturnType<typeof createRemoteChannel>
