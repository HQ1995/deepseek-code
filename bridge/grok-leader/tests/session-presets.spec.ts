import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createSessionPresets, type AgentPresetsLike } from '../src/session-presets.ts'
import { presetHistory } from '../src/preset-history.ts'
import { event } from './support/session-events.ts'

function fixture() {
  const order: string[] = [], sessions = new Map<string, { clientId: number; agent: Agent; queue: { busy: boolean } }>()
  const choices = new Map<Context, string>()
  const histories = new WeakMap<Agent, { header: { agentPreset: string }; events: SessionEvent[] }>()
  const entries = [
    { id: 'standard' },
    { id: 'minimal' },
    { id: 'custom', name: 'Custom', description: 'User-authored', path: '/tmp/custom/preset.yml', trust: 'user' as const },
  ]
  const roster = {
    list: vi.fn(async () => entries),
    resolve: vi.fn(async (id = 'standard') => {
      const selected = entries.find(preset => preset.id === (id === 'alias' ? 'minimal' : id))
      if (selected === undefined) throw new Error('missing: ' + id)
      return selected
    }),
    mount: vi.fn(async (ctx: Context, id = 'standard') => { choices.set(ctx, id); order.push('mount:' + id) }),
    recompose: vi.fn(async (ctx: Context, id: string) => { choices.set(ctx, id); order.push('recompose:' + id) }),
    composedPreset: (ctx: Context) => choices.get(ctx),
    read: vi.fn(async (id: string) => 'id: ' + id),
    copy: vi.fn(async (from: string, id: string) => { order.push('copy:' + from + '/' + id) }),
  }
  const settings = {
    describe: vi.fn(() => [] as Array<{ ns: string; user: unknown }>),
    mutate: vi.fn(async (_ns: string, ops: Array<{ value?: unknown }>) => { order.push('remember:' + String(ops[0]?.value)) }),
  }
  const flush = vi.fn(async (_session: Agent['session']) => { order.push('flush') })
  let availableRoster: AgentPresetsLike | undefined = roster
  let availableSettings: typeof settings | undefined = settings
  const host = {
    roster: () => availableRoster, settings: () => availableSettings, flush,
    history: (record: { agent: Agent }) => { const source = histories.get(record.agent)!; return presetHistory(source.header, source.events) },
    isLive: (record: { agent: Agent }) => sessions.get(record.agent.session.id) === record,
    owned: (clientId: number, id: SessionId | undefined) => { const record = sessions.get(String(id)); return record?.clientId === clientId ? record : undefined },
    unblocked: vi.fn((_record: { clientId: number; agent: Agent; queue: { busy: boolean } }) => {}),
  }
  const presets = createSessionPresets(host)
  function add(id = 'root', preset = 'standard', events: SessionEvent[] = []) {
    const ctx = new Context(), header = { agentPreset: preset }
    const append = vi.fn((type: string, data: unknown) => {
      order.push('append:' + (data as { agentPreset: string }).agentPreset)
      const next = event(type, data); events.push(next); return next
    })
    const agent = { id, ctx, status: 'idle', session: { id: SessionId(id), header, snapshotEvents: () => { throw new Error('preset controls must not read history') }, append } } as unknown as Agent
    histories.set(agent, { header, events })
    const record = { clientId: 1, agent, queue: { busy: false } }
    sessions.set(id, record); choices.set(ctx, preset)
    return { record, events, append, ctx, source: { header, events } }
  }
  return { presets, host, roster, settings, sessions, choices, order, flush, add,
    setRoster: (next?: AgentPresetsLike) => { availableRoster = next }, setSettings: (next?: typeof settings) => { availableSettings = next } }
}

