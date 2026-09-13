import { invalidParams } from './acp.ts'

export interface SessionOperation {
  readonly signal: AbortSignal
  /** Check immediately before a subsequent native mutation after an await. */
  assertActive(): void
}
interface WorkHost {
  /** Exact published owner; false while reload admission is suspended. */
  isLive(): boolean
  /** Full input policy, including initialization and preset/permission state. */
  assertReady(): void
}
export type SessionWork = ReturnType<typeof createSessionWork>

/** The accepted async work of one session, independent of any feature. Native
 * calls keep their own semantics and must honor the signal/checkpoint; this
 * owner cancels admission generations and waits for real completion, never
 * races a fake cancellation result against a still-writing native operation. */
export function createSessionWork(host: WorkHost) {
  const pending = new Map<AbortController, Promise<unknown>>()
  let closed = false, disposal: Promise<void> | undefined
  const accept = <T>(write: boolean, operation: (scope: SessionOperation) => Promise<T>): Promise<T> => {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
    const controller = new AbortController()
    const scope: SessionOperation = {
      signal: controller.signal,
      assertActive() { if (closed || controller.signal.aborted || !host.isLive()) throw invalidParams('session closed') },
    }
    const work = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.set(controller, work)
    void work.then(() => pending.delete(controller), () => pending.delete(controller))
    // Publication precedes native execution, including reentrant close.
    try {
      if (write) host.assertReady()
      scope.assertActive()
      resolve(Promise.resolve(operation(scope)).then(result => { scope.assertActive(); return result }))
    } catch (error) { reject(error) }
    return work
  }
  const cancel = (): void => { for (const controller of [...pending.keys()]) controller.abort() }
  const settle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending.values()])
  }
  return {
    run: <T>(operation: (scope: SessionOperation) => Promise<T>) => accept(true, operation),
    /** Initialization projections may read before the session accepts input. */
    read: <T>(operation: (scope: SessionOperation) => Promise<T>) => accept(false, operation),
    cancel, settle,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(settle)
      cancel()
      return disposal
    },
  }
}
