/** The `sessionController` seam the Host Schedule service delivers through.
 * dscode's semantics: a reminder is delivered into its session only while a
 * TUI client has that session open and ready in this leader. Schedule calls
 * `resolveAgent` inside its one serialized queue, so the answer is immediate:
 * a closed or not-ready session fails that delivery and the reminder stays due.
 * The leader then asks Schedule to deliver again (`requestDelivery`) whenever a
 * session becomes ready and when the Schedule service appears. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errorChain } from '@deepseek-ai/dsh-llm'

export type ResolvedSessionAgent = { readonly agent: Agent } | { readonly error: Error }

/** The Host Schedule retry request; a runtime built without dscode's source
 * patch lacks it. */
export interface ScheduleDeliveryLike { requestDelivery?(): void }

/** The two service-registry calls provision needs (a Cordis context satisfies it). */
interface ServiceScope {
  get(name: string, strict?: boolean): unknown
  provide(name: string, value?: unknown): () => void
}

/**
 * Provide `sessionController` with only `resolveAgent`, unless another plugin
 * (the Web app's session controller) already provides one: its delivery policy
 * then stands, and this leader only logs that it stepped aside.
 * @returns whether this leader's controller was provided.
 */
export function provideSessionController(
  ctx: ServiceScope,
  controller: { resolveAgent(sessionId: SessionId): Promise<ResolvedSessionAgent> },
  logger: { info(message: string): void },
): boolean {
  // Non-strict: a provider registered by a fiber that is still starting counts.
  if (ctx.get('sessionController', false) !== undefined) {
    logger.info('grok-leader: another plugin provides sessionController; reminders follow its delivery policy')
    return false
  }
  ctx.provide('sessionController', { resolveAgent: (sessionId: SessionId) => controller.resolveAgent(sessionId) })
  return true
}

interface ControllerHost<T extends { agent: Agent }> {
  /** The published owner of one session id, if any. */
  record(sessionId: SessionId): T | undefined
  /** Live, initialized and accepting input from a connected TUI client. */
  ready(record: T): boolean
  /** The Host Schedule service, once it is up. */
  schedule(): ScheduleDeliveryLike | undefined
  logger: { warn(message: string): void }
}

/** No registry of its own: sessions stay owned by the session registry, and
 * readiness is the host's. The only state is one pending delivery request. */
export function createSessionController<T extends { agent: Agent }>(host: ControllerHost<T>) {
  let closed = false, warned = false
  let pending: ReturnType<typeof setImmediate> | undefined
  const notOpen = (sessionId: SessionId, reason = 'is not open in dscode'): ResolvedSessionAgent =>
    ({ error: new Error(`Session ${sessionId} ${reason}; its reminders are delivered while it is open.`) })
  const request = (): void => {
    pending = undefined
    // A service that is not up yet asks again when it appears.
    const schedule = host.schedule()
    if (closed || schedule === undefined) return
    if (typeof schedule.requestDelivery !== 'function') {
      if (!warned) host.logger.warn('grok-leader: the Schedule service has no requestDelivery; a reminder due while its session was not open waits for the next reminder change')
      warned = true
      return
    }
    try { schedule.requestDelivery() } catch (error) {
      host.logger.warn('grok-leader: reminder delivery request failed: ' + errorChain(error))
    }
  }
  return {
    /** `sessionController.resolveAgent`: the open session's live agent, or why there is none. */
    async resolveAgent(sessionId: SessionId): Promise<ResolvedSessionAgent> {
      if (closed) return notOpen(sessionId, 'cannot receive reminders while the dscode leader shuts down')
      const record = host.record(sessionId)
      return record !== undefined && host.ready(record) ? { agent: record.agent } : notOpen(sessionId)
    },
    /** A session became ready (`record`), or the Schedule service appeared:
     * ask Schedule to deliver what is due. Requests made in one event-loop turn
     * share one call, made after that turn, so the response that readied the
     * session is written before a reminder turn can start. */
    deliverable(record?: T): void {
      if (closed || pending !== undefined || (record !== undefined && !host.ready(record))) return
      pending = setImmediate(request)
    },
    dispose(): void {
      closed = true
      clearImmediate(pending)
      pending = undefined
    },
  }
}
