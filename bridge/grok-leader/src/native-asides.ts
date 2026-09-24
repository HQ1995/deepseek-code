import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { textBlocks } from './projection.ts'
import type { SessionOperation, SessionWork } from './session-work.ts'

export type NativeAsideRuntime = Pick<SubagentRuntime, 'start'> & Partial<Pick<SubagentRuntime, 'list'>>
interface AsideSession { agent: Agent; clientId: number; work: Pick<SessionWork, 'run'> }
interface AsideHost<S extends AsideSession> {
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  canDelegate(record: S): boolean
  subagents(record: S): NativeAsideRuntime | undefined
}

/** One-shot foreground asides, separate from continuable children and prompt
 * queues. The provider owns a pending start; this module owns every returned
 * run, including late handles, until native disposal reaches quiescence. */
export function createNativeAsides<S extends AsideSession>(host: AsideHost<S>) {
  let closed = false, disposal: Promise<void> | undefined
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>()
  const assertOpen = () => { if (closed) throw internalError('native asides have been disposed') }
  const active = (record: S, scope: SessionOperation) => {
    assertOpen(); scope.assertActive()
    if (host.owned(record.clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
  }
  const execute = async (record: S, question: string, scope: SessionOperation) => {
    active(record, scope)
    if (question.trim().length === 0) throw invalidParams('empty btw question')
    const available = host.canDelegate(record)
    active(record, scope)
    if (!available) throw invalidParams('/btw needs subagents, which this session\'s preset does not have. Ask in the conversation instead, or start a /new session with a preset that has subagents.')
    const subagents = host.subagents(record)
    active(record, scope)
    if (subagents === undefined) throw internalError('subagents are not available in this agent preset')
    const providers = subagents.list?.() ?? []
    active(record, scope)
    const provider = providers.includes('spawn') ? 'spawn' : providers.includes('fork') ? 'fork' : providers[0]
    if (provider === undefined) throw internalError('no subagent provider is registered')
    const controller = new AbortController()
    let run: SubagentRun
    try {
      run = await subagents.start(provider, {
        parent: record.agent, prompt: [{ type: 'text', text: question }], label: 'btw',
        signal: AbortSignal.any([scope.signal, shutdown.signal, controller.signal]),
      })
    } catch (error) { controller.abort(); throw error }
    const failures: unknown[] = []
    let releasePromise: Promise<void> | undefined
    const release = (): Promise<void> => {
      // Publish first: abort/dispose may synchronously reenter host shutdown.
      return releasePromise ??= Promise.resolve().then(async () => { controller.abort(); await run.dispose() })
    }
    const cancellation = AbortSignal.any([scope.signal, shutdown.signal])
    let interrupt!: () => void
    const interrupted = new Promise<undefined>(resolve => { interrupt = () => { resolve(undefined) } })
    const onCancel = () => { void release().catch(() => {}); interrupt() }
    let answer = ''
    try {
      // Observe a late handle's result even when cancellation skips awaiting it.
      const outcome = run.result.then(value => ({ value }), (error: unknown) => ({ error }))
      cancellation.addEventListener('abort', onCancel, { once: true })
      if (cancellation.aborted) onCancel()
      active(record, scope)
      // Cancellation only ends the result wait and starts release. The request
      // and both drains still await actual native disposal below.
      const result = await Promise.race([outcome, interrupted])
      if (result !== undefined && 'error' in result) throw result.error
      active(record, scope)
      if (result !== undefined) {
        if (result.value.stopReason !== 'completed') {
          throw internalError('/btw did not complete (' + result.value.stopReason + ')')
        }
        answer = textBlocks(result.value.output).map(block => block.text).join('').trim()
      }
    } catch (error) { failures.push(error) }
    finally { cancellation.removeEventListener('abort', onCancel) }
    try { await release() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'btw execution and disposal failed')
    active(record, scope)
    return { result: { answer: answer.length > 0 ? answer : '(no answer)' } }
  }
  return {
    btw(clientId: number, params: unknown): Promise<{ result: { answer: string } }> {
      if (closed) return Promise.reject(internalError('native asides have been disposed'))
      let resolve!: (value: { result: { answer: string } } | PromiseLike<{ result: { answer: string } }>) => void
      let reject!: (reason: unknown) => void
      const result = new Promise<{ result: { answer: string } }>((yes, no) => { resolve = yes; reject = no })
      pending.add(result)
      void result.then(() => pending.delete(result), () => pending.delete(result))
      // Publish accepted work before a getter or native callback can reenter disposal.
      try {
        const p = paramRecord(params, 'x.ai/btw')
        const record = host.owned(clientId, sessionIdParam(p.sessionId))
        assertOpen()
        if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
        resolve(record.work.run(scope => execute(record, typeof p.question === 'string' ? p.question : '', scope)))
      } catch (error) { reject(error) }
      return result
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => { while (pending.size > 0) await Promise.allSettled([...pending]) })
      shutdown.abort()
      return disposal
    },
  }
}
