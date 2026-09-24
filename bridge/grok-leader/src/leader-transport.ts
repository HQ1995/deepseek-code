/** Leader framing, registration and ACP lifetimes, independent of DSH/agents. */
import { chmodSync, linkSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, join, sep } from 'node:path'
import { writeJsonFrame, waitForDrain, FrameDecoder } from './codec.ts'
import { LEADER_PROTOCOL_VERSION, RpcError, decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from './protocol.ts'
import { JSONRPC_INVALID_PARAMS, internalError } from './acp.ts'
import { errorMessage } from './guards.ts'

export interface LeaderClient {
  readonly clientId: number
  readonly closed: boolean
  /** Aborts on disconnect; feature work need not touch the underlying socket. */
  readonly signal: AbortSignal
  notify(method: string, params: unknown): void
  /** Wait only when the socket is backpressured; no socket leaks to features. */
  drain?(): Promise<void> | undefined
  request<T>(method: string, params: unknown, sessionId?: string, timeoutMs?: number, signal?: AbortSignal): Promise<T>
  rejectSessionRequests(sessionId: string): void
}

export interface LeaderTransportOptions {
  socketPath: string
  version: string
  request(clientId: number, method: string, params: unknown): Promise<unknown>
  notification(clientId: number, method: string, params: unknown): void
  registered(clientId: number): void
  disconnected(clientId: number): void
  failed(error: NodeJS.ErrnoException): void
  logger: { warn(message: string): void; debug(message: string): void }
  debug?: boolean
  registrationTimeoutMs?: number
}

/** Longest Unix socket path the kernel accepts (sun_path less its NUL). */
const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103

/** Normalize direct x.ai/foo and wrapped _x.ai/foo forms (upstream method_of). */
const normalizeMethod = (method: string, params: unknown): string => {
  if (!method.startsWith('_')) return method
  const nested = params as { method?: unknown } | null | undefined
  return typeof nested?.method === 'string' ? nested.method : method.slice(1)
}

interface PendingRequest { sessionId?: string; resolve(value: unknown): void; reject(error: Error): void }

/** One accepted socket. `registered` is shared and mutable: the frame handler
 * sets it, the socket's timeout and close handlers read it. */
interface Connection {
  readonly clientId: number
  readonly socket: Socket
  readonly client: LeaderClient
  readonly pending: Map<string, PendingRequest>
  registered: boolean
  send(message: ServerMessage): void
  sendAcp(value: unknown): void
}

/** What every connection's frame handler shares with its transport. */
interface TransportEnv {
  readonly options: LeaderTransportOptions
  readonly clients: Map<number, LeaderClient>
  readonly textDecoder: InstanceType<typeof TextDecoder>
  trace(direction: string, value: unknown, max: number): void
}

/** The feature-facing handle of one socket. `isClosed` reads the transport's
 * live closed flag; reverse requests are numbered per client. */
function leaderClient(clientId: number, socket: Socket, disconnected: AbortSignal, pending: Map<string, PendingRequest>,
  isClosed: () => boolean, sendAcp: (value: unknown) => void): LeaderClient {
  let requestId = 0
  const client: LeaderClient = {
    clientId,
    get closed() { return isClosed() || socket.destroyed },
    signal: disconnected,
    drain: () => socket.writableNeedDrain ? waitForDrain(socket) : undefined,
    notify(method, params) {
      // ACP extensions require the '_' prefix; session/update is typed.
      const wire = method === 'session/update' || method.startsWith('_') ? method : '_' + method
      sendAcp({ jsonrpc: '2.0', method: wire, params })
    },
    request<T>(method: string, params: unknown, sessionId?: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
      if (client.closed) return Promise.reject(new Error('grok client disconnected'))
      if (signal?.aborted) return Promise.reject(internalError('client request cancelled'))
      const id = requestId++
      return new Promise<T>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          pending.delete(String(id))
        }
        const cancel = () => { clean(); reject(internalError('client request cancelled')) }
        const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
          clean()
          reject(internalError('client did not answer ' + method + ' within ' + timeoutMs + 'ms'))
        }, timeoutMs) : undefined
        pending.set(String(id), {
          sessionId,
          resolve(value) { clean(); resolve(value as T) },
          reject(error) { clean(); reject(error) },
        })
        signal?.addEventListener('abort', cancel, { once: true })
        try { sendAcp({ jsonrpc: '2.0', id, method, params }) }
        catch (error) { clean(); reject(error) }
      })
    },
    rejectSessionRequests(sessionId) {
      for (const [id, request] of pending) {
        if (request.sessionId !== sessionId) continue
        pending.delete(id)
        request.reject(internalError('session ' + sessionId + ' is no longer active'))
      }
    },
  }
  return client
}

