/** Leader socket spec: leader commands, skills and runtime rails. */
import { describe, expect, it, vi } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { collectIds, makeClient, packageVersion, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader commands, skills and runtime rails', () => {
  const start = useLeaderHarness()

  it('scopes skill discovery to each session and advertises only user-invocable skills', async () => {
    const reads: Array<{ cwd?: string; scope: unknown }> = []
    const { registry, client: c } = await start({
      skills: {
        list: async (lookup: { cwd?: string; scope: unknown }) => {
          reads.push(lookup)
          return [
            { name: lookup.cwd?.endsWith('/alpha') ? 'alpha-skill' : 'beta-skill', description: 'Scoped skill' },
            { name: 'manual-only', description: 'Explicit instructions', invocation: { userInvocable: true, modelInvocable: false } },
            { name: 'model-only', description: 'Model instructions', invocation: { userInvocable: false, modelInvocable: true } },
            { name: 'dsh', description: 'Must not shadow the host command' },
          ]
        },
      },
    })
    register(c)
    await c.next()
    const alpha = await c.request(1, 'session/new', { cwd: '/tmp/alpha', mcpServers: [] })
    const beta = await c.request(2, 'session/new', { cwd: '/tmp/beta', mcpServers: [] })
    const ids = [alpha, beta].map(response => (response.result as { sessionId: string }).sessionId)
    for (const [i, sessionId] of ids.entries()) {
      const listed = await c.request(10 + i, 'x.ai/skills/list', { sessionId })
      const skills = (listed.result as { skills: Array<{ name: string; description: string; user_invocable: boolean }> }).skills
      expect(skills[0].name).toBe(i === 0 ? 'alpha-skill' : 'beta-skill')
      expect(skills.find(skill => skill.name === 'manual-only')?.description).toContain('User only')
      expect(skills.find(skill => skill.name === 'model-only')?.user_invocable).toBe(false)
      expect(reads.some(read => read.scope === registry.byId.get(sessionId)
        && read.cwd === (i === 0 ? '/tmp/alpha' : '/tmp/beta'))).toBe(true)
      const catalog = await c.request(20 + i, 'x.ai/commands/list', { sessionId })
      const commands = (catalog.result as { commands: Array<{ name: string; description: string; _meta?: Record<string, unknown> }> }).commands
      expect(commands.find(command => command.name === skills[0].name)?._meta).toMatchObject({ scope: 'plugin', path: '', pluginName: 'dsh' })
      expect(commands.some(command => command.name === 'manual-only')).toBe(true)
      expect(commands.some(command => command.name === 'model-only')).toBe(false)
      expect(commands.filter(command => command.name === 'dsh')).toHaveLength(1)
      expect(commands.find(command => command.name === 'dsh')?.description).not.toContain('shadow')
    }
    const missing = await c.request(30, 'x.ai/skills/list', {})
    expect(missing.error).toMatchObject({ code: -32602 })
  })

  it('reports missing optional dependencies without model work, and flags a selected LSP preset', async () => {
    const { ctx, registry, client: c } = await start({ presets: true })
    Object.assign(ctx.get('agentPresets') as object, { resolve: async (id = 'standard') => ({ id }) })
    const resolved: string[] = []
    Object.assign(new (class extends Service {})(ctx, 'subprocess'), {
      resolveExecutable: async (command: string) => { resolved.push(command); throw new Error('missing executable') },
      spawnTerminal: () => { throw new Error('doctor must not start a PTY') },
    })
    Object.assign(new (class extends Service {})(ctx, 'terminals'), { listBackends: () => ['shell'], list: () => [] })
    register(c); await c.next()
    expect((await c.request(1, 'x.ai/doctor', { tuiVersion: '0.0.14-alpha.3' })).error?.code).toBe(-32602)
    for (const preset of ['standard', 'lsp']) {
      const created = await c.request(2, 'session/new', { cwd: '/tmp/doctor', mcpServers: [], _meta: { agentProfile: preset } })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const response = await c.request(3, 'x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.3' })
      expect(response.error).toBeUndefined()
      const text = (response.result as { text: string }).text
      expect(text).toContain(`[${preset === 'lsp' ? 'ERROR' : 'INFO'}] Shipped LSP preset: Optional dependencies missing`)
      expect(text).toContain('[OK] PTY backend: shell backend registered')
      expect(registry.byId.get(sessionId)!.internals.messages).toEqual([])
    }
    expect(resolved).toEqual(['typescript-language-server', 'tsc', 'typescript-language-server', 'tsc'])
  })

  it('keeps terminal inspection and controls scoped to the exact owner and awaits close', async () => {
    const { ctx, registry, client: c, socketPath } = await start({ presets: true })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: '/tmp/terminal', mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const owner = registry.byId.get(sessionId)
    let live = true, failClose = true
    const signals: string[] = []
    const reads: object[] = []
    Object.assign(new (class extends Service {})(ctx, 'terminals'), {
      list: (agent: unknown) => agent === owner && live ? [{ sessionId: 'pty-1', name: 'retained', type: 'shell', status: { kind: 'running' } }] : [],
      read: (agent: unknown, id: string, options: object) => {
        expect(agent).toBe(owner); expect(id).toBe('pty-1'); reads.push(options)
        return { text: 'retained output', lineBegin: 0, lineEnd: 1, totalLines: 1, truncated: false }
      },
      signal: async (agent: unknown, id: string, signal: string) => {
        expect(agent).toBe(owner); expect(id).toBe('pty-1'); signals.push(signal)
      },
      kill: async (agent: unknown, id: string) => {
        expect(agent).toBe(owner); expect(id).toBe('pty-1')
        if (failClose) throw new Error('backend close failed')
        await Promise.resolve(); live = false
      },
    })
    const foreign = await makeClient(socketPath)
    try {
      register(foreign); await foreign.next()
      for (const action of ['list', 'interrupt', 'close']) {
        expect((await foreign.request(2, 'x.ai/terminals', { sessionId, action, terminalId: 'pty-1' })).error?.code).toBe(-32602)
        const unknown = await c.request(3, 'x.ai/terminals', { sessionId, action, terminalId: 'foreign' })
        if (action === 'list') expect(unknown.result).toMatchObject({ items: [{ id: 'pty-1', text: 'retained' }] })
        else expect(unknown.error?.code).toBe(-32602)
      }
      expect(reads).toEqual([]); expect(signals).toEqual([])
      const read = await c.request(4, 'x.ai/terminals', { sessionId, terminalId: 'pty-1' })
      expect(read.result).toMatchObject({ items: [{ id: 'pty-1', detail: 'pty-1 · shell · shell alive' }] })
      expect(reads).toEqual([{ count: 1000 }])
      await c.request(5, 'x.ai/terminals', { sessionId, terminalId: 'pty-1', action: 'interrupt' })
      expect(signals).toEqual(['SIGINT']); expect(live).toBe(true)
      expect((await c.request(6, 'x.ai/terminals', { sessionId, terminalId: 'pty-1', action: 'close' })).error).toBeDefined()
      expect(live).toBe(true)
      failClose = false
      expect((await c.request(7, 'x.ai/terminals', { sessionId, terminalId: 'pty-1', action: 'close' })).result).toMatchObject({ items: [] })
      expect(live).toBe(false)
      expect((await c.request(8, 'x.ai/terminals', { sessionId, terminalId: 'pty-1' })).result).toMatchObject({ items: [] })
    } finally { foreign.socket.destroy() }
  })

  it('closing a session stops runtime diagnostics before later execution-host lookups and PTY projection', async () => {
    let release!: () => void, signal: AbortSignal | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { ctx, client: c } = await start()
    const resolveExecutable = vi.fn(async (_command: string, _env: object, received: AbortSignal) => {
      signal = received; await gate; return '/host/executable'
    })
    const listBackends = vi.fn(() => ['shell'])
    Object.assign(new (class extends Service {})(ctx, 'subprocess'), { resolveExecutable, spawnTerminal: vi.fn() })
    Object.assign(new (class extends Service {})(ctx, 'terminals'), { listBackends, list: () => [] })
    try {
      register(c); await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      sendRequest(c, 2, 'x.ai/doctor', { sessionId, tuiVersion: packageVersion })
      await waitFor(() => signal !== undefined)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => signal?.aborted === true)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(resolveExecutable).toHaveBeenCalledOnce()
      expect(listBackends).not.toHaveBeenCalled()
    } finally { release() }
  })

  it.each(['resetToAuto', 'reset_to_auto'])('signals automatic title refresh on session close and waits before flush (%s)', async resetKey => {
    let release!: () => void, entered = false, signal: AbortSignal | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const flush = vi.fn(async () => {})
    const { registry, client: c } = await start({ sessionsStore: { flush }, sessionTitle: {
      rename: vi.fn(), refresh: async (_session: unknown, received?: AbortSignal) => { entered = true; signal = received; await gate },
    } })
    try {
      register(c); await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
      sendRequest(c, 2, 'x.ai/session/rename', { sessionId, [resetKey]: true })
      await waitFor(() => entered)
      const cancellations = agent.internals.cancelCalls
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => agent.internals.cancelCalls > cancellations)
      const aborted = signal?.aborted === true, flushedEarly = flush.mock.calls.length, disposedEarly = agent.internals.disposed
      release()
      const replies = await collectIds(c, [2, 3])
      expect(aborted).toBe(true); expect(flushedEarly).toBe(0); expect(disposedEarly).toBe(false)
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(flush).toHaveBeenCalledOnce(); expect(agent.internals.disposed).toBe(true)
    } finally { release() }
  })

  it('drains an accepted reference query before session close releases the native owner', async () => {
    let release!: () => void, signal: AbortSignal | undefined
    const gate = new Promise<void>(resolve => { release = resolve }), flush = vi.fn(async () => {})
    const { ctx, registry, client: c } = await start({ sessionsStore: { flush } })
    const query = vi.fn(async (_agent: Agent, _query: string, received: AbortSignal) => { signal = received; await gate; return [] })
    ctx.provide('sessionReferenceResolver', { remoteExportCandidates: query } as never)
    try {
      register(c); await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
      sendRequest(c, 2, 'x.ai/session/references', { sessionId, query: 'needle' })
      await waitFor(() => signal !== undefined)
      expect(query).toHaveBeenCalledWith(agent, 'needle', signal)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => signal?.aborted === true)
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 }); expect(replies.get(3)?.error).toBeUndefined()
      expect(flush).toHaveBeenCalledOnce(); expect(agent.internals.disposed).toBe(true)
    } finally { release() }
  })

  it('drives the auxiliary dscode rails end to end for one owned session', async () => {
    const planStates: boolean[] = []
    const renamed: string[] = []
    let titleRefreshes = 0
    let subagentDisposed = false
    const { registry, client: c } = await start({
      presets: true,
      mcpServers: [{ serverName: 'github', transport: 'stdio' }, { serverName: 'filesystem', transport: 'streamable-http' }],
      planMode: { set: (_agent: unknown, active: boolean) => { planStates.push(active) } },
      sessionTitle: {
        rename: (_session: unknown, title: string) => { renamed.push(title) },
        refresh: async () => { titleRefreshes += 1 },
      },
      tools: {
        schemas: () => [
          { name: 'mcp__github__search' },
          { name: 'mcp__github__issues' },
          { name: 'mcp__filesystem__read' },
          { name: 'bash' },
          { name: 'subagent' },
        ],
      },
      skills: {
        list: async () => [{
          name: 'review-code',
          description: 'Review a change',
          whenToUse: 'When code needs review',
          path: '/skills/review-code',
          invocation: { userInvocable: true, modelInvocable: true },
        }],
      },
      subagents: {
        list: () => ['spawn'],
        start: async (provider: string, request: { prompt: Array<{ text: string }> }) => {
          expect(provider).toBe('spawn')
          expect(request.prompt).toEqual([{ type: 'text', text: 'check this independently' }])
          return {
            result: Promise.resolve({ output: [{ type: 'text', text: 'independent answer' }], stopReason: 'completed' }),
            dispose: async () => { subagentDisposed = true },
          }
        },
      },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'standard' },
    })
    const sessionId = (created.result as { sessionId: string }).sessionId

    expect((await c.request(2, 'session/set_mode', { sessionId, modeId: 'plan' })).result).toEqual({})
    expect((await c.request(3, 'session/set_mode', { sessionId, modeId: 'default' })).result).toEqual({})
    expect(planStates).toEqual([true, false])

    expect((await c.request(4, 'x.ai/session/rename', { sessionId, title: 'Reviewed session' })).result).toEqual({})
    expect((await c.request(5, 'x.ai/session/rename', { sessionId, resetToAuto: true })).result).toEqual({})
    expect(renamed).toEqual(['Reviewed session'])
    expect(titleRefreshes).toBe(1)

    const skills = await c.request(6, 'x.ai/skills/list', { sessionId })
    expect(skills.result).toEqual({
      skills: [{
        name: 'review-code',
        display_name: 'review-code',
        description: 'Review a change',
        has_user_specified_description: false,
        when_to_use: 'When code needs review',
        short_description: 'Review a change',
        path: '/skills/review-code',
        scope: 'plugin',
        user_invocable: true,
        enabled: true,
      }],
    })
    const mcp = await c.request(7, 'x.ai/mcp/list', { sessionId })
    expect(mcp.result).toMatchObject({
      servers: [
        { name: 'github', _meta: { toolCount: 2 }, session: { status: 'unknown' } },
        { name: 'filesystem', _meta: { toolCount: 1 }, session: { status: 'unknown' } },
      ],
    })

    const btw = await c.request(8, 'x.ai/btw', { sessionId, question: 'check this independently' })
    expect(btw.result).toEqual({ result: { answer: 'independent answer' } })
    expect(subagentDisposed).toBe(true)

    expect((await c.request(9, 'x.ai/marketplace/list', {})).result).toEqual({ sources: [] })
    expect((await c.request(10, 'x.ai/workflows/list', {})).result).toEqual({ workflows: [] })
    expect((await c.request(11, 'x.ai/billing', {})).result).toEqual({ config: null, onDemandEnabled: false, subscriptionTier: null })
    expect((await c.request(12, 'x.ai/suggestPrompt', { generation: 7 })).result).toEqual({ suggestion: null, generation: 7 })
    const info = await c.request(13, 'x.ai/session/info', { sessionId })
    expect(info.result).toMatchObject({
      result: {
        sessionId,
        cwd: process.cwd(),
        turns: 0,
        context: { available: false, capacityAvailable: false, breakdownAvailable: false, autoCompactThresholdAvailable: false },
      },
    })

    const forkId = '11111111-1111-4111-8111-111111111111'
    const forked = await c.request(14, 'x.ai/session/fork', {
      sourceSessionId: sessionId,
      newSessionId: forkId,
      newCwd: process.cwd(),
    })
    expect(forked.result).toEqual({ newSessionId: forkId })
    expect(registry.byId.has(forkId)).toBe(true)
    expect(registry.created.at(-1)).toEqual({ sessionId: forkId, cwd: process.cwd(), agentPreset: 'standard' })

    // Extension-modal tabs the pager always offers: an unimplemented method
    // shows up as "couldn't load hooks/plugins: method not found".
    expect((await c.request(15, 'x.ai/hooks/list', {})).result).toEqual({ hooks: [], projectTrusted: false, loadErrors: [] })
    expect((await c.request(16, 'x.ai/plugins/list', {})).result).toEqual({ plugins: [] })
  })

  it('surfaces dsh-registry commands as slash commands and routes them to execute()', async () => {
    const executed: string[] = []
    const commandImages: unknown[][] = []
    const commandSignals: boolean[] = []
    const commandsService = {
      list: () => [{ name: 'greet', description: 'Say hello', input: { hint: '<name>', images: true } }],
      execute: async (_agent: unknown, line: string, images: unknown[], signal: AbortSignal) => {
        const parsed = /^\/greet(\s+(.*))?$/.exec(line)
        if (parsed === null) return undefined
        executed.push(line)
        commandImages.push(images)
        commandSignals.push(signal instanceof AbortSignal)
        return { commandId: 'c1', result: { kind: 'success', text: 'hello ' + (parsed[2] ?? 'world') } }
      },
    }
    const { registry, client: c } = await start({ commands: commandsService })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // The registry command is advertised to the session (ACP
    // available_commands_update) alongside the builtin bridge commands.
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && (m.params as { update?: { sessionUpdate?: string; availableCommands?: Array<{ name: string }> } }).update?.sessionUpdate === 'available_commands_update'
      && ((m.params as { update?: { availableCommands?: Array<{ name: string }> } }).update?.availableCommands ?? []).some(entry => entry.name === 'greet')))
    const listed = await c.request(10, 'x.ai/commands/list', { sessionId })
    expect(((listed.result as { commands: Array<{ name: string }> }).commands).map(command => command.name)).toContain('greet')

    // A registered command routes to execute() and never reaches the model.
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/greet dscode' }], _meta: { promptId: 'greet-1' } })
    const settled = await waitForId(c, 2)
    expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'greet-1' } })
    expect(executed).toEqual(['/greet dscode'])
    expect(commandImages).toEqual([[]])
    expect(commandSignals).toEqual([true])
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '') === 'hello dscode'))
    expect(agent.internals.followups).toEqual([])

    // rc.2 commands receive raw composer images before their registry performs
    // command-specific durable admission.
    sendRequest(c, 3, 'session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: '/greet picture' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'end_turn' })
    expect(executed).toEqual(['/greet dscode', '/greet picture'])
    expect(commandImages[1]).toEqual([{ data: 'AQID', mediaType: 'image/png' }])
    expect(commandSignals).toEqual([true, true])

    // Unknown slash text falls through to the model unchanged.
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/nope do it' }] })
    await waitFor(() => agent.internals.followups.includes('/nope do it'))
    agent.internals.idleWaiters.shift()?.()
    await waitForId(c, 4)
  })

  it.each([false, true])('passes prototype-named unknown slash commands to the model (native registry: %s)', async withRegistry => {
    const execute = vi.fn(async () => undefined)
    const { registry, client: c } = await start(withRegistry ? { commands: { list: () => [], execute } } : {})
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const texts = ['/constructor inspect this', '/__proto__ inspect that']
    for (const [index, text] of texts.entries()) {
      const result = await c.request(index + 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      expect(result.error).toBeUndefined()
      // The turnless model mock settles cancelled at idle, unlike a handled
      // native command. The exact followups below prove model admission.
      expect(result.result).toMatchObject({ stopReason: 'cancelled' })
    }
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual(texts)
    expect(execute).toHaveBeenCalledTimes(withRegistry ? 2 : 0)
  })

  it('coalesces registry changes across a delayed skill read before advertising over the socket', async () => {
    let release!: () => void, entered = false, name = 'initial'
    const gate = new Promise<void>(resolve => { release = resolve })
    const list = vi.fn(async () => [] as Array<{ name: string; description: string }>)
    const { ctx, client: c } = await start({
      commands: { list: () => [{ name, description: name }], execute: async () => undefined },
      skills: { list },
    })
    const advertisements = () => c.all.flatMap(message => {
      const params = message.params as { sessionId: string; update?: { sessionUpdate?: string; availableCommands?: Array<{ name: string }> } } | undefined
      return message.method === 'session/update' && params?.update?.sessionUpdate === 'available_commands_update' ? [params] : []
    })
    try {
      register(c); await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      expect(created.error).toBeUndefined()
      await waitFor(() => advertisements().some(params => params.update?.availableCommands?.some(command => command.name === 'initial')))
      const before = advertisements().length
      list.mockImplementationOnce(async () => { entered = true; await gate; return [] })
      name = 'stale'
      ctx.emit('commands/change' as never)
      await waitFor(() => entered)
      name = 'fresh'
      ctx.emit('commands/change' as never); ctx.emit('skills/change' as never)
      release()
      await waitFor(() => advertisements().some(params => params.update?.availableCommands?.some(command => command.name === 'fresh')))
      const updates = advertisements().slice(before)
      expect(updates).toHaveLength(1)
      expect(updates[0]!.update?.availableCommands?.map(command => command.name)).toEqual(['dsh', 'browser', 'subagents', 'fresh'])
      expect(updates[0]).not.toHaveProperty('eventSeq'); expect(updates[0]).not.toHaveProperty('promptId')
      expect(list).toHaveBeenCalledTimes(3)
    } finally { release() }
  })

  it.each([
    ['x.ai/commands/run', '/goal status'], ['session/prompt', '/guard'],
  ])('session/close drains an accepted %s command before final flush without blocking another session', async (method, line) => {
    let release!: () => void, signal: AbortSignal | undefined
    const held = new Promise<void>(resolve => { release = resolve }), order: string[] = []
    const flush = vi.fn(async () => { order.push('flush') })
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown, accepted: AbortSignal) => {
      signal = accepted; await held; order.push('native finished')
      return { result: { kind: 'success', text: 'late command result' } }
    })
    const { registry, client: c } = await start({ commands: { list: () => [], execute }, sessionsStore: { flush } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    flush.mockClear(); order.length = 0
    try {
      sendRequest(c, 2, method, { sessionId, prompt: [{ type: 'text', text: line }] })
      await waitFor(() => signal !== undefined)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => signal?.aborted === true)
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      expect((await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [] })).error).toBeUndefined()
      expect(c.all.some(message => message.id === 3)).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602, message: 'session closed' })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(order.indexOf('native finished')).toBeLessThan(order.indexOf('flush'))
      expect(agent.internals.disposed).toBe(true)
    } finally { release() }
  })

  it('reload drains an unknown slash lookup and prevents its late fallback from becoming model input', async () => {
    let release!: () => void, signal: AbortSignal | undefined, fail = true
    const held = new Promise<void>(resolve => { release = resolve }), order: string[] = []
    const flush = vi.fn(async () => { order.push('flush'); if (fail) { fail = false; throw new Error('reload flush failed') } })
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown, accepted: AbortSignal) => {
      signal = accepted; await held; order.push('lookup finished'); return undefined
    })
    const { registry, client: c } = await start({ commands: { list: () => [], execute }, sessionsStore: { flush } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    try {
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/unknown held' }] })
      await waitFor(() => signal !== undefined)
      sendRequest(c, 3, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
      await waitFor(() => signal?.aborted === true)
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 })
      expect(replies.get(3)?.error).toMatchObject({ code: -32603, message: expect.stringContaining('reload flush failed') })
      expect(order).toEqual(['lookup finished', 'flush'])
      expect(agent.internals.followups).toEqual([])
      expect(registry.byId.get(sessionId)).toBe(agent)
      expect((await c.request(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'recovered' }] })).error).toBeUndefined()
      expect(agent.internals.followups).toEqual(['recovered'])
    } finally { release() }
  })

  it('close releases an already-returned btw handle while its result is still pending', async () => {
    let releaseResult!: () => void, releaseDispose!: () => void
    let signal: AbortSignal | undefined, disposing = false
    const result = new Promise<{ output: Array<{ type: string; text: string }>; stopReason: string }>(resolve => {
      releaseResult = () => { resolve({ output: [], stopReason: 'cancelled' }) }
    })
    const disposal = new Promise<void>(resolve => { releaseDispose = resolve })
    const dispose = vi.fn(async () => { disposing = true; await disposal })
    const flush = vi.fn(async () => {})
    const { registry, client: c } = await start({
      tools: { schemas: () => [{ name: 'subagent' }] }, sessionsStore: { flush },
      subagents: { list: () => ['spawn'], start: async (_provider: string, request: { signal: AbortSignal }) => {
        signal = request.signal; return { result, dispose }
      } },
    })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    try {
      sendRequest(c, 2, 'x.ai/btw', { sessionId, question: 'held result' })
      await waitFor(() => signal !== undefined)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => signal?.aborted === true)
      // A same-socket dispatch barrier, not a sleep-based assertion.
      await c.request(4, 'x.ai/session/info', { sessionId })
      const releasedBeforeResult = disposing
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      releaseResult(); await waitFor(() => disposing)
      expect(flush).not.toHaveBeenCalled(); expect(c.all.some(message => message.id === 3)).toBe(false)
      releaseDispose()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(flush).toHaveBeenCalledOnce(); expect(agent.internals.disposed).toBe(true)
      expect(releasedBeforeResult).toBe(true); expect(dispose).toHaveBeenCalledOnce()
    } finally { releaseResult(); releaseDispose() }
  })

  it('close releases a late btw handle before parent flush without waiting for its cancelled result', async () => {
    let releaseStart!: () => void, releaseDispose!: () => void, rejectResult!: (error: unknown) => void
    let signal: AbortSignal | undefined, disposing = false
    const starting = new Promise<void>(resolve => { releaseStart = resolve })
    const disposal = new Promise<void>(resolve => { releaseDispose = resolve })
    const result = new Promise<never>((_resolve, reject) => { rejectResult = reject })
    const flush = vi.fn(async () => {})
    const { registry, client: c } = await start({
      tools: { schemas: () => [{ name: 'subagent' }] }, sessionsStore: { flush },
      subagents: { list: () => ['spawn'], start: async (_provider: string, request: { signal: AbortSignal }) => {
        signal = request.signal; await starting
        return { result, dispose: async () => { disposing = true; await disposal } }
      } },
    })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId, agent = registry.byId.get(sessionId)!
    try {
      sendRequest(c, 2, 'x.ai/btw', { sessionId, question: 'held question' })
      await waitFor(() => signal !== undefined)
      sendRequest(c, 3, 'session/close', { sessionId })
      await waitFor(() => signal?.aborted === true)
      expect(flush).not.toHaveBeenCalled(); expect(agent.internals.disposed).toBe(false)
      releaseStart(); await waitFor(() => disposing)
      expect(flush).not.toHaveBeenCalled(); expect(c.all.some(message => message.id === 3)).toBe(false)
      releaseDispose()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602 })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(flush).toHaveBeenCalledOnce(); expect(agent.internals.disposed).toBe(true)
      rejectResult(new Error('late cancelled result'))
    } finally { releaseStart(); releaseDispose() }
  })

  it('discovers and executes the preset-scoped dsh compact command', async () => {
    const executions: Array<{ line: string; images: unknown[]; signal: boolean }> = []
    const commandsService = {
      list: () => [{ name: 'compact', description: 'Compact older conversation history' }],
      execute: async (_agent: unknown, line: string, images: unknown[], signal: AbortSignal) => {
        if (line !== '/compact') return undefined
        executions.push({ line, images, signal: signal instanceof AbortSignal })
        return { commandId: 'compact-1', result: { kind: 'success', text: 'No compactable history yet.' } }
      },
    }
    const { registry, client: c } = await start({ commands: commandsService })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    await waitFor(() => c.all.some(message => JSON.stringify(message).includes('"name":"compact"')))
    sendRequest(c, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/compact' }],
      _meta: { promptId: 'compact-prompt' },
    })

    expect((await waitForId(c, 2)).result).toMatchObject({
      stopReason: 'end_turn',
      _meta: { promptId: 'compact-prompt' },
    })
    expect(executions).toEqual([{ line: '/compact', images: [], signal: true }])
    await waitFor(() => c.all.some(message => JSON.stringify(message).includes('No compactable history yet.')))
    expect(agent.internals.followups).toEqual([])
  })

  it('fails a raw compact request closed when the preset has no compact command', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/compact' }],
    })

    expect((await waitForId(c, 2)).error).toMatchObject({ code: -32602, message: 'Manual compaction is unavailable in this session.' })
    expect(c.all.filter(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('Manual compaction'))).toEqual([])
    expect(agent.internals.followups).toEqual([])
  })

  it('advertises the preset command and serves the session prompt history', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()

    const initialize = await c.request(0, 'initialize', { protocolVersion: 1 })
    const meta = (initialize.result as {
      _meta: { cancelRewind: boolean; availableCommands: Array<{ name: string; description: string; input?: { hint: string } }> }
    })._meta
    expect(meta.cancelRewind).toBe(false)
    expect(meta.availableCommands).toEqual([
      { name: 'dsh', description: 'Manage dsh plugins', input: { hint: 'plugins | enable|disable <bundle>[#row] | add [--trust] <package> | remove <name> | inspect <name>' } },
      { name: 'browser', description: 'Turn the isolated browser on or off', input: { hint: 'status | on [--executable <path>] [--origin <origin>]... [--any-origin] | off | origins add|remove <origin>' } },
      { name: 'subagents', description: 'Inspect and control child conversations', input: { hint: 'list | pending <child> | queue|steer <child> <text> | edit|remove|steer-queued|clear|stop <child> ...' }, _meta: { immediate: true } },
      { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | ptc | minimal | cordis' } },
    ])

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await c.next() // consume the echoed user_message_chunk before the next request

    const commands = await c.request(3, 'x.ai/commands/list', { sessionId })
    expect(commands.result).toEqual({
      commands: [
        { name: 'dsh', description: 'Manage dsh plugins', input: { hint: 'plugins | enable|disable <bundle>[#row] | add [--trust] <package> | remove <name> | inspect <name>' } },
        { name: 'browser', description: 'Turn the isolated browser on or off', input: { hint: 'status | on [--executable <path>] [--origin <origin>]... [--any-origin] | off | origins add|remove <origin>' } },
        { name: 'subagents', description: 'Inspect and control child conversations', input: { hint: 'list | pending <child> | queue|steer <child> <text> | edit|remove|steer-queued|clear|stop <child> ...' }, _meta: { immediate: true } },
        { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | ptc | minimal | cordis' } },
      ],
    })

    const history = await c.request(4, 'x.ai/prompt_history', { cwd: process.cwd(), filter_session_id: sessionId })
    expect(history.result).toEqual({ prompts: ['hello'] })
  })
})
