import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionArtifacts, type NativeSessionTitles } from '../src/session-artifacts.ts'
import { createSessionWork } from '../src/session-work.ts'
import { tick } from './support/async.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
function fixture() {
  const ready = { value: true }, client = new AbortController(), configured = { titles: true, client: true }
  const agent = { session: { id: SessionId('one'), header: { cwd: '/workspace' } } } as Agent
  const record = { clientId: 1, agent, output: { context: vi.fn(() => ({ used: 25 })), stats: { turnCount: 3 } },
    work: createSessionWork({ isLive: () => owner === record, assertReady: () => { if (!ready.value) throw new Error('initializing') } }) }
  let owner: typeof record | undefined = record
  const titles = { rename: vi.fn<NativeSessionTitles['rename']>(() => ({ title: 'accepted' })),
    refresh: vi.fn<NonNullable<NativeSessionTitles['refresh']>>(async () => ({ title: 'automatic' })) }
  const host = {
    owned: vi.fn((clientId: number, id: SessionId | undefined) => clientId === 1 && id === 'one' ? owner : undefined),
    client: vi.fn(() => configured.client ? { signal: client.signal } : undefined),
    titles: vi.fn(() => configured.titles ? titles : undefined),
    archive: vi.fn(async (_id: SessionId, _cwd: string, _filename: string, _signal: AbortSignal) => '/workspace/saved.zip'),
  }
  const artifacts = createSessionArtifacts(host)
  stops.push(async () => { await artifacts.dispose(); await record.work.dispose() })
  const archive = (params: object = {}) => artifacts.archive(1, { sessionId: 'one', prompt: [{ type: 'text', text: 'saved.zip' }], ...params })
  const rename = (params: object = {}) => artifacts.rename(1, { sessionId: 'one', title: '  original title  ', ...params })
  return { artifacts, host, record, client, configured, titles, ready, archive, rename,
    replace: () => { owner = { ...record } } }
}

