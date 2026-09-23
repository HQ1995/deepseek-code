/** Leader socket spec: leader session ownership, history and discovery. */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistenceRevision, sessionFormatVersionRefusal } from '@deepseek-ai/dsh-session-persistence'
import { makeClient, mockSessionsStore, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader session ownership, history and discovery', () => {
  const start = useLeaderHarness()

  it('refreshes picker metadata after an external durable revision changes', async () => {
    const { persistence, client: c } = await start()
    register(c); await c.next()
    let revision = 'r1', listings = 0
    persistence.list = async () => { listings += 1; return [{ header: persistence.header, revision: SessionPersistenceRevision(revision) }] }
    persistence.events.push(
      { type: 'user/message', seq: SessionSeq(0), time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }) },
      { type: 'session/title', seq: SessionSeq(1), time: 2, data: { title: 'old' } },
    )
    const list = async (id: number) => (await c.request(id, 'x.ai/session/list', {})).result as { sessions: Array<{ title: string; updatedAt: string }> }
    const clock = vi.spyOn(Date, 'now')
    try {
      expect((await list(1)).sessions[0]?.title).toBe('old')
      // The harness's read handle walks the store itself, so only the deltas
      // below say whether a tick paid a listing of its own.
      const paidFirst = listings
      expect(paidFirst).toBeGreaterThan(0)
      // The second tick lands inside the window the first settled, so the
      // picker reads that listing instead of the store and folds its revision
      // from the resident index.
      await list(2)
      expect(persistence.loaded).toHaveLength(1)
      expect(listings).toBe(paidFirst)
      // An external revision reaches the window only through a listing, so the
      // row stands as stale as the listing behind it — and the tick past the
      // deadline pays its own listing and re-reads the session it changed.
      persistence.events.push({ type: 'session/title', seq: SessionSeq(2), time: 3, data: { title: 'external change' } })
      revision = 'r2'
      expect((await list(3)).sessions[0]?.title).toBe('old')
      expect(persistence.loaded).toHaveLength(1)
      expect(listings).toBe(paidFirst)
      clock.mockReturnValue(Date.now() + 10_001)
      expect((await list(4)).sessions[0]).toMatchObject({ title: 'external change', updatedAt: new Date(3).toISOString() })
      expect(persistence.loaded).toHaveLength(2)
      expect(listings).toBeGreaterThan(paidFirst)
    } finally { clock.mockRestore() }
  })

  it('session/load validates cwd and mcpServers like session/new', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const badCwd = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: 'relative', mcpServers: [] })
    expect(badCwd.error).toEqual({ code: -32602, message: 'cwd must be an absolute path: relative' })
    const badMcp = await c.request(2, 'session/load', { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: { name: 'fs' } })
    expect(badMcp.error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    const loaded = await c.request(3, 'session/load', { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(loaded.result).toEqual({})
  })

  it('rejects a session/new that pins an already-live session id', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { sessionId: 'pinned-session' } })
    expect(created.result).toEqual({ sessionId: 'pinned-session' })
    const dup = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { sessionId: 'pinned-session' } })
    expect(dup.error).toMatchObject({ code: -32602 })
    // The first session still works: its record was not replaced.
    const prompted = await c.request(3, 'session/prompt', { sessionId: 'pinned-session', prompt: [{ type: 'text', text: 'still here' }] })
    expect(prompted.result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('rejects a session/new id already present in durable persistence', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const duplicate = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { sessionId: 'persisted-session' },
    })
    expect(duplicate.error).toEqual({
      code: -32602,
      message: 'session id is already in use: persisted-session',
    })
  })

  it('a second client cannot touch the first client sessions', async () => {
    const { registry, client: c, socketPath } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    const other = await makeClient(socketPath)
    register(other)
    await other.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const denied = { code: -32602, message: 'unknown session: ' + sessionId }

    // Every session-scoped request reads as unknown to the foreign client.
    expect((await other.request(10, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'steal' }] })).error).toEqual(denied)
    expect((await other.request(11, 'session/set_model', { sessionId, modelId: 'pi-code' })).error).toEqual(denied)
    expect((await other.request(12, 'x.ai/prompt_history', { filter_session_id: sessionId })).error).toEqual(denied)
    expect((await other.request(13, 'x.ai/session/info', { sessionId })).error).toEqual(denied)
    expect((await other.request(14, 'session/close', { sessionId })).error).toEqual(denied)

    // Foreign notifications must not reach the owned session either.
    const agent = registry.byId.get(sessionId)!
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    other.notify('session/cancel', { sessionId })
    other.notify('x.ai/queue/clear', { sessionId })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.cancelCalls).toBe(0)
    expect(((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries?: unknown[] }).entries).toHaveLength(1)

    // The owner's flow is untouched: the parked prompt settles and the queued
    // row still runs (a foreign queue/clear would have removed it).
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent.internals.followups).toEqual(['first', 'second'])
    expect(agent.internals.cancelCalls).toBe(0)
    expect(registry.byId.has(sessionId)).toBe(true)
    other.socket.destroy()
  })

  it('a second live client cannot load the first client live session', async () => {
    const { registry, client: c, socketPath } = await start()
    register(c)
    await c.next()
    const other = await makeClient(socketPath)
    register(other)
    await other.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // A live foreign owner is never displaced; the id reads as unknown so the
    // session's existence does not leak.
    const stolen = await other.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(stolen.error).toEqual({ code: -32602, message: 'unknown session: ' + sessionId })
    expect(agent.internals.disposed).toBe(false)
    expect(registry.byId.get(sessionId)).toBe(agent)
    expect(mockSessionsStore.flushed).not.toContain(agent.session)
    other.socket.destroy()
  })

  it('a reconnecting client re-loads its session after the first socket is gone', async () => {
    const { registry, client: c, socketPath } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const first = registry.byId.get(sessionId)!

    // TUI reconnect: the first socket dies and the respawned client registers
    // under a NEW clientId before re-loading its session.
    c.socket.destroy()
    await waitFor(() => first.internals.disposed === true)
    const again = await makeClient(socketPath)
    register(again)
    await again.next()
    const loaded = await again.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(loaded.result).toEqual({})
    expect(registry.resumed.map(entry => entry.sessionId)).toContain(sessionId)
    again.socket.destroy()
  })

  it('rewinds by forking at a user-prompt boundary and preserves the source session', async () => {
    const { registry, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const session = registry.byId.get(sessionId)!.session
    const message = (text: string) => ({
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    })
    session.append('turn/start', { turn: 0 })
    session.append('user/message', message('first prompt'))
    session.append('assistant/message', { turn: 0, step: 0, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'first answer' }], source: { provider: 'deepseek', model: 'chat' } }) })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', message('second prompt'))
    session.append('assistant/message', { turn: 1, step: 0, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'second answer' }], source: { provider: 'deepseek', model: 'chat' } }) })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const points = await c.request(2, 'x.ai/rewind/points', { sessionId })
    expect(points.result).toMatchObject({
      rewindPoints: [
        { promptIndex: 0, promptPreview: 'first prompt' },
        { promptIndex: 1, promptPreview: 'second prompt' },
      ],
    })
    const rewound = await c.request(3, 'x.ai/rewind/execute', {
      sessionId,
      targetPromptIndex: 1,
      force: true,
      mode: 'conversation_only',
    })
    const result = rewound.result as { newSessionId: string; promptText: string }
    expect(result).toMatchObject({
      success: true,
      targetPromptIndex: 1,
      promptText: 'second prompt',
      mode: 'conversation_only',
    })
    expect(result.newSessionId).not.toBe(sessionId)
    expect(registry.byId.has(sessionId)).toBe(true)
    expect(registry.seeds.get(result.newSessionId)?.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ])
  })

  it('forks a durable session without requiring a live parent record', async () => {
    const { registry, persistence, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const childId = '22222222-2222-4222-8222-222222222222'
    const forked = await c.request(1, 'x.ai/session/fork', {
      sourceSessionId: 'persisted-session',
      newSessionId: childId,
      newCwd: '/tmp/proj',
    })
    expect(forked.result).toEqual({ newSessionId: childId })
    expect(persistence.loaded).toContain('persisted-session')
    expect(registry.created.at(-1)).toEqual({
      sessionId: childId,
      cwd: '/tmp/proj',
      agentPreset: 'standard',
    })
  })

  it.each(['session/load', 'x.ai/session/fork'])('%s preserves an unsupported-format refusal without creating an agent', async (method) => {
    const { registry, persistence, client: c } = await start()
    register(c)
    await c.next()
    const message = sessionFormatVersionRefusal('persisted-session', 1)
    persistence.open = async () => { throw new SessionFormatUnsupportedError(message) }
    const response = await c.request(1, method, method === 'session/load'
      ? { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] }
      : { sourceSessionId: 'persisted-session', newSessionId: '22222222-2222-4222-8222-222222222222', newCwd: '/tmp/proj' })
    expect(response.error).toMatchObject({ code: -32603, message: expect.stringContaining(message) })
    expect(registry.created).toEqual([])
    expect(registry.resumed).toEqual([])
  })

  it('refuses to fork an open turn after a durable assistant attempt', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const result = created.result
    if (result === null || typeof result !== 'object' || !('sessionId' in result) || typeof result.sessionId !== 'string') {
      throw new Error('session/new did not return a session id')
    }
    const sessionId = result.sessionId
    const session = registry.byId.get(sessionId)!.session
    session.append('turn/start', { turn: 0 })
    session.append('assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['unfinished'] }] })
    const forked = await c.request(2, 'x.ai/session/fork', {
      sourceSessionId: sessionId,
      newSessionId: '22222222-2222-4222-8222-222222222222',
      newCwd: process.cwd(),
    })
    expect(forked.error).toEqual({ code: -32602, message: 'cannot fork while a turn is open' })
    expect(registry.created).toHaveLength(1)
    expect(registry.byId.has(sessionId)).toBe(true)
  })

  it.each(['session/load', 'x.ai/session/fork', 'x.ai/session/list'])('%s awaits read-handle closure on success and failure', async (method) => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    const open = persistence.open
    for (const fail of [true, false]) {
      let closeStarted = false
      let releaseClose!: () => void
      const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
      persistence.open = async (id, access) => {
        const handle = await open(id, access)
        return {
          ...handle,
          read: async () => {
            if (fail) throw new Error('storage read failed')
            return handle.read()
          },
          close: async () => {
            closeStarted = true
            await closeGate
            await handle.close()
          },
        }
      }
      const requestId = fail ? 101 : 102
      const params = method === 'session/load'
        ? { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] }
        : method === 'x.ai/session/fork'
          ? { sourceSessionId: 'persisted-session', newSessionId: randomUUID(), newCwd: '/tmp/proj' }
          : { cwd: '/tmp/proj' }
      sendRequest(c, requestId, method, params)
      await waitFor(() => closeStarted)
      expect(c.all.some(message => message.id === requestId)).toBe(false)
      expect(persistence.closed).toHaveLength(fail ? 0 : 1)
      releaseClose()
      const response = await waitForId(c, requestId)
      if (fail) expect(response.error).toMatchObject({ message: 'storage read failed' })
      else expect(response.error).toBeUndefined()
      expect(persistence.closed).toHaveLength(fail ? 1 : 2)
    }
  })

  it.each(['session/load', 'x.ai/session/fork', 'x.ai/session/list'])('%s surfaces read-handle close failures', async (method) => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    const open = persistence.open
    persistence.open = async (id, access) => {
      const handle = await open(id, access)
      return { ...handle, close: async () => { await handle.close(); throw new Error('storage close failed') } }
    }
    const response = await c.request(1, method, method === 'session/load'
      ? { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] }
      : method === 'x.ai/session/fork'
        ? { sourceSessionId: 'persisted-session', newSessionId: randomUUID(), newCwd: '/tmp/proj' }
        : { cwd: '/tmp/proj' })
    expect(response.error).toMatchObject({ message: 'storage close failed' })
    expect(persistence.closed).toEqual(['persisted-session'])
  })

  it('x.ai/session/list backfills firstPrompt before the query filter', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.readEvents = async () => [{ type: 'user/message', seq: SessionSeq(0), time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Needle prompt title' }] } }]
    const listed = await c.request(1, 'x.ai/session/list', { query: 'needle' })
    expect(listed.result).toMatchObject({
      sessions: [{
        sessionId: 'persisted-session',
        cwd: '/tmp/proj',
        firstPrompt: 'Needle prompt title',
        _meta: { 'x.ai/session': { kind: 'chat' } },
      }],
    })
  })

  it('x.ai/session/list does not inspect logs outside the requested cwd', async () => {
    const { persistence, client: c } = await start()
    const other = {
      version: 0,
      isSeeded: false,
      id: SessionId('other-repo-session'),
      createdAt: 1,
      cwd: '/tmp/other',
      agentPreset: 'standard',
    }
    persistence.list = async () => [persistence.header, other].map(header => ({ header, revision: SessionPersistenceRevision('mock') }))
    register(c)
    await c.next()

    await c.request(1, 'x.ai/session/list', { cwd: '/tmp/proj' })

    expect(persistence.loaded).toContain('persisted-session')
    expect(persistence.loaded).not.toContain('other-repo-session')
  })

  it('x.ai/session/search maps ranked dsh content hits for the resume picker', async () => {
    const searchSessions = vi.fn(async () => ({
      items: [{
        header: { id: 'matched-session', createdAt: 1_000, cwd: '/tmp/search' },
        bestMatch: { time: 2_000, snippet: 'matched needle in a tool result', type: 'tool/result' },
      }],
      nextCursor: 'cursor-2',
    }))
    const { client: c } = await start({ sessionQuery: { searchSessions } })
    register(c)
    await c.next()

    const searched = await c.request(1, 'x.ai/session/search', {
      query: ' needle ',
      limit: 20,
      includeContent: true,
    })
    expect(searchSessions).toHaveBeenCalledWith({ query: 'needle', limit: 20 }, { signal: expect.any(AbortSignal) })
    expect(searched.result).toEqual({
      results: [{
        sessionId: 'matched-session',
        cwd: '/tmp/search',
        summary: 'matched needle in a tool result',
        updatedAt: '1970-01-01T00:00:02.000Z',
        score: 0,
        matchedFields: ['content'],
        snippet: 'matched needle in a tool result',
      }],
      nextCursor: 'cursor-2',
      nextOffset: null,
      totalEstimate: null,
      bootstrapping: false,
    })
    await c.request(2, 'x.ai/session/search', { query: 'needle', cursor: 'cursor-2' })
    expect(searchSessions).toHaveBeenLastCalledWith({
      query: 'needle',
      limit: 20,
      cursor: 'cursor-2',
    }, { signal: expect.any(AbortSignal) })
  })

  it('x.ai/session/list resolves an exact id outside the launch cwd', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const listed = await c.request(1, 'x.ai/session/list', {
      cwd: '/another/project',
      query: 'persisted-session',
    })
    expect(listed.result).toMatchObject({
      sessions: [{ sessionId: 'persisted-session', cwd: '/tmp/proj' }],
    })
  })

  it('x.ai/session/list exposes durable titles for title-based resume', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.readEvents = async () => [
        { type: 'user/message', seq: SessionSeq(0), time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Initial prompt' }] } },
        { type: 'session/title', seq: SessionSeq(1), time: 20, data: { title: 'Reviewed session', messageSeqs: [], source: { kind: 'user' } } },
    ]
    const listed = await c.request(1, 'x.ai/session/list', { query: 'reviewed session' })
    expect(listed.result).toMatchObject({
      sessions: [{
        sessionId: 'persisted-session',
        title: 'Reviewed session',
        summary: 'Reviewed session',
        updatedAt: new Date(20).toISOString(),
      }],
    })
  })

  it('x.ai/session/list orders sessions by their latest durable event', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    const olderCreated = { ...persistence.header, id: SessionId('older-created'), createdAt: 100 }
    persistence.list = async () => [olderCreated, persistence.header].map(header => ({ header, revision: SessionPersistenceRevision('mock') }))
    persistence.readEvents = async (id: SessionId) => [{
        type: 'user/message',
        seq: SessionSeq(0),
        time: id === olderCreated.id ? 100 : 500,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: String(id) }] },
    }]
    const listed = await c.request(1, 'x.ai/session/list', {})
    expect((listed.result as { sessions: Array<{ sessionId: string }> }).sessions.map(row => row.sessionId)).toEqual([
      'persisted-session',
      'older-created',
    ])
  })

  it('x.ai/session/list refreshes an empty firstPrompt when the durable revision changes', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    let prompted = false
    persistence.list = async () => [{ header: persistence.header, revision: SessionPersistenceRevision(prompted ? 'prompted' : 'empty') }]
    persistence.readEvents = async () => prompted
        ? [{ type: 'user/message', seq: SessionSeq(0), time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Late title' }] } }]
        : []
    const clock = vi.spyOn(Date, 'now')
    try {
      const first = await c.request(1, 'x.ai/session/list', {})
      expect((first.result as { sessions: Array<{ firstPrompt: string }> }).sessions[0]!.firstPrompt).toBe('')
      // The durable change is only visible to the listing that reports it, so
      // the window that settled before it keeps answering its empty prompt.
      prompted = true
      const second = await c.request(2, 'x.ai/session/list', {})
      expect((second.result as { sessions: Array<{ firstPrompt: string }> }).sessions[0]!.firstPrompt).toBe('')
      clock.mockReturnValue(Date.now() + 10_001)
      const third = await c.request(3, 'x.ai/session/list', {})
      expect((third.result as { sessions: Array<{ firstPrompt: string }> }).sessions[0]!.firstPrompt).toBe('Late title')
    } finally { clock.mockRestore() }
  })

  it('session/load replay repopulates the up-arrow prompt history', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.readEvents = async () => [
        { type: 'user/message', seq: SessionSeq(0), time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted one' }] } },
        { type: 'user/message', seq: SessionSeq(1), time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted two' }] } },
    ]
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    // Consume the two replayed user_message_chunk notifications so the next
    // request is not stalled behind them in the client's message queue.
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'persisted one' } } },
    })
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'persisted two' } } },
    })
    const history = await c.request(2, 'x.ai/prompt_history', { filter_session_id: 'persisted-session' })
    expect(history.result).toEqual({ prompts: ['persisted two', 'persisted one'] })
  })

  it('session/load replays failed attempts, reasoning and answers from native embedded streams once', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 0 } },
      { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 0, step: 0 } },
      { type: 'assistant/attempt', seq: SessionSeq(2), time: 2, data: { turn: 0, step: 0, stream: [{ type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['failed attempt'] }] } },
      { type: 'assistant/message', seq: SessionSeq(4), time: 4, surfaceOp: 'append', data: {
        turn: 0, step: 0,
        stream: [
          { type: 'reasoning-chunks', time0: 2, index: 0, dt: [], texts: ['replayed reasoning'] },
          { type: 'text-chunks', time0: 3, index: 1, dt: [], texts: ['replayed answer'] },
        ],
        message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'replayed reasoning' }, { type: 'text', text: 'replayed answer' }], source: { provider: 'deepseek', model: 'chat' } }),
      } },
      { type: 'step/end', seq: SessionSeq(5), time: 5, data: { turn: 0, step: 0 } },
      { type: 'step/start', seq: SessionSeq(6), time: 6, data: { turn: 0, step: 1 } },
      { type: 'assistant/message', seq: SessionSeq(7), time: 7, surfaceOp: 'append', data: {
        turn: 0, step: 1,
        stream: [],
        message: createAssistantMessage({ content: [{ type: 'text', text: 'next step answer' }], source: { provider: 'deepseek', model: 'chat' } }),
      } },
      { type: 'step/end', seq: SessionSeq(8), time: 8, data: { turn: 0, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(9), time: 9, data: { turn: 0, reason: { kind: 'completed' } } },
    ]
    persistence.readEvents = async () => events
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(await c.next()).toMatchObject({ method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [] }, _meta: { isReplay: true } } })
    for (const [sessionUpdate, text] of [
      ['agent_message_chunk', 'failed attempt'],
      ['agent_thought_chunk', 'replayed reasoning'],
      ['agent_message_chunk', 'replayed answer'],
      ['agent_message_chunk', 'next step answer'],
    ]) {
      expect(await c.next()).toMatchObject({
        method: 'session/update',
        params: { update: { sessionUpdate, content: { type: 'text', text } }, _meta: { isReplay: true } },
      })
    }
    const replayUpdates = c.all.filter(message => {
      const params = message.params
      if (message.method !== 'session/update' || params === null || typeof params !== 'object' || !('_meta' in params)) return false
      const meta = params._meta
      return meta !== null && typeof meta === 'object' && 'isReplay' in meta && meta.isReplay === true
    })
    expect(replayUpdates).toHaveLength(5)
  })

  it('session/load noReplay rebuilds history without emitting prior transcript updates', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.readEvents = async () => [
        { type: 'user/message', seq: SessionSeq(0), time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted prompt' }] } },
        { type: 'assistant/message', seq: SessionSeq(1), time: 1, data: { turn: 0, step: 0, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'persisted answer' }], source: { provider: 'deepseek', model: 'chat' } }) } },
    ]
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { noReplay: true },
    })
    expect(loaded.error).toBeUndefined()
    expect(c.all.some(message => {
      const params = message.params as { _meta?: { isReplay?: boolean } } | undefined
      return message.method === 'session/update' && params?._meta?.isReplay === true
    })).toBe(false)
    const history = await c.request(2, 'x.ai/prompt_history', { session_id: 'persisted-session' })
    expect(history.result).toEqual({ prompts: ['persisted prompt'] })
  })

  it('session/load validates noReplay metadata type', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { noReplay: 'yes' },
    })
    expect(loaded.error).toEqual({ code: -32602, message: '_meta.noReplay must be a boolean' })
  })

  it('emits a first projected event whose seq is 0 (lastSeq starts at -1)', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.readEvents = async () => [{ type: 'user/message', seq: SessionSeq(0), time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'seq zero replay' }] } }]
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    const seen = (): boolean => c.all.some(msg => {
      const params = msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } }; _meta?: { isReplay?: boolean } }
      return msg.method === 'session/update'
        && params.update?.sessionUpdate === 'user_message_chunk'
        && params.update.content?.type === 'text'
        && params.update.content.text === 'seq zero replay'
        && params._meta?.isReplay === true
    })
  })

  it('replays every chunk a multi-block user/message event projects', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    // One dsh event with three text blocks must produce three wire updates.
    // Gate admission runs per event; a per-item gate would drop items 2 and 3.
    persistence.readEvents = async () => [
        {
          type: 'user/message', seq: SessionSeq(0), time: 0,
          data: {
            source: { kind: 'user' },
            content: [
              { type: 'text', text: 'alpha' },
              { type: 'text', text: 'beta' },
              { type: 'text', text: 'gamma' },
            ],
          },
        },
    ]
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    for (const text of ['alpha', 'beta', 'gamma']) {
      await waitFor(() => c.all.some(msg => {
        const params = msg.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }
        return msg.method === 'session/update'
          && params.update?.sessionUpdate === 'user_message_chunk'
          && params.update.content?.text === text
      }))
    }
  })
})
