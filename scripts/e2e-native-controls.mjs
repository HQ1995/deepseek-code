import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A tool image kept in the attachment store is captioned, not named by its
 * content hash; Open still reaches the stored file (checked below). */
const STORED_IMAGE_CAPTION = /Saved with the session · click to copy its path/

const messageText = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const latestPrompt = messages => {
  const start = messages.findLastIndex(message => message.role === 'user' && messageText(message) !== 'Attached image(s) from tool result:')
  return { start, prompt: messages[start] && messageText(messages[start]) }
}

// Each job outlives the reply that started it, so its completion reaches an idle owner.
const WAKE_CHAIN_STEPS = 4
const wakeChainJob = step => ({ name: 'bash', arguments: {
  command: `: DSCODE_WAKE_STEP_${step}; sleep 2`, description: `DSCODE wake chain ${step}`, run_in_background: true,
} })
const wakeNoticeStep = prompt => prompt?.includes('background job') ? Number(prompt.match(/DSCODE_WAKE_STEP_(\d+)/)?.[1] ?? 0) : 0

export function nativeControlsReply(body) {
  const messages = body.messages ?? []
  const { start, prompt } = latestPrompt(messages)
  if (prompt?.includes('DSCODE_LOG_') && prompt.includes('background job')) return { text: 'DSCODE_CONTROLS_JOB_NOTICE' }
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  // A completion notice names its job's command; the turn it opens starts the next step.
  const woke = wakeNoticeStep(prompt)
  if (woke > 0 || prompt?.includes('DSCODE_CONTROLS_WAKE_CHAIN')) {
    if (woke === WAKE_CHAIN_STEPS) return { text: 'DSCODE_CONTROLS_WAKE_CHAIN_DONE' }
    if (!results.length) return wakeChainJob(woke + 1)
    return { text: `DSCODE_CONTROLS_WAKE_STARTED_${woke + 1}` }
  }
  if (!prompt?.includes('DSCODE_CONTROLS_')) return
  if (prompt.includes('DSCODE_CONTROLS_PRESENT')) {
    if (!results.length) return { name: 'present', arguments: { files: [{ path: 'delivered report.md', description: 'DSCODE delivered artifact' }] } }
    return { text: 'DSCODE_CONTROLS_PRESENT_DONE' }
  }
  if (prompt.includes('DSCODE_CONTROLS_REMINDER_DUE')) return { text: 'DSCODE_CONTROLS_REMINDER_DELIVERED' }
  if (prompt.includes('DSCODE_CONTROLS_CHILD_HOLD')) return { text: 'DSCODE_CONTROLS_CHILD_RUNNING', hold: true, releaseKey: 'controls-child', releaseText: ' CHILD_END' }
  if (prompt.includes('DSCODE_CONTROLS_JOB_START')) {
    if (!results.length) return { name: 'bash', arguments: {
      command: "printf 'DSCODE_LOG_%s\\n' FIRST; sleep 4; printf 'DSCODE_LOG_%s\\n' SECOND; sleep 2",
      description: 'DSCODE passive log probe', run_in_background: true,
    } }
    return { text: 'DSCODE_CONTROLS_JOB_HELD', hold: true, releaseKey: 'controls-job', releaseText: ' JOB_END' }
  }
  const job = prompt.match(/DSCODE_CONTROLS_JOB_READ:(\S+)/)
  if (job) {
    if (!results.length) return { name: 'job_output', arguments: { job_id: job[1] } }
    const text = JSON.stringify(results)
    return { text: text.includes('DSCODE_LOG_FIRST') && text.includes('DSCODE_LOG_SECOND')
      ? 'DSCODE_CONTROLS_JOB_CURSOR_INTACT' : 'DSCODE_CONTROLS_JOB_CURSOR_LOST' }
  }
  const image = prompt.match(/DSCODE_CONTROLS_IMAGE:([A-Za-z0-9_-]+)/)
  if (image) {
    if (!results.length) return { name: 'read_image', arguments: { file_path: Buffer.from(image[1], 'base64url').toString('utf8') } }
    return { text: 'DSCODE_CONTROLS_IMAGE_DONE', ...prompt.includes('hold child image')
      ? { hold: true, releaseKey: 'controls-image-child', releaseText: ' IMAGE_CHILD_END' } : {} }
  }
  return { text: 'DSCODE_CONTROLS_CHILD_DONE' }
}

