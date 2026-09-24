import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * A bare SessionEvent literal for specs that feed projections or fixture
 * logs directly. seq and time default to 0; specs whose logs need other
 * values pass them explicitly.
 */
export const event = (type: string, data: unknown = {}, seq = 0, time = 0): SessionEvent =>
  ({ type, data, seq, time }) as SessionEvent
