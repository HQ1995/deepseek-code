/** Leaf value guards shared across the bridge. No imports. */

export const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A non-null object that is not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** An Error's message, or any other thrown value as text. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
