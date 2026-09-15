/** Preset policy state, restored and incrementally driven by the native registry. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface PresetHistory {
  selected: string | null
  locked: boolean
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    dscodePresetHistory: PresetHistory
  }
}

const initial = (header: { agentPreset?: string }): PresetHistory => ({ selected: header.agentPreset ?? null, locked: false })
function apply(state: PresetHistory, event: SessionEvent): PresetHistory {
  if (event.type === 'agent-preset/selected') {
    const selected = (event.data as { agentPreset?: unknown }).agentPreset
    if (typeof selected === 'string' && selected.length > 0 && selected !== state.selected) return { ...state, selected }
  }
  if (!state.locked && (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')) return { ...state, locked: true }
  return state
}

/** Deliberately preserves the bridge's model-visible-history gate, not the
 * native preset selector's different turn-boundary gate. No transcript kept. */
export const presetHistoryProjection: ProjectionDefinition<'dscodePresetHistory'> = {
  key: 'dscodePresetHistory',
  stateVersion: 1,
  stateSchema: z.object({ selected: z.string().nullable(), locked: z.boolean() }),
  init: initial,
  apply,
}

/** Cold load/fork already owns this complete source; no Session reader here. */
export function presetHistory(header: { agentPreset?: string }, events: readonly SessionEvent[]): PresetHistory {
  return events.reduce(apply, initial(header))
}
