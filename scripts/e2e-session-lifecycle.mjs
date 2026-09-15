import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { FrameDecoder, encodeJsonFrame } from '../bridge/grok-leader/src/codec.ts'

/** A second real bridge client owns isolated sessions; it never borrows or
 * changes the TUI client's session. Only the model gateway is scripted. */
export async function sessionLifecycleAcceptance({ socketPath, cwd, artifact, state, waitFor }) {
  const socket = createConnection(socketPath), decoder = new FrameDecoder(), pending = new Map(), messages = []
  let counter = 0
  const rejectPending = error => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    pending.clear()
  }
  socket.on('error', rejectPending)
  socket.on('close', () => rejectPending(new Error('lifecycle client disconnected')))
  const send = value => socket.write(encodeJsonFrame(value))
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`lifecycle request timed out: ${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method: method.startsWith('x.ai/') ? '_' + method : method, params }) })
  })
  socket.on('data', data => {
    try {
      for (const frame of decoder.push(data)) {
        const envelope = JSON.parse(new TextDecoder().decode(frame))
        if (envelope.type === 'registered') { socket.emit('registered'); continue }
        if (envelope.type !== 'acp') continue
        const message = JSON.parse(envelope.payload)
        messages.push(message)
        const waiter = pending.get(message.id)
        if (!waiter) continue
        clearTimeout(waiter.timer); pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
    } catch (error) { rejectPending(error); socket.destroy(error) }
  })
  const sourceId = randomUUID(), forkId = randomUUID()
  const first = `DSCODE_LIFECYCLE_FIRST_${sourceId}`, second = `DSCODE_LIFECYCLE_SECOND_${sourceId}`
  const points = sessionId => request('x.ai/rewind/points', { sessionId })
  const previews = result => result.rewindPoints.map(point => point.promptPreview)
  const load = sessionId => request('session/load', { sessionId, cwd, mcpServers: [] })
  try {
    await once(socket, 'connect')
    const registered = once(socket, 'registered', { signal: AbortSignal.timeout(10000) })
    send({ type: 'register', client_type: 'grok-shell', mode: 'stdio' }); await registered
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await request('session/new', { cwd, mcpServers: [], _meta: { sessionId: sourceId } })
    for (const text of [first, second]) {
      const result = await request('session/prompt', { sessionId: sourceId, prompt: [{ type: 'text', text }] })
      assert.equal(result.stopReason, 'end_turn')
    }
    assert.deepEqual(previews(await points(sourceId)), [first, second])
    const replayStart = messages.length
    await load(sourceId) // Same client/leader and live native owner, not a cold resume.
    const replay = messages.slice(replayStart).filter(message => message.method === 'session/update'
      && message.params?.sessionId === sourceId && message.params.update?.sessionUpdate === 'user_message_chunk')
      .map(message => message.params.update.content.text)
    assert.deepEqual(replay, [first, second], 'Live reload must replay each accepted user prompt exactly once')
    assert.deepEqual((await request('x.ai/prompt_history', { session_id: sourceId })).prompts, [second, first])
    assert.deepEqual(await request('x.ai/session/fork', { sourceSessionId: sourceId, newSessionId: forkId }), { newSessionId: forkId })
    assert.deepEqual(previews(await points(forkId)), [first, second], 'Live fork must inherit the complete durable prefix')
    await load(forkId)
    assert.deepEqual(previews(await points(forkId)), [first, second], 'Seeded fork must survive same-leader reload')
    const rewind = await request('x.ai/rewind/execute', { sessionId: sourceId, targetPromptIndex: 1 })
    assert.equal(rewind.mode, 'conversation_only'); assert.equal(rewind.promptText, second)
    assert.deepEqual(rewind.revertedFiles, [])
    assert.deepEqual(previews(await points(rewind.newSessionId)), [first], 'Rewind must omit the selected turn')
    assert.deepEqual(previews(await points(sourceId)), [first, second], 'Rewind must leave its source intact')
    for (const sessionId of [sourceId, forkId, rewind.newSessionId]) await request('session/close', { sessionId })
    await load(forkId) // Closed source now uses storage, not any live source snapshot.
    assert.deepEqual(previews(await points(forkId)), [first, second], 'Closed fork must remain durably resumable')
    await request('session/close', { sessionId: forkId })
    // Grow real history past two page boundaries through ordinary model turns,
    // never by injecting events or substituting a synthetic persistence backend.
    const pagedId = randomUUID(), prompts = []
    await request('session/new', { cwd, mcpServers: [], _meta: { sessionId: pagedId } })
    let eventCount = 0
    for (let index = 0; eventCount <= 512 && index < 64; index++) {
      const text = `DSCODE_REWIND_PAGE_${index}_${pagedId}`
      const result = await request('session/prompt', { sessionId: pagedId, prompt: [{ type: 'text', text }] })
      assert.equal(result.stopReason, 'end_turn'); prompts.push(text)
      const observed = await waitFor(() => state(pagedId), value => value?.status === 'idle' && value.eventCount > eventCount, 'paged-rewind-native-history')
      eventCount = observed.eventCount
    }
    assert.ok(eventCount > 512, `Expected at least three history pages, observed ${eventCount} events`)
    const pagedPoints = await points(pagedId)
    assert.deepEqual(previews(pagedPoints), prompts)
    assert.deepEqual(pagedPoints.rewindPoints.map(point => point.promptIndex), prompts.map((_, index) => index))
    await request('session/close', { sessionId: pagedId }); await load(pagedId)
    assert.deepEqual(previews(await points(pagedId)), prompts, 'Paged points must survive cold resume')
    await request('session/close', { sessionId: pagedId })
    const result = { sourceId, forkId, rewindId: rewind.newSessionId, liveReloadReplay: replay,
      pagedRewind: { sessionId: pagedId, eventCount, prompts: prompts.length },
      cases: ['live-reload', 'live-fork', 'seeded-live-reload', 'wire-rewind', 'source-preserved', 'closed-fork-resume', 'paged-rewind-points', 'paged-rewind-resume'] }
    await artifact('session-lifecycle', { ...result, messages })
    return result
  } finally {
    rejectPending(new Error('lifecycle acceptance finished'))
    socket.destroy()
  }
}