describe('session preset ownership', () => {
  it('keeps lazy optional composition and resolves only the known grok fallbacks', async () => {
    const f = fixture()
    f.setRoster()
    const absent = await f.presets.prepare({ kind: 'new', meta: { agentPreset: 'anything' } })
    expect(absent.agentPreset).toBeUndefined(); expect(absent.mount).toBeUndefined()
    expect((await f.presets.status()).personas).toEqual([])
    f.setRoster(f.roster)
    const fallback = await f.presets.prepare({ kind: 'new', meta: { agentProfile: 'grok-build-plan' } })
    expect(fallback.agentPreset).toBe('standard')
    await expect(f.presets.prepare({ kind: 'new', meta: { agentProfile: 'typo' } })).rejects.toThrow('unknown agent preset')
    await expect(f.presets.prepare({ kind: 'new', meta: { agentProfile: 'grok-build-plan-no-subagents' } })).rejects.toThrow('--no-subagents')
    await expect(f.presets.prepare({ kind: 'new', meta: { agentProfile: {} } })).rejects.toThrow('JSON definitions')
    await expect(f.presets.prepare({ kind: 'new', meta: { agentPreset: 1 } })).rejects.toThrow('must be a string')
    expect((await f.presets.prepare({ kind: 'new', meta: { agentProfile: 'typo', agentPreset: 'minimal' } })).agentPreset).toBe('minimal')
  })

  it('remembers a real explicit new choice only on a one-shot successful adoption', async () => {
    const f = fixture(), { record, ctx } = f.add()
    const prepared = await f.presets.prepare({ kind: 'new', meta: { agentPreset: 'minimal', rememberAgentPreset: true } })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    await prepared.mount!(ctx)
    const first = prepared.commit(record)
    expect(prepared.commit(record)).toBe(first)
    await first
    expect(f.order).toEqual(['mount:minimal', 'remember:minimal'])
    await expect(prepared.commit(f.add('other').record)).rejects.toThrow('another session')
    for (const meta of [{ agentPreset: 'alias', rememberAgentPreset: true }, { agentProfile: 'grok-build-plan', rememberAgentPreset: true }, { agentPreset: 'minimal' }]) {
      await (await f.presets.prepare({ kind: 'new', meta })).commit(f.add(String(f.sessions.size)).record)
    }
    expect(f.settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('inherits latest durable selection on fork/load and does not replace it with an unknown grok profile', async () => {
    const f = fixture(), source = { header: { agentPreset: 'standard' }, events: [event('agent-preset/selected', { agentPreset: 'minimal' }), event('agent-preset/selected', { agentPreset: '' })] }
    expect((await f.presets.prepare({ kind: 'fork', source })).agentPreset).toBe('minimal')
    expect((await f.presets.prepare({ kind: 'load', source, meta: { agentProfile: 'grok-build-plan' } })).agentPreset).toBe('minimal')
    await expect(f.presets.prepare({ kind: 'load', source, meta: { agentPreset: 'typo' } })).rejects.toThrow('unknown agent preset')
  })

  it('commits a cold switch after adoption, flushes it, then remembers the default', async () => {
    const f = fixture(), { record, source, events } = f.add()
    const prepared = await f.presets.prepare({ kind: 'load', source, meta: { agentPreset: 'minimal', rememberAgentPreset: true } })
    expect(f.order).toEqual([])
    await prepared.commit(record)
    expect(f.order).toEqual(['append:minimal', 'flush', 'remember:minimal'])
    expect(events.at(-1)).toMatchObject({ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } })
    expect(f.roster.recompose).not.toHaveBeenCalled()
  })

  it('refuses in-place switches into or out of a preset whose Team tools attach on open', async () => {
    const f = fixture(), roster = { ...f.roster, attachesOnOpen: vi.fn(async (id: string) => id === 'custom') }
    f.setRoster(roster)
    const { record } = f.add()
    await expect(f.presets.command(record, '/preset custom')).rejects.toThrow('Preset "custom" attaches Agent Team tools when a session opens')
    const team = f.add('team', 'custom').record
    await expect(f.presets.command(team, '/preset minimal')).rejects.toThrow('Reopen this session with the preset you want')
    expect(f.order).toEqual([])
    // A live reopen recreates the agent under the new preset, so it stays allowed.
    const live = f.add('live')
    const prepared = await f.presets.prepare({ kind: 'load', source: live.source, live: live.record, meta: { agentPreset: 'custom' } })
    expect(prepared.agentPreset).toBe('custom')
    await expect(f.presets.command(record, '/preset minimal')).resolves.toContain('Switched')
  })

  it('locks all model-visible history but not log-only events; reselecting a busy live session is also locked', async () => {
    const f = fixture()
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      await expect(f.presets.prepare({ kind: 'load', source: { header: { agentPreset: 'standard' }, events: [event(type)] }, meta: { agentPreset: 'minimal' } })).rejects.toThrow('produced history')
    }
    expect((await f.presets.prepare({ kind: 'load', source: { header: { agentPreset: 'standard' }, events: [event('request/header')] }, meta: { agentPreset: 'minimal' } })).agentPreset).toBe('minimal')
    const { record, source } = f.add()
    record.queue.busy = true
    await expect(f.presets.prepare({ kind: 'load', live: record, source, meta: { agentPreset: 'standard' } })).rejects.toThrow('while a turn is running')
    expect(f.roster.recompose).not.toHaveBeenCalled()
  })

  it('rejects a missing projection before recomposition instead of falling back to a log scan', async () => {
    const f = fixture(), { record } = f.add()
    f.host.history = () => { throw new Error('preset history projection is unavailable') }
    await expect(f.presets.command(record, '/preset minimal')).rejects.toThrow('projection is unavailable')
    expect(f.roster.recompose).not.toHaveBeenCalled()
  })

  it('rolls back an append failure, preserves the original error, and permits a later switch', async () => {
    const f = fixture(), { record, append, events, ctx } = f.add(), failure = new Error('append failed')
    append.mockImplementationOnce(() => { throw failure })
    await expect(f.presets.command(record, '/preset minimal')).rejects.toBe(failure)
    expect(f.choices.get(ctx)).toBe('standard'); expect(events).toEqual([])
    expect(f.order).toEqual(['recompose:minimal', 'recompose:standard'])
    await expect(f.presets.command(record, '/preset minimal')).resolves.toContain('Switched')
    expect(f.order.slice(2)).toEqual(['recompose:minimal', 'append:minimal', 'flush', 'remember:minimal'])
  })

  it('reports both append and rollback errors without claiming a successful selection', async () => {
    const f = fixture(), { record, append } = f.add(), failure = new Error('append failed'), rollback = new Error('rollback failed')
    append.mockImplementationOnce(() => { throw failure })
    f.roster.recompose.mockImplementationOnce(async () => {}).mockRejectedValueOnce(rollback)
    await expect(f.presets.command(record, '/preset minimal')).rejects.toMatchObject({ errors: [failure, rollback] })
    expect(f.flush).not.toHaveBeenCalled(); expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(() => f.presets.assertReady(record)).toThrow('close and reload')
    await expect(f.presets.command(record, '/preset standard')).rejects.toThrow('close and reload')
  })

  it('rolls back a live switch when flush fails so composition stays on the previous preset', async () => {
    const f = fixture(), { record, source, ctx, events } = f.add()
    f.flush.mockRejectedValueOnce(new Error('flush failed'))
    await expect(f.presets.prepare({ kind: 'load', live: record, source, meta: { agentPreset: 'minimal' } })).rejects.toThrow('flush failed')
    expect(f.choices.get(ctx)).toBe('standard')
    expect(f.order).toEqual(['recompose:minimal', 'append:minimal', 'recompose:standard'])
    expect(events).toHaveLength(1)
    f.presets.assertReady(record)
  })

  it('retains and flushes the committed live choice when remembering the default fails', async () => {
    const f = fixture(), { record, source, events, ctx } = f.add()
    f.settings.mutate.mockRejectedValueOnce(new Error('settings unavailable'))
    await expect(f.presets.prepare({ kind: 'load', live: record, source, meta: { agentPreset: 'minimal', rememberAgentPreset: true } })).rejects.toThrow('failed to remember preset')
    expect(f.choices.get(ctx)).toBe('minimal')
    expect(events).toHaveLength(1); expect(f.flush).toHaveBeenCalledWith(record.agent.session)
    expect(f.roster.recompose).toHaveBeenCalledTimes(1)
    f.presets.assertReady(record)
  })

  it('reserves a transition before async lookup, isolates simultaneous sessions, and reports each ended change', async () => {
    const f = fixture(), a = f.add('a'), b = f.add('b'), lookup = Promise.withResolvers<void>(), ready: boolean[] = []
    f.host.unblocked.mockImplementation(record => { ready.push((() => { try { f.presets.assertReady(record); return true } catch { return false } })()) })
    f.roster.resolve.mockImplementationOnce(async () => { await lookup.promise; return { id: 'minimal', name: 'Minimal', trust: 'system' } })
    const first = f.presets.command(a.record, '/preset minimal')
    expect(() => f.presets.assertReady(a.record)).toThrow('in progress')
    await expect(f.presets.command(a.record, '/preset custom')).rejects.toThrow('in progress')
    await expect(f.presets.prepare({ kind: 'load', source: a.source, live: a.record })).rejects.toThrow('in progress')
    await expect(f.presets.command(b.record, '/preset minimal')).resolves.toContain('Switched')
    lookup.resolve(); await first
    f.presets.assertReady(a.record)
    // Refused attempts never held the session; each change that ran reports its end once, already ready.
    expect(f.host.unblocked.mock.calls.map(([record]) => record)).toEqual([b.record, a.record])
    expect(ready).toEqual([true, true])
  })

  it('does not recompose a retired owner after lookup and drains the accepted request', async () => {
    const f = fixture(), { record } = f.add(), lookup = Promise.withResolvers<void>()
    f.roster.resolve.mockImplementationOnce(async () => { await lookup.promise; return { id: 'minimal', name: 'Minimal', trust: 'system' } })
    const work = f.presets.command(record, '/preset minimal'), outcome = expect(work).rejects.toThrow('session closed')
    f.sessions.delete('root')
    let done = false
    const retirement = f.presets.retire(record).then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    lookup.resolve(); await outcome; await retirement
    expect(f.roster.recompose).not.toHaveBeenCalled(); expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('rolls back a completed recompose if the owner closes or a native turn starts during it', async () => {
    for (const retire of [true, false]) {
      const f = fixture(), { record, ctx, events } = f.add(), gate = Promise.withResolvers<void>()
      f.roster.recompose.mockImplementationOnce(async (ctx, id) => { f.choices.set(ctx, id); await gate.promise })
      const work = f.presets.command(record, '/preset minimal')
      const outcome = expect(work).rejects.toThrow(retire ? 'session closed' : 'produced history')
      await vi.waitFor(() => expect(f.roster.recompose).toHaveBeenCalledTimes(1))
      if (retire) { f.sessions.delete('root'); void f.presets.retire(record) } else events.push(event('user/message'))
      gate.resolve(); await outcome
      expect(f.choices.get(ctx)).toBe('standard'); expect(f.flush).not.toHaveBeenCalled()
    }
  })

  it('drains a default write accepted before reentrant shutdown and emits no late success', async () => {
    const f = fixture(), { record } = f.add(), gate = Promise.withResolvers<void>()
    let disposal: Promise<void> | undefined, retirement: Promise<void> | undefined, stopped = false
    f.settings.mutate.mockImplementationOnce(async () => {
      f.sessions.delete('root')
      retirement = f.presets.retire(record)
      disposal = f.presets.dispose(); void disposal.then(() => { stopped = true })
      await gate.promise
    })
    const work = f.presets.command(record, '/preset minimal'), outcome = expect(work).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(disposal).toBeDefined())
    expect(stopped).toBe(false); expect(f.presets.dispose()).toBe(disposal)
    expect(f.presets.retire(record)).toBe(retirement)
    gate.resolve(); await outcome; await disposal; await retirement
    expect(stopped).toBe(true); expect(f.flush).toHaveBeenCalledTimes(1)
  })

  it('drains mounting and rejects late preparation after global disposal', async () => {
    const f = fixture(), lookup = Promise.withResolvers<void>(), mount = Promise.withResolvers<void>()
    const prepared = await f.presets.prepare({ kind: 'new' })
    f.roster.mount.mockImplementationOnce(async () => { await mount.promise })
    const mounting = prepared.mount!(new Context()), mountOutcome = expect(mounting).rejects.toThrow('disposed')
    f.roster.resolve.mockImplementationOnce(async () => { await lookup.promise; return { id: 'standard', name: 'Standard', trust: 'system' } })
    const preparing = f.presets.prepare({ kind: 'new' }), prepareOutcome = expect(preparing).rejects.toThrow('disposed')
    let stopped = false
    const disposal = f.presets.dispose().then(() => { stopped = true })
    await Promise.resolve(); expect(stopped).toBe(false)
    lookup.resolve(); mount.resolve(); await prepareOutcome; await mountOutcome; await disposal
    await expect(prepared.mount!(new Context())).rejects.toThrow('disposed')
  })

  it('localizes only system presets and enforces scoped copy/read/edit controls', async () => {
    const f = fixture(), { record } = f.add()
    const status = await f.presets.status()
    expect(status.personaDetails[0]?.name).toBe('Standard mode')
    expect(status.personaDetails[2]).toMatchObject({ name: 'Custom', description: 'User-authored' })
    await expect(f.presets.controls(2, { sessionId: 'root' })).rejects.toThrow('owned sessionId')
    await expect(f.presets.controls(1, { sessionId: 'root', action: 'copy', from: 'standard', id: '../escape' })).rejects.toThrow('lowercase')
    await expect(f.presets.controls(1, { sessionId: 'root', action: 'edit', id: 'standard' })).rejects.toThrow('Copy this shipped preset')
    const edited = await f.presets.controls(1, { sessionId: 'root', action: 'edit', id: 'custom' })
    expect(edited.document).toEqual({ id: 'custom', content: 'id: custom', editPath: '/tmp/custom/preset.yml' })
    expect(edited.items[2]?.editable).toBe(true)
    await f.presets.controls(1, { sessionId: 'root', action: 'copy', from: 'standard', id: 'mine' })
    expect(f.roster.copy).toHaveBeenCalledWith('standard', 'mine')
    await f.presets.retire(record)
    await expect(f.presets.controls(1, { sessionId: 'root' })).rejects.toThrow('session closed')
  })

  it('drains an accepted copy but skips follow-up roster reads once its owner closes', async () => {
    const f = fixture(), { record } = f.add(), gate = Promise.withResolvers<void>()
    f.roster.copy.mockImplementationOnce(async () => { await gate.promise })
    const copy = f.presets.controls(1, { sessionId: 'root', action: 'copy', from: 'standard', id: 'mine' })
    const outcome = expect(copy).rejects.toThrow('session closed')
    const stop = f.presets.retire(record)
    gate.resolve(); await outcome; await stop
    expect(f.roster.list).not.toHaveBeenCalled()
  })

  it('does not rewrite an already remembered default and rejects missing optional settings explicitly', async () => {
    const f = fixture(), { record } = f.add()
    f.settings.describe.mockReturnValue([{ ns: 'agent-preset-registry', user: { selectedDefault: 'standard' } }])
    await expect(f.presets.command(record, '/preset standard')).resolves.toContain('is active')
    expect(f.settings.mutate).not.toHaveBeenCalled()
    f.setSettings()
    await expect(f.presets.command(record, '/preset standard')).rejects.toThrow('settings service is not configured')
    await expect(f.presets.command(record, '/preset')).resolves.toContain('Available: standard, minimal, custom')
    await expect(f.presets.command(record, '/preset typo')).rejects.toThrow('Unknown preset "typo".')
  })
})
