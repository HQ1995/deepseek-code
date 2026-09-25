import { describe, expect, it } from 'vitest'
import { commandLine, commandResult, commandResultNotice, commandResults, type CommandFold } from '../src/command-results.ts'
import { event } from './support/session-events.ts'

const run = (commandId: string, name: string, args?: string) => event('command/run', { commandId, name, ...args === undefined ? {} : { args }, source: { kind: 'user' } })
const done = (commandId: string, data: Record<string, unknown>) => event('command/done', { commandId, ...data })

describe('command results from their durable records', () => {
  it('pairs each command/done with its command/run by commandId, interleaved and in either kind', () => {
    const fold: CommandFold = new Map()
    expect(commandResults(fold, run('a', 'goal', ' pause'))).toEqual([])
    expect(commandResults(fold, run('b', 'dsh', ' plugins'))).toEqual([])
    expect(commandResults(fold, event('assistant/message', {}))).toEqual([])
    expect(commandResults(fold, done('b', { kind: 'success', text: '| bundle | on |' }))).toEqual([
      { sessionUpdate: 'command_result', name: 'dsh', args: 'plugins', kind: 'success', text: '| bundle | on |' }])
    expect(commandResults(fold, done('a', { kind: 'error', text: 'No goal is currently set' }))).toEqual([
      { sessionUpdate: 'command_result', name: 'goal', args: 'pause', kind: 'error', text: 'No goal is currently set' }])
    // Settled runs are released; a repeated settlement pairs with nothing.
    expect(fold.size).toBe(0)
    expect(commandResults(fold, done('a', { kind: 'success', text: 'again' }))).toEqual([])
  })

  it('shows nothing for a text-less success an earlier event presents, and a bare header otherwise', () => {
    const fold: CommandFold = new Map()
    commandResults(fold, run('compact', 'compact', ''))
    expect(commandResults(fold, done('compact', { kind: 'success', sourceEventSeq: 7 }))).toEqual([])
    expect(fold.size).toBe(0)
    // With its own text the result still shows, beside the event it names.
    commandResults(fold, run('compact-2', 'compact'))
    expect(commandResults(fold, done('compact-2', { kind: 'success', text: 'Compacted 3 history items.', sourceEventSeq: 7 }))).toEqual([
      { sessionUpdate: 'command_result', name: 'compact', kind: 'success', text: 'Compacted 3 history items.' }])
    // An unrecorded input (`recordInput: false`) and no text: the command's header alone.
    commandResults(fold, run('plan', 'plan'))
    expect(commandResults(fold, done('plan', { kind: 'success' }))).toEqual([{ sessionUpdate: 'command_result', name: 'plan', kind: 'success' }])
  })

  it('ignores unpaired, malformed and unknown-kind records without keeping them', () => {
    const fold: CommandFold = new Map()
    expect(commandResults(fold, done('missing', { kind: 'success', text: 'orphan' }))).toEqual([])
    expect(commandResults(fold, event('command/run', null))).toEqual([])
    expect(commandResults(fold, event('command/run', { commandId: 'x', name: '' }))).toEqual([])
    expect(commandResults(fold, event('command/done', null))).toEqual([])
    commandResults(fold, run('odd', 'goal'))
    expect(commandResults(fold, done('odd', { kind: 'cancelled', text: 'no' }))).toEqual([])
    expect(fold.size).toBe(0)
  })

  it('resolves a settlement against runs another reader kept (a child history page)', () => {
    const runs = new Map([['early', { name: 'feedback', args: ' great tool' }]])
    expect(commandResult(done('early', { kind: 'success', text: 'Feedback recorded' }), id => runs.get(id))).toEqual(
      { sessionUpdate: 'command_result', name: 'feedback', args: 'great tool', kind: 'success', text: 'Feedback recorded' })
    expect(commandResult(run('early', 'feedback'), id => runs.get(id))).toBeUndefined()
  })

  it('sends DSH text as plain text and marks a bridge-owned result as Markdown', () => {
    const fold: CommandFold = new Map()
    commandResults(fold, run('g', 'goal', ' pause'))
    expect(commandResults(fold, done('g', { kind: 'error', text: 'Usage: /goal [<objective>|clear]' }))[0]).not.toHaveProperty('markdown')
    expect(commandResultNotice('dsh', 'plugins', 'success', '| a | b |', true)).toEqual(
      { sessionUpdate: 'command_result', name: 'dsh', args: 'plugins', kind: 'success', text: '| a | b |', markdown: true })
  })

  it('reads a bridge-owned command line into its name and input', () => {
    expect(commandLine('  /DSH  enable  @acme/x#row ')).toEqual({ name: 'dsh', args: 'enable  @acme/x#row' })
    expect(commandLine('/team')).toEqual({ name: 'team' })
    expect(commandLine('/subagents queue child\nsecond line')).toEqual({ name: 'subagents', args: 'queue child\nsecond line' })
    expect(commandLine('plain')).toBeUndefined()
  })
})
