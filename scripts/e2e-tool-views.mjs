// Real TUI + DSH + bridge acceptance for tool cards built from DSH's own tool
// presenters (`_meta['dscode/view']`): the mock model issues one call of each
// standard shell, file and todo tool, the installed runtime runs them, and the
// transcript must show the same cards live and after a resume. The mock model
// alone is scripted; the runtime produces every event. Command results then
// follow the same rule: a DSH command's result is its own block, shown once
// live and again after a resume; a bridge-owned command's is live only.
import assert from 'node:assert/strict'

const PROMPT = 'DSCODE_TOOL_VIEWS'
const DONE = 'DSCODE_TOOL_VIEWS_DONE'
const text = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

/** One call per model step, in order; `dir` is this run's fixture directory in the workspace. */
const steps = dir => [
  { name: 'bash', arguments: { command: `mkdir -p ${dir} && printf DSCODE_VIEWS_BASH_OUT`, description: 'DSCODE views shell step' } },
  { name: 'write', arguments: { file_path: `${dir}/sample.txt`, content: 'alpha\nVIEWS_NEEDLE beta\ngamma\n' } },
  { name: 'read', arguments: { file_path: `${dir}/sample.txt` } },
  { name: 'edit', arguments: { file_path: `${dir}/sample.txt`, old_string: 'gamma', new_string: 'gamma VIEWS_NEEDLE' } },
  { name: 'grep', arguments: { pattern: 'VIEWS_NEEDLE', path: dir } },
  { name: 'glob', arguments: { pattern: `${dir}/*.txt` } },
  { name: 'todo_write', arguments: { todos: [{ content: 'DSCODE views todo', status: 'completed' }] } },
]

export function toolViewsReply(body) {
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user' && text(message).startsWith(PROMPT + ':'))
  if (start < 0) return
  // Only the current turn: it begins after the last final (tool-free) answer.
  const turn = messages.findLastIndex(message => message.role === 'assistant' && !(message.tool_calls?.length > 0)) + 1
  if (start < turn) return
  const plan = steps(text(messages[start]).slice(PROMPT.length + 1).trim())
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  return results.length < plan.length ? plan[results.length] : { text: DONE }
}

/** The cards between the prompt and the answer, as text. Live-only chrome is
 * dropped: timings (a live card shows its elapsed time, a restored one does
 * not), the selection and fresh-edit gutter, and the task notices the shell's
 * job lifecycle adds, which a resume does not replay. */
function cardsOf(history, prompt) {
  const from = history.lastIndexOf(prompt)
  assert.ok(from >= 0, 'the prompt must be in the transcript')
  const to = history.indexOf(DONE, from)
  assert.ok(to > from, 'the answer must follow the cards')
  return history.slice(from + prompt.length, to).split('\n')
    .map(line => line.replace(/^[\s┃❙│]+/u, '').replace(/\s+(?:\d+(?:\.\d+)?(?:ms|s|m)|—)\s*$/u, '').trimEnd())
    .filter(line => line !== '' && !/^\W*Task (?:started|completed|failed)\b/u.test(line) && !/^\d{1,2}:\d{2} [AP]M$/u.test(line))
}