/** One ACP payload: a reply to a reverse request, a notification, or a request
 * answered with its result or a JSON-RPC error. */
async function handleAcp(conn: Connection, env: TransportEnv, raw: string): Promise<void> {
  const { options } = env
  let value: unknown
  try { value = JSON.parse(raw.trimEnd()) } catch (error) {
    options.logger.warn('grok-leader: dropping unparseable acp payload: ' + String(error))
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    options.logger.warn('grok-leader: dropping non-object acp payload')
    return
  }
  const message = value as Record<string, unknown>
  if (typeof message.method !== 'string') {
    const response = message as { id?: unknown; result?: unknown; error?: { code: number; message: string } }
    const request = conn.pending.get(String(response.id))
    if (request === undefined) return
    conn.pending.delete(String(response.id))
    if (response.error !== undefined) request.reject(new RpcError(response.error.code, response.error.message))
    else request.resolve(response.result)
    return
  }
  const method = normalizeMethod(message.method, message.params)
  if (message.id === undefined) {
    options.notification(conn.clientId, method, message.params)
    return
  }
  try {
    const result = await options.request(conn.clientId, method, message.params)
    conn.sendAcp({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    const rpc = error instanceof RpcError ? error : internalError(errorMessage(error))
    // A refusal is final: `data.message` lets the TUI show it as is, not as a retryable failure.
    conn.sendAcp({ jsonrpc: '2.0', id: message.id, error: { code: rpc.code, message: rpc.message,
      ...rpc.code === JSONRPC_INVALID_PARAMS ? { data: { message: rpc.message } } : {} } })
  }
}

/** The handshake and frame loop of one connection: registration first, then
 * ping, ACP, control and disconnect frames. */
function frameHandler(conn: Connection, env: TransportEnv): (frame: Uint8Array) => Promise<void> {
  const { options, clients } = env
  const { clientId, socket, client, send } = conn
  return async (frame: Uint8Array): Promise<void> => {
    if (client.closed) return
    let value: unknown
    try { value = JSON.parse(env.textDecoder.decode(frame)) } catch {
      send({ type: 'error', code: -32700, message: 'invalid JSON frame' })
      socket.destroy(); return
    }
    let message: ClientMessage
    try { message = decodeClientMessage(value) } catch (error) {
      send({ type: 'error', code: -32600, message: errorMessage(error) })
      socket.destroy(); return
    }
    env.trace('in', message, 400)
    if (!conn.registered && message.type !== 'register') {
      send({ type: 'error', code: 1, message: 'Expected Register message' }); return
    }
    switch (message.type) {
      case 'register':
        if (conn.registered) { send({ type: 'error', code: 2, message: 'Already registered' }); return }
        conn.registered = true
        clients.set(clientId, client)
        options.registered(clientId)
        socket.setTimeout(0)
        send({ type: 'registered', clientId, ready: true, leaderProtocolVersion: LEADER_PROTOCOL_VERSION,
          leaderBinaryVersion: options.version,
          leaderCapabilities: { controlV1: false, workspaceExposure: false, relaunchV1: false } })
        return
      case 'ping': send({ type: 'pong' }); return
      case 'acp': await handleAcp(conn, env, message.payload); return
      case 'control':
        send({ type: 'controlResult', requestId: message.requestId,
          result: { Err: { code: 'internal_error', message: 'control commands are not implemented by this leader' } } })
        return
      case 'disconnect': socket.end(); return
    }
  }
}

export function createLeaderTransport(options: LeaderTransportOptions) {
  const textDecoder = new TextDecoder()
  const clients = new Map<number, LeaderClient>()
  const sockets = new Set<Socket>()
  let sequence = 0, closed = false, started = false, bound = false
  let failure: NodeJS.ErrnoException | undefined
  // Removes the private bind directory; start() installs the real closure,
  // close() calls it in case the listen callback never fires.
  let discardStaging: () => void = () => {}
  const debug = options.debug ?? process.env.DSCODE_DEBUG === '1'
  const server = createServer(accept)
  const trace = (direction: string, value: unknown, max: number): void => {
    if (debug) process.stderr.write('grok-leader wire ' + direction + ': ' + JSON.stringify(value).slice(0, max) + '\n')
  }
  const env: TransportEnv = { options, clients, textDecoder, trace }
  const removeSocketFile = (): void => {
    if (!bound) return // Never remove another leader's path after EADDRINUSE.
    bound = false
    try { unlinkSync(options.socketPath) } catch { /* Already removed by node. */ }
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    failure = error
    process.stderr.write('grok-leader: socket error: ' + String(error) + '\n')
    options.logger.warn('grok-leader: socket error: ' + String(error))
    options.failed(error)
  })

  function accept(socket: Socket): void {
    if (closed) { socket.destroy(); return }
    sockets.add(socket)
    const clientId = ++sequence, abort = new AbortController(), decoder = new FrameDecoder()
    const pending = new Map<string, PendingRequest>()
    const send = (message: ServerMessage): void => {
      trace('out', message, 200)
      if (!socket.destroyed) writeJsonFrame(socket, encodeServerMessage(message))
    }
    const sendAcp = (value: unknown): void => {
      trace('out acp', value, 400)
      if (!socket.destroyed) writeJsonFrame(socket, { type: 'acp', payload: JSON.stringify(value) })
    }
    const conn: Connection = { clientId, socket, pending, registered: false, send, sendAcp,
      client: leaderClient(clientId, socket, abort.signal, pending, () => closed, sendAcp) }
    const handleFrame = frameHandler(conn, env)

    socket.setTimeout(options.registrationTimeoutMs ?? 30_000)
    socket.on('timeout', () => {
      if (!conn.registered) { send({ type: 'error', code: 3, message: 'Registration timeout' }); socket.destroy() }
    })
    socket.on('error', error => { options.logger.debug('grok-leader: socket error: ' + String(error)) })
    socket.on('data', chunk => {
      let frames: Uint8Array[]
      try { frames = decoder.push(chunk) } catch (error) {
        options.logger.warn('grok-leader: frame decode failed: ' + String(error)); socket.destroy(); return
      }
      for (const frame of frames) void handleFrame(frame).catch(error => {
        process.stderr.write('grok-leader: message handler failed: ' + String(error) + '\n')
        options.logger.warn('grok-leader: message handler failed: ' + String(error))
      })
    })
    socket.on('close', () => {
      sockets.delete(socket)
      clients.delete(clientId)
      abort.abort()
      for (const request of pending.values()) request.reject(new Error('grok client disconnected'))
      pending.clear()
      if (conn.registered) options.disconnected(clientId)
    })
  }

  return {
    clients: clients as ReadonlyMap<number, LeaderClient>,
    get failure() { return failure },
    start() {
      if (started || closed) throw new Error('leader transport cannot be started again')
      started = true
      // Never change the process umask: plugins create files and directories
      // concurrently at boot, and a umask held across the asynchronous listen
      // made their directories unsearchable (the SSH adapter's control
      // directory). Bind in a private directory beside the socket path,
      // restrict the socket, then publish it by hard link: it is never
      // reachable before it is owner-only, and the link fails like a bind when
      // another leader owns the path, whose socket is never removed. A pipe
      // binds and listens synchronously inside listen(), so all of this
      // happens in this turn, before any client can connect.
      let staging: string
      // Concatenated, not joined: join() would normalize the trailing '.' away.
      try { staging = mkdtempSync(dirname(options.socketPath) + sep + '.') } catch (error) {
        queueMicrotask(() => server.emit('error', error))
        return
      }
      let discarded = false
      discardStaging = () => {
        if (discarded) return
        discarded = true
        rmSync(staging, { recursive: true, force: true })
      }
      const staged = join(staging, 's')
      const onListening = () => { if (closed) { server.close(); removeSocketFile() } }
      if (Buffer.byteLength(staged) > MAX_SOCKET_PATH) {
        // No room for a staging name (Node 22 would silently truncate it):
        // bind in place. The node takes the umask at bind, which happens
        // synchronously inside listen(), so an owner-only umask held for just
        // that call leaves no connectable window and ends before any other
        // JavaScript runs.
        discardStaging()
        const previousUmask = process.umask(0o177)
        try { server.listen(options.socketPath, onListening) } finally { process.umask(previousUmask) }
        if (!server.listening) return
        bound = true
        try { chmodSync(options.socketPath, 0o600) } catch (error) {
          options.logger.warn('grok-leader: socket chmod failed: ' + String(error))
        }
        return
      }
      server.once('error', discardStaging)
      server.listen(staged, onListening)
      // A failed bind is reported by the 'error' event, which also discards staging.
      if (!server.listening) return
      try {
        chmodSync(staged, 0o600)
        linkSync(staged, options.socketPath)
      } catch (error) {
        const cause = error as NodeJS.ErrnoException
        server.off('error', discardStaging)
        discardStaging()
        server.close()
        const reported = cause.code !== 'EEXIST' ? cause
          : Object.assign(new Error('listen EADDRINUSE: address already in use ' + options.socketPath), { code: 'EADDRINUSE', errno: cause.errno, syscall: 'listen', address: options.socketPath })
        queueMicrotask(() => server.emit('error', reported))
        return
      }
      bound = true
      // The listening socket keeps its inode; only the staging name goes.
      server.off('error', discardStaging)
      discardStaging()
    },
    close() {
      if (closed) return
      closed = true
      discardStaging()
      server.close()
      for (const socket of sockets) socket.destroy()
      removeSocketFile()
    },
  }
}
