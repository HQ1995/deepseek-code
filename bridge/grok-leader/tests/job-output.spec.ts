import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { jobOutputPatch, observeJobOutputs } from '../src/job-output.ts'

it('bounds finished previews without consuming the native job output', async () => {
  const ctx = new Context()
  let sequence = 0
  const jobs = { start(spec: { run(): unknown }) { spec.run(); return String(sequence++) } }
  ctx.provide('jobs', jobs as never)
  ctx.provide('subprocess', { spawn() {} } as never)
  let snapshot!: ReturnType<typeof observeJobOutputs>
  await ctx.plugin({ name: 'bounded-job-previews', apply(scope) { snapshot = observeJobOutputs(scope) } })
  const owner = {} as never
  for (let index = 0; index < 70; index++) {
    jobs.start({ owner, run() { return { done: Promise.resolve({ output: 'result ' + index }), cancel() {} } } } as never)
    await Promise.resolve()
  }
  expect(snapshot(jobs, owner, '0')).toBeUndefined()
  expect(snapshot(jobs, owner, '5')).toBeUndefined()
  expect(snapshot(jobs, owner, '6')).toBe('result 6')
  expect(snapshot(jobs, owner, '69')).toBe('result 69')
  await ctx.fiber.dispose()
})

it('leaves unsupported runtime services untouched', () => {
  const terminals = { startSend: undefined, read: undefined }
  const jobs = { start: undefined }
  const subprocess = { spawn: undefined }
  const scope = { terminals, jobs, subprocess, effect: () => { throw new Error('unsupported service was patched') } }
  const ctx = { inject: (_names: string[], apply: (value: typeof scope) => void) => apply(scope) }
  expect(() => observeJobOutputs(ctx as unknown as Context)).not.toThrow()
  expect(terminals.startSend).toBeUndefined()
  expect(jobs.start).toBeUndefined()
  expect(subprocess.spawn).toBeUndefined()
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