export async function nativeControlsAcceptance(ui) {
  const { send, key, type, paste, click, mediaOpenerLog, wait, waitFor, capture, state, waitState, settle, artifact, restart, readRequests, cwd, childId } = ui
  const child = () => state(childId)
  const waitChild = (predicate, label) => waitFor(child, value => value && predicate(value), label)
  const pending = value => [...value.inbox.nextTurn, ...value.inbox.nextStep]
  const release = async name => {
    const result = await fetch(`${process.env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=controls-${name}`, { method: 'POST' })
    assert.ok(result.ok)
  }
  const ready = () => waitFor(capture, screen => screen.includes('Esc:') && !screen.includes('Updating…') && !screen.includes('Loading…') && !screen.includes('Enter: submit'), 'controls-idle')
  const edit = async (action, text) => {
    await ready(); await key(action); await wait(/Enter: submit/); await paste(text); await key('Enter'); await ready()
  }
  const openInbox = async () => {
    await key('C-p'); await type('inbox'); await key('Enter'); await wait(/Child conversations/); await ready()
    const children = (await state()).descendants.filter(row => row.kind === 'child' && row.mode === 'continuable')
    const index = children.findIndex(row => row.id === childId)
    assert.ok(index >= 0)
    for (let i = 0; i < index; i++) await key('Down')
    await key('Enter'); await wait(/Input queue/); await ready()
  }
  // Queueing to an inactive child uses native resume admission. All mutations
  // below go through the real panel while the root draft remains unsent.
  await type('DSCODE_CONTROLS_ROOT_DRAFT')
  const before = (await readRequests()).length
  await openInbox()
  await edit('a', 'DSCODE_CONTROLS_CHILD_HOLD')
  await waitChild(value => value.status === 'running', 'panel-child-resumed')
  await waitFor(readRequests, rows => rows.slice(before).some(body => JSON.stringify(body.messages).includes('DSCODE_CONTROLS_CHILD_HOLD')), 'panel-child-held')
  await edit('a', 'DSCODE_CONTROLS_EDIT\nsecond line')
  const queued = await waitChild(value => value.inbox.nextTurn.length === 1, 'panel-queue')
  const message = queued.inbox.nextTurn[0]
  assert.equal(messageText(message), 'DSCODE_CONTROLS_EDIT\nsecond line')
  assert.equal(message.source.kind, 'user')
  assert.ok(message.source.rpcId)
  await edit('e', '\nthird line')
  const edited = await waitChild(value => messageText(value.inbox.nextTurn[0] ?? { content: '' }).endsWith('third line'), 'panel-multiline-edit')
  assert.equal(edited.inbox.nextTurn[0].id, message.id)
  assert.equal(messageText(edited.inbox.nextTurn[0]), 'DSCODE_CONTROLS_EDIT\nsecond line\nthird line')
  assert.deepEqual(edited.inbox.nextTurn[0].source, message.source)
  await key('i'); await ready()
  await waitChild(value => value.inbox.nextStep.length === 1 && value.inbox.nextTurn.length === 0, 'panel-steer-queued')
  await edit('s', 'DSCODE_CONTROLS_DIRECT')
  const steering = await waitChild(value => value.inbox.nextStep.length === 2, 'panel-direct-steer')
  await key('S'); await ready()
  const stopped = await waitChild(value => value.status === 'idle', 'panel-stop')
  assert.deepEqual(pending(stopped), pending(steering), 'Stop must preserve pending IDs, multiline content and source')
  await artifact('controls-inbox-stop', { parent: await state(), child: stopped, screen: await capture() })
  await key('x'); await ready()
  await waitChild(value => pending(value).length === 1, 'panel-remove')
  await key('X'); await ready()
  await waitFor(child, value => value === null || pending(value).length === 0, 'panel-clear')
  await wait(/No pending items/)
  await edit('a', 'DSCODE_CONTROLS_RESUME')
  await waitState(value => value.descendants.some(row => row.id === childId && row.activity === 'inactive'), 'panel-child-complete')
  await key('Escape')
  assert.ok((await capture()).includes('DSCODE_CONTROLS_ROOT_DRAFT'))
  assert.ok(!(await readRequests()).slice(before).some(body => JSON.stringify(body.messages).includes('DSCODE_CONTROLS_ROOT_DRAFT')), 'Panel must not submit the parent draft')
  await key('C-u')

  // Native reminders survive a new leader, and overdue delivery uses the
  // official resume path. No observer or test controller mutates the schedule:
  // the observer only reads the Host Schedule catalog (DSH 0.1.7-rc.2).
  const reminder = (value, prompt) => value.reminders.find(row => row.prompt === prompt)
  await send('/reminders'); await wait(/Session reminders/); await ready()
  const reminderStart = (await readRequests()).length
  await edit('a', 'after 1h DSCODE_CONTROLS_CANCEL')
  const cancelState = await waitState(value => reminder(value, 'DSCODE_CONTROLS_CANCEL')?.status === 'active', 'panel-reminder-created')
  const cancelId = reminder(cancelState, 'DSCODE_CONTROLS_CANCEL').id
  await key('x'); await ready()
  // A deleted Host task has no row left in the catalog.
  await waitState(value => !value.reminders.some(row => row.id === cancelId), 'panel-reminder-cancelled')
  await edit('a', 'every 5m DSCODE_CONTROLS_RECURRING')
  await waitState(value => reminder(value, 'DSCODE_CONTROLS_RECURRING')?.kind === 'every', 'panel-reminder-recurring-created')
  await key('a'); await wait(/Enter: submit/); await paste('every 1s DSCODE_CONTROLS_INVALID'); await key('Enter')
  await wait(/A repeating reminder needs an interval of at least 1m\./)
  await wait(/every 1s DSCODE_CONTROLS_INVALID/)
  await artifact('controls-reminder-invalid', { screen: await capture(), state: await state() })
  assert.ok(!(await state()).reminders.some(row => row.prompt === 'DSCODE_CONTROLS_INVALID'), 'An invalid reminder must not be stored')
  await key('Escape')
  await edit('a', 'after 12s DSCODE_CONTROLS_REMINDER_DUE')
  const scheduled = await waitState(value => reminder(value, 'DSCODE_CONTROLS_REMINDER_DUE')?.status === 'active', 'panel-reminder-due-created')
  const dueId = reminder(scheduled, 'DSCODE_CONTROLS_REMINDER_DUE').id
  assert.equal((await readRequests()).length, reminderStart, 'Reminder CRUD must not prompt the model')
  await artifact('controls-reminders-live', { state: scheduled, screen: await capture() })
  await key('Escape')
  await restart(13000)
  await wait(/DSCODE_CONTROLS_REMINDER_DELIVERED/)
  // A delivered one-shot ends: the Host keeps it as an inactive row with its delivery.
  const dueDelivered = await waitState(value => value.status === 'idle'
    && value.reminders.some(row => row.id === dueId && row.status === 'inactive' && row.lastDelivery), 'overdue-reminder-native-dispatch')
  assert.equal(reminder(dueDelivered, 'DSCODE_CONTROLS_RECURRING')?.status, 'active', 'The recurring reminder stays armed across the restart')
  // Armed reminders list first; the delivered one stays listed as inactive until deleted.
  await send('/reminders'); await wait(/DSCODE_CONTROLS_RECURRING/)
  await wait(/DSCODE_CONTROLS_REMINDER_DUE[^\n]*\n[^\n]*inactive · after 12s · delivered \d{4}-/); await ready()
  await artifact('controls-reminders-restarted', { state: await state(), screen: await capture() })
  // Delete both rows (the armed one first) so nothing fires into the steps below.
  await key('x'); await ready()
  await waitState(value => !value.reminders.some(row => row.prompt === 'DSCODE_CONTROLS_RECURRING'), 'panel-reminder-recurring-deleted')
  await key('x'); await ready()
  await waitState(value => value.reminders.length === 0, 'panel-reminder-inactive-deleted')
  await wait(/No pending items/); await key('Escape')

  await send('DSCODE_CONTROLS_JOB_START'); await wait(/DSCODE_CONTROLS_JOB_HELD/)
  const jobs = await waitState(value => value.jobs.some(job => job.label.includes('DSCODE_LOG_')), 'passive-log-native-job')
  const job = jobs.jobs.find(job => job.label.includes('DSCODE_LOG_'))
  assert.equal(job.output.earliest, 0)
  const openTask = async (label, fresh = false) => {
    await key('C-g')
    if (fresh) { await key('h'); await wait(/h:hide done/) }
    await key('Home'); await key('Right'); await key('/'); await key('C-u'); await type(label); await key('Enter'); await settle(150); await key('Enter')
  }
  await openTask('DSCODE_LOG_')
  await wait(/DSCODE_LOG_FIRST/)
  const streaming = await state()
  assert.equal(streaming.jobs.find(row => row.id === job.id).status, 'running')
  await artifact('controls-job-streaming', { state: streaming, screen: await capture() })
  await wait(/DSCODE_LOG_SECOND/)
  const finished = await waitState(value => value.jobs.some(row => row.id === job.id && row.status === 'completed'), 'passive-log-native-completed')
  assert.equal(finished.jobs.find(row => row.id === job.id).output.earliest, job.output.earliest, 'Passive viewing must retain the output head')
  await artifact('controls-job-completed', { state: finished, screen: await capture() })
  await key('q')
  await waitFor(capture, screen => !screen.includes('f:filter'), 'passive-log-viewer-closed')
  // A task log returns focus to scrollback. First focus Tasks, then hide it.
  await key('C-g'); await key('C-g'); await release('job')
  await waitState(value => value.status === 'idle', 'passive-log-parent-idle')
  await send(`DSCODE_CONTROLS_JOB_READ:${job.id}`)
  await waitFor(readRequests, rows => rows.some(body => JSON.stringify(body.messages).includes(`DSCODE_CONTROLS_JOB_READ:${job.id}`)), 'passive-log-model-read-admitted')
  await wait(/DSCODE_CONTROLS_JOB_CURSOR_INTACT/)
  await waitState(value => value.status === 'idle', 'passive-log-read-idle')

  // DSH 0.1.7-alpha.2 no longer caps completion wakeups by default. Under the
  // old cap of three, the fourth idle completion was queued silently and the
  // chain stalled until the next user input; here each one opens its own turn.
  const chainStart = (await readRequests()).length
  await send('DSCODE_CONTROLS_WAKE_CHAIN')
  await wait(/DSCODE_CONTROLS_WAKE_CHAIN_DONE/)
  const chained = await waitState(value => value.status === 'idle'
    && value.jobs.filter(row => row.label.includes('DSCODE_WAKE_STEP_') && row.status === 'completed').length === WAKE_CHAIN_STEPS, 'wake-chain-idle')
  const wakePrompts = (await readRequests()).slice(chainStart).map(body => latestPrompt(body.messages ?? []).prompt)
  for (let step = 1; step <= WAKE_CHAIN_STEPS; step++) {
    assert.ok(wakePrompts.some(prompt => wakeNoticeStep(prompt) === step), `Idle completion ${step} must open a model turn`)
  }
  assert.ok(wakePrompts.filter(prompt => wakeNoticeStep(prompt) === 0).every(prompt => prompt?.includes('DSCODE_CONTROLS_WAKE_CHAIN')),
    'The chain must need no further user input')
  await artifact('controls-wake-chain', { state: chained, prompts: wakePrompts, screen: await capture() })

  const delivered = join(cwd, 'delivered report.md')
  await writeFile(delivered, '# Native DSH delivery\n')
  const openedBefore = await readFile(mediaOpenerLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  await send('DSCODE_CONTROLS_PRESENT'); await wait(/DSCODE_CONTROLS_PRESENT_DONE/)
  const presented = await waitState(value => value.status === 'idle' && value.deliveries.length === 1, 'native-present-delivery')
  await wait(/Delivered files/)
  assert.equal(presented.deliveries[0].data.files[0].path, 'delivered report.md')
  assert.ok(presented.projections.values.subagentCatalog.some(row => row.id === childId), 'Native parent catalog must retain the completed child')
  assert.equal(await readFile(mediaOpenerLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), openedBefore, 'Present must not open files automatically')
  await artifact('controls-delivery-live', { state: presented, screen: await capture() })
  await restart()
  await wait(/Delivered files/)
  const replayed = await waitState(value => value.status === 'idle' && value.deliveries.length === 1, 'native-present-replay')
  assert.deepEqual(replayed.deliveries, presented.deliveries)
  assert.deepEqual(replayed.projections.values.subagentCatalog, presented.projections.values.subagentCatalog)
  await artifact('controls-delivery-replayed', { state: replayed, screen: await capture() })
  const requestsBeforeFeedback = (await readRequests()).length
  await send('/feedback DSCODE_CONTROLS_FEEDBACK')
  await waitState(value => value.feedback.some(event => event.data.text === 'DSCODE_CONTROLS_FEEDBACK'), 'native-feedback-recorded')
  assert.equal((await readRequests()).length, requestsBeforeFeedback, 'Feedback must not start a model turn')

  const path = join(cwd, 'controls-image.png')
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  const imagePrompt = `DSCODE_CONTROLS_IMAGE:${Buffer.from(path).toString('base64url')}`
  await send(imagePrompt); await wait(/DSCODE_CONTROLS_IMAGE_DONE/)
  const imageState = await waitState(value => value.status === 'idle' && value.images.length > 0, 'tool-image-native-attachment')
  const stored = imageState.images.at(-1)
  assert.ok(stored.path && stored.path !== path)
  const bytes = await readFile(stored.path)
  await wait(STORED_IMAGE_CAPTION)
  const imageScreen = await wait(/\[Open/)
  const lines = imageScreen.split('\n'), y = lines.findLastIndex(line => line.includes('[Open'))
  await click(lines[y].indexOf('[Open') + 2, y)
  await waitFor(() => readFile(mediaOpenerLog, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error
  }), log => log.split('\n').some(line => line && JSON.parse(line)[0] === stored.path), 'native-image-open-verified-path')
  await artifact('controls-image-live', { image: stored, screen: await capture() })
  await send(`/subagents queue ${childId} ${imagePrompt} hold child image`)
  await waitFor(child, value => value?.images.length > 0 && value.status === 'running', 'child-tool-image')
  await release('image-child')
  await waitState(value => value.descendants.some(row => row.id === childId && row.activity === 'inactive'), 'child-image-completed')
  await unlink(path)
  await restart()
  assert.deepEqual(await readFile(stored.path), bytes)
  await wait(STORED_IMAGE_CAPTION)
  await artifact('controls-image-restarted', { image: stored, screen: await capture() })
  await openTask('DSCODE controlled child', true)
  await wait(/DSCODE controlled child[^\n]*\[✗\]/)
  for (let i = 0; i < 10; i++) await key('NPage')
  await wait(STORED_IMAGE_CAPTION)
  await artifact('controls-image-child-history', { screen: await capture() })
  await key('Escape'); await key('C-g')
  return { childId, jobId: job.id, dueReminderId: dueId, image: stored.attachment, deliveries: true, parentCatalog: true, feedbackWithoutTurn: true, idleCompletionWakes: WAKE_CHAIN_STEPS }
}
