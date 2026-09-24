import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { contextInfoFromProjection } from './projection.ts'
import type { SessionOutput } from './session-output.ts'
import type { SessionOperation, SessionWork } from './session-work.ts'

export type NativeSessionReferences = Pick<SessionReferenceResolver, 'remoteExportCandidates'>
export interface NativeSessionTitles {
  rename(session: Agent['session'], title: string): unknown
  refresh?(session: Agent['session'], signal?: AbortSignal): Promise<unknown>
}
interface ArtifactSession {
  agent: Agent
  clientId: number
  work: Pick<SessionWork, 'read' | 'run'>
  output: Pick<SessionOutput, 'context'> & { readonly stats: { turnCount: number } }
}
interface ArtifactHost<S extends ArtifactSession> {
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  client(clientId: number): { readonly signal: AbortSignal } | undefined
  titles(): NativeSessionTitles | undefined
  references(): NativeSessionReferences | undefined
  archive(sessionId: SessionId, cwd: string, filename: string, signal: AbortSignal): Promise<string>
}

/** Attached-session metadata and durable artifacts. Native title/reference
 * capabilities and the archive writer retain their policies; this module owns
 * RPC validation, exact-session admission, cancellation and completion drains.
 * A completed archive is not rolled back if its client departs afterward. */
export function createSessionArtifacts<S extends ArtifactSession>(host: ArtifactHost<S>) {
  let closed = false, disposal: Promise<void> | undefined
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>()
  const assertOpen = () => { if (closed) throw internalError('session artifacts have been disposed') }
  const active = (record: S, scope?: SessionOperation) => {
    assertOpen(); scope?.assertActive()
    if (host.owned(record.clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
  }
  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(internalError('session artifacts have been disposed'))
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    // Native getters/writers can reenter disposal before their first await.
    try { resolve(Promise.resolve(operation()).then(value => { assertOpen(); return value })) }
    catch (error) { reject(error) }
    return result
  }
  const owned = (clientId: number, id: unknown) => {
    assertOpen()
    const record = host.owned(clientId, sessionIdParam(id))
    assertOpen()
    return record
  }
  return {
    archive(clientId: number, params: unknown) {
      return accept(async () => {
        const p = paramRecord(params, 'x.ai/session/export'), record = owned(clientId, p.sessionId)
        const client = host.client(clientId)
        if (record === undefined || client === undefined) throw invalidParams('archive requires an owned sessionId')
        if (!Array.isArray(p.prompt) || p.prompt.length !== 1 || p.prompt[0]?.type !== 'text' || typeof p.prompt[0].text !== 'string') {
          throw invalidParams('archive requires one text filename')
        }
        const filename: string = p.prompt[0].text
        return record.work.read(async scope => {
          active(record, scope)
          const signal = AbortSignal.any([scope.signal, client.signal, shutdown.signal])
          signal.throwIfAborted()
          const path = await host.archive(record.agent.session.id, record.agent.session.header.cwd ?? process.cwd(), filename, signal)
          active(record, scope); signal.throwIfAborted()
          return { result: { kind: 'success', text: 'Session archive exported to ' + path } }
        })
      })
    },
    references(clientId: number, params: unknown) {
      return accept(async () => {
        const p = paramRecord(params, 'x.ai/session/references')
        if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.query !== 'string' || p.query.length > 1024) {
          throw invalidParams('session references requires sessionId and a query of at most 1024 characters')
        }
        const record = owned(clientId, p.sessionId)
        if (record === undefined) throw invalidParams('unknown session')
        const query = p.query
        return record.work.read(async scope => {
          active(record, scope)
          const resolver = host.references()
          active(record, scope)
          if (resolver === undefined) throw internalError('session references are unavailable')
          const candidates = await resolver.remoteExportCandidates(record.agent, query,
            AbortSignal.any([scope.signal, shutdown.signal, AbortSignal.timeout(10_000)]))
          active(record, scope)
          return { candidates }
        })
      })
    },
    rename(clientId: number, params: unknown) {
      return accept(async () => {
        const p = paramRecord(params, 'x.ai/session/rename'), record = owned(clientId, p.sessionId)
        if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
        return record.work.run(async scope => {
          active(record, scope)
          const titles = host.titles()
          active(record, scope)
          if (titles === undefined) throw internalError('session title service is not configured')
          if (p.reset_to_auto === true || p.resetToAuto === true) {
            if (titles.refresh === undefined) throw internalError('session title refresh is not available')
            await titles.refresh(record.agent.session, AbortSignal.any([scope.signal, shutdown.signal]))
          } else {
            const title = typeof p.title === 'string' ? p.title : ''
            if (title.trim().length === 0) throw invalidParams('title must be a non-empty string')
            await titles.rename(record.agent.session, title)
          }
          active(record, scope)
          return {}
        })
      })
    },
    info(clientId: number, params: unknown) {
      assertOpen()
      const p = paramRecord(params, 'x.ai/session/info'), id = typeof p.sessionId === 'string' ? p.sessionId : undefined
      const record = id === undefined ? undefined : owned(clientId, id)
      if (id !== undefined && record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
      const context = record?.output.context() ?? contextInfoFromProjection({})
      const turns = record?.output.stats.turnCount ?? 0
      if (record !== undefined) active(record)
      else assertOpen()
      return { result: { sessionId: record?.agent.session.id ?? '', cwd: record?.agent.session.header.cwd ?? '',
        turns, turnIndex: record === undefined ? 0 : Math.max(0, turns - 1), model: null, context } }
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
