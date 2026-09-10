import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { observeJobOutputs, outputSnapshot } from '../src/job-output.ts'
import { createImageOutputProjector } from '../src/image-output.ts'
import { parseReminder } from '../src/reminders.ts'

it('observes collected job output without consuming model bytes or acknowledging completion', async () => {
  const ctx = new Context()
  let text = 'first\n', modelOffset = 0, reported = false
  let finish!: (outcome: { status: string }) => void
  const done = new Promise<{ status: string }>(resolve => { finish = resolve })
  const reader = { readFrom: (offset: number) => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) }
  const subprocess = { spawn: () => ({ collected: { stdout: reader }, done }) }
  const jobs = {
    start(spec: { run(): unknown }) { spec.run(); return 'bash-1' },
    read() { const read = reader.readFrom(modelOffset); modelOffset = read.nextOffset; reported = true; return read.text },
  }
  ctx.provide('jobs', jobs as never)
  ctx.provide('subprocess', subprocess as never)
  let snapshot!: ReturnType<typeof observeJobOutputs>
  await ctx.plugin({ name: 'output-observer-test', apply(scope) { snapshot = observeJobOutputs(scope) } })
  const owner = {} as never
  const id = ctx.jobs.start({ owner, kind: 'bash' as never, label: 'test', run() {
    ctx.subprocess.spawn({} as never)
    return { cancel() {}, done: done as never, readOutput: () => jobs.read() }
  } })
  expect(snapshot(jobs, owner, id)).toContain('first')
  expect(snapshot(jobs, owner, id)).toContain('first')
  expect(reported).toBe(false)
  expect(jobs.read()).toBe('first\n')
  text += 'second\n'
  expect(snapshot(jobs, owner, id)).toContain('second')
  expect(jobs.read()).toBe('second\n')
  expect(snapshot(jobs, {} as never, id)).toBeUndefined()
  finish({ status: 'completed' })
  await ctx.fiber.dispose()
  expect(jobs.start.name).toBe('start')
  expect(subprocess.spawn.name).toBe('spawn')
})

it('keeps truncation and stderr visible within a bounded output snapshot', () => {
  const text = outputSnapshot({ streams: [{ stdout: { readFrom: () => ({ text: 'tail', nextOffset: 50, lossy: true, spillPath: '/private/full.log' }) }, stderr: { readFrom: () => ({ text: 'failure', nextOffset: 7, lossy: false }) } }] })
  expect(text).toContain('Earlier output truncated; full output: /private/full.log')
  expect(text).toContain('[stderr]\nfailure')
  expect(outputSnapshot({ streams: [], final: 'x'.repeat(400_000) }).length).toBeLessThan(263_000)
  const unicode = outputSnapshot({ streams: [], final: '🙂' + 'x'.repeat(256 * 1024 - 1) })
  expect(unicode).not.toMatch(/[\uD800-\uDFFF]/u)
})

it('previews a PTY job without consuming model output and freezes it when the send settles', async () => {
  const ctx = new Context()
  const owner = {} as never
  let text = 'early', consumed = false
  let finish!: (result: unknown) => void
  const done = new Promise(resolve => { finish = resolve })
  const operation = { done, cancel() {}, readOutput() { consumed = true; return { delta: text, truncated: false } } }
  const terminals = {
    startSend(_owner: unknown, _id: string, _request: unknown) { return operation },
    read(agent: unknown, id: string) {
      expect(agent).toBe(owner); expect(id).toBe('pty-1')
      return { text, truncated: false }
    },
  }
  const jobs = { start(spec: { run(): unknown }) { spec.run(); return 'pty-job' } }
  ctx.provide('terminals', terminals as never)
  ctx.provide('jobs', jobs as never)
  ctx.provide('subprocess', { spawn() {} } as never)
  let snapshot!: ReturnType<typeof observeJobOutputs>
  await ctx.plugin({ name: 'terminal-output-observer-test', apply(scope) { snapshot = observeJobOutputs(scope) } })
  jobs.start({ run() {
    terminals.startSend(owner, 'pty-1', {})
    return { done, cancel() {}, readOutput: operation.readOutput }
  }, owner } as never)
  expect(snapshot(jobs, owner, 'pty-job')).toContain('early')
  text = 'early\nlate'
  expect(snapshot(jobs, owner, 'pty-job')).toContain('late')
  expect(consumed).toBe(false)
  expect(snapshot(jobs, {} as never, 'pty-job')).toBeUndefined()
  expect(operation.readOutput().delta).toBe('early\nlate')
  finish({}); await done; await Promise.resolve()
  text = 'unrelated later command'
  expect(snapshot(jobs, owner, 'pty-job')).toContain('early\nlate')
  expect(snapshot(jobs, owner, 'pty-job')).not.toContain('unrelated')
  await ctx.fiber.dispose()
  expect(terminals.startSend.name).toBe('startSend')
})

