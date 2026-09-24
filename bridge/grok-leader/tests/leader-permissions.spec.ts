/** Leader socket spec: leader questions and permissions. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader questions and permissions', () => {
  const start = useLeaderHarness()

  const answerQuestion = async (
    questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>,
    response: Record<string, unknown>,
  ) => {
    const { pluginCtx, registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const answer = pluginCtx.waterfall('user-questions/request', {
      agent: registry.byId.get(sessionId)!, questions,
    }, () => Promise.reject(new Error('no answerer')))
    await waitFor(() => c.all.some(message => message.method === 'x.ai/ask_user_question'))
    const reverse = c.all.find(message => message.method === 'x.ai/ask_user_question')!
    c.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: reverse.id, result: response }) })
    return await answer
  }

  it('control: freeform answers survive the Other marker and annotations', async () => {
    expect(await answerQuestion([{ id: 'q1', question: 'Name?' }], {
      outcome: 'accepted', answers: { 'Name?': ['Other'] }, annotations: { 'Name?': { notes: 'my custom answer' } },
    })).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'my custom answer' }] })
  })

  it('a real option labelled Other remains selected', async () => {
    expect(await answerQuestion([{ id: 'q1', question: 'Category?', options: [{ label: 'Main' }, { label: 'Other' }] }], {
      outcome: 'accepted', answers: { 'Category?': ['Other'] },
    })).toEqual({ answers: [{ id: 'q1', selected: ['Other'] }] })
  })

  it('equal question text does not lose a distinct question id', async () => {
    const result = await answerQuestion([
      { id: 'q1', question: 'Choice?', options: [{ label: 'first' }, { label: 'second' }] },
      { id: 'q2', question: 'Choice?', options: [{ label: 'first' }, { label: 'second' }] },
    ], {
      outcome: 'accepted', answers: { q1: ['first'], q2: ['second'] },
    })
    // The TUI returns each stable ID even when the displayed headings match.
    expect(result.answers.map(answer => answer.id).sort()).toEqual(['q1', 'q2'])
  })

  it('rejects ambiguous legacy question keys instead of assigning the answer to the last question', async () => {
    await expect(answerQuestion([
      { id: 'q1', question: 'Choice?' }, { id: 'q2', question: 'Choice?' },
    ], { outcome: 'accepted', answers: { 'Choice?': ['Other'] } })).rejects.toThrow('ambiguous question')
  })

  it('session/load rejects the old owner pending permission before the reload', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))

    // waitForId, not request: the pending permission reverse request (its own
    // JSON-RPC id) interleaves with the load response.
    sendRequest(c, 2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    const loaded = await waitForId(c, 2)
    expect(loaded.error).toBeUndefined()
    // Reload cancels the old owner's outstanding permission without inventing a rejection.
    await expect(decision).resolves.toBe('cancelled')
  })

  it('keeps yolo approval active when a session is resumed', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { yoloMode: true },
    })
    expect(loaded.error).toBeUndefined()
    const agent = registry.byId.get('persisted-session')!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-yolo', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await expect(decision).resolves.toBe('allowed-once')
    expect(c.all.some(msg => msg.method === 'session/request_permission')).toBe(false)
  })

  it('lets bypassPermissions override the pager\'s explicit yoloMode false', async () => {
    const permissionPresets: string[] = []
    const { registry, pluginCtx, client: c } = await start({
      permissionPresets: { set: (_session: unknown, preset: string) => { permissionPresets.push(preset) } },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { permissionMode: 'bypassPermissions', yoloMode: false },
    })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-bypass', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await expect(decision).resolves.toBe('allowed-once')
    expect(c.all.some(msg => msg.method === 'session/request_permission')).toBe(false)
    expect(permissionPresets.at(-1)).toBe('danger-full-access')
  })

  it('applies plan permission mode without inheriting an explicit yolo bit', async () => {
    const planCalls: Array<{ agent: unknown; active: boolean }> = []
    const permissionPresets: string[] = []
    const { registry, pluginCtx, client: c } = await start({
      planMode: { set: (agent: unknown, active: boolean) => { planCalls.push({ agent, active }) } },
      permissionPresets: { set: (_session: unknown, preset: string) => { permissionPresets.push(preset) } },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { permissionMode: 'plan', yoloMode: true },
    })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    expect(planCalls).toEqual([{ agent, active: true }])
    expect(permissionPresets.at(-1)).toBe('workspace-write')
    c.notify('x.ai/yolo_mode_changed', {
      sessionId,
      permission_mode: 'default',
      yolo_mode: false,
    })
    await waitFor(() => planCalls.length === 2)
    expect(planCalls).toEqual([{ agent, active: true }, { agent, active: false }])
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-plan', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('cancelled')
  })

  it('targets live permission changes and restores approval in canonical ask mode', async () => {
    const applied = new Map<unknown, string>()
    const { registry, pluginCtx, client: c } = await start({
      permissionPresets: { set: (session: unknown, preset: string) => { applied.set(session, preset) } },
    })
    register(c)
    await c.next()
    const first = await c.request(1, 'session/new', {
      cwd: process.cwd(), mcpServers: [], _meta: { permissionMode: 'ask' },
    })
    expect(first.error).toBeUndefined()
    const second = await c.request(2, 'session/new', {
      cwd: process.cwd(), mcpServers: [], _meta: { permissionMode: 'default' },
    })
    const sessionId = (first.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const other = registry.byId.get((second.result as { sessionId: string }).sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<string>
    c.notify('x.ai/yolo_mode_changed', {
      sessionId, permission_mode: 'always-approve', yolo_mode: true, auto_mode: false,
    })
    await waitFor(() => applied.get(agent.session) === 'danger-full-access')
    expect(applied.get(other.session)).toBe('workspace-write')
    await expect(waterfall('approval/request', {
      agent, callId: 'live-allow', toolName: 'bash',
    }, async () => 'rejected' as const)).resolves.toBe('allowed-once')
    c.notify('x.ai/yolo_mode_changed', {
      sessionId, permission_mode: 'ask', yolo_mode: false, auto_mode: false,
    })
    await waitFor(() => applied.get(agent.session) === 'workspace-write')
    const decision = waterfall('approval/request', {
      agent, callId: 'live-ask', toolName: 'bash',
    }, async () => 'rejected' as const)
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('cancelled')
  })

  it('a plugin command asks the user a question mid-execution (userQuestions rail)', async () => {
    // CommandInvocation carries the live root agent; the command asks the
    // scoped waterfall and the bridge relays the request to that agent's client.
    let pluginCtx: Context | undefined
    const commandsService = {
      list: () => [{ name: 'confirm', description: 'Ask before doing' }],
      execute: async (agent: Agent, line: string) => {
        if (!/^\/confirm(\s|$)/.test(line)) return undefined
        if (pluginCtx === undefined) throw new Error('test plugin context is unavailable')
        const answer = await pluginCtx.waterfall('user-questions/request', {
          agent,
          questions: [{
            id: 'q1',
            header: 'Deployment decision',
            question: 'Proceed?',
            detail: 'Review both lines.\nKeep the rollback ready.',
            options: [{ label: 'Yes' }, { label: 'No' }],
          }],
        }, () => Promise.reject(new Error('no question answerer')))
        const picked = answer.answers[0]?.selected[0] ?? 'nothing'
        const custom = answer.answers[0]?.custom
        return { commandId: 'c1', result: { kind: 'success', text: 'confirmed: ' + picked + (custom === undefined ? '' : '\n' + custom) } }
      },
    }
    const started = await start({ commands: commandsService })
    pluginCtx = started.pluginCtx
    const { client: c } = started
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/confirm go' }], _meta: { promptId: 'ask-1' } })

    // The command handler blocks on the question: the client sees the ext
    // reverse request with the typed payload FLAT under params (camelCase,
    // matching the pager's AskUserQuestionExtRequest serde — it parses
    // `ext.request.params` directly with from_str, no method wrapper).
    await waitFor(() => c.all.some(m => m.method === 'x.ai/ask_user_question' && typeof m.id === 'number'))
    const reverse = c.all.find(m => m.method === 'x.ai/ask_user_question')!
    const inner = reverse.params as { sessionId: string; questions: Array<{ question: string; options: Array<{ label: string }> }> }
    expect(inner.sessionId).toBe(sessionId)
    const displayQuestion = 'Deployment decision\nProceed?\nReview both lines.\nKeep the rollback ready.'
    expect(inner.questions[0].question).toBe(displayQuestion)
    expect(inner.questions[0].options.map(o => o.label)).toEqual(['Yes', 'No'])

    // Answer as the grok TUI would: accepted, keyed by question text.
    c.send({ type: 'acp', payload: JSON.stringify({
      jsonrpc: '2.0',
      id: reverse.id,
      result: {
        outcome: 'accepted',
        answers: { [displayQuestion]: ['Yes', 'Other'] },
        annotations: { [displayQuestion]: { notes: 'first line\nsecond line' } },
      },
    }) })

    const settled = await waitForId(c, 2)
    expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'ask-1' } })
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '') === 'confirmed: Yes\nfirst line\nsecond line'))
  })

  it('keeps a human approval pending beyond 60s and accepts the eventual answer', async () => {
    vi.useFakeTimers()
    try {
      const { registry, pluginCtx, client: c } = await start()
      register(c)
      await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!
      const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
      const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
      const request = await c.next()
      expect(request.method).toBe('session/request_permission')
      let settled = false
      void decision.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      c.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }) })
      await expect(decision).resolves.toBe('allowed-once')
    } finally {
      vi.useRealTimers()
    }
  })

  it('session/cancel cancels a pending permission roundtrip', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    // The reverse request reached the client before the cancel settles it.
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))
    let settled = false
    void decision.then(() => { settled = true })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(settled).toBe(false)
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('cancelled')
  })

  it('native cancellation failure cannot strand an already-issued permission request', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'cancel-failure', toolName: 'bash' }, async () => 'rejected') as Promise<string>
    await waitFor(() => c.all.some(message => message.method === 'session/request_permission'))
    let settled = false
    void decision.then(() => { settled = true })
    vi.spyOn(agent, 'cancel').mockImplementationOnce(() => { throw new Error('native cancellation failed') })
    c.notify('session/cancel', { sessionId })
    // A later response on the same socket is a barrier after notification
    // dispatch. Clean up with another cancel even when reviewing old wiring.
    await c.request(2, 'x.ai/session/info', { sessionId })
    const settledAfterFirstCancel = settled
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('cancelled')
    expect(settledAfterFirstCancel).toBe(true)
  })

  it('cancels an individual native human request without cancelling a sibling in the same session', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>
    const abort = new AbortController()
    const answer = waterfall('user-questions/request', { agent, signal: abort.signal, questions: [{ id: 'q', question: 'Continue?' }] }, async () => ({ answers: [] }))
    const cancelled = expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const decision = waterfall('approval/request', { agent, callId: 'sibling', toolName: 'bash' }, async () => 'rejected')
    await waitFor(() => c.all.some(m => m.method === 'x.ai/ask_user_question') && c.all.some(m => m.method === 'session/request_permission'))
    const question = c.all.find(m => m.method === 'x.ai/ask_user_question')!, permission = c.all.find(m => m.method === 'session/request_permission')!
    abort.abort(); await cancelled
    c.send({ type: 'acp', payload: JSON.stringify({ id: question.id, result: { outcome: 'accepted', answers: { 'Continue?': ['Yes'] } } }) })
    c.send({ type: 'acp', payload: JSON.stringify({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }) })
    await expect(decision).resolves.toBe('allowed-once')
    expect(agent.internals.disposed).toBe(false)
  })

  const rejectWithFeedback = async (manualIdle: boolean, followup: string) => {
    const { registry, pluginCtx, client: c } = await start({ manualIdle })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    if (manualIdle) {
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'delete the build' }] })
      await waitFor(() => agent.internals.idleWaiters.length === 1)
    }
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>
    const decision = waterfall('approval/request', { agent, callId: 'rm', toolName: 'bash' }, async () => 'cancelled')
    await waitFor(() => c.all.some(m => m.method === 'session/request_permission'))
    const permission = c.all.find(m => m.method === 'session/request_permission')!
    // The TUI's reject row: the RejectOnce option, the typed text in _meta.
    c.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: permission.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' }, _meta: { followup_message: followup } } }) })
    await expect(decision).resolves.toBe('rejected')
    return { c, agent, sessionId }
  }

  it('steers the feedback typed on a reject into the running turn', async () => {
    const { c, agent, sessionId } = await rejectWithFeedback(true, 'use git clean instead')
    await waitFor(() => agent.internals.steered.length === 1)
    expect(agent.internals.steered).toEqual(['use git clean instead'])
    expect(agent.internals.followups).toEqual(['delete the build'])
    expect(agent.internals.cancelCalls).toBe(0)
    // No interjection id: the pane that typed it renders the block too.
    await waitFor(() => c.all.some(m => m.method === 'x.ai/session/interjection'))
    expect(c.all.find(m => m.method === 'x.ai/session/interjection')!.params).toEqual({ sessionId, text: 'use git clean instead' })
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('queues the reject feedback as the next prompt when no turn is left to steer', async () => {
    const { c, agent } = await rejectWithFeedback(false, 'try the dry run first')
    await waitFor(() => agent.internals.followups.includes('try the dry run first'))
    expect(agent.internals.steered).toEqual([])
    expect(c.all.some(m => m.method === 'x.ai/session/interjection')).toBe(false)
  })

  it('a reject without feedback, or with only whitespace, delivers nothing', async () => {
    const { c, agent } = await rejectWithFeedback(true, '  \n ')
    await c.request(3, 'x.ai/session/info', { sessionId: agent.session.id })
    expect(agent.internals.steered).toEqual([])
    expect(agent.internals.followups).toEqual(['delete the build'])
    agent.internals.idleWaiters.shift()!()
  })

  it('refuses further input after a partial native permission change until the session is reloaded', async () => {
    const plan = { set: vi.fn() }
    const { registry, client: c } = await start({ planMode: plan, permissionPresets: { set: vi.fn() } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    plan.set.mockImplementationOnce(() => { throw new Error('native plan append failed') })
    c.notify('x.ai/yolo_mode_changed', { sessionId, permission_mode: 'always-approve' })
    await c.request(2, 'initialize', {})
    expect((await c.request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'must not run' }] })).error)
      .toMatchObject({ code: -32602, message: expect.stringContaining('permission state is inconsistent') })
    expect(agent.internals.followups).toEqual([])
    expect((await c.request(4, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })).error).toBeUndefined()
    expect(agent.internals.disposed).toBe(true)
    expect((await c.request(5, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'resumed' }] })).error).toBeUndefined()
  })
})
