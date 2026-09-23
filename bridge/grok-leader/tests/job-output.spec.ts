import { expect, it, vi } from 'vitest'
import { jobOutputPatch, jobOutputSnapshot, outputSnapshot } from '../src/job-output.ts'

it('reads retained job output under the session id without consuming the model cursor', () => {
  let text = 'first\n', modelOffset = 0
  const owner = { session: { id: 'owner' } } as never
  const jobs = {
    get: vi.fn(() => ({ output: { total: text.length, earliest: 0 } })),
    readAt: vi.fn((_id: string, from: number, caller: string) => {
      if (caller !== 'owner') throw new Error('foreign job')
      return { chunks: [{ at: from, text: text.slice(from), channel: 'stdout' }], next: text.length, lossy: false }
    }),
    read: vi.fn(() => { const result = text.slice(modelOffset); modelOffset = text.length; return result }),
  }
  expect(jobOutputSnapshot(jobs, owner, 'bash-1')).toBe(text)
  expect(jobOutputSnapshot(jobs, owner, 'bash-1')).toBe(text)
  expect(jobs.read).not.toHaveBeenCalled()
  expect(jobs.readAt).toHaveBeenCalledWith('bash-1', 0, 'owner')
  expect(jobs.read()).toBe('first\n')
  text += 'second\n'
  expect(jobOutputSnapshot(jobs, owner, 'bash-1')).toBe(text)
  expect(jobs.read()).toBe('second\n')
  expect(() => jobOutputSnapshot(jobs, { session: { id: 'foreign' } } as never, 'bash-1')).toThrow('foreign job')
})

it('shows retained PTY output after later commands without touching the terminal reader', () => {
  const jobs = {
    readAt: () => ({ chunks: [{ at: 0, text: 'early\nlate' }], next: 10, lossy: false }),
    get: () => ({ output: { total: 10, earliest: 0 } }),
  }
  const owner = { session: { id: 'owner' } } as never
  expect(jobOutputSnapshot(jobs, owner, 'pty-1')).toBe('early\nlate')
  expect(jobOutputSnapshot({}, owner, 'unsupported')).toBeUndefined()
})

it('keeps stream loss, spill paths and stderr visible and bounds Unicode output', () => {
  const text = outputSnapshot({ chunks: [{ at: 42, text: 'tail', channel: 'stdout' }, { at: 46, text: 'failure', channel: 'stderr', gapBefore: true }], next: 53, lossy: true }, ['/private/full.log'])
  expect(text).toContain('Earlier output truncated; full output: /private/full.log')
  expect(text).toContain('[Output gap]')
  expect(text).toContain('[stderr]failure')
  const read = (text: string) => ({ chunks: [{ at: 0, text }], next: text.length, lossy: false })
  expect(outputSnapshot(read('x'.repeat(400_000))).length).toBeLessThan(263_000)
  expect(outputSnapshot(read('🙂' + 'x'.repeat(256 * 1024 - 1)))).not.toMatch(/[\uD800-\uDFFF]/u)
})

it('sends output growth as a suffix and resets rolled or corrected snapshots', () => {
  let text = ''
  let previous: string | undefined
  let bytes = 0
  for (let index = 0; index < 1000; index++) {
    const output = (previous ?? '') + '测试🙂\n'
    const patch = jobOutputPatch(previous, output)
    bytes += JSON.stringify(patch).length
    if (typeof patch.output_for_prompt === 'string') text = patch.output_for_prompt
    else text += patch.output_append
    expect(text).toBe(output)
    previous = output
  }
  expect(bytes).toBeLessThan(100_000)
  expect(jobOutputPatch(previous, '[Earlier output truncated]\nlast')).toEqual({ type: 'Bash', output_for_prompt: '[Earlier output truncated]\nlast' })
  expect(jobOutputPatch('partial �', 'partial 你')).toEqual({ type: 'Bash', output_for_prompt: 'partial 你' })
})
