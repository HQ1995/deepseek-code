/** Leader socket spec: leader prompt turns, content and usage. */
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { encodeJsonFrame } from '../src/codec.ts'
import { collectIds, mockSessionsStore, mockVisionLlm, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader prompt turns, content and usage', () => {
  const start = useLeaderHarness()

  it('runs the session flow: new, prompt, cancel, models, list, load, close', async () => {
    const { registry, persistence, client: c } = await start()
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd() }])

    const promptResult = await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello there' }] })
    // Turnless mock: admission never claims a turn, so the prompt settles cancelled at idle.
    expect(promptResult.result).toMatchObject({ stopReason: 'cancelled' })
    expect(registry.byId.get(sessionId)?.internals.followups).toEqual(['hello there'])

    // The accepted prompt is echoed before the response so it enters the transcript.
    const echo = await c.next()
    expect(echo).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello there' } },
        _meta: { eventSeq: 3, promptId: expect.any(String) as string },
      },
    })

    c.notify('session/cancel', { sessionId })
    c.notify('_x.ai/log', { src: 'grok-pager', entries: [] })

    const models = await c.request(3, 'x.ai/models/list', {})
    expect(models.result).toEqual({
      currentModelId: 'deepseek-chat',
      availableModels: [
        { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
        { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      ],
      _meta: {
        currentProviderId: 'deepseek',
        providers: [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'pi', name: 'Pi AI' },
        ],
      },
    })

    const listed = await c.request(4, 'session/list', {})
    expect(listed.result).toEqual({
      sessions: [{ sessionId: 'persisted-session', cwd: '/tmp/proj', updatedAt: '1970-01-01T00:00:00.000Z' }],
    })

    const loaded = await c.request(5, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.result).toEqual({})
    expect(persistence.loaded).toEqual(['persisted-session'])
    expect(registry.resumed).toEqual([{ sessionId: 'persisted-session' }])

    const closed = await c.request(6, 'session/close', { sessionId: 'persisted-session' })
    expect(closed.result).toEqual({})
    // The mock disposer removes the entry, so absence is the disposal proof.
    expect(registry.byId.has('persisted-session')).toBe(false)
    expect(mockSessionsStore.flushed).toHaveLength(1)

    // Unknown notifications are dropped and unknown requests get method-not-found.
    const unknown = await c.request(7, 'no/such/method', {})
    expect(unknown.error).toEqual({ code: -32601, message: 'method not found: no/such/method' })

    // The connection survives all of it: ping still answers.
    c.send({ type: 'ping' })
    expect(await c.next()).toEqual({ type: 'pong' })
  })

  it('targets only the selected prompt over the socket and ignores late cancellation after promotion', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    for (const [id, text] of [[2, 'first'], [3, 'second'], [4, 'third']] as const) {
      sendRequest(c, id, 'session/prompt', { sessionId, _meta: { promptId: text }, prompt: [{ type: 'text', text }] })
    }
    await waitFor(() => (c.broadcasts.at(-1)?.params as { entries?: unknown[] })?.entries?.length === 2)
    expect((await c.request(5, '_x.ai/session/cancel_prompt', { sessionId, promptId: 'second' })).result).toEqual({ status: 'cancelled' })
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'second' } })
    expect(agent.internals.cancelCalls).toBe(0)
    expect((await c.request(6, '_x.ai/session/cancel_prompt', { sessionId, promptId: 'first' })).result).toEqual({ status: 'cancelled' })
    expect(c.all.some(message => message.id === 2)).toBe(false)
    expect(agent.internals.followups).toEqual(['first'])
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.followups.length === 2)
    expect(agent.internals.followups).toEqual(['first', 'third'])
    expect((await c.request(7, '_x.ai/session/cancel_prompt', { sessionId, promptId: 'first' })).result).toEqual({ status: 'not_found' })
    expect(agent.internals.cancelCalls).toBe(1)
    for (const idle of agent.internals.idleWaiters.splice(0)) idle()
    await waitForId(c, 4)
  })

  it('registers prompt ownership before a cancellation frame from the same socket write', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    const frame = (id: number, method: string, params: unknown) => encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    c.socket.write(Buffer.concat([
      frame(2, 'session/prompt', { sessionId, _meta: { promptId: 'early' }, prompt: [{ type: 'text', text: 'do not admit' }] }),
      frame(3, '_x.ai/session/cancel_prompt', { sessionId, promptId: 'early' }),
    ]))
    expect((await waitForId(c, 3)).result).toEqual({ status: 'cancelled' })
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'early' } })
    expect(agent.internals.followups).toEqual([]); expect(agent.internals.cancelCalls).toBe(0)
  })

  it('settle emits prompt_complete, the promotion broadcast + echo, and the response LAST (grok wire order)', async () => {
    // Auto idle: the promotion microtask beats the RPC response write, pinning
    // the live/grok order — the TUI's stashed-adoption rail depends on it.
    const { client: c } = await start({ followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    // One write, one data event: both prompts enter the leader in the same
    // synchronous frame loop, so 'second' queues while 'first' is in flight
    // (split writes let 'first' settle before 'second' arrives).
    const promptFrame = (id: number, text: string): Uint8Array => encodeJsonFrame({
      type: 'acp',
      payload: JSON.stringify({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }),
    })
    c.socket.write(Buffer.concat([promptFrame(2, 'first'), promptFrame(3, 'second')]))
    await waitForId(c, 2)
    await waitForId(c, 3)

    const idx = (predicate: (m: Record<string, unknown>) => boolean): number => {
      const i = c.all.findIndex(predicate)
      expect(i).toBeGreaterThanOrEqual(0)
      return i
    }
    const completeOf = (promptId: string): number => idx(m => m.method === 'x.ai/session/prompt_complete' && (m.params as { promptId?: string }).promptId === promptId)
    const responseOf = (id: number): number => idx(m => m.id === id && m.method === undefined)
    const promotionOf = (text: string): number => idx(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 0 && (m.params as { runningText?: string }).runningText === text)
    const echoOf = (text: string): number => idx(m => m.method === 'session/update' && (m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text === text)

    const firstId = (c.all.find(m => m.method === 'x.ai/queue/changed' && (m.params as { runningText?: string }).runningText === 'first')!.params as { runningPromptId: string }).runningPromptId
    const secondId = (c.all.find(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 1)!.params as { entries: Array<{ id: string }> }).entries[0]!.id

    const complete1 = completeOf(firstId)
    const response1 = responseOf(2)
    const promotion = promotionOf('second')
    const echo = echoOf('second')
    expect(complete1).toBeLessThan(response1)
    // The promotion broadcast adopts the next turn before its echo streams.
    expect(promotion).toBeLessThan(echo)
    // ...and the whole promotion rides out BEFORE the settling prompt's
    // JSON-RPC response (the response is last, as the TUI expects).
    expect(echo).toBeLessThan(response1)
    expect(complete1).toBeLessThan(promotion)
    // The promoted row ran its own turn (a terminal exists for its id).
    const complete2 = completeOf(secondId)
    expect(complete2).toBeGreaterThanOrEqual(0)
  })

  it('combines 2+ queued plain prompts into one turn when enabled', async () => {
    const { registry, client: c } = await start({ manualIdle: true, combineQueuedPrompts: true, followUpBehavior: 'queue' })
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

    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    // Followers fold into the front: the front RUNS the combined turn (its
    // response settles with the turn); the follower resolves as removed now.
    await waitFor(() => agent.internals.followups.includes('second\n\nthird'))
    expect(agent.internals.followups).toEqual(['first', 'second\n\nthird'])
    agent.internals.idleWaiters.shift()!()
    const settled = new Set<unknown>()
    for (;;) {
      const msg = await c.next()
      if (msg.id === 3 || msg.id === 4) {
        expect(msg.result).toMatchObject({ stopReason: 'cancelled' })
        settled.add(msg.id)
        if (settled.size === 2) break
      }
    }
    const promo = c.broadcasts.find(b => (b.params as { runningText?: string }).runningText === 'second')
    expect(promo).toBeDefined()
    expect((promo!.params as { runningCombinedTexts?: string[] }).runningCombinedTexts).toEqual(['second', 'third'])
  })

  it('keeps image-bearing queued prompts separate from combined text turns', async () => {
    const { registry, client: c } = await start({
      manualIdle: true,
      combineQueuedPrompts: true,
      followUpBehavior: 'queue',
      llm: mockVisionLlm,
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'second [Image #1]' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))

    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second [Image #1]'))
    expect(agent.internals.messages[1]).toMatchObject({
      content: [
        { type: 'text', text: 'second [Image #1]' },
        { type: 'image', attachment: { attachmentId: 'test-image-0' } },
      ],
    })
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'second [Image #1]', 'third'])
    agent.internals.idleWaiters.shift()!()
  })

  it('admits ACP image blocks into durable dsh user-message content', async () => {
    const saved: Array<{ data: number[]; mediaType: string }> = []
    const attachments = {
      saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string }>) => {
        saved.push(...inputs.map(input => ({ data: [...input.data], mediaType: input.mediaType })))
        return inputs.map((input, index) => ({
          attachmentId: 'durable-' + String(index),
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }))
      },
    }
    const { registry, client: c } = await start({ attachments, llm: mockVisionLlm })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    const result = await c.request(2, 'session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'inspect [Image #1]' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(saved).toEqual([{ data: [1, 2, 3], mediaType: 'image/png' }])
    expect(registry.byId.get(sessionId)!.internals.messages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'inspect [Image #1]' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'durable-0',
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
      ],
    })
  })

  it('hydrates images before the single tool completion, later text and prompt settlement', async () => {
    let finish!: () => void
    const readImage = vi.fn((ref: unknown) => new Promise(resolve => {
      finish = () => resolve({ ref, data: new Uint8Array([1]) })
    }))
    const { registry, pluginCtx, client: c } = await start({ manualIdle: true,
      attachments: { readImage, imageHostPath: () => '/private/verified-object' },
    })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const response = c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'inspect tool image' }] })
    await waitFor(() => agent.internals.followups.length === 1)
    pluginCtx.emit('session/event', agent.session, { type: 'tool/call', seq: 0, time: 1, data: {
      turn: 0, step: 0, callId: 'image', name: 'read_image', arguments: '{}',
    } } as never)
    pluginCtx.emit('session/event', agent.session, { type: 'tool/result', seq: 1, time: 2, data: {
      message: { role: 'tool', toolCallId: 'image', content: [{ type: 'image', attachment: { attachmentId: 'stored' } }] },
    } } as never)
    pluginCtx.emit('session/event', agent.session, { type: 'assistant/message', seq: 2, time: 3, data: {
      turn: 0, step: 0, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'final image answer' }], source: { provider: 'deepseek', model: 'chat' } }),
    } } as never)
    agent.internals.idleWaiters.shift()!()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(readImage).toHaveBeenCalledOnce()
    expect(c.all.some(row => row.id === 2 || JSON.stringify(row).includes('final image answer'))).toBe(false)
    finish()
    expect((await response).error).toBeUndefined()
    const completed = c.all.filter(row => JSON.stringify(row).includes('dscodeImages'))
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'image', status: 'completed', rawOutput: { dscodeImages: ['/private/verified-object'] },
    } } })
    const imageIndex = c.all.indexOf(completed[0]!)
    const textIndex = c.all.findIndex(row => JSON.stringify(row).includes('final image answer'))
    expect(textIndex).toBeGreaterThan(imageIndex)
    expect(c.all.findIndex(row => row.id === 2)).toBeGreaterThan(textIndex)
  })

  it('forwards exact cumulative cache usage and replaces repeated same-step samples', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const usageEvent = {
      type: 'assistant/message',
      seq: 0,
      time: Date.now(),
      data: {
        turn: 0,
        step: 0,
        stream: [],
        message: createAssistantMessage({ content: [], source: { provider: 'deepseek', model: 'vision' } }),
        usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 999, cacheWriteTokens: 0 },
      },
    } as unknown as SessionEvent

    pluginCtx.emit('session/event', agent.session, usageEvent)
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
        _meta: { cumulativeTokens: 1005, cacheHitPercent: '99.9', contextInfo: { available: false } },
      },
    })
    expect((await c.request(2, 'x.ai/session/info', { sessionId })).result).toMatchObject({
      result: { context: { available: false, capacityAvailable: false } },
    })
    pluginCtx.emit('session/event', agent.session, {
      type: 'assistant/message', seq: 1, time: Date.now(), data: {
        turn: 0, step: 0, stream: [],
        message: createAssistantMessage({ content: [], source: { provider: 'deepseek', model: 'vision' } }),
        usage: { inputTokens: 2, outputTokens: 6, cacheReadTokens: 998, cacheWriteTokens: 0 },
      },
    } as never)
    expect(await c.next()).toMatchObject({ params: { _meta: { cumulativeTokens: 1006, cacheHitPercent: '99.8' } } })
  })

  it('reports whole-session decode speed from the settled steps', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const settle = (step: number, startTime: number, firstToken: number, messageTime: number, outputTokens: number) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startTime)
      try {
        pluginCtx.emit('session/event', agent.session, agent.session.append('step/start', { turn: 1, step } as never))
        clock.mockReturnValue(messageTime)
        pluginCtx.emit('session/event', agent.session, agent.session.append('assistant/message', {
          turn: 1, step,
          stream: [{ type: 'chunk', time: firstToken, chunk: { type: 'text-delta', index: 0, text: 'ok' } }],
          message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'deepseek', model: 'chat' } }),
          usage: { inputTokens: 1, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as never))
      } finally { clock.mockRestore() }
    }
    // 40 tokens over the 800ms after the first token, then 10 over the next 1000ms.
    settle(0, 1000, 1200, 2000, 40)
    expect(await c.next()).toMatchObject({ params: { _meta: { tokensPerSecond: '50' } } })
    settle(1, 2100, 3000, 4000, 10)
    expect(await c.next()).toMatchObject({ params: { _meta: { tokensPerSecond: '28' } } })
  })

  it('refuses a turn DSH failed for a missing key, naming dscode\'s fix', async () => {
    const { registry, pluginCtx, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'keyless' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    pluginCtx.emit('agent/inbox/claimed', { agent, message: agent.internals.messages[0] as UserMessage, turn: 1 })
    pluginCtx.emit('agent/error', { agent, turn: 1, step: 0, error: Object.assign(new Error('llm-deepseek: no API key'), {
      failure: { code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key for provider route "deepseek-official"; store it' },
    }) })
    const refusal = 'No API key is stored for provider "deepseek-official". Add one in /provider (highlight it and press e), then send again.'
    expect((await waitForId(c, 2)).error).toEqual({ code: -32602, message: refusal, data: { message: refusal } })
  })

  it('rejects a prompt only when agent/error names its in-flight turn', async () => {
    const { registry, pluginCtx, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    pluginCtx.emit('agent/inbox/claimed', {
      agent,
      message: agent.internals.messages[0] as UserMessage,
      turn: 1,
    })
    // An error for a different turn is ignored...
    pluginCtx.emit('agent/error', { agent, turn: 2, step: 0, error: new Error('other turn') })
    // ...and the in-flight turn's own error rejects the prompt.
    pluginCtx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('boom') })
    expect((await waitForId(c, 2)).error).toEqual({ code: -32603, message: 'turn failed: boom' })

    // The rejected turn left the session clean: the next prompt still runs.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await waitFor(() => agent.internals.idleWaiters.length >= 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('two'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('cancel settles the in-flight and queued prompts as cancelled', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent!.internals.followups).toEqual(['one'])

    c.notify('session/cancel', { sessionId })
    await waitFor(() => agent!.internals.cancelCalls === 1)
    expect(c.all.some(message => message.id === 2)).toBe(false)
    for (const idle of agent!.internals.idleWaiters.splice(0)) idle()
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent!.internals.followups).toEqual(['one']) // the queued prompt never ran
  })
})
