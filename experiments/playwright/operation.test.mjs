import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserOperation } from './operation.mjs'

test('active cancellation awaits cleanup and permanently closes only that owner', async () => {
  const cleaned = Promise.withResolvers(), entered = Promise.withResolvers(), abort = new AbortController()
  let closes = 0, returned = false
  const state = { closed: false, close: async () => { closes++; await cleaned.promise } }
  const pending = browserOperation(state, abort.signal, async signal => {
    entered.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }, 1000).finally(() => { returned = true })
  const rejected = assert.rejects(pending)
  await entered.promise; abort.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, false); assert.equal(state.closed, true); assert.equal(closes, 1)
  cleaned.resolve(); await rejected
  await assert.rejects(browserOperation(state, new AbortController().signal, async () => {}, 1000), /reopen/)
})
test('pre-cancel never touches resources; success retains browser; timeout closes it', async () => {
  let closes = 0
  const state = { closed: false, close: async () => { closes++ } }
  await assert.rejects(browserOperation(state, AbortSignal.abort(), async () => assert.fail(), 1000))
  assert.equal(closes, 0)
  assert.equal(await browserOperation(state, new AbortController().signal, async () => 42, 1000), 42)
  assert.equal(closes, 0)
  await assert.rejects(browserOperation(state, new AbortController().signal, async signal => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }, 10), /timed out/)
  assert.equal(closes, 1)
})
test('cleanup failure remains an error, never a quiescence claim', async () => {
  await assert.rejects(browserOperation({ closed: false, close: async () => { throw new Error('cleanup failed') } }, new AbortController().signal, async signal => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }, 10), /cleanup failed/)
})
