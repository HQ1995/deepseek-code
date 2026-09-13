import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionCommands, type NativeCommands, type NativeSkills } from '../src/session-commands.ts'
import { createSessionWork, type SessionWork } from '../src/session-work.ts'
import { parsePrompt } from '../src/prompt-content.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())) })
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type TestSession = { agent: Agent; clientId: number; work: SessionWork; output: { update: ReturnType<typeof vi.fn> } }
function fixture(disposalError?: string) {
  const sessions = new Map<SessionId, TestSession>(), events = new Map<string, () => void>(), unsubscribes: Array<ReturnType<typeof vi.fn>> = []
  const clients = new Map([[1, { closed: false, notify: vi.fn() }], [2, { closed: false, notify: vi.fn() }]])
  const inputReady = { value: true }, list = vi.fn<NativeCommands['list']>(() => [])
  const execute = vi.fn<NativeCommands['execute']>(async () => undefined)
  const skills = vi.fn<NativeSkills['list']>(async () => [])
  const roster = vi.fn(async () => [{ id: 'standard' }, { id: 'minimal' }])
  const native = { value: true }, rosterAvailable = { value: true }
  const host = {
    sessions, owned: (clientId: number, id: SessionId | undefined) => {
      const record = id === undefined ? undefined : sessions.get(id)
      return record?.clientId === clientId ? record : undefined
    },
    client: (id: number) => clients.get(id),
    registry: vi.fn(() => native.value ? { list, execute } : undefined),
    roster: vi.fn(() => rosterAvailable.value ? { list: roster } : undefined),
    skills: vi.fn((_record: TestSession) => ({ list: skills })), capabilities: vi.fn(() => ['skills', 'subagents']),
    profile: { execute: vi.fn(async (_text: string, _notify: (message: string) => void) => 'profile done') },
    preset: vi.fn(async (_record: TestSession, _text: string) => 'preset done'),
    children: { command: vi.fn(async (_clientId: number, _params: unknown) => ({ result: { kind: 'success', text: 'children done' } })) },
    goals: { goal: vi.fn(async (_clientId: number, _params: unknown) => ({ result: { kind: 'success', text: 'goal done' } })) },
    on: vi.fn((name: 'commands/change' | 'skills/change', listener: () => void) => {
      events.set(name, listener)
      const unsubscribe = vi.fn(() => { events.delete(name) }); unsubscribes.push(unsubscribe); return unsubscribe
    }), logger: { warn: vi.fn() },
  }
  const commands = createSessionCommands(host)
  stops.push(async () => {
    if (disposalError === undefined) await commands.dispose()
    else await expect(commands.dispose()).rejects.toThrow(disposalError)
    await Promise.all([...sessions.values()].map(record => record.work.dispose()))
  })
  const add = (id: string, clientId = 1) => {
    const record: TestSession = { clientId, agent: { session: { id: SessionId(id), header: { cwd: '/work' } } } as Agent,
      output: { update: vi.fn() }, work: undefined as never }
    record.work = createSessionWork({ isLive: () => sessions.get(SessionId(id)) === record && clients.get(clientId)?.closed === false,
      assertReady: () => { if (!inputReady.value) throw new Error('initializing') } })
    sessions.set(SessionId(id), record)
    return record
  }
  const record = add('one')
  const request = (text: string, recordToUse = record, images = false) => {
    const params = { sessionId: String(recordToUse.agent.session.id), _meta: { promptId: 'command-id' },
      prompt: [{ type: 'text', text }, ...images ? [{ type: 'image', mimeType: 'image/png', data: 'aA==' }] : []] }
    return commands.execute(recordToUse, params, parsePrompt(params.prompt))
  }
  return { host, commands, record, add, request, list, execute, skills, roster, native, rosterAvailable,
    inputReady, sessions, clients, unsubscribes, emit: (name: string) => events.get(name)?.() }
}

