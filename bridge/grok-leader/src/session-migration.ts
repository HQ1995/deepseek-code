/** Normalize dscode's historical model event names before native format migration. */
import { symbols } from '@deepseek-ai/cordis'

export const LEGACY_MODEL_SELECTION_EVENTS = new Set(['dscode/model-selected', 'model/selected'])

/** Keep every envelope/payload field so native admission still rejects malformed records. */
export function normalizeLegacyModelSelection(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const event = row as Record<string, unknown>
  return typeof event.type === 'string' && LEGACY_MODEL_SELECTION_EVENTS.has(event.type)
    ? { ...event, type: 'model/selection' } : row
}

/**
 * Preserve native locking, generation publication, validation and sequence remapping.
 * Only historical decoding changes; source files and current writes stay native.
 */
export function installLegacySessionMigration(service: unknown): () => void {
  let owner = service as Record<PropertyKey, unknown>
  while (owner?.[symbols.original] !== undefined) owner = owner[symbols.original] as Record<PropertyKey, unknown>
  // ponytail: pinned JSONL provider adapter is private; replace this seam when DSH exposes format adapters.
  const format = owner?.['generationFormat'] as {
    createRestore(header: Record<string, unknown>): { decodeRow(row: unknown): void }
  } | undefined
  // Memory/custom persistence providers have no historical JSONL generations.
  if (format === undefined) return () => {}
  if (typeof format.createRestore !== 'function') throw new Error('unsupported DSH historical format adapter')
  const original = format.createRestore
  const wrapped: typeof original = header => {
    const restore = original.call(format, header)
    if (typeof header.version === 'number' && header.version < 3) {
      const decode = restore.decodeRow.bind(restore)
      restore.decodeRow = row => decode(normalizeLegacyModelSelection(row))
    }
    return restore
  }
  format.createRestore = wrapped
  return () => { if (format.createRestore === wrapped) format.createRestore = original }
}
