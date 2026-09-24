import { errorChain } from '@deepseek-ai/dsh-llm'

interface Disposable { dispose(): void | Promise<unknown> }
interface LeaderHost {
  sessions: {
    readonly closed: boolean
    disconnect(clientId: number): void
    drain(): Promise<void>
    dispose(): Promise<void>
  }
  catalog: Disposable
  transport: {
    readonly clients: { readonly size: number }
    readonly failure: NodeJS.ErrnoException | undefined
    start(): void
    close(): void
  }
  owners: readonly Disposable[]
  pollers: readonly { poll(): void }[]
  appExit(): ((code: number) => void) | undefined
  logger: { warn(message: string): void }
  /** Grace before exiting with no clients; a function is read at each disconnect. */
  idleExitMs?: number | (() => number)
}

/** Host grace/heartbeat and shutdown coordination. Feature owners retain their
 * accepted-work drains; this module closes admission, stops producers and joins
 * every owner before asking the foreground launcher to exit. */
export function createLeaderLifecycle(host: LeaderHost) {
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let generation = 0, started = false
  let quiescing: Promise<void> | undefined, disposal: Promise<void> | undefined
  let startupFailure: unknown
  const warn = (label: string, error: unknown) => { host.logger.warn('grok-leader: ' + label + ': ' + errorChain(error)) }
  const cancelIdle = () => {
    generation += 1
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
  }
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    let resolve!: () => void, reject!: (error: unknown) => void
    quiescing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Publish before closing admission: native cancellation/unsubscribe hooks
    // can synchronously enter host disposal again.
    cancelIdle()
    if (heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined }
    const work: Promise<unknown>[] = []
    const attempt = (close: () => unknown) => {
      try { work.push(Promise.resolve(close())) } catch (error) { work.push(Promise.reject(error)) }
    }
    attempt(() => host.sessions.dispose())
    attempt(() => host.catalog.dispose())
    attempt(() => host.transport.close())
    for (const owner of host.owners) attempt(() => owner.dispose())
    void Promise.allSettled(work).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length > 0) reject(new AggregateError(failures, failures.map(error => errorChain(error)).join('; ')))
      else resolve()
    })
    return quiescing
  }
  const failed = (error: unknown) => {
    startupFailure = error
    void quiesce().catch(failure => { warn('quiesce failed', failure) })
  }
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    let resolve!: (value: PromiseLike<void>) => void
    disposal = new Promise<void>(yes => { resolve = yes })
    resolve(quiesce().catch(error => { warn('quiesce failed', error) }).then(() => {
      const failure = startupFailure ?? host.transport.failure
      if (failure !== undefined) throw failure
    }))
    return disposal
  }
  return {
    start(): void {
      if (started || quiescing !== undefined) throw new Error('leader lifecycle cannot be started again')
      started = true
      heartbeat = setInterval(() => { for (const owner of host.pollers) owner.poll() }, 500)
      heartbeat.unref()
      try { host.transport.start() } catch (error) { failed(error); throw error }
    },
    registered: cancelIdle,
    disconnected(clientId: number): void {
      cancelIdle()
      if (quiescing === undefined && !host.sessions.closed && host.transport.clients.size === 0) {
        const accepted = generation
        idleTimer = setTimeout(() => {
          idleTimer = undefined
          void (async () => {
            await host.sessions.drain()
            if (quiescing !== undefined || host.sessions.closed || host.transport.clients.size > 0 || accepted !== generation) return
            try { await quiesce() } catch (error) { warn('quiesce failed', error) }
            const exit = host.appExit()
            if (exit === undefined) host.logger.warn('grok-leader: the host exposes no appExit; the leader will stay up with no clients')
            else exit(0)
          })().catch(error => { warn('idle exit failed', error) })
        }, typeof host.idleExitMs === 'function' ? host.idleExitMs() : host.idleExitMs ?? 2000)
      }
      host.sessions.disconnect(clientId)
    },
    failed,
    dispose,
  }
}
