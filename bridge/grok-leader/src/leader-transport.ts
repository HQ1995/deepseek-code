/** Leader framing, registration and ACP lifetimes, independent of DSH/agents. */
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { encodeJsonFrame, FrameDecoder } from './codec.ts'
import { LEADER_PROTOCOL_VERSION, RpcError, decodeClientMessage, encodeServerMessage, type ClientMessage, type ServerMessage } from './protocol.ts'
import { internalError } from './acp.ts'

export interface LeaderClient {
  readonly clientId: number
  readonly closed: boolean
  /** Aborts on disconnect; feature work need not touch the underlying socket. */
  readonly signal: AbortSignal
  notify(method: string, params: unknown): void
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

/** Normalize direct x.ai/foo and wrapped _x.ai/foo forms (upstream method_of). */
const normalizeMethod = (method: string, params: unknown): string => {
  if (!method.startsWith('_')) return method
  const nested = params as { method?: unknown } | null | undefined
  return typeof nested?.method === 'string' ? nested.method : method.slice(1)
}

export function createLeaderTransport(options: LeaderTransportOptions) {
  const clients = new Map<number, LeaderClient>()
  const sockets = new Set<Socket>()
  let sequence = 0, closed = false, started = false, bound = false
  let failure: NodeJS.ErrnoException | undefined
  const debug = options.debug ?? process.env.DSCODE_DEBUG === '1'
  const server = createServer(accept)
  const trace = (direction: string, value: unknown, max: number): void => {
    if (debug) process.stderr.write('grok-leader wire ' + direction + ': ' + JSON.stringify(value).slice(0, max) + '\n')
  }
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
    const pending = new Map<string, { sessionId?: string; resolve(value: unknown): void; reject(error: Error): void }>()
    let registered = false, requestId = 0
    const send = (message: ServerMessage): void => {
      trace('out', message, 200)
      if (!socket.destroyed) socket.write(encodeJsonFrame(encodeServerMessage(message)))
    }
    const sendAcp = (value: unknown): void => {
      trace('out acp', value, 400)
      if (!socket.destroyed) socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(value) }))
    }
    const client: LeaderClient = {
      clientId,
      get closed() { return closed || socket.destroyed },
      signal: abort.signal,
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

    async function handleAcp(raw: string): Promise<void> {
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
        const request = pending.get(String(response.id))
        if (request === undefined) return
        pending.delete(String(response.id))
        if (response.error !== undefined) request.reject(new RpcError(response.error.code, response.error.message))
        else request.resolve(response.result)
        return
      }
      const method = normalizeMethod(message.method, message.params)
      if (message.id === undefined) {
        options.notification(clientId, method, message.params)
        return
      }
      try {
        const result = await options.request(clientId, method, message.params)
        sendAcp({ jsonrpc: '2.0', id: message.id, result })
      } catch (error) {
        const rpc = error instanceof RpcError ? error : internalError(error instanceof Error ? error.message : String(error))
        sendAcp({ jsonrpc: '2.0', id: message.id, error: { code: rpc.code, message: rpc.message } })
      }
    }

    async function handleFrame(frame: Uint8Array): Promise<void> {
      if (client.closed) return
      let value: unknown
      try { value = JSON.parse(new TextDecoder().decode(frame)) } catch {
        send({ type: 'error', code: -32700, message: 'invalid JSON frame' })
        socket.destroy(); return
      }
      let message: ClientMessage
      try { message = decodeClientMessage(value) } catch (error) {
        send({ type: 'error', code: -32600, message: error instanceof Error ? error.message : String(error) })
        socket.destroy(); return
      }
      trace('in', message, 400)
      if (!registered && message.type !== 'register') {
        send({ type: 'error', code: 1, message: 'Expected Register message' }); return
      }
      switch (message.type) {
        case 'register':
          if (registered) { send({ type: 'error', code: 2, message: 'Already registered' }); return }
          registered = true
          clients.set(clientId, client)
          options.registered(clientId)
          socket.setTimeout(0)
          send({ type: 'registered', clientId, ready: true, leaderProtocolVersion: LEADER_PROTOCOL_VERSION,
            leaderBinaryVersion: options.version,
            leaderCapabilities: { controlV1: false, workspaceExposure: false, relaunchV1: false } })
          return
        case 'ping': send({ type: 'pong' }); return
        case 'acp': await handleAcp(message.payload); return
        case 'control':
          send({ type: 'controlResult', requestId: message.requestId,
            result: { Err: { code: 'internal_error', message: 'control commands are not implemented by this leader' } } })
          return
        case 'disconnect': socket.end(); return
      }
    }

    socket.setTimeout(options.registrationTimeoutMs ?? 30_000)
    socket.on('timeout', () => {
      if (!registered) { send({ type: 'error', code: 3, message: 'Registration timeout' }); socket.destroy() }
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
      if (registered) options.disconnected(clientId)
    })
  }

  return {
    clients: clients as ReadonlyMap<number, LeaderClient>,
    get failure() { return failure },
    start() {
      if (started || closed) throw new Error('leader transport cannot be started again')
      started = true
      server.listen(options.socketPath, () => {
        bound = true
        if (closed) { server.close(); removeSocketFile(); return }
        try { chmodSync(options.socketPath, 0o600) } catch (error) {
          options.logger.warn('grok-leader: socket chmod failed: ' + String(error))
        }
      })
    },
    close() {
      if (closed) return
      closed = true
      server.close()
      for (const socket of sockets) socket.destroy()
      removeSocketFile()
    },
  }
}
