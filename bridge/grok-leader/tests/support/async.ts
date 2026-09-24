/**
 * Microtask flushing for specs that drive already-settled promise chains
 * without timers. Each spec passes the turn count it was written against, so
 * sharing the helper never changes how far a chain is allowed to advance.
 */
export async function tick(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}
