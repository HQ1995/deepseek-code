/** Active cancellation owns cleanup; queued cancellation never calls this module. */
export async function browserOperation(state, signal, operation, timeoutMs) {
  signal.throwIfAborted()
  if (state.closed) throw new Error('Browser closed after cancellation; reopen the Session for a fresh browser.')
  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  let closing
  const close = () => {
    state.closed = true
    closing ??= Promise.resolve().then(() => state.close())
    void closing.catch(() => {})
  }
  combined.addEventListener('abort', close, { once: true })
  const timer = setTimeout(() => deadline.abort(new Error('Browser operation timed out')), timeoutMs)
  try {
    combined.throwIfAborted()
    const result = await operation(combined)
    combined.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', close)
    // Do not turn an unconfirmed cleanup into an ordinary cancellation success.
    if (closing) await closing
  }
}
