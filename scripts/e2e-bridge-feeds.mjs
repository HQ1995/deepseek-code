// Real TUI + DSH + bridge acceptance for the DSH events the bridge feeds into
// existing TUI renderers: model retries and typed failures, tool calls being
// written, plan review and plan mode, and why a woken turn started. The mock
// model alone is scripted; the runtime produces every event.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const text = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
/** Requests per prompt, so one prompt can fail before it succeeds. */
const attempts = new Map()

export function bridgeFeedsReply(body) {
  const messages = body.messages ?? []
  const last = messages.findLast(message => message.role === 'user')
  // A finished background job wakes its idle owner with a job notice.
  if (last && /background job/.test(text(last)) && text(last).includes('DSCODE_FEEDS_WAKE_JOB')) return { text: 'DSCODE_FEEDS_WOKEN' }
  // Only the current turn: it begins after the last final (tool-free) answer,
  // so a later unrelated prompt never replays one of these scripts.
  const turn = messages.findLastIndex(message => message.role === 'assistant' && !(message.tool_calls?.length > 0)) + 1
  const start = messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('DSCODE_FEEDS_'))
  if (start < turn) return
  const prompt = text(messages[start]).trim()
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  if (prompt === 'DSCODE_FEEDS_RETRY') {
    const seen = (attempts.get(prompt) ?? 0) + 1
    attempts.set(prompt, seen)
    return seen === 1 ? { status: 503, error: 'DSCODE_FEEDS_OVERLOADED' } : { text: 'DSCODE_FEEDS_RETRY_DONE' }
  }
  if (prompt === 'DSCODE_FEEDS_REFUSED') return { status: 400, error: 'DSCODE_FEEDS_BAD_REQUEST' }
  if (prompt === 'DSCODE_FEEDS_WRITING') {
    if (!results.length) return { holdToolCall: { name: 'bash', argumentsPrefix: '{"command":"printf DSCODE_FEEDS_', argumentsRest: 'WRITTEN","description":"DSCODE feeds write"}' }, releaseKey: 'feeds-writing' }
    return { text: 'DSCODE_FEEDS_WRITING_DONE' }
  }
  if (prompt === 'DSCODE_FEEDS_PLAN') {
    if (!results.length) return { name: 'exit_plan_mode', arguments: { plan: '# DSCODE feeds plan\n\n1. Review this plan in the TUI plan view\n2. DSCODE_FEEDS_PLAN_STEP\n' } }
    return { text: /Plan approved/.test(text(results.at(-1))) ? 'DSCODE_FEEDS_PLAN_APPROVED' : 'DSCODE_FEEDS_PLAN_UNEXPECTED' }
  }
  if (prompt === 'DSCODE_FEEDS_WAKE') {
    if (!results.length) return { name: 'bash', arguments: { command: 'sleep 2; echo DSCODE_FEEDS_WAKE_JOB', description: 'DSCODE_FEEDS_WAKE_JOB', run_in_background: true } }
    return { text: 'DSCODE_FEEDS_WAKE_STARTED' }
  }
}

export async function bridgeFeedsAcceptance(ui) {
  const { send, key, wait, capture, waitState, waitFor, artifact, tuiLog, captureHistory } = ui
  const idle = label => waitState(value => value.status === 'idle', label, 30000)
  const logged = (pattern, label) => waitFor(tuiLog, log => pattern.test(log), label, 30000)

  // A 503 is retried by DSH's llm-retry; the TUI shows its Retrying state.
  await send('DSCODE_FEEDS_RETRY')
  await wait(/DSCODE_FEEDS_RETRY_DONE/, 30000)
  await logged(/Retry state: Retrying \{ attempt: 1, max_retries: \d+/, 'feeds-retrying-state')
  await idle('feeds-retry-idle')

  // A non-retryable failure is the TUI's typed failure banner, not "Turn failed".
  await send('DSCODE_FEEDS_REFUSED')
  const refused = await wait(/Request failed[^\n]*DSCODE_FEEDS_BAD_REQUEST/, 30000)
  await idle('feeds-refused-idle')
  assert.doesNotMatch(refused.slice(refused.lastIndexOf('DSCODE_FEEDS_REFUSED')), /Turn failed/)
  await artifact('feeds-failure', { screen: refused })

  // A tool call the model is still streaming shows the TUI's writing status.
  await send('DSCODE_FEEDS_WRITING')
  const writing = await wait(/(?:Writing command|Preparing bash)(?: \(\d+\))?…/, 30000)
  const released = await fetch(`${process.env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=feeds-writing`, { method: 'POST' })
  assert.ok(released.ok, `Release the held tool call: ${released.status}`)
  await wait(/DSCODE_FEEDS_WRITING_DONE/, 30000)
  await idle('feeds-writing-idle')
  await artifact('feeds-writing', { screen: writing })

  // Plan mode: DSH's committed state drives the indicator, and exit_plan_mode
  // opens the TUI's plan approval view; approving it leaves plan mode.
  await send('/plan')
  await waitState(value => value.projections.values.plan?.active === true, 'feeds-plan-on', 30000)
  await logged(/Plan mode state updated \(from CurrentModeUpdate\)[^\n]*plan_active=true|plan_active=true[^\n]*Plan mode state updated/, 'feeds-plan-indicator-on')
  await send('DSCODE_FEEDS_PLAN')
  const review = await wait(/DSCODE_FEEDS_PLAN_STEP/, 30000)
  assert.match(review, /plan\.md/)
  await key('a')
  await wait(/DSCODE_FEEDS_PLAN_APPROVED/, 30000)
  await idle('feeds-plan-idle')
  await waitState(value => value.projections.values.plan?.active === false, 'feeds-plan-off', 30000)
  await logged(/plan_active=false/, 'feeds-plan-indicator-off')
  await artifact('feeds-plan', { review })

  // A finished background job wakes the idle session: a system line says why.
  await send('DSCODE_FEEDS_WAKE')
  await wait(/DSCODE_FEEDS_WAKE_STARTED/, 30000)
  await wait(/DSCODE_FEEDS_WOKEN/, 60000)
  const history = await captureHistory()
  const woken = history.slice(history.lastIndexOf('DSCODE_FEEDS_WAKE_STARTED'))
  assert.match(woken, /Background task updated: [^\n]*DSCODE_FEEDS_WAKE_JOB[\s\S]*DSCODE_FEEDS_WOKEN/)
  assert.doesNotMatch(woken, /job_output/, 'The job notice framed for the model stays off the transcript')
  await idle('feeds-wake-idle')
  await artifact('feeds-wake', { screen: woken, capture: await capture() })
  return { retried: true, refused: true, writing: true, plan: true, woken: true }
}

/** The TUI debug log of the current generation. */
export const tuiLogReader = path => () => readFile(path(), 'utf8')
