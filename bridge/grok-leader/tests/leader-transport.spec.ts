import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeJsonFrame, FrameDecoder } from '../src/codec.ts'
import { createLeaderTransport, type LeaderTransportOptions } from '../src/leader-transport.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const register = { type: 'register', client_type: 'grok-shell', mode: 'stdio', capabilities: { client_version: '1.2.3' } }

async function fixture(overrides: Partial<LeaderTransportOptions> = {}) {
  const root = mkdtempSync('/tmp/dscode-wire-'), sockets: Socket[] = []
  const options: LeaderTransportOptions = {
    socketPath: join(root, 'leader.sock'), version: '1.2.3',
    request: vi.fn(async (_client, method, params) => ({ method, params })),
    notification: vi.fn(), registered: vi.fn(), disconnected: vi.fn(), failed: vi.fn(),
    logger: { warn: vi.fn(), debug: vi.fn() }, ...overrides,
  }
  const transport = createLeaderTransport(options)
  cleanup.push(async () => {
    transport.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => setImmediate(resolve))
    rmSync(root, { recursive: true, force: true })
  })
  transport.start()
  await vi.waitFor(() => expect(existsSync(options.socketPath)).toBe(true))
  async function connect() {
    const socket = createConnection(options.socketPath), frames: Array<Record<string, unknown>> = [], decoder = new FrameDecoder()
    sockets.push(socket)
    socket.on('data', bytes => { for (const frame of decoder.push(bytes)) frames.push(JSON.parse(new TextDecoder().decode(frame))) })
    await once(socket, 'connect')
    const send = (value: unknown) => { socket.write(encodeJsonFrame(value)) }
    const acp = (value: unknown) => { send({ type: 'acp', payload: JSON.stringify(value) }) }
    const next = async () => {
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
      return frames.shift()!
    }
    const nextAcp = async () => JSON.parse(String((await next()).payload)) as Record<string, unknown>
    return { socket, frames, send, acp, next, nextAcp }
  }
  return { transport, options, connect }
}

it('owns registration, framing, ACP normalization and notification encoding without DSH', async () => {
  const f = await fixture(), c = await f.connect()
  c.send({ type: 'ping' })
  expect(await c.next()).toMatchObject({ type: 'error', code: 1 })
  c.send(register)
  expect(await c.next()).toMatchObject({ type: 'registered', client_id: 1, leader_binary_version: '1.2.3', leader_protocol_version: 1 })
  expect(statSync(f.options.socketPath).mode & 0o777).toBe(0o600)
  c.send(register)
  expect(await c.next()).toMatchObject({ type: 'error', code: 2 })
  c.acp({ id: 7, method: '_x.ai/wrapped', params: { method: 'x.ai/actual', value: 1 } })
  expect(await c.nextAcp()).toMatchObject({ id: 7, result: { method: 'x.ai/actual' } })
  c.acp({ method: '_x.ai/event', params: { value: 2 } })
  await vi.waitFor(() => expect(f.options.notification).toHaveBeenCalledWith(1, 'x.ai/event', { value: 2 }))
  const client = f.transport.clients.get(1)!
  client.notify('x.ai/status', { status: 'idle' })
  expect(await c.nextAcp()).toMatchObject({ method: '_x.ai/status' })
  client.notify('session/update', {})
  expect(await c.nextAcp()).toMatchObject({ method: 'session/update' })
})

it('marks refusals final so the TUI shows them without a retry hint', async () => {
  const { RpcError } = await import('../src/protocol.ts')
  const request = vi.fn(async (_client: number, method: string) => {
    throw method === 'refuse' ? new RpcError(-32602, '/btw needs subagents') : new Error('boom')
  })
  const f = await fixture({ request }), c = await f.connect()
  c.send(register); await c.next()
  c.acp({ id: 1, method: 'refuse', params: {} })
  expect(await c.nextAcp()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: '/btw needs subagents', data: { message: '/btw needs subagents' } } })
  c.acp({ id: 2, method: 'fail', params: {} })
  expect(await c.nextAcp()).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } })
})

it('binds the socket owner-only without ever changing the process umask', async () => {
  const root = mkdtempSync('/tmp/dscode-umask-')
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'before'), 'x')
  const umask = process.umask()
  process.umask(umask)
  // Directories other plugins create while the leader binds must stay usable.
  const concurrent = mkdtemp(join(root, 'plugin-'))
  const f = await fixture()
  expect(process.umask()).toBe(umask)
  expect(statSync(await concurrent).mode & 0o777).toBe(0o700 & ~umask)
  // The socket appears only once it is owner-only, fully bound and published.
  await f.connect()
  expect(readdirSync(dirname(f.options.socketPath)).filter(name => name.startsWith('.'))).toEqual([])
  writeFileSync(join(root, 'after'), 'x')
  expect(statSync(f.options.socketPath).mode & 0o777).toBe(0o600)
  // A umask left at 0o177 would make this file 0o600 instead of matching
  // the file created before the transport started.
  expect(statSync(join(root, 'after')).mode).toBe(statSync(join(root, 'before')).mode)
})

it('binds in place, still owner-only, when a staging name would exceed the socket path limit', async () => {
  // Deep enough that <dir>/.XXXXXX/s is too long while <dir>/l.sock still fits.
  const base = mkdtempSync('/tmp/dscode-deep-')
  cleanup.push(async () => rmSync(base, { recursive: true, force: true }))
  const limit = process.platform === 'linux' ? 107 : 103
  const dir = join(base, 'd'.repeat(limit - base.length - 1 - 8))
  mkdirSync(dir)
  const socketPath = join(dir, 'l.sock')
  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(limit)
  const umask = process.umask()
  process.umask(umask)
  const f = await fixture({ socketPath })
  expect(process.umask()).toBe(umask)
  const c = await f.connect()
  c.send(register)
  expect(await c.next()).toMatchObject({ type: 'registered' })
  expect(statSync(socketPath).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).filter(name => name.startsWith('.'))).toEqual([])
})

