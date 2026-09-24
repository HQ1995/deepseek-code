import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { presetHistory, presetHistoryProjection } from '../src/preset-history.ts'
import { event } from './support/session-events.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const store = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
  const stop = projections.register(presetHistoryProjection)
  return { ctx, store, projections, stop, state: (session: Parameters<typeof projections.stateOf>[0]) => projections.stateOf(session, 'dscodePresetHistory') }
}

describe('native preset history projection', () => {
  it('keeps the exact history policy and latest valid selection without retaining event content', () => {
    const header = { agentPreset: 'standard' }
    expect(presetHistory(header, [event('turn/start'), event('request/header')])).toEqual({ selected: 'standard', locked: false })
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      expect(presetHistory(header, [event(type, { largeBody: 'not retained' })])).toEqual({ selected: 'standard', locked: true })
    }
    expect(presetHistory(header, [event('agent-preset/selected', { agentPreset: 'minimal' }), event('agent-preset/selected', { agentPreset: '' })]))
      .toEqual({ selected: 'minimal', locked: false })
  })

  it('drives append state, reuses unchanged state, and does not reread a warm history', () => {
    const f = fixture(), session = f.store.create(SessionId('live'), { meta: { agentPreset: 'standard' } })
    const before = f.state(session)
    const snapshots = vi.spyOn(session, 'snapshotEvents')
    const at = vi.spyOn(session, 'eventAt')
    session.append('agent-preset/selected', { agentPreset: 'minimal' })
    expect(f.state(session)).toEqual({ selected: 'minimal', locked: false })
    expect(f.state(session)).not.toBe(before)
    const selected = f.state(session)
    for (let i = 0; i < 1000; i++) session.append('session/title', { title: 'title ' + i })
    expect(f.state(session)).toBe(selected)
    expect(snapshots).not.toHaveBeenCalled()
    expect(at).not.toHaveBeenCalled()
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(f.state(session)).toEqual({ selected: 'minimal', locked: true })
    // Host-only state must not change the wire contract.
    expect(f.projections.snapshot(session).values).not.toHaveProperty('dscodePresetHistory')
  })

  it('reconstructs identical live, resumed, and inherited-fork policy through the native registry', () => {
    const f = fixture(), root = f.store.create(SessionId('root'), { meta: { agentPreset: 'standard' } })
    root.append('agent-preset/selected', { agentPreset: 'minimal' })
    root.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const seed = root.snapshotEvents()
    const resumed = f.store.create(SessionId('resumed'), { seed, meta: { agentPreset: 'standard' } })
    const forked = f.store.create(SessionId('forked'), { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { agentPreset: 'standard', parentSession: root.id, isSeeded: true } })
    expect(f.state(resumed)).toEqual(f.state(root))
    expect(f.state(forked)).toEqual(f.state(root))
    expect(f.state(root)).toEqual({ selected: 'minimal', locked: true })
    const beforeConversation = seed.slice(0, 1)
    const rewound = f.store.create(SessionId('rewound'), { seed: beforeConversation, inheritedEventCount: SessionLogOffset(1), meta: { agentPreset: 'standard', parentSession: root.id, isSeeded: true } })
    expect(f.state(rewound)).toEqual({ selected: 'minimal', locked: false })
    const check = f.projections.checkpoint(forked).dscodePresetHistory
    expect(check).toMatchObject({ ver: 1, val: { selected: 'minimal', locked: true } })
  })

  it('invalidates native cached state when the registration retires and rebuilds on remount', () => {
    const f = fixture(), session = f.store.create(SessionId('remount'))
    session.append('agent-preset/selected', { agentPreset: 'minimal' })
    expect(f.state(session)).toEqual({ selected: 'minimal', locked: false })
    f.stop()
    expect(f.state(session)).toBeUndefined()
    f.projections.register(presetHistoryProjection)
    expect(f.state(session)).toEqual({ selected: 'minimal', locked: false })
  })
})
