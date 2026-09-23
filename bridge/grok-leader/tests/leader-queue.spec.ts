/** Leader socket spec: leader prompt queue, steering and interjection. */
import { describe, expect, it } from 'vitest'
import { collectIds, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader prompt queue, steering and interjection', () => {
  const start = useLeaderHarness()

  it('broadcasts x.ai/queue/changed while a prompt runs and when it settles', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello there' }] })

    expect(c.broadcasts.length).toBeGreaterThanOrEqual(2)
    const first = c.broadcasts[0]!
    expect(first.params).toMatchObject({
      sessionId,
      entries: [],
    })
    const fp = first.params as { runningPromptId?: string; runningText?: string; runningKind?: string }
    expect(fp.runningPromptId).toEqual(expect.any(String) as string)
    expect(fp.runningText).toBe('hello there')
    expect(fp.runningKind).toBe('prompt')
    const last = c.broadcasts[c.broadcasts.length - 1]!
    expect((last.params as { runningPromptId?: string }).runningPromptId).toBeUndefined()
    expect(c.completes.some(m => (m.params as { stopReason?: string }).stopReason === 'cancelled')).toBe(true)
  })

  it('queues a second prompt and reports it in x.ai/queue/changed until promotion', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // First prompt parks on an idle waiter (mock never claims the turn).
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => Array.isArray((b.params as { entries?: unknown }).entries) && ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const hp = held.params as { entries?: Array<{ id: string; text: string; kind: string; position: number }>; runningPromptId?: string }
    expect(hp.entries).toHaveLength(1)
    expect(hp.entries![0]).toMatchObject({ kind: 'prompt', text: 'second', position: 0 })
    expect(hp.runningPromptId).toEqual(expect.any(String) as string)

    // Release the first turn; the queue promotes and empties.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.length === 2)
    const secondId = hp.entries![0]!.id
    await waitFor(() => c.broadcasts.some(b => {
      const params = b.params as { entries?: unknown[]; runningPromptId?: string; runningText?: string }
      return params.entries?.length === 0 && params.runningPromptId === secondId
    }))
    // The promotion broadcast must precede the promoted prompt's echo: the
    // pager routes user_message_chunk by runningPromptId.
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 0 && (m.params as { runningPromptId?: string }).runningPromptId === secondId)
    const echoIndex = c.all.findIndex(m => m.method === 'session/update' && ((m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text) === 'second')
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await waitForId(c, 3)
  })

  it('interject cancels the running turn (send-now) and promotes the row next', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await waitFor(() => c.broadcasts.some(b => ((b.params as { runningText?: string }).runningText) === 'first'))
    const firstId = (c.broadcasts.find(b => ((b.params as { runningText?: string }).runningText) === 'first')!.params as { runningPromptId: string }).runningPromptId
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const secondId = ((held.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/interject', { sessionId, id: secondId, expectedVersion: 0 })

    // Acknowledgment is not completion; release the cancelled native drain.
    await waitFor(() => agent.internals.cancelCalls >= 1)
    expect(c.completes).toEqual([])
    agent.internals.idleWaiters.shift()!()
    // The first turn settles cancelled with the send_now trigger...
    await waitFor(() => c.completes.some(m => (m.params as { cancelTrigger?: string }).cancelTrigger === 'send_now'))
    const complete = c.completes[c.completes.length - 1]!
    expect(complete.params).toMatchObject({ sessionId, promptId: firstId, stopReason: 'cancelled', cancelTrigger: 'send_now' })
    expect(agent.internals.cancelCalls).toBeGreaterThanOrEqual(1)
    for (;;) {
      const msg = await c.next()
      if (msg.id === 2) { expect(msg.result).toMatchObject({ stopReason: 'cancelled' }); break }
    }

    // ...and the interjected row runs next as its own turn (after the agent idles).
    await waitFor(() => agent.internals.idleWaiters.length >= 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second') && c.broadcasts.some(b => (b.params as { runningPromptId?: string }).runningPromptId === secondId))
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { runningPromptId?: string }).runningPromptId === secondId)
    const echoIndex = c.all.findIndex(m => m.method === 'session/update' && ((m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text) === 'second')
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await waitForId(c, 3)
  })

  it('queue/steer merges a queued row into the running turn without cancelling it', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await waitFor(() => c.broadcasts.some(b => ((b.params as { runningText?: string }).runningText) === 'first'))
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const secondId = ((held.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/steer', { sessionId, id: secondId, expectedVersion: 0 })

    // The queued row is folded into the live turn, not promoted/cancelled.
    await waitFor(() => agent.internals.steered.includes('second'))
    expect(agent.internals.cancelCalls).toBe(0)
    await waitFor(() => {
      const last = c.broadcasts[c.broadcasts.length - 1]!.params as {
        entries?: Array<{ id: string }>
        runningPromptId?: string
      }
      return last.entries?.length === 0 && last.runningPromptId !== undefined
    })

    // The host turn keeps running and settles normally; the steered prompt
    // settles with the host turn's stop reason.
    agent.internals.idleWaiters.shift()!()
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({
      stopReason: 'cancelled',
      _meta: { promptId: secondId },
    })
  })

  it('queue/edit replaces the row text, bumps its version, and rebroadcasts', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const queued = c.broadcasts.find(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1)!
    const row = ((queued.params as { entries: Array<{ id: string; text: string; version: number }> }).entries[0]!)
    expect(row).toMatchObject({ text: 'second', version: 0 })

    const before = c.broadcasts.length
    c.notify('x.ai/queue/edit', { sessionId, id: row.id, newText: 'edited second' })
    await waitFor(() => c.broadcasts.length > before)
    const edited = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string; text: string; version: number }> }).entries[0]!
    expect(edited).toMatchObject({ id: row.id, text: 'edited second', version: 1 })

    // The edited text is what the row runs once it promotes. One promotion
    // wait exists (scheduled at enqueue; the edit and settle dedup into it).
    agent.internals.idleWaiters.shift()!() // settle the running first
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!() // the pending promotion: runs the edited row
    await waitFor(() => agent.internals.followups.includes('edited second'))
    agent.internals.idleWaiters.shift()!() // settle the promoted row
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('queue/hold_edit parks the front and queue/release_edit promotes it', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const secondId = ((c.broadcasts[c.broadcasts.length - 1]!.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Releasing the hold unblocks the parked row. Either order works: if the
    // pending enqueue-time promotion fires before the release lands, it parks
    // on the held front and the release then promotes synchronously on the
    // idle agent; if the release lands first, its promotion request dedups
    // into the pending wait.
    c.notify('x.ai/queue/release_edit', { sessionId, id: secondId })
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!() // settle the promoted second
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('queue/remove of a held front promotes the next queued row', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))
    const entries = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string }> }).entries
    const secondId = entries[0]!.id
    const thirdId = entries[1]!.id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Removing the held front unblocks the next row instead of stranding it.
    c.notify('x.ai/queue/remove', { sessionId, id: secondId, expectedVersion: 0 })
    // The removed row's RPC resolves as cancelled; its response proves the
    // remove landed before the pending promotion wait is fired.
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    agent.internals.idleWaiters.shift()!() // the pending promotion: promotes the new front
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'third'])
    agent.internals.idleWaiters.shift()!() // settle the promoted third
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(thirdId).toEqual(expect.any(String) as string)
  })

  it('queue/reorder of a held front away from the lead promotes the new front', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))
    const entries = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string }> }).entries
    const secondId = entries[0]!.id
    const thirdId = entries[1]!.id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Moving the held row out of the lead lets the new front run; the held
    // second stays queued behind it. The reorder's promotion request dedups
    // into the promotion wait scheduled at enqueue time; firing that wait
    // promotes the reordered new front.
    c.notify('x.ai/queue/reorder', { sessionId, orderedIds: [thirdId, secondId] })
    await waitFor(() => c.broadcasts.some(b => {
      const params = b.params as { entries?: Array<{ id: string }> }
      return params.entries?.map(entry => entry.id).join(',') === `${thirdId},${secondId}`
    }))
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'third'])
    const reorderBroadcast = () => c.broadcasts.find(b => {
      const params = b.params as { entries?: Array<{ id: string }>; runningPromptId?: string }
      return params.runningPromptId === thirdId && params.entries?.map(entry => entry.id).join(',') === secondId
    })
    await waitFor(() => reorderBroadcast() !== undefined)
    const afterReorder = (reorderBroadcast()!.params as { entries?: Array<{ id: string }> }).entries
    expect(afterReorder?.map(entry => entry.id)).toEqual([secondId])

    agent.internals.idleWaiters.shift()!() // settle the promoted third
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(secondId).toEqual(expect.any(String) as string)
  })

  it('a stale expectedVersion on edit/remove/interject is a no-op that resyncs', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const id = ((c.broadcasts[c.broadcasts.length - 1]!.params as { entries: Array<{ id: string }> }).entries[0]!).id
    const latestRow = (): { text: string; version: number } | undefined => {
      const params = c.broadcasts[c.broadcasts.length - 1]!.params as { entries?: Array<{ id: string; text: string; version: number }> }
      return params.entries?.find(entry => entry.id === id)
    }

    // Stale edit: text/version untouched, still rebroadcast for the resync.
    const beforeEdit = c.broadcasts.length
    c.notify('x.ai/queue/edit', { sessionId, id, newText: 'changed', expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeEdit)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })

    // Stale remove: the row stays queued.
    const beforeRemove = c.broadcasts.length
    c.notify('x.ai/queue/remove', { sessionId, id, expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeRemove)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })

    // Stale interject: the row stays and the running turn is not cancelled.
    const beforeInterject = c.broadcasts.length
    c.notify('x.ai/queue/interject', { sessionId, id, expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeInterject)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })
    expect(agent.internals.cancelCalls).toBe(0)
    c.notify('session/cancel', { sessionId })
    await waitFor(() => agent.internals.cancelCalls === 1)
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await collectIds(c, [2, 3])
  })

  it('queues a second prompt behind the in-flight one (FIFO)', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)
    expect(agent).toBeDefined()

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    expect(agent!.internals.followups).toEqual(['first'])
    // The first prompt echoes before its response; consume it so the queued
    // prompt's echo order below is unambiguous.
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' } } },
    })

    // The second prompt must queue instead of hard-erroring while the first runs.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent!.internals.followups).toEqual(['first'])

    agent!.internals.idleWaiters.shift()!()
    // With the idle gate, the settling response goes out first; the promotion
    // broadcast and the promoted echo follow once the agent idles again.
    const isEcho = (msg: Record<string, unknown>, text: string): boolean => {
      const params = msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } | undefined
      return params?.update?.sessionUpdate === 'user_message_chunk'
        && params.update.content?.type === 'text'
        && params.update.content.text === text
    }
    let sawSecondEcho = false
    for (;;) {
      const msg = await c.next()
      if (msg.id === 2) {
        expect(msg.result).toMatchObject({ stopReason: 'cancelled' })
        expect(sawSecondEcho).toBe(false)
        break
      }
      if (isEcho(msg, 'second')) sawSecondEcho = true
    }

    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    agent!.internals.idleWaiters.shift()!()
    await waitFor(() => agent!.internals.followups.includes('second'))
    // The promotion broadcast adopts the next turn before its echo streams.
    // Wait for the broadcast to cross the socket: the agent-side followup
    // lands before the client reads the frames.
    await waitFor(() => c.all.some(m => m.method === 'x.ai/queue/changed' && (m.params as { runningText?: string }).runningText === 'second'))
    await waitFor(() => c.all.some(m => isEcho(m, 'second')))
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { runningPromptId?: string }).runningPromptId !== undefined && (m.params as { runningText?: string }).runningText === 'second')
    const echoIndex = c.all.findIndex(m => isEcho(m, 'second'))
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
    expect(agent!.internals.followups).toEqual(['first', 'second'])

    agent!.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('does not bypass the idle gate for a prompt enqueued between turn-end and idle', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    expect(agent.internals.followups).toEqual(['first'])

    // Queue a second prompt while the first turn is still in flight.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // End the first turn. The settle path schedules an idle-gated promotion
    // for 'second', but the agent has not reported idle yet.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // This prompt arrives in the turn-end -> idle window. It must join the
    // queue instead of starting immediately and racing the harness.
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Fire the pending idle-gated promotion; 'second' starts.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    expect(agent.internals.followups).toEqual(['first', 'second'])

    // Let 'second' settle and then 'third' runs through the same idle gate.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'second', 'third'])
  })

  it('steers a prompt sent mid-turn into the running turn (followUpBehavior=steer)', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // A follow-up during the turn folds in at the next step boundary instead
    // of parking behind the whole (possibly minutes-long) turn.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }], _meta: { promptId: 'steer-1' } })
    await waitFor(() => agent.internals.steered.includes('second'))
    expect(agent.internals.followups).toEqual(['first'])

    // The row was confirmed once (so the pager's optimistic echo retires by
    // id) and then left the queue as it joined the live turn.
    await waitFor(() => {
      const rowSeen = c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'steer-1'))
      const latest = c.broadcasts[c.broadcasts.length - 1]?.params as { entries?: Array<{ id: string }> } | undefined
      return rowSeen && latest !== undefined && !(latest.entries ?? []).some(e => e.id === 'steer-1')
    })
    // Its text streams into the live turn as a user echo.
    await waitFor(() => c.all.some(m => m.method === 'session/update' && ((m.params as { update?: { content?: { text?: string } } }).update?.content?.text) === 'second'))

    // Both RPCs settle with the host turn's outcome, each with its own attribution.
    agent.internals.idleWaiters.shift()!()
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'steer-1' } })
    // The steered prompt never became its own turn.
    expect(agent.internals.followups).toEqual(['first'])
  })

  it('routes per prompt: _meta.followUp=steer steers one message under the queue default', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // One flagged message steers into the running turn...
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'nudge' }], _meta: { promptId: 'route-steer', followUp: 'steer' } })
    await waitFor(() => agent.internals.steered.includes('nudge'))
    // ...while an unflagged one still parks in the queue.
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'later' }], _meta: { promptId: 'route-queue' } })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'route-queue')))
    expect(agent.internals.followups).toEqual(['first'])

    // The steered message settles with the host turn; the queued one runs next.
    agent.internals.idleWaiters.shift()!()
    const settled = await collectIds(c, [2, 3])
    expect(settled.get(3)!.result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'route-steer' } })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('later'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'route-queue' } })
  })

  it('x.ai/interject merges text into the running turn without cancelling it', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    sendRequest(c, 3, 'x.ai/interject', { sessionId, text: 'course correction', interjectionId: 'ij-1' })
    expect((await waitForId(c, 3)).result).toEqual({})
    expect(agent.internals.steered).toEqual(['course correction'])
    expect(agent.internals.cancelCalls).toBe(0)
    // The broadcast reaches the pane (the originator dedups by id).
    await waitFor(() => c.all.some(m => m.method === 'x.ai/session/interjection'
      && (m.params as { interjectionId?: string }).interjectionId === 'ij-1'
      && (m.params as { text?: string }).text === 'course correction'))

    // The host turn keeps running and settles normally.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('session/prompt with _meta.sendNow cancels the running turn and runs next', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'urgent' }], _meta: { promptId: 'now-1', sendNow: true } })
    await waitFor(() => agent.internals.cancelCalls >= 1)
    expect(c.all.some(message => message.id === 2)).toBe(false)
    agent.internals.idleWaiters.shift()!()
    // The running turn is cancelled with the send_now trigger...
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => c.completes.some(m => (m.params as { cancelTrigger?: string }).cancelTrigger === 'send_now'))
    expect(agent.internals.cancelCalls).toBeGreaterThanOrEqual(1)
    // ...and the send-now prompt runs after the cancelled owner drains.
    await waitFor(() => agent.internals.followups.includes('urgent'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'now-1' } })
  })

  it('routes per prompt: _meta.followUp=queue parks one message under a steer default', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'parked' }], _meta: { promptId: 'route-parked', followUp: 'queue' } })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'route-parked')))
    expect(agent.internals.steered).toEqual([])

    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('parked'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('defaults to queue: a mid-turn prompt parks instead of steering', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    expect(agent.internals.steered).toEqual([])

    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent.internals.followups).toEqual(['first', 'second'])
  })

  it('steer mode still runs an idle-session prompt as its own turn', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'solo' }] })
    await waitFor(() => agent.internals.followups.includes('solo'))
    expect(agent.internals.steered).toEqual([])
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('stamps a strictly increasing seq on queue/changed and promptId meta on settle results', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    // A client-minted promptId rides back on the settle result, so the pager
    // attributes the response without falling back to the RPC id.
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }], _meta: { promptId: 'row-1' } })
    const settledOne = await waitForId(c, 2)
    expect(settledOne.result).toMatchObject({ stopReason: 'cancelled', _meta: { sessionId, promptId: 'row-1' } })

    // A leader-minted id is still echoed on the result.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    const settledTwo = await waitForId(c, 3)
    expect((settledTwo.result as { _meta?: { promptId?: string } })._meta?.promptId).toEqual(expect.any(String) as string)

    // Every snapshot carries a seq, strictly increasing in emission order, so
    // the pager can drop a stale snapshot regardless of channel interleaving.
    const seqs = c.broadcasts.map(b => (b.params as { seq?: number }).seq)
    expect(seqs.length).toBeGreaterThanOrEqual(2)
    for (const seq of seqs) expect(typeof seq).toBe('number')
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })

  it('random queue-op interleavings converge: one settle per prompt, seq-ordered snapshots, a drained queue', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    let rpcId = 10
    // Three seeded rounds; a failure reproduces exactly from its seed.
    for (const seedBase of [0xC0FFEE, 0xBADD1E, 0x5EED]) {
      let seed = seedBase >>> 0
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)]!

      sendRequest(c, ++rpcId, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const created = await waitForId(c, rpcId)
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!
      const sent: Array<{ rpc: number; promptId: string }> = []
      const texts: string[] = []
      const knownIds: string[] = []
      const held: string[] = []
      let counter = 0

      for (let op = 0; op < 40; op++) {
        const roll = rnd()
        if (roll < 0.35) {
          const promptId = 's' + String(seedBase) + '-p' + String(counter)
          const text = 's' + String(seedBase) + '-t' + String(counter)
          counter += 1
          knownIds.push(promptId)
          texts.push(text)
          sent.push({ rpc: ++rpcId, promptId })
          sendRequest(c, rpcId, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }], _meta: { promptId } })
        } else if (roll < 0.6) {
          // Model the agent reaching idle at an arbitrary point.
          agent.internals.idleWaiters.shift()?.()
        } else if (roll < 0.68) {
          if (knownIds.length > 0) c.notify('x.ai/queue/remove', { sessionId, id: pick(knownIds) })
        } else if (roll < 0.76) {
          if (knownIds.length > 0) {
            const text = 's' + String(seedBase) + '-edit' + String(counter)
            counter += 1
            texts.push(text)
            c.notify('x.ai/queue/edit', { sessionId, id: pick(knownIds), newText: text })
          }
        } else if (roll < 0.84) {
          if (knownIds.length > 0) {
            const id = pick(knownIds)
            held.push(id)
            c.notify('x.ai/queue/hold_edit', { sessionId, id })
          }
        } else if (roll < 0.9) {
          if (held.length > 0) c.notify('x.ai/queue/release_edit', { sessionId, id: held.splice(Math.floor(rnd() * held.length), 1)[0]! })
        } else if (roll < 0.96) {
          if (knownIds.length > 1) c.notify('x.ai/queue/reorder', { sessionId, orderedIds: [...knownIds].sort(() => rnd() - 0.5) })
        } else if (knownIds.length > 0) {
          c.notify('x.ai/queue/interject', { sessionId, id: pick(knownIds) })
        }
        // Let the leader drain its socket and microtasks at arbitrary cuts.
        if (op % 5 === 4) await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
      }

      // Stop mutating; discard what never ran and settle whatever is running.
      c.notify('x.ai/queue/clear', { sessionId })
      await waitFor(() => {
        agent.internals.idleWaiters.splice(0).forEach((fire) => { fire() })
        return sent.every(({ rpc }) => c.all.some(m => m.id === rpc && m.method === undefined))
      }, 10_000)

      // Exactly one settle per prompt, attributed to its queue row.
      for (const { rpc, promptId } of sent) {
        const responses = c.all.filter(m => m.id === rpc && m.method === undefined)
        expect(responses).toHaveLength(1)
        const result = responses[0]!.result as { stopReason?: string; _meta?: { promptId?: string } } | undefined
        expect(result?.stopReason).toEqual(expect.any(String) as string)
        expect(result?._meta?.promptId).toBe(promptId)
      }
      // Snapshots stay strictly seq-ordered.
      const snaps = c.broadcasts.filter(b => (b.params as { sessionId?: string }).sessionId === sessionId)
      const seqs = snaps.map(b => (b.params as { seq?: number }).seq)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
      // No prompt ran twice, and only texts this round produced ever ran.
      const runs = agent.internals.followups
      expect(new Set(runs).size).toBe(runs.length)
      for (const run of runs) expect(texts).toContain(run)
      // The queue drained to the idle empty snapshot.
      const last = snaps[snaps.length - 1]!.params as { entries: unknown[]; runningPromptId?: string }
      expect(last.entries).toEqual([])
      expect(last.runningPromptId).toBeUndefined()
    }
  })
})