it('scopes reverse requests to each client and session and releases them on reply, cancellation or disconnect', async () => {
  const f = await fixture(), a = await f.connect(), b = await f.connect()
  a.send(register); await a.next(); b.send(register); await b.next()
  const first = f.transport.clients.get(1)!, second = f.transport.clients.get(2)!
  const reply = first.request<string>('ask', {}, 'session-a', Infinity)
  const ask = await a.nextAcp()
  b.acp({ id: ask.id, result: 'foreign' })
  a.acp({ id: ask.id, result: 'owned' })
  expect(await reply).toBe('owned')
  const cancelled = first.request('ask', {}, 'session-a', Infinity).catch(error => error)
  const retained = first.request('ask', {}, 'session-b', Infinity)
  await a.nextAcp(); const kept = await a.nextAcp()
  first.rejectSessionRequests('session-a')
  expect(await cancelled).toMatchObject({ code: -32603, message: 'session session-a is no longer active' })
  a.acp({ id: kept.id, result: 'still live' })
  expect(await retained).toBe('still live')
  const disconnected = second.request('ask', {}, 'session-b', Infinity).catch(error => error)
  await b.nextAcp()
  b.socket.destroy()
  expect(await disconnected).toMatchObject({ message: 'grok client disconnected' })
  expect(second.signal.aborted).toBe(true)
  expect(first.signal.aborted).toBe(false)
  expect(f.transport.clients.has(2)).toBe(false)
})

it('cancels one reverse request by signal, removes its listener and ignores late replies without cancelling siblings', async () => {
  const f = await fixture(), c = await f.connect()
  c.send(register); await c.next()
  const client = f.transport.clients.get(1)!, abort = new AbortController()
  const remove = vi.spyOn(abort.signal, 'removeEventListener')
  const cancelled = client.request('ask', {}, 's', Infinity, abort.signal).catch(error => error)
  const first = await c.nextAcp()
  const sibling = client.request('ask', {}, 's', Infinity)
  const second = await c.nextAcp()
  abort.abort()
  expect(await cancelled).toMatchObject({ code: -32603, message: 'client request cancelled' })
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  c.acp({ id: first.id, result: 'late approval' })
  c.acp({ id: second.id, result: 'sibling approval' })
  expect(await sibling).toBe('sibling approval')
  await expect(client.request('never sent', {}, 's', Infinity, abort.signal)).rejects.toThrow('cancelled')
  c.send({ type: 'ping' })
  expect(await c.next()).toEqual({ type: 'pong' })
})

it('removes reverse-request abort listeners on ordinary reply, timeout and session cancellation', async () => {
  const f = await fixture(), c = await f.connect()
  c.send(register); await c.next()
  const client = f.transport.clients.get(1)!
  for (const ending of ['reply', 'timeout', 'cancel'] as const) {
    const abort = new AbortController(), remove = vi.spyOn(abort.signal, 'removeEventListener')
    const result = client.request('ask', {}, 's', ending === 'timeout' ? 10 : Infinity, abort.signal).catch(error => error)
    const request = await c.nextAcp()
    if (ending === 'reply') c.acp({ id: request.id, result: 'answer' })
    if (ending === 'cancel') client.rejectSessionRequests('s')
    await result
    expect(remove).toHaveBeenCalledTimes(1)
    abort.abort()
    expect(remove).toHaveBeenCalledTimes(1)
  }
})

it('times out unanswered reverse requests without killing the connection', async () => {
  const f = await fixture(), c = await f.connect()
  c.send(register); await c.next()
  const client = f.transport.clients.get(1)!
  const pending = client.request('timeout', {}, 's', 10).catch(error => error)
  await c.nextAcp()
  expect(await pending).toMatchObject({ code: -32603, message: 'client did not answer timeout within 10ms' })
  c.send({ type: 'ping' })
  expect(await c.next()).toEqual({ type: 'pong' })
})

it('drops unregistered idle sockets without publishing a client lifetime', async () => {
  const f = await fixture({ registrationTimeoutMs: 20 }), unregistered = await f.connect()
  expect(await unregistered.next()).toMatchObject({ type: 'error', code: 3 })
  await vi.waitFor(() => expect(unregistered.socket.destroyed).toBe(true))
  expect(f.options.disconnected).not.toHaveBeenCalled()
})

it('closes registered and unregistered sockets when disposed', async () => {
  const f = await fixture(), registered = await f.connect()
  registered.send(register); await registered.next()
  const other = await f.connect()
  const client = [...f.transport.clients.values()][0]!
  f.transport.close(); f.transport.close()
  await vi.waitFor(() => expect(registered.socket.destroyed && other.socket.destroyed).toBe(true))
  expect(client.signal.aborted).toBe(true)
  expect(f.transport.clients.size).toBe(0)
  expect(existsSync(f.options.socketPath)).toBe(false)
  await expect(client.request('closed', {})).rejects.toThrow('disconnected')
  expect(() => f.transport.start()).toThrow('cannot be started again')
})

it('does not unlink another leader after a bind failure', async () => {
  const owner = await fixture()
  const failed = vi.fn()
  const other = createLeaderTransport({ ...owner.options, failed })
  cleanup.push(async () => { other.close() })
  other.start()
  await vi.waitFor(() => expect(failed).toHaveBeenCalled())
  expect(other.failure?.code).toBe('EADDRINUSE')
  other.close()
  expect(existsSync(owner.options.socketPath)).toBe(true)
  const c = await owner.connect()
  c.send(register)
  expect(await c.next()).toMatchObject({ type: 'registered' })
})