it('verifies each tool attachment and preserves explicit errors in live and replay projections', async () => {
  const ctx = new Context()
  const reads: string[] = []
  ctx.provide('attachments', {
    async readImage(ref: { attachmentId: string }) {
      reads.push(ref.attachmentId)
      if (ref.attachmentId === 'missing') throw new Error('Stored image is missing')
      return { ref, data: new Uint8Array([1]) }
    },
    imageHostPath(ref: { attachmentId: string }) { return '/private/' + ref.attachmentId + '.png' },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'valid' } }, { type: 'image', attachment: { attachmentId: 'missing' } }] }] } } } as never
  for (const replay of [false, true]) {
    const updates = await project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' }])
    expect(updates[0]).toMatchObject({ rawOutput: { dscodeImages: ['/private/valid.png'] }, content: [{ content: { text: 'Image preview unavailable: Stored image is missing' } }] })
    expect(replay ? reads.length === 4 : reads.length === 2).toBe(true)
  }
  await ctx.fiber.dispose()
})

it('resolves PTC sub-call images through the same attachment authority', async () => {
  const ctx = new Context()
  ctx.provide('attachments', {
    async readImage(ref: { attachmentId: string }) { return { ref, data: new Uint8Array([1]) } },
    imageHostPath(ref: { attachmentId: string }) { return '/private/' + ref.attachmentId + '.png' },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'ptc-image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/ptc-dispatch', data: { rootCallId: 'code', parentCallId: 'code', subCallId: 'code:ptc:1', name: 'read_image', arguments: {}, isError: false, content: [{ type: 'image', attachment: { attachmentId: 'nested' } }] } } as never
  expect(await project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:1', status: 'completed' }]))
    .toMatchObject([{ toolCallId: 'code:ptc:1', rawOutput: { dscodeImages: ['/private/nested.png'] } }])
  // A sub-call without images never rewrites the projected update.
  const plain = await project({ type: 'tool/ptc-dispatch', data: { content: [{ type: 'text', text: 'ok' }] } } as never,
    [{ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:2', status: 'completed' }])
  expect(plain[0]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'code:ptc:2', status: 'completed' })
  await ctx.fiber.dispose()
})

it('parses reminder input without rewriting message text or admitting unsafe durations', () => {
  expect(parseReminder('after 10m check\nthe build')).toEqual({ after_seconds: 600, prompt: 'check\nthe build' })
  expect(parseReminder('every 5m check')).toEqual({ every_seconds: 300, prompt: 'check' })
  expect(parseReminder('at 2030-01-01T00:00:00Z check')).toEqual({ at: '2030-01-01T00:00:00Z', prompt: 'check' })
  for (const invalid of ['every 0m check', 'after 999999999999999999d check', 'weekly check', 'after 1h']) expect(() => parseReminder(invalid)).toThrow()
})

it('does not create image preview files after disposal interrupts an attachment read', async () => {
  const ctx = new Context()
  let finish!: (value: unknown) => void
  let localized = false
  const reading = new Promise(resolve => { finish = resolve })
  ctx.provide('attachments', {
    readImage: () => reading,
    imageHostPath() { localized = true; return undefined },
  } as never)
  let project!: ReturnType<typeof createImageOutputProjector>
  await ctx.plugin({ name: 'closing-image-projector-test', apply(scope) { project = createImageOutputProjector(scope) } })
  const event = { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'pending' } }] }] } } } as never
  const projected = project(event, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' }])
  await ctx.fiber.dispose()
  finish({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1]) })
  expect(await projected).toMatchObject([{ rawOutput: { dscodeImages: [], dscodeImageErrors: ['Image preview unavailable: Image preview closed'] } }])
  expect(localized).toBe(false)
})
