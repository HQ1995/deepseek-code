/** Host-served command options: DSH's SelectOption rows, their bounds, and
 * the pure rows of /goal and /subagents. */
import { describe, expect, it } from 'vitest'
import { boundOptions, confirmation, goalOptions } from '../src/command-options.ts'
import { subagentOptions, type ChildRow } from '../src/child-controls.ts'

describe('command options', () => {
  it('bounds what leaves the bridge: one-line text, whole ids, one active row', () => {
    const rows = boundOptions([
      { id: ' standard ', label: 'Standard\nmode', detail: 'x'.repeat(400), badge: 'custom\tpreset', active: true },
      { id: 'minimal', label: 'Minimal', active: true, next: true },
      { id: 'bad\nid', label: 'Dropped' },
      { id: 'y'.repeat(513), label: 'Dropped too' },
      { id: 'blank', label: ' ‮ ' },
      { id: '', label: 'Bare', detail: '  ', confirmation: confirmation('Sure?\n', 'It\u0007 goes.', 'Go') },
    ])
    expect(rows).toEqual([
      { id: 'standard', label: 'Standard mode', detail: 'x'.repeat(299) + '…', badge: 'custom preset', active: true },
      { id: 'minimal', label: 'Minimal', next: true },
      { id: '', label: 'Bare', confirmation: { title: 'Sure?', description: 'It goes.', acknowledgeLabel: 'I understand', cancelLabel: 'Cancel', confirmLabel: 'Go' } },
    ])
    expect(boundOptions(Array.from({ length: 250 }, (_, index) => ({ id: String(index), label: 'row' })))).toHaveLength(200)
  })

  it('offers the goal controls DSH accepts in each phase', () => {
    const goal = (phase: 'active' | 'paused' | 'blocked' | 'complete', activation: 'armed' | 'disarmed' = 'armed') =>
      goalOptions({ objective: 'ship it', phase, activation }).map(option => option.id)
    expect(goalOptions(undefined)).toEqual([])
    expect(goal('active')).toEqual(['', 'pause', 'clear'])
    expect(goal('active', 'disarmed')).toEqual(['', 'resume', 'clear'])
    expect(goal('paused')).toEqual(['', 'resume', 'clear'])
    expect(goal('blocked')).toEqual(['', 'resume', 'clear'])
    expect(goal('complete')).toEqual(['', 'clear'])
    const [show, , clear] = goalOptions({ objective: 'ship it', phase: 'active', activation: 'armed' })
    expect(show).toMatchObject({ label: 'Show the goal', detail: 'ship it' })
    expect(clear?.confirmation).toMatchObject({ title: 'Clear the goal?', confirmLabel: 'Clear' })
  })

  it('offers the child list, then one continuable child\'s controls', () => {
    const rows: ChildRow[] = [
      { kind: 'child', id: 'child-a', mode: 'continuable', label: 'review' },
      { kind: 'child', id: 'child-b', mode: 'continuable', label: 'teammate row' },
      { kind: 'child', id: 'child-c', mode: 'one-shot', label: 'once' },
      { kind: 'diagnostic', id: 'broken', reason: 'unreadable' },
    ]
    const members = [{ id: 'child-b', name: 'ada' }]
    const running = (id: string) => id === 'child-a'
    expect(subagentOptions(rows, members, running, '')).toEqual([
      { id: 'list', label: 'List child conversations' },
      { id: 'child-a', label: 'review', detail: 'child-a', badge: 'running', next: true },
      { id: 'child-b', label: 'ada', detail: 'child-b', next: true },
    ])
    expect(subagentOptions(rows, members, running, 'child-a').map(option => option.id)).toEqual(['pending child-a', 'stop child-a', 'clear child-a'])
    // A teammate's queued input is Team mailbox delivery: no clear.
    expect(subagentOptions(rows, members, running, 'child-b').map(option => option.id)).toEqual(['pending child-b', 'stop child-b'])
    expect(subagentOptions(rows, members, running, 'child-b')[1]?.confirmation?.title).toBe('Stop ada?')
    for (const query of ['child-c', 'broken', 'child']) expect(subagentOptions(rows, members, running, query)).toEqual([])
    expect(subagentOptions([rows[3]!], [], running, '')).toEqual([])
  })
})