describe('session artifact ownership', () => {
  it('keeps unknown unbound context distinct from live counters without inventing a model', () => {
    const f = fixture()
    expect(f.artifacts.info(1, {})).toEqual({ result: { sessionId: '', cwd: '', turns: 0, turnIndex: 0, model: null,
      context: { available: false, capacityAvailable: false, breakdownAvailable: false, autoCompactThresholdAvailable: false } } })
    expect(f.artifacts.info(1, { sessionId: 'one' })).toEqual({ result: { sessionId: 'one', cwd: '/workspace', turns: 3, turnIndex: 2, model: null, context: { used: 25 } } })
    f.record.output.stats.turnCount = 0
    expect(f.artifacts.info(1, { sessionId: 'one' }).result.turnIndex).toBe(0)
    expect(() => f.artifacts.info(2, { sessionId: 'one' })).toThrow('unknown session')
  })

  it('does not publish information from an owner replaced during context projection', () => {
    const f = fixture()
    f.record.output.context.mockImplementationOnce(() => { f.replace(); return { used: 99 } })
    expect(() => f.artifacts.info(1, { sessionId: 'one' })).toThrow('session closed')
  })

  it('validates archive request shape and exact client ownership before calling the writer', async () => {
    const f = fixture()
    await expect(f.artifacts.archive(2, { sessionId: 'one', prompt: [{ type: 'text', text: 'saved.zip' }] })).rejects.toThrow('owned sessionId')
    for (const prompt of [[], [{ type: 'image', data: 'AQ==' }], [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], [{ type: 'text', text: 5 }]]) {
      await expect(f.archive({ prompt })).rejects.toThrow('one text filename')
    }
    f.configured.client = false
    await expect(f.archive()).rejects.toThrow('owned sessionId')
    expect(f.host.archive).not.toHaveBeenCalled()
  })

  it('delegates archive filenames and cwd unchanged, without moving native file policy into dispatch', async () => {
    const f = fixture()
    f.ready.value = false // an archive read is allowed during initialization
    await expect(f.archive({ prompt: [{ type: 'text', text: '~/A B.zip' }] })).resolves.toEqual({ result: { kind: 'success', text: 'Session archive exported to /workspace/saved.zip' } })
    expect(f.host.archive).toHaveBeenCalledWith('one', '/workspace', '~/A B.zip', expect.any(AbortSignal))
    const collision = Object.assign(new Error('exists'), { code: 'EEXIST' })
    f.host.archive.mockRejectedValueOnce(collision)
    await expect(f.archive()).rejects.toBe(collision)
  })

  it('does not start an archive for an already-aborted client', async () => {
    const f = fixture(); f.client.abort()
    await expect(f.archive()).rejects.toThrow()
    expect(f.host.archive).not.toHaveBeenCalled()
  })

  it('drains an accepted archive after client abort without a late success or rollback', async () => {
    const f = fixture(), gate = Promise.withResolvers<string>()
    f.host.archive.mockReturnValueOnce(gate.promise)
    const request = f.archive(), rejected = expect(request).rejects.toThrow()
    f.client.abort()
    let done = false; const drain = f.record.work.settle().then(() => { done = true })
    await tick(); const early = done
    expect(f.host.archive.mock.calls[0]![3].aborted).toBe(true)
    gate.resolve('/workspace/committed.zip'); await rejected; await drain
    expect(early).toBe(false); expect(f.host.archive).toHaveBeenCalledOnce()
  })

  it('prevents native writes after service lookup reenters owner cancellation', async () => {
    const f = fixture()
    f.host.titles.mockImplementationOnce(() => { f.record.work.cancel(); return f.titles })
    await expect(f.rename()).rejects.toThrow('session closed')
    expect(f.titles.rename).not.toHaveBeenCalled()
    f.host.titles.mockImplementationOnce(() => { f.replace(); return f.titles })
    await expect(f.rename()).rejects.toThrow('session closed')
    expect(f.titles.rename).not.toHaveBeenCalled()
  })

  it('keeps title policy native and accepts both explicit automatic-title spellings', async () => {
    const f = fixture()
    await expect(f.rename()).resolves.toEqual({})
    expect(f.titles.rename).toHaveBeenCalledWith(f.record.agent.session, '  original title  ')
    await expect(f.rename({ resetToAuto: true })).resolves.toEqual({})
    await expect(f.rename({ reset_to_auto: true })).resolves.toEqual({})
    expect(f.titles.refresh).toHaveBeenCalledTimes(2)
    for (const call of f.titles.refresh.mock.calls) {
      expect(call[0]).toBe(f.record.agent.session); expect(call[1]).toBeInstanceOf(AbortSignal)
    }
  })

  it('rejects unavailable title controls and input during initialization', async () => {
    const f = fixture()
    f.ready.value = false
    await expect(f.rename()).rejects.toThrow('initializing')
    expect(f.host.titles).not.toHaveBeenCalled()
    f.ready.value = true
    await expect(f.rename({ title: '  ' })).rejects.toThrow('non-empty string')
    f.host.titles.mockReturnValueOnce({ rename: f.titles.rename } as typeof f.titles)
    await expect(f.rename({ resetToAuto: true })).rejects.toThrow('refresh is not available')
    f.configured.titles = false
    await expect(f.rename()).rejects.toThrow('not configured')
  })

  it('signals title refresh cancellation but still drains its native completion', async () => {
    const f = fixture(), gate = Promise.withResolvers<unknown>()
    f.titles.refresh.mockReturnValueOnce(gate.promise)
    const request = f.rename({ resetToAuto: true }), rejected = expect(request).rejects.toThrow('session closed')
    f.record.work.cancel()
    let done = false; const drain = f.record.work.settle().then(() => { done = true })
    await tick(); const early = done
    expect(f.titles.refresh.mock.calls[0]![1]?.aborted).toBe(true)
    gate.resolve({ title: 'late' }); await rejected; await drain
    expect(early).toBe(false)
  })

  it('preserves a native failure even when shutdown starts before it settles', async () => {
    const f = fixture(), gate = Promise.withResolvers<unknown>(), failure = new Error('title write failed')
    f.titles.rename.mockReturnValueOnce(gate.promise)
    const request = f.rename(), rejected = expect(request).rejects.toBe(failure)
    const drain = f.artifacts.dispose()
    gate.reject(failure); await rejected; await drain
  })

  it.each(['archive', 'rename'] as const)('registers %s before a synchronous native callback can reenter disposal', async kind => {
    const f = fixture(), gate = Promise.withResolvers<unknown>()
    let disposal!: Promise<void>, done = false
    const enter = () => { disposal = f.artifacts.dispose(); void disposal.then(() => { done = true }); return gate.promise }
    if (kind === 'archive') f.host.archive.mockImplementationOnce(async () => { await enter(); return '/late.zip' })
    else f.titles.rename.mockImplementationOnce(enter)
    const request = kind === 'archive' ? f.archive() : f.rename()
    const rejected = expect(request).rejects.toThrow('disposed')
    await tick(); const early = done
    gate.resolve(undefined); await rejected; await disposal
    expect(early).toBe(false); expect(f.artifacts.dispose()).toBe(disposal)
    await expect(f.rename()).rejects.toThrow('disposed')
    expect(() => f.artifacts.info(1, {})).toThrow('disposed')
  })
})
