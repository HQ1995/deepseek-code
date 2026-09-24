/** Normalize dscode's historical model event names before native format migration. */
import { symbols } from '@deepseek-ai/cordis'

export const LEGACY_MODEL_SELECTION_EVENTS = new Set(['dscode/model-selected', 'model/selected'])

/** Keep every envelope/payload field so native admission still rejects malformed records. */
function normalizeLegacyModelSelection(row: unknown): unknown {
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
  // Pinned JSONL provider adapter; child catalog facts and every native validation
  // stay in its decoder. The source patch extracts this instance-local method.
  const provider = owner as {
    generationFormat?: object
    createHistoricalRestore?: (header: Record<string, unknown>, children: unknown) => { decodeRow(row: unknown): void }
  }
  if (provider.generationFormat === undefined) return () => {}
  const original = provider.createHistoricalRestore
  if (typeof original !== 'function') throw new Error('unsupported DSH historical format adapter; rebuild the pinned source runtime')
  const wrapped: typeof original = (header, children) => {
    const restore = original.call(provider, header, children)
    if (typeof header.version === 'number' && header.version < 3) {
      const decode = restore.decodeRow.bind(restore)
      restore.decodeRow = row => decode(normalizeLegacyModelSelection(row))
    }
    return restore
  }
  provider.createHistoricalRestore = wrapped
  return () => { if (provider.createHistoricalRestore === wrapped) provider.createHistoricalRestore = original }
}
