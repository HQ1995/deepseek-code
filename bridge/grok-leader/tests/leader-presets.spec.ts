/** Leader socket spec: leader preset selection and composition. */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionSeq, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { collectIds, mockDefaultModel, mockSessionsStore, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader preset selection and composition', () => {
  const start = useLeaderHarness()

  it('routes the grok agentProfile to the dsh preset roster', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd(), agentPreset: 'ptc' }])
    expect(presets?.resolved).toEqual(['ptc'])
    expect(presets?.mounted).toEqual(['ptc'])
  })

  it('remembers every successfully applied manual preset for future sessions', async () => {
    const mutations: Array<{ ns: string; ops: unknown }> = []
    const settings = {
      describe: () => [{ ns: 'agent-preset-registry', user: {} }],
      mutate: async (ns: string, ops: unknown) => { mutations.push({ ns, ops }) },
    }
    const { client: c } = await start({ presets: true, settings })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'ptc', rememberAgentPreset: true },
    })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/load', {
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'minimal', rememberAgentPreset: true },
    })
    await c.request(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/preset cordis' }],
    })

    expect(mutations).toEqual([
      { ns: 'agent-preset-registry', ops: [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }] },
      { ns: 'agent-preset-registry', ops: [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }] },
      { ns: 'agent-preset-registry', ops: [{ op: 'set', path: ['selectedDefault'], value: 'cordis' }] },
    ])
  })

  it('keeps an unmarked preset override session-local', async () => {
    const mutations: unknown[] = []
    const settings = {
      mutate: async (_ns: string, ops: unknown) => { mutations.push(ops) },
    }
    const { client: c } = await start({ presets: true, settings })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'minimal' },
    })

    expect(created.error).toBeUndefined()
    expect(mutations).toEqual([])
  })

  it('lists the dsh preset roster as bundle/status personas', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const status = await c.request(1, 'x.ai/bundle/status', {})
    expect(status.error).toBeUndefined()
    expect(status.result).toEqual({
      hasCache: true,
      defaultPersona: 'standard',
      personas: ['standard', 'ptc', 'minimal', 'cordis'],
      roles: [],
      agents: [],
      skills: [],
      personaDetails: [
        { name: 'Standard mode', description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.', hasInputs: false, hasOutputs: false },
        { name: 'PTC mode', description: 'Full coding agent without the workflow tool; other tools are exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.', hasInputs: false, hasOutputs: false },
        { name: 'Minimal mode', description: 'Minimal coding agent with a persistent shell.', hasInputs: false, hasOutputs: false },
        { name: 'Creator mode', description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.', hasInputs: false, hasOutputs: false },
      ],
      roleDetails: [],
    })
  })

  it('overrides the persisted preset on session/load when a valid preset is explicitly requested', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['minimal'])
    expect(registry.byId.get('persisted-session')?.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
  })

  it('prepares a live blank preset before reading its flushed reload history', async () => {
    const { registry, persistence, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const live = registry.byId.get(sessionId)!
    const open = persistence.open
    persistence.open = async (...args) => {
      expect(presets?.recomposed).toEqual(['minimal'])
      expect(mockSessionsStore.flushed).toContain(live.session)
      return open(...args)
    }
    const loaded = await c.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(persistence.loaded).toEqual([sessionId])
    expect(presets?.recomposed).toEqual(['minimal'])
    expect(mockSessionsStore.flushed).toContain(live.session)
    expect(live.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
    expect(registry.resumed.map(entry => entry.sessionId)).toContain(sessionId)
  })

  it.each(['minimal', 'ptc'])('preserves an active turn when preset %s is selected', async (preset) => {
    const mutations: unknown[] = []
    const settings = { mutate: async (_ns: string, ops: unknown) => { mutations.push(ops) } }
    const { registry, presets, pluginCtx, client: c } = await start({ presets: true, manualIdle: true, settings })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'keep working' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    const loaded = await c.request(3, 'session/load', {
      sessionId, cwd: process.cwd(), mcpServers: [],
      _meta: { agentProfile: preset, rememberAgentPreset: true },
    })
    expect(loaded.error).toMatchObject({ code: -32602, message: 'agent-preset-locked: cannot change preset while a turn is running' })
    expect(registry.byId.get(sessionId)).toBe(agent)
    expect(agent.internals.cancelCalls).toBe(0)
    expect(agent.internals.disposed).toBe(false)
    expect(presets?.recomposed).toEqual([])
    expect(mutations).toEqual([])
    expect(c.completes).toEqual([])

    pluginCtx.emit('agent/inbox/claimed', { agent, message: agent.internals.messages[0] as UserMessage, turn: 0 })
    pluginCtx.emit('session/event', agent.session, {
      type: 'turn/end', seq: SessionSeq(0), time: Date.now(), data: { turn: 0, reason: { kind: 'completed' } },
    })
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'end_turn' })
    agent.internals.idleWaiters.shift()!()
  })

  it('keeps the live session owned when its reload flush fails', async () => {
    const sessionsStore = { flush: async () => { throw new Error('flush failed') } }
    const { registry, client: c } = await start({ presets: true, sessionsStore })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const live = registry.byId.get(sessionId)!
    const loaded = await c.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toMatchObject({ code: -32603 })
    expect(registry.byId.get(sessionId)).toBe(live)
    expect(live.internals.disposed).toBe(false)
  })

  it('rejects input during reload flush and preserves a usable owner after that flush fails', async () => {
    let entered = false, release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let fail = true
    const sessionsStore = { flush: async () => { if (fail) { entered = true; await held; fail = false; throw new Error('reload storage failed') } } }
    const setPermission = vi.fn(), setPlan = vi.fn()
    const { registry, client: c } = await start({ sessionsStore, permissionPresets: { set: setPermission }, planMode: { set: setPlan } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    try {
      sendRequest(c, 2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
      await waitFor(() => entered)
      for (const [id, method, payload] of [
        [3, 'session/prompt', { prompt: [{ type: 'text', text: 'during reload' }] }],
        [4, 'x.ai/interject', { text: 'during reload' }],
        [5, 'session/set_model', { modelId: 'pi-code' }],
        [7, 'session/set_mode', { modeId: 'plan' }],
      ] as const) {
        expect((await c.request(id, method, { sessionId, ...payload })).error).toMatchObject({ code: -32602, message: 'session is already reloading' })
      }
      c.notify('x.ai/yolo_mode_changed', { sessionId, permission_mode: 'always-approve', yolo_mode: true })
      await c.request(8, 'initialize', {}) // Same socket: notification has been dispatched.
      expect(setPermission).not.toHaveBeenCalled(); expect(setPlan).not.toHaveBeenCalled()
      expect(agent.internals.disposed).toBe(false)
      expect(agent.internals.followups).toEqual([]); expect(agent.internals.steered).toEqual([])
      release()
      expect((await waitForId(c, 2)).error).toMatchObject({ code: -32603, message: expect.stringContaining('reload storage failed') })
      expect(registry.byId.get(sessionId)).toBe(agent)
      expect((await c.request(6, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'after failure' }] })).error).toBeUndefined()
      expect(agent.internals.followups).toEqual(['after failure'])
      c.notify('x.ai/yolo_mode_changed', { sessionId, permission_mode: 'always-approve', yolo_mode: true })
      await waitFor(() => setPermission.mock.calls.length === 1)
      expect(setPermission).toHaveBeenCalledWith(agent.session, 'danger-full-access')
    } finally { release() }
  })

  it('settles an accepted model write before reload preflight and retains the selection in the resumed agent', async () => {
    const { registry, client: c } = await start()
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    let entered = false, release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const save = mockDefaultModel.saveSelection
    const spy = vi.spyOn(mockDefaultModel, 'saveSelection').mockImplementation(async selection => { entered = true; await held; await save(selection) })
    const idle = vi.spyOn(agent, 'whenIdle')
    try {
      sendRequest(c, 2, 'session/set_model', { sessionId, modelId: 'pi-code' })
      await waitFor(() => entered)
      sendRequest(c, 3, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
      await c.request(99, 'initialize', {})
      await waitFor(() => agent.internals.cancelCalls > 0)
      expect(idle).not.toHaveBeenCalled()
      expect(agent.internals.disposed).toBe(false)
      expect(c.all.some(message => message.id === 3)).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toBeUndefined(); expect(replies.get(3)?.error).toBeUndefined()
      expect(agent.internals.disposed).toBe(true)
      expect(registry.byId.get(sessionId)?.options).toMatchObject({ provider: 'pi', model: 'pi-code' })
    } finally { release(); spy.mockRestore(); idle.mockRestore() }
  })

  it('refuses to switch a persisted preset after the session has history', async () => {
    const { registry, persistence, presets, client: c } = await start({ presets: true })
    persistence.events.push({
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'already ran' }] },
    } as SessionEvent)
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toMatchObject({
      code: -32602,
      message: 'agent-preset-locked: a preset can only be changed before the session has produced history',
    })
    expect(registry.resumed).toEqual([])
    expect(presets?.mounted).toEqual([])
  })

  it('does not lock a blank preset switch on log-only session events', async () => {
    const { persistence, presets, client: c } = await start({ presets: true })
    persistence.events.push({
      type: 'request/header',
      seq: 0,
      time: 0,
      data: {},
    } as SessionEvent)
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['minimal'])
  })

  it('executes the advertised raw /preset command only while the session is blank', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/preset minimal' }] })
    expect(switched.error).toBeUndefined()
    expect(switched.result).toMatchObject({ stopReason: 'end_turn' })
    expect(presets?.recomposed).toEqual(['minimal'])
    expect(registry.byId.get(sessionId)?.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
    expect(registry.byId.get(sessionId)?.internals.followups).toEqual([])
  })

  it('serves the roster as /preset options, its preset active, and takes the pick as a command line', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'ptc' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const listed = (await c.request(2, 'x.ai/commands/list', { sessionId })).result as { commands: Array<{ name: string }> }
    expect(listed.commands.find(command => command.name === 'preset')).toMatchObject({ input: { hint: '<preset id>' }, _meta: { options: true } })
    const options = async (id: number) => ((await c.request(id, 'x.ai/commands/options', { sessionId, name: 'preset' })).result as { options: Array<{ id: string; label: string; active?: boolean }> }).options
    const offered = await options(3)
    expect(offered.map(option => [option.id, option.label, option.active === true])).toEqual([
      ['standard', 'Standard mode', false], ['ptc', 'PTC mode', true], ['minimal', 'Minimal mode', false], ['cordis', 'Creator mode', false]])
    expect((await c.request(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/preset minimal' }] })).error).toBeUndefined()
    expect((await options(5)).filter(option => option.active === true).map(option => option.id)).toEqual(['minimal'])
    expect((await c.request(6, 'x.ai/commands/options', { sessionId, name: 'compact' })).error).toMatchObject({ code: -32602 })
    expect((await c.request(7, 'x.ai/commands/options', { name: 'preset' })).error).toMatchObject({ code: -32602 })
  })

  it('blocks new prompts and interjections while a preset recompose is pending', async () => {
    const setPermission = vi.fn()
    const { registry, pluginCtx, client: c } = await start({ presets: true, permissionPresets: { set: setPermission } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const roster = pluginCtx.get('agentPresets')!
    let release!: () => void, entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const recompose = roster.recompose.bind(roster)
    const spy = vi.spyOn(roster, 'recompose').mockImplementation(async (ctx, id) => { entered = true; await held; return recompose(ctx, id) })
    try {
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/preset minimal' }] })
      await waitFor(() => entered)
      for (const [id, method, payload] of [
        [3, 'session/prompt', { prompt: [{ type: 'text', text: 'do not admit yet' }] }],
        [4, 'x.ai/interject', { text: 'do not steer yet' }],
        [5, 'x.ai/commands/run', { prompt: [{ type: 'text', text: '/goal do not start yet' }] }],
        [6, 'x.ai/btw', { question: 'do not delegate yet' }],
        [7, 'session/set_mode', { modeId: 'plan' }],
      ] as const) {
        const reply = await c.request(id, method, { sessionId, ...payload })
        expect(reply.error).toMatchObject({ code: -32602, message: 'agent-preset-locked: a preset change is in progress' })
      }
      expect(agent.internals.followups).toEqual([])
      expect(agent.internals.steered).toEqual([])
      c.notify('x.ai/yolo_mode_changed', { sessionId, permission_mode: 'always-approve' })
      await c.request(8, 'initialize', {})
      expect(setPermission).not.toHaveBeenCalled()
      release()
      expect((await waitForId(c, 2)).error).toBeUndefined()
    } finally { release(); spy.mockRestore() }
  })

  it('session/close drains an accepted preset default write before native disposal', async () => {
    let release!: () => void, entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const settings = { mutate: async () => { entered = true; await held } }
    const { registry, client: c } = await start({ presets: true, settings })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    try {
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/preset minimal' }] })
      await waitFor(() => entered)
      const notifications = c.all.length
      sendRequest(c, 3, 'session/close', { sessionId })
      await c.request(99, 'initialize', {})
      expect(agent.internals.disposed).toBe(false)
      expect(c.all.some(message => message.id === 3)).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602, message: 'session closed' })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(agent.internals.disposed).toBe(true)
      expect(mockSessionsStore.flushed).toContain(agent.session)
      expect(c.all.slice(notifications).some(message => message.method === 'session/update'
        && JSON.stringify(message).includes('Switched to preset'))).toBe(false)
    } finally { release() }
  })

  it('keeps the persisted preset on session/load when no preset is explicitly requested', async () => {
    const { presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['standard'])
  })

  it('defaults a preset-less session to the roster default', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd(), agentPreset: 'standard' }])
    expect(presets?.mounted).toEqual(['standard'])
  })

  it('does not advertise subagents when the selected preset exposes no delegation tool', async () => {
    const { client: c } = await start({
      presets: true,
      subagents: { list: () => ['spawn'] },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'standard' },
    })
    expect(created.error).toBeUndefined()
    await waitFor(() => c.all.some(message => {
      const update = (message.params as { update?: { sessionUpdate?: string; _meta?: { capabilities?: string[] } } } | undefined)?.update
      return update?.sessionUpdate === 'available_commands_update'
        && update._meta?.capabilities?.includes('subagents') === false
    }))
  })

  it('advertises plugin-added delegation from the actual tool surface, independent of preset id', async () => {
    const { client: c } = await start({
      presets: true,
      tools: { schemas: () => [{ name: 'subagent' }] },
      subagents: { list: () => ['spawn'] },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'minimal' },
    })
    expect(created.error).toBeUndefined()
    await waitFor(() => c.all.some(message => {
      const update = (message.params as { update?: { sessionUpdate?: string; _meta?: { capabilities?: string[] } } } | undefined)?.update
      return update?.sessionUpdate === 'available_commands_update'
        && update._meta?.capabilities?.includes('subagents') === true
    }))
  })

  it('falls back to the default preset for grok built-ins and rejects JSON-object agent selections', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const unknown = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'grok-build-plan' } })
    expect(unknown.error).toBeUndefined()
    const objectProfile = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: { name: 'custom' } } })
    expect(objectProfile.error).toMatchObject({ code: -32602, message: '_meta.agentProfile JSON definitions are not supported; send a preset id string' })
    const typo = await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'stanard' } })
    expect(typo.error).toMatchObject({ code: -32602 })
    const noSubagents = await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'grok-build-plan-no-subagents' } })
    expect(noSubagents.error).toMatchObject({
      code: -32602,
      message: '--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead',
    })
  })

  it('creates editable declaration bundles and refuses unowned or shipped edit requests', async () => {
    const { ctx, client: c, registry } = await start({ presets: true })
    const directory = await mkdtemp(resolve(tmpdir(), 'dscode-preset-copy-'))
    ctx.effect(() => () => rm(directory, { recursive: true, force: true }))
    ctx.provide('profileContext', { dir: directory, home: directory } as never)
    const definition = { id: 'standard', plugins: [{ name: '@deepseek-ai/dsh-tool-bash' }] }
    ctx.provide('configEditor', { entries: () => [{ options: { name: '@deepseek-ai/dsh-agent-preset', config: definition }, parent: { tree: { ctx: {} } } }] } as never)
    const roster = ctx.get('agentPresets') as unknown as Record<string, unknown>
    const rows = new Map([['standard', definition]])
    Object.assign(roster, {
      list: async () => [...rows.keys()].map(id => ({ id })),
      resolve: async (id = 'standard') => { if (!rows.has(id)) throw new Error('Unknown preset'); return { id } },
      register: async (row: typeof definition) => { rows.set(row.id, row); return () => { rows.delete(row.id) } },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: '/tmp/project', mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const original = registry.byId.get(sessionId)
    expect((await c.request(2, 'x.ai/presets', { action: 'copy', from: 'standard', id: 'custom' })).error?.code).toBe(-32602)
    expect((await c.request(3, 'x.ai/presets', { sessionId, action: 'copy', from: 'standard', id: '../escape' })).error?.code).toBe(-32602)
    expect(rows.size).toBe(1)
    expect((await c.request(4, 'x.ai/presets', { sessionId, action: 'copy', from: 'standard', id: 'custom' })).error).toBeUndefined()
    expect(rows.get('custom')).toMatchObject({ id: 'custom', plugins: definition.plugins })
    expect((await c.request(5, 'x.ai/presets', { sessionId, action: 'edit', id: 'standard' })).error?.code).toBe(-32602)
    expect((await c.request(6, 'x.ai/presets', { sessionId, action: 'read', id: 'standard' })).result).toMatchObject({ document: { id: 'standard', content: expect.stringContaining('@deepseek-ai/dsh-tool-bash') } })
    expect((await c.request(7, 'x.ai/presets', { sessionId, action: 'edit', id: 'custom' })).result).toMatchObject({ document: { id: 'custom', editPath: resolve(directory, 'preset-bundles/custom/cordis.patch.yml') } })
    expect(JSON.parse(readFileSync(resolve(directory, 'preset-bundles/custom/package.json'), 'utf8')).dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(registry.byId.get(sessionId)).toBe(original)
  })
})