describe('owned session commands', () => {
  it('merges bridge, native and user-invocable skill commands with case-insensitive precedence', async () => {
    const f = fixture()
    f.list.mockReturnValue([{ name: 'DSH', description: 'shadow' }, { name: 'build', description: 'native', input: { hint: 'target' } }])
    f.skills.mockResolvedValue([
      { name: 'BUILD', description: 'shadow native' }, { name: 'hidden', description: 'model only', invocation: { userInvocable: false } },
      { name: 'review', description: 'review code', provider: 'plugin', source: 'project-local', resourceBase: { kind: 'file', path: '/repo/skill' }, invocation: { modelInvocable: false } },
    ])
    const result = await f.commands.catalog(1, { session_id: 'one' })
    expect(result.commands.map(command => command.name)).toEqual(['dsh', 'subagents', 'preset', 'build', 'review'])
    expect(result.commands.at(-1)).toEqual({ name: 'review', description: 'User only · review code', input: { hint: 'Instructions for this skill' },
      _meta: { scope: 'repo', path: '/repo/skill', pluginName: 'plugin' } })
    expect(f.skills).toHaveBeenCalledWith({ cwd: '/work', scope: f.record.agent })
  })

  it('keeps the full skill view independent of slash visibility and owns session validation', async () => {
    const f = fixture()
    f.skills.mockResolvedValue([{ name: 'hidden', description: 'native description', whenToUse: 'work', invocation: { userInvocable: false }, source: 'user-local', path: '/user/skill' }])
    await expect(f.commands.skills(1, { sessionId: 'one' })).resolves.toEqual({ skills: [{
      name: 'hidden', display_name: 'hidden', description: 'native description', short_description: 'native description', when_to_use: 'work',
      has_user_specified_description: false, path: '/user/skill', scope: 'user', user_invocable: false, enabled: true,
    }] })
    await expect(f.commands.catalog(2, { sessionId: 'one' })).rejects.toThrow('unknown session')
    await expect(f.commands.skills(1, { session_id: 'one' })).rejects.toThrow('owned sessionId')
    await expect(f.commands.catalog(undefined, { sessionId: 'one' })).rejects.toThrow('unknown session')
  })

  it('allows initialization catalog reads but rejects command execution until input readiness', async () => {
    const f = fixture(); f.inputReady.value = false
    await expect(f.commands.catalog(1, { sessionId: 'one' })).resolves.toHaveProperty('commands')
    await expect(f.request('/auto')).rejects.toThrow('initializing')
    expect(f.record.output.update).not.toHaveBeenCalled()
  })

  it('owns unbound catalogs and waits for a roster that ignores shutdown', async () => {
    const f = fixture(), gate = deferred<Array<{ id: string }>>()
    f.roster.mockImplementationOnce(() => gate.promise)
    const catalog = f.commands.catalog(), rejected = expect(catalog).rejects.toThrow('disposed')
    let done = false; const disposal = f.commands.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve([{ id: 'late' }]); await rejected; await disposal
    expect(early).toBe(false)
    for (const unsubscribe of f.unsubscribes) expect(unsubscribe).toHaveBeenCalledOnce()
    expect(f.host.registry).not.toHaveBeenCalled()
  })

  it('does not continue discovery after a cancelled session generation becomes usable again', async () => {
    const f = fixture(), gate = deferred<Array<{ id: string }>>()
    f.roster.mockImplementationOnce(() => gate.promise)
    const catalog = f.commands.catalog(1, { sessionId: 'one' }), rejected = expect(catalog).rejects.toThrow('session closed')
    f.record.work.cancel(); gate.resolve([{ id: 'late' }]); await rejected
    expect(f.list).not.toHaveBeenCalled(); expect(f.skills).not.toHaveBeenCalled()
    await expect(f.commands.catalog(1, { sessionId: 'one' })).resolves.toHaveProperty('commands')
  })

  it('coalesces changes during a slow roster read and never publishes the stale advertisement last', async () => {
    const f = fixture(), gate = deferred<Awaited<ReturnType<NativeSkills['list']>>>(), entered = deferred()
    f.list.mockReturnValue([{ name: 'old', description: 'old' }])
    f.skills.mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    const first = f.commands.refresh(f.record); await entered.promise
    f.list.mockReturnValue([{ name: 'fresh', description: 'fresh' }])
    f.emit('commands/change'); f.emit('skills/change')
    expect(f.commands.refresh(f.record)).toBe(first)
    gate.resolve([]); await first
    const notify = f.clients.get(1)!.notify
    expect(notify).toHaveBeenCalledOnce()
    const [method, params] = notify.mock.calls[0]!
    expect(method).toBe('session/update')
    expect(params.update.availableCommands.map((command: { name: string }) => command.name)).toEqual(['dsh', 'subagents', 'preset', 'fresh'])
    expect(params.update.meta).toEqual({ capabilities: ['skills', 'subagents'] })
    expect(params).not.toHaveProperty('promptId'); expect(params).not.toHaveProperty('eventSeq')
    expect(f.record.output.update).not.toHaveBeenCalled(); expect(f.skills).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh refresh when a change arrives after the preceding notification', async () => {
    const f = fixture(), notify = f.clients.get(1)!.notify
    f.list.mockReturnValue([{ name: 'old', description: 'old' }])
    notify.mockImplementationOnce(() => { queueMicrotask(() => {
      f.list.mockReturnValue([{ name: 'new', description: 'new' }]); f.emit('commands/change')
    }) })
    await f.commands.refresh(f.record); await tick()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![1].update.availableCommands.at(-1).name).toBe('new')
  })

  it('isolates failed refreshes and allows later native change events to retry', async () => {
    const f = fixture(), other = f.add('other', 2)
    f.skills.mockImplementation(async ({ scope }) => { if (scope === f.record.agent) throw new Error('one failed'); return [] })
    f.emit('skills/change'); await tick()
    expect(f.clients.get(2)!.notify).toHaveBeenCalledOnce()
    expect(f.clients.get(1)!.notify).not.toHaveBeenCalled()
    expect(f.host.logger.warn).toHaveBeenCalledWith('command discovery failed: one failed')
    f.skills.mockResolvedValue([]); await f.commands.refresh(f.record)
    expect(f.clients.get(1)!.notify).toHaveBeenCalledOnce()
    await other.work.dispose()
  })

  it('does not add an async hop for ordinary prompts or unknown commands without a registry', async () => {
    const f = fixture()
    expect(f.request('hello')).toBeUndefined(); expect(f.host.registry).not.toHaveBeenCalled()
    f.native.value = false
    expect(f.request('/unknown')).toBeUndefined()
    expect(f.request('/constructor')).toBeUndefined()
    expect(f.request('/__proto__')).toBeUndefined()
    expect(f.record.output.update).not.toHaveBeenCalled()
  })

  it('leaves image admission to native commands and settles their replies without completing the active model turn', async () => {
    const f = fixture()
    f.execute.mockResolvedValue({ result: { kind: 'success', text: 'native reply' } })
    await expect(f.request(' /native text ', f.record, true)).resolves.toEqual({ stopReason: 'end_turn', _meta: { sessionId: 'one', promptId: 'command-id' } })
    expect(f.execute).toHaveBeenCalledWith(f.record.agent, '/native text', [expect.objectContaining({ mediaType: 'image/png' })], expect.any(AbortSignal))
    expect(f.record.output.update).toHaveBeenCalledWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native reply' } }, false, expect.any(Number))
    expect(f.clients.get(1)!.notify).not.toHaveBeenCalled()
  })

  it.each(['/auto', '/delete', '/remember'])('keeps %s ahead of plugins and refuses image attachments', async command => {
    const f = fixture()
    await expect(f.request(command)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.record.output.update.mock.calls[0]![0].content.text).toContain(command)
    await expect(f.request(command, f.record, true)).rejects.toThrow('does not accept image attachments')
  })

  it('offers compact to native commands first and only then emits the fallback', async () => {
    const f = fixture()
    f.execute.mockResolvedValueOnce({ result: { kind: 'success', text: 'compacted' } })
    await f.request('/compact')
    expect(f.record.output.update.mock.calls[0]![0].content.text).toBe('compacted')
    await f.request('/compact')
    expect(f.record.output.update.mock.calls[1]![0].content.text).toContain('Manual compaction is unavailable')
    await expect(f.request('/compact', f.record, true)).rejects.toThrow('does not accept image attachments')
  })

  it('preserves reserved-command casing and delegates native child and goal controls', async () => {
    const f = fixture()
    f.host.children.command.mockResolvedValueOnce({ result: { kind: 'error', text: 'child failed' } })
    await f.request('/SUBAGENTS list'); await f.request('/GOAL show')
    expect(f.host.children.command).toHaveBeenCalledOnce(); expect(f.host.goals.goal).toHaveBeenCalledOnce()
    expect(f.record.output.update.mock.calls[0]![0].content.text).toBe('error: child failed')
    expect(f.execute).not.toHaveBeenCalled()
    await f.request('/DSH plugins')
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.host.profile.execute).not.toHaveBeenCalled()
  })

  it('keeps profile progress and preset refresh turnless while retaining their existing mutation owners', async () => {
    const f = fixture()
    f.host.profile.execute.mockImplementationOnce(async (_text, notify) => { notify('auditing'); return 'installed' })
    await f.request('/dsh add plugin'); await f.request('/preset minimal'); await tick()
    expect(f.record.output.update.mock.calls.map(call => call[0].content.text)).toEqual(['auditing', 'installed', 'preset done'])
    expect(f.host.preset).toHaveBeenCalledWith(f.record, '/preset minimal')
    expect(f.clients.get(1)!.notify.mock.calls.map(call => call[1].update.sessionUpdate)).toEqual(['available_commands_update'])
    expect(f.execute).not.toHaveBeenCalled()
    await expect(f.request('/dsh plugins', f.record, true)).rejects.toThrow('image attachments')
    await expect(f.request('/preset minimal', f.record, true)).rejects.toThrow('image attachments')
  })

  it('suppresses late profile progress and replies after a failed reload restores the same record', async () => {
    const f = fixture(), gate = deferred()
    f.host.profile.execute.mockImplementationOnce(async (_text, notify) => { notify('before'); await gate.promise; notify('late'); return 'late result' })
    const result = f.request('/dsh plugins')!, rejected = expect(result).rejects.toThrow('session closed')
    f.record.work.cancel(); gate.resolve(); await rejected
    expect(f.record.output.update.mock.calls.map(call => call[0].content.text)).toEqual(['before'])
    await expect(f.request('/auto')).resolves.toHaveProperty('stopReason', 'end_turn')
  })

  it('never lets a cancelled unknown native command become model fallback', async () => {
    const f = fixture(), gate = deferred()
    f.execute.mockImplementationOnce(async () => { await gate.promise; return undefined })
    const result = f.request('/unknown')!, rejected = expect(result).rejects.toThrow('session closed')
    const signal = f.execute.mock.calls[0]![3]
    f.record.work.cancel(); gate.resolve(); await rejected
    expect(signal.aborted).toBe(true); expect(f.record.output.update).not.toHaveBeenCalled()
  })

  it('aborts native commands on disposal but waits for real completion and preserves native failure', async () => {
    const f = fixture(), gate = deferred(), error = new Error('native failed')
    f.execute.mockImplementationOnce(async () => { await gate.promise; throw error })
    const result = f.request('/native')!, rejected = expect(result).rejects.toBe(error)
    let done = false; const disposal = f.commands.dispose().then(() => { done = true })
    const signal = f.execute.mock.calls[0]![3]
    await tick(); const early = done
    gate.resolve(); await rejected; await disposal
    expect(signal.aborted).toBe(true); expect(early).toBe(false)
    expect(f.record.output.update).not.toHaveBeenCalled()
  })

  it('publishes disposal before unsubscribe reentry and attempts every cleanup hook', async () => {
    const f = fixture('command subscriptions failed to dispose')
    let reentered!: Promise<void>
    f.unsubscribes[0]!.mockImplementationOnce(() => { reentered = f.commands.dispose(); throw new Error('first failed') })
    f.unsubscribes[1]!.mockImplementationOnce(() => { throw new Error('second failed') })
    const disposal = f.commands.dispose()
    expect(reentered).toBe(disposal); expect(f.commands.dispose()).toBe(disposal)
    await expect(disposal).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'first failed' }), expect.objectContaining({ message: 'second failed' })] })
    await expect(f.commands.catalog()).rejects.toThrow('disposed')
    f.emit('commands/change'); await tick()
    expect(f.roster).not.toHaveBeenCalled()
  })

  it('rolls back partial subscription construction without starting reentrant discovery', async () => {
    const f = fixture(), unsubscribe = vi.fn(), error = new Error('registration failed')
    await f.commands.dispose()
    expect(() => createSessionCommands({ ...f.host, on: (name, listener) => {
      listener()
      if (name === 'skills/change') throw error
      return unsubscribe
    } })).toThrow(error)
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(f.roster).not.toHaveBeenCalled()
  })
})