export async function toolViewsAcceptance(ui) {
  const { send, wait, waitState, artifact, restart, captureHistory, tuiLog } = ui
  const dir = `views-${Date.now().toString(36)}`
  const prompt = `${PROMPT}:${dir}`
  const logStart = (await tuiLog()).length
  await send(prompt)
  await wait(new RegExp(DONE), 60000)
  await waitState(value => value.status === 'idle', 'tool-views-idle', 30000)
  // Every call and result arrived with the tool's own view (the TUI logs its card).
  const log = (await tuiLog()).slice(logStart)
  const views = kind => [...log.matchAll(new RegExp(`\\[acp\\] ${kind} id=[^\\n]* view=(\\w+)`, 'g'))].map(match => match[1])
  assert.deepEqual(views('tool_call').sort(), ['diff', 'diff', 'generic', 'generic', 'generic', 'generic', 'terminal'], 'call views')
  assert.deepEqual(views('tool_call_update').sort(), ['diff', 'diff', 'none', 'read', 'search', 'search', 'terminal'], 'result views')
  // A viewed call carries no typed rawOutput: bash sends no byte array any more.
  assert.doesNotMatch(log, /\[acp\] tool_call_update id=[^\n]* raw_output=(?!none)/, 'viewed results carry no rawOutput')
  const live = cardsOf(await captureHistory(), prompt)
  const check = (cards, label) => {
    const screen = cards.join('\n')
    // bash: a terminal view is the Execute card under its description.
    assert.match(screen, /DSCODE views shell step/, `${label}: the terminal card`)
    // write: a result diff with no before-image is a created file.
    assert.match(screen, new RegExp(`Creating ${dir}/sample\\.txt`), `${label}: the new-file diff card`)
    // edit: the Edit card with its hunk.
    assert.match(screen, new RegExp(`Edit(?:ed)? ${dir}/sample\\.txt`), `${label}: the edit card`)
    assert.match(screen, /gamma VIEWS_NEEDLE/, `${label}: the edit hunk`)
    // read, grep and glob fold into the TUI's verb groups, as before views.
    assert.match(screen, /Read 1 file/, `${label}: the read card`)
    assert.match(screen, /Searched 2 patterns/, `${label}: the grep and glob cards`)
    // todo_write stays off the transcript: the todo pane shows it.
    assert.doesNotMatch(screen, /Update todo list|todo_write/, `${label}: the todo card stays hidden`)
  }
  check(live, 'live')
  await artifact('tool-views-live', { dir, cards: live })
  await restart()
  await wait(new RegExp(DONE), 30000)
  const resumed = cardsOf(await captureHistory(), prompt)
  check(resumed, 'resumed')
  await artifact('tool-views-resumed', { dir, cards: resumed })
  assert.deepEqual(resumed, live, 'a resumed transcript must show the same cards')
  const commands = await commandResultsAcceptance(ui)
  return { dir, cards: live.length, commands }
}

/** Occurrences of `text` in a captured transcript. */
const count = (screen, text) => screen.split(text).length - 1
const GOAL_REFUSAL = 'No goal is currently set; /goal pause requires one.'
const FEEDBACK = 'Feedback recorded for session'

/** DSH's `/goal` (immediate, over `x.ai/commands/run`) and `/feedback`
 * (queued like a prompt) record their results durably: each shows once as its
 * own "/name args" block, never also as the reply's text, and again after a
 * resume. `/feedback` records no input (its own event holds it), so its block
 * reads `/feedback`. DSH's text is plain: `/goal`'s usage line stays one line.
 * `/browser` is the bridge's own command: its result is live only. */
async function commandResultsAcceptance({ send, wait, waitState, artifact, restart, captureHistory }) {
  await send('/goal pause')
  await wait(new RegExp(GOAL_REFUSAL.replaceAll('/', '\\/').replaceAll('.', '\\.')), 30000)
  await send('/feedback DSCODE_VIEWS_FEEDBACK')
  await wait(new RegExp(FEEDBACK), 30000)
  await send('/browser status')
  await wait(/Browser: (?:off|on)/, 30000)
  await waitState(value => value.status === 'idle', 'command-results-idle', 30000)
  const live = await captureHistory()
  await artifact('command-results-live', { screen: live })
  assert.equal(count(live, GOAL_REFUSAL), 1, 'the /goal result must show once, not also as its reply')
  assert.equal(count(live, FEEDBACK), 1, 'the /feedback result must show once, not also as assistant text')
  assert.match(live, /\/goal pause/, 'the /goal block names its invocation')
  assert.match(live, /Usage: \/goal \[<objective>\|clear\|edit <objective>\|pause\|resume\]/, 'plain DSH text renders verbatim, not as Markdown')
  await restart()
  await wait(new RegExp(FEEDBACK), 30000)
  const resumed = await captureHistory()
  await artifact('command-results-resumed', { screen: resumed })
  assert.equal(count(resumed, GOAL_REFUSAL), 1, 'a resumed transcript must show the /goal result once')
  assert.equal(count(resumed, FEEDBACK), 1, 'a resumed transcript must show the /feedback result once')
  assert.match(resumed, /\/goal pause/, 'the resumed /goal block names its invocation')
  assert.match(resumed, /^\W*\/feedback\s*$/m, 'the resumed /feedback block names its command')
  assert.doesNotMatch(resumed, /\/feedback DSCODE_VIEWS_FEEDBACK/, 'a resume has no prompt echo for a command')
  assert.doesNotMatch(resumed, /Browser: (?:off|on)/, "the bridge's own /browser result is live only")
  return ['goal-refusal', 'feedback', 'browser-live-only']
}
