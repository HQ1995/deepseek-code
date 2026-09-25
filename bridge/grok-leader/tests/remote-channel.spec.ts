/** The generic remote channel over a fake in-process gateway: default-deny
 * admission, identity binding, caps, cancellation and the result shape. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { invalidParams } from '../src/acp.ts'
import type { RemoteDescriptorLike, RemoteInvocationLike } from '../src/native-seams.ts'
import { createRemoteChannel, encodeRemoteValue, REMOTE_ALLOWLIST, type RemoteEntry } from '../src/remote-channel.ts'
import { createSessionWork } from '../src/session-work.ts'
import { tick } from './support/async.ts'

const direct = { kind: 'direct' } as const
const CANDIDATES: RemoteDescriptorLike = {
  invocation: direct, scope: { context: 'agent', wire: 'agentId' }, cancellation: { parameter: 'signal' },
  parameters: [{ wire: 'agentId', source: 'lookup', lookup: 'agent' }, { wire: 'query', source: 'json' }],
}
const DESCRIPTORS: Record<string, RemoteDescriptorLike> = {
  'sessionReferenceResolver/candidates': CANDIDATES,
  'fixture/list': { invocation: direct, parameters: [{ wire: 'filter', source: 'json' }] },
  'fixture/create': { invocation: direct, parameters: [{ wire: 'request', source: 'json' }], cancellation: { parameter: 'signal' } },
  'fixture/slow': CANDIDATES,
  'fixture/scoped': { invocation: { kind: 'context', context: 'agent', wire: 'agentId' }, parameters: [{ wire: 'text', source: 'json' }] },
}
const ALLOWLIST: RemoteEntry[] = [
  ...REMOTE_ALLOWLIST,
  { endpoint: 'fixture/list', bind: 'host', mutates: false, timeoutMs: 30 },
  { endpoint: 'fixture/create', bind: { field: 'request.sessionId' }, mutates: true, timeoutMs: 20 },
  { endpoint: 'fixture/slow', bind: 'scope', mutates: false, timeoutMs: 20 },
  { endpoint: 'fixture/scoped', bind: 'scope', mutates: false },
]
const refused = (message: string | RegExp) => expect.objectContaining({ code: -32602, message: expect.stringMatching(message) })

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
function fixture() {
  const ready = { value: true }, clients = new Map([[1, new AbortController()], [2, new AbortController()]])
  const agent = { id: SessionId('one'), session: { id: SessionId('one') } } as Agent
  const record = { clientId: 1, agent, work: createSessionWork({ isLive: () => owner === record, assertReady: () => undefined }) }
  let owner: typeof record | undefined = record
  const descriptors = new Map(Object.entries(DESCRIPTORS)), seen = new Set<string>(), configured = { gateway: true }
  const invoke = vi.fn(async (_request: RemoteInvocationLike): Promise<unknown> => [{ sessionId: 'two', mention: '@[two](dsh-session:two)' }])
  const host = {
    owned: vi.fn((clientId: number, id: SessionId | undefined) => clientId === 1 && id === 'one' ? owner : undefined),
    assertReady: vi.fn((_record: typeof record) => { if (!ready.value) throw invalidParams('session is still initializing') }),
    client: vi.fn((id: number) => clients.get(id)),
    gateway: vi.fn(() => configured.gateway ? { invoke } : undefined),
    typert: vi.fn(() => ({ local: { get: (endpoint: string) => descriptors.get(endpoint), hasSeen: (endpoint: string) => seen.has(endpoint) } })),
  }
  const channel = createRemoteChannel(host, ALLOWLIST)
  stops.push(async () => { await channel.dispose(); await record.work.dispose() })
  const call = (params: object = {}, clientId = 1) => channel.invoke(clientId,
    { sessionId: 'one', endpoint: 'sessionReferenceResolver/candidates', args: { query: 'x' }, ...params })
  const hosted = (args: object = {}, clientId = 1) => channel.invoke(clientId, { endpoint: 'fixture/list', args })
  const gate = () => {
    const pending = Promise.withResolvers<unknown>()
    invoke.mockImplementationOnce(() => pending.promise)
    return pending
  }
  return { channel, record, host, invoke, ready, clients, descriptors, seen, configured, call, hosted, gate, replace: () => { owner = { ...record } } }
}

describe('remote channel', () => {
  it('allowlists exactly the session reference candidates', () => {
    expect(REMOTE_ALLOWLIST).toEqual([{ endpoint: 'sessionReferenceResolver/candidates', bind: 'scope', mutates: false }])
  })

  it('invokes an allowlisted read with the owned agent id and answers the official result shape', async () => {
    const f = fixture()
    await expect(f.call()).resolves.toEqual({ ok: true, value: [{ sessionId: 'two', mention: '@[two](dsh-session:two)' }] })
    expect(f.invoke).toHaveBeenCalledWith({ namespace: 'sessionReferenceResolver', method: 'candidates', args: { query: 'x', agentId: 'one' }, signal: expect.any(AbortSignal) })
    // A @RemoteScope receiver binds its context wire the same way.
    await f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/scoped', args: { text: 'hi' } })
    expect(f.invoke.mock.calls[1]![0].args).toEqual({ text: 'hi', agentId: 'one' })
    f.invoke.mockResolvedValueOnce(undefined)
    await expect(f.call()).resolves.toEqual({ ok: true })
  })

  it('refuses unlisted endpoints and malformed names before the gateway', async () => {
    const f = fixture()
    await expect(f.call({ endpoint: 'pluginManager/listPlugins' })).rejects.toEqual(refused('not allowed: pluginManager/listPlugins'))
    for (const endpoint of ['sessionReferenceResolver', 'sessionReferenceResolver/candidates/x', '../candidates', 'a b/c', 7]) {
      await expect(f.call({ endpoint })).rejects.toEqual(refused('requires an endpoint <namespace>/<method>'))
    }
    await expect(f.call({ endpoint: 'sessionReferenceResolver/prepare' })).rejects.toEqual(refused('not allowed'))
    await expect(f.channel.invoke(1, null)).rejects.toEqual(refused('must be an object'))
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('refuses a foreign, missing or unready session and a session on a host entry', async () => {
    const f = fixture()
    await expect(f.call({}, 2)).rejects.toEqual(refused('unknown session: one'))
    await expect(f.call({ sessionId: undefined })).rejects.toEqual(refused('requires an owned sessionId'))
    f.ready.value = false
    await expect(f.call()).rejects.toEqual(refused('still initializing'))
    await expect(f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/list', args: {} })).rejects.toEqual(refused('takes no sessionId'))
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('refuses a client-supplied identity wherever the bridge binds one', async () => {
    const f = fixture()
    for (const args of [{ query: 'x', agentId: 'two' }, { query: 'x', sessionId: 'two' }]) {
      await expect(f.call({ args })).rejects.toEqual(refused('bound by the bridge'))
    }
    await expect(f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/create', args: { request: { sessionId: 'two' } } }))
      .rejects.toEqual(refused('args.request.sessionId is bound by the bridge'))
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('caps args at 64 KiB and 32 levels', async () => {
    const f = fixture()
    let deep: unknown = 'leaf'
    for (let level = 0; level < 33; level++) deep = { deep }
    await expect(f.hosted(deep as object)).rejects.toEqual(refused('deeper than 32'))
    await expect(f.hosted({ filter: 'x'.repeat(64 * 1024) })).rejects.toEqual(refused('exceed 64 KiB'))
    await expect(f.call({ args: [] })).rejects.toEqual(refused('args must be an object'))
    expect(f.invoke).not.toHaveBeenCalled()
    await expect(f.hosted((deep as { deep: object }).deep)).resolves.toMatchObject({ ok: true })
  })

  it('answers a read at its timeout without waiting for the native call', async () => {
    const f = fixture(), native = f.gate()
    const answer = await f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/slow', args: {} })
    expect(answer).toEqual({ ok: false, error: { code: 'gateway/cancelled', message: 'Remote invocation "fixture/slow" was aborted: timed out after 20 ms', details: {} } })
    expect(f.invoke.mock.calls[0]![0].signal!.aborted).toBe(true)
    native.resolve([])
  })

  it('waits for a mutation to finish and injects the session into its request body', async () => {
    const f = fixture(), native = f.gate()
    let settled = false
    const answer = f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/create', args: { request: { title: 'standup' } } })
    void answer.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(f.invoke.mock.calls[0]![0]).toMatchObject({ args: { request: { title: 'standup', sessionId: 'one' } } })
    expect(f.invoke.mock.calls[0]![0].signal!.aborted).toBe(true)
    expect(settled).toBe(false)
    native.resolve({ id: 'reminder' })
    await expect(answer).resolves.toEqual({ ok: true, value: { id: 'reminder' } })
    // A mutation is session input: not while the session is initializing.
    f.ready.value = false
    await expect(f.channel.invoke(1, { sessionId: 'one', endpoint: 'fixture/create', args: {} })).rejects.toEqual(refused('initializing'))
  })

  it('passes RemoteError codes through and reduces anything else to gateway/internal', async () => {
    const f = fixture()
    const busy = Object.assign(new Error('session is busy'), { isDSHRemoteError: true, code: 'session/agent-busy', details: { sessionId: 'one' } })
    f.invoke.mockRejectedValueOnce(busy)
    await expect(f.call()).resolves.toEqual({ ok: false, error: { code: 'session/agent-busy', message: 'session is busy', details: { sessionId: 'one' } } })
    f.invoke.mockRejectedValueOnce(Object.assign(new Error('secret path /x'), { code: 'EACCES', stack: 'at somewhere' }))
    await expect(f.call()).resolves.toEqual({ ok: false, error: { code: 'gateway/internal', message: 'secret path /x', details: {} } })
  })

  it('refuses binary, lossy and oversized results', async () => {
    const f = fixture()
    for (const value of [new Uint8Array(3), { nested: [Buffer.from('x')] }, new ArrayBuffer(2)]) {
      f.invoke.mockResolvedValueOnce(value)
      await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/result-invalid', message: expect.stringContaining('binary data'),
        details: { endpoint: 'sessionReferenceResolver/candidates', field: 'result' } } })
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [new Date(0), [undefined], Number.NaN, cyclic, { fn: () => 1 }]) {
      f.invoke.mockResolvedValueOnce(value)
      await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/result-invalid' } })
    }
    f.invoke.mockResolvedValueOnce(['x'.repeat(1024 * 1024)])
    await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'dscode/result-too-large', details: { limit: 1024 * 1024 } } })
    // Multi-byte text is measured in UTF-8 bytes.
    expect(encodeRemoteValue('é'.repeat(600 * 1024), 'e/p')).toMatchObject({ ok: false, error: { code: 'dscode/result-too-large' } })
    f.invoke.mockResolvedValueOnce({ kept: 1, absent: undefined, list: [null, 'a'] })
    await expect(f.call()).resolves.toEqual({ ok: true, value: { kept: 1, list: [null, 'a'] } })
  })

  it('answers unavailable without the gateway, and refuses a definition the allowlist does not match', async () => {
    const f = fixture()
    f.configured.gateway = false
    await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'dscode/remote-unavailable' } })
    f.configured.gateway = true
    f.descriptors.delete('sessionReferenceResolver/candidates')
    await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/invocation-unavailable' } })
    f.seen.add('sessionReferenceResolver/candidates')
    await expect(f.call()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/definition-unavailable' } })
    const mismatches: Array<[string, RemoteDescriptorLike]> = [
      ['sessionReferenceResolver/candidates', { ...CANDIDATES, scope: undefined }],
      ['sessionReferenceResolver/candidates', { ...CANDIDATES, mode: 'stream' }],
      ['sessionReferenceResolver/candidates', { ...CANDIDATES, parameters: [...CANDIDATES.parameters, { wire: 'job', source: 'lookup', lookup: 'job' }] }],
      ['sessionReferenceResolver/candidates', { ...CANDIDATES, parameters: [{ wire: 'agentId', source: 'lookup', lookup: 'job' }] }],
      ['fixture/list', CANDIDATES],
      ['fixture/create', { invocation: direct, parameters: [{ wire: 'request', source: 'json' }] }],
      ['fixture/create', { invocation: direct, parameters: [{ wire: 'body', source: 'json' }], cancellation: { parameter: 'signal' } }],
    ]
    for (const [endpoint, descriptor] of mismatches) {
      f.descriptors.set(endpoint, descriptor)
      const answer = await f.channel.invoke(1, { ...endpoint === 'fixture/list' ? {} : { sessionId: 'one' }, endpoint, args: {} })
      expect(answer).toMatchObject({ ok: false, error: { code: 'dscode/binding-mismatch', details: { endpoint } } })
    }
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('refuses a client arg that names any looked-up object of the definition', async () => {
    const f = fixture()
    f.descriptors.set('fixture/list', { invocation: direct, parameters: [{ wire: 'filter', source: 'json' }] })
    f.descriptors.set('sessionReferenceResolver/candidates', { ...CANDIDATES, invocation: { kind: 'context', context: 'agent', wire: 'agentId' },
      scope: undefined, parameters: [{ wire: 'query', source: 'json' }] })
    await expect(f.call({ args: { query: 'x', agentId: 'one' } })).rejects.toEqual(refused('bound by the bridge'))
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('runs 8 calls per client at once, queues 32 more in order and drops the oldest waiter past that', async () => {
    const f = fixture(), native = Promise.withResolvers<unknown>()
    f.invoke.mockImplementation(() => native.promise)
    const running = Array.from({ length: 8 }, () => f.hosted())
    const waiting = Array.from({ length: 32 }, (_, index) => f.hosted({ filter: String(index) }))
    await tick()
    expect(f.invoke).toHaveBeenCalledTimes(8)
    // Another client has its own lane.
    const other = f.hosted({}, 2)
    await tick()
    expect(f.invoke).toHaveBeenCalledTimes(9)
    const newest = f.hosted({ filter: 'newest' })
    await expect(waiting[0]).rejects.toEqual(refused('dropped: more than 32 remote calls were waiting'))
    // A read answers at its timeout but holds its slot until the native call settles.
    for (const answer of running) await expect(answer).resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(f.invoke).toHaveBeenCalledTimes(9)
    native.resolve([])
    await expect(newest).resolves.toEqual({ ok: true, value: [] })
    for (const answer of [other, ...waiting.slice(1)]) await expect(answer).resolves.toEqual({ ok: true, value: [] })
    expect(f.invoke.mock.calls.slice(9).map(([request]) => request.args.filter)).toEqual([...Array.from({ length: 31 }, (_, index) => String(index + 1)), 'newest'])
  })

  it('drops a waiting call when its client disconnects', async () => {
    const f = fixture(), native = Promise.withResolvers<unknown>()
    f.invoke.mockImplementation(() => native.promise)
    const running = Array.from({ length: 8 }, () => f.hosted())
    const waiting = f.hosted({ filter: 'late' })
    await tick()
    f.clients.get(1)!.abort()
    await expect(waiting).rejects.toEqual(refused('client disconnected'))
    native.resolve([])
    await Promise.all(running)
    expect(f.invoke).toHaveBeenCalledTimes(8)
  })

  it('aborts a host call when its client disconnects', async () => {
    const f = fixture()
    f.invoke.mockImplementationOnce(request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => { reject(new Error('aborted by caller')) })
    }))
    const answer = f.hosted()
    f.clients.get(1)!.abort()
    await expect(answer).resolves.toEqual({ ok: false, error: { code: 'gateway/cancelled', message: 'Remote invocation "fixture/list" was aborted: the client disconnected', details: {} } })
  })

  it('aborts a session call when the session closes and drains it before the close completes', async () => {
    const f = fixture(), native = f.gate()
    const answer = f.call(), rejected = expect(answer).rejects.toEqual(refused('session closed'))
    await tick()
    f.record.work.cancel()
    expect(f.invoke.mock.calls[0]![0].signal!.aborted).toBe(true)
    let drained = false
    const drain = f.record.work.settle().then(() => { drained = true })
    await tick()
    expect(drained).toBe(false)
    native.reject(new Error('aborted'))
    await rejected; await drain
  })

  it('aborts in-flight calls at shutdown, drains them and refuses new ones', async () => {
    const f = fixture()
    f.invoke.mockImplementationOnce(request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => { reject(new Error('aborted by caller')) })
    }))
    const answer = f.hosted()
    const disposal = f.channel.dispose()
    await expect(answer).resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled', message: expect.stringContaining('the leader is shutting down') } })
    await disposal
    expect(f.channel.dispose()).toBe(disposal)
    await expect(f.hosted()).rejects.toThrow('disposed')
  })

  it('rejects an allowlist entry it cannot enforce', () => {
    const f = fixture()
    for (const entry of [{ endpoint: 'one-segment', bind: 'host', mutates: false }, { endpoint: 'a/b/c', bind: 'host', mutates: false },
      { endpoint: 'a/b', bind: 'host', mutates: false, timeoutMs: 60_001 }, { endpoint: 'a/b', bind: { field: 'request..id' }, mutates: true }] as RemoteEntry[]) {
      expect(() => createRemoteChannel(f.host, [entry])).toThrow('invalid remote allowlist entry')
    }
    expect(() => createRemoteChannel(f.host, [...REMOTE_ALLOWLIST, ...REMOTE_ALLOWLIST])).toThrow('invalid remote allowlist entry')
  })
})
