/** x.ai/remote/invoke end to end: the leader socket, DSH's real Typert
 * registry and in-process gateway, and a fixture behind the pinned runtime's
 * generated `sessionReferenceResolver/candidates` definition. */
import { describe, expect, it, vi } from 'vitest'
import { collectIds, makeClient, register, sendRequest, useLeaderHarness, waitFor, type ClientHandle } from './support/leader-harness.ts'

const CANDIDATE = { sessionId: 'other', label: 'Other', displayTitle: 'Other', sameWorkspace: true, createdAt: 1, mention: '@[Other](dsh-session:other)' }
// The TUI sends the ACP extension form `_x.ai/remote/invoke`, whose top-level
// `method` param the leader wire would read as the wrapped method name.
const INVOKE = '_x.ai/remote/invoke', ENDPOINT = 'sessionReferenceResolver/candidates'
const invoke = (c: ClientHandle, id: number, sessionId: string, args: object = { query: '' }, endpoint = ENDPOINT) =>
  c.request(id, INVOKE, { sessionId, endpoint, args })
const open = async (c: ClientHandle, id: number): Promise<string> =>
  ((await c.request(id, 'session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string }).sessionId

describe('remote channel over the real Typert gateway', () => {
  const start = useLeaderHarness()

  it('advertises the channel and answers candidates for the owned session through the real definition', async () => {
    const { client: c, remote, registry } = await start({ remote: true })
    register(c); await c.next()
    const initialize = await c.request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(initialize.result).toMatchObject({ _meta: { dscodeRemote: 1 } })
    const sessionId = await open(c, 1)
    remote!.answer = async () => [CANDIDATE]
    expect((await invoke(c, 2, sessionId, { query: 'oth' })).result).toEqual({ ok: true, value: [CANDIDATE] })
    expect(remote!.calls).toEqual([{ agent: registry.byId.get(sessionId), query: 'oth', signal: expect.any(AbortSignal) }])
    // The gateway itself validates the exact wire fields of the definition.
    expect((await invoke(c, 3, sessionId, { query: 'oth', extra: true })).result)
      .toMatchObject({ ok: false, error: { code: 'gateway/arguments-invalid', details: { endpoint: 'sessionReferenceResolver/candidates' } } })
    expect((await invoke(c, 4, sessionId, { query: 7 })).result)
      .toMatchObject({ ok: false, error: { code: 'gateway/input-invalid', details: { field: 'query' } } })
    expect(remote!.calls).toHaveLength(1)
    // The dedicated relay this channel replaced is gone.
    expect((await c.request(5, 'x.ai/session/references', { sessionId, query: '' })).error).toMatchObject({ code: -32601 })
  })

  it('refuses client B binding client A\'s session, by sessionId or by an injected agentId', async () => {
    const { client: a, socketPath, remote } = await start({ remote: true })
    register(a); await a.next()
    const owned = await open(a, 1)
    const b = await makeClient(socketPath)
    try {
      register(b); await b.next()
      expect((await invoke(b, 1, owned)).error).toMatchObject({ code: -32602, message: 'unknown session: ' + owned })
      const own = await open(b, 2)
      expect((await invoke(b, 3, own, { query: '', agentId: owned })).error).toMatchObject({ code: -32602, message: expect.stringContaining('bound by the bridge') })
      expect((await invoke(b, 4, own, {}, 'pluginManager/listPlugins')).error)
        .toMatchObject({ code: -32602, message: 'remote endpoint is not allowed: pluginManager/listPlugins' })
      expect(remote!.calls).toEqual([])
    } finally { b.socket.destroy() }
  })

  it('aborts a call when its session closes, and drains it before releasing the native owner', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), flush = vi.fn(async () => {})
    const { client: c, registry, remote } = await start({ remote: true, sessionsStore: { flush } })
    remote!.answer = async (_agent, _query, signal) => { await gate; signal.throwIfAborted(); return [CANDIDATE] }
    try {
      register(c); await c.next()
      const sessionId = await open(c, 1), agent = registry.byId.get(sessionId)!
      sendRequest(c, 2, INVOKE, { sessionId, endpoint: ENDPOINT, args: { query: '' } })
      await waitFor(() => remote!.calls.length === 1)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => remote!.calls[0]!.signal.aborted)
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602, message: 'session closed' })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(flush).toHaveBeenCalledOnce(); expect(agent.internals.disposed).toBe(true)
    } finally { release() }
  })

  it('answers every query of a type-ahead burst, running at most eight at once', async () => {
    const { client: c, remote } = await start({ remote: true })
    register(c); await c.next()
    const sessionId = await open(c, 1)
    let active = 0, peak = 0
    remote!.answer = async (_agent, query) => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return [{ ...CANDIDATE, label: query }]
    }
    // The picker asks again on every keystroke of its query.
    const ids = Array.from({ length: 24 }, (_, index) => index + 2)
    for (const id of ids) sendRequest(c, id, INVOKE, { sessionId, endpoint: ENDPOINT, args: { query: 'x'.repeat(id) } })
    const replies = await collectIds(c, ids)
    expect(ids.map(id => (replies.get(id)?.result as { value?: Array<{ label: string }> } | undefined)?.value?.[0]?.label))
      .toEqual(ids.map(id => 'x'.repeat(id)))
    expect(peak).toBe(8)
  })

  it('answers unavailable when the composition mounts no gateway', async () => {
    const { client: c } = await start()
    register(c); await c.next()
    const sessionId = await open(c, 1)
    expect((await invoke(c, 2, sessionId)).result).toMatchObject({ ok: false, error: { code: 'dscode/remote-unavailable' } })
  })
})
