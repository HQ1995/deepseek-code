import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const messageText = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

export function nativeControlsReply(body) {
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user' && messageText(message) !== 'Attached image(s) from tool result:')
  const prompt = messages[start] && messageText(messages[start])
  if (prompt?.includes('DSCODE_LOG_') && prompt.includes('background job')) return { text: 'DSCODE_CONTROLS_JOB_NOTICE' }
  if (!prompt?.includes('DSCODE_CONTROLS_')) return
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
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
  // official resume path. No observer or test controller mutates the schedule.
  await send('/reminders'); await wait(/Session reminders/); await ready()
  const reminderStart = (await readRequests()).length
  await edit('a', 'after 1h DSCODE_CONTROLS_CANCEL')
  const cancelState = await waitState(value => value.schedules.some(event => event.data.schedule?.prompt === 'DSCODE_CONTROLS_CANCEL'), 'panel-reminder-created')
  const cancelId = cancelState.schedules.find(event => event.data.schedule?.prompt === 'DSCODE_CONTROLS_CANCEL').data.schedule.id
  await key('x'); await ready()
  await waitState(value => value.schedules.some(event => event.data.operation === 'delete' && event.data.id === cancelId), 'panel-reminder-cancelled')
  await edit('a', 'every 5m DSCODE_CONTROLS_RECURRING')
  await key('a'); await wait(/Enter: submit/); await paste('every 1s DSCODE_CONTROLS_INVALID'); await key('Enter')
  await wait(/every_seconds must be at least 300/)
  await wait(/every 1s DSCODE_CONTROLS_INVALID/)
  await artifact('controls-reminder-invalid', { screen: await capture(), state: await state() })
  await key('Escape')
  await edit('a', 'after 12s DSCODE_CONTROLS_REMINDER_DUE')
  const scheduled = await waitState(value => value.schedules.some(event => event.data.schedule?.prompt === 'DSCODE_CONTROLS_REMINDER_DUE'), 'panel-reminder-due-created')
  const dueId = scheduled.schedules.find(event => event.data.schedule?.prompt === 'DSCODE_CONTROLS_REMINDER_DUE').data.schedule.id
  assert.equal((await readRequests()).length, reminderStart, 'Reminder CRUD must not prompt the model')
  await artifact('controls-reminders-live', { state: scheduled, screen: await capture() })
  await key('Escape')
  await restart(13000)
  await wait(/DSCODE_CONTROLS_REMINDER_DELIVERED/)
  await waitState(value => value.status === 'idle' && value.schedules.some(event => event.data.operation === 'dispatch' && event.data.id === dueId), 'overdue-reminder-native-dispatch')
  await send('/reminders'); await wait(/DSCODE_CONTROLS_RECURRING/); await ready()
  assert.ok(!(await capture()).includes('DSCODE_CONTROLS_REMINDER_DUE'))
  await artifact('controls-reminders-restarted', { state: await state(), screen: await capture() })
  await key('x'); await ready(); await key('Escape')

  await send('DSCODE_CONTROLS_JOB_START'); await wait(/DSCODE_CONTROLS_JOB_HELD/)
  const jobs = await waitState(value => value.jobs.some(job => job.label.includes('DSCODE_LOG_')), 'passive-log-native-job')
  const job = jobs.jobs.find(job => job.label.includes('DSCODE_LOG_'))
  assert.equal(job.reported, false)
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
  assert.equal(finished.jobs.find(row => row.id === job.id).reported, job.reported, 'Viewing output must not acknowledge the model job')
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

  const path = join(cwd, 'controls-image.png')
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  const imagePrompt = `DSCODE_CONTROLS_IMAGE:${Buffer.from(path).toString('base64url')}`
  await send(imagePrompt); await wait(/DSCODE_CONTROLS_IMAGE_DONE/)
  const imageState = await waitState(value => value.status === 'idle' && value.images.length > 0, 'tool-image-native-attachment')
  const stored = imageState.images.at(-1)
  assert.ok(stored.path && stored.path !== path)
  const bytes = await readFile(stored.path)
  await wait(new RegExp(basename(stored.path).replaceAll('.', '\\.')))
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
  await wait(new RegExp(basename(stored.path).replaceAll('.', '\\.')))
  await artifact('controls-image-restarted', { image: stored, screen: await capture() })
  await openTask('DSCODE controlled child', true)
  await wait(/DSCODE controlled child[^\n]*\[✗\]/)
  for (let i = 0; i < 10; i++) await key('NPage')
  await wait(new RegExp(basename(stored.path).replaceAll('.', '\\.')))
  await artifact('controls-image-child-history', { screen: await capture() })
  await key('Escape'); await key('C-g')
  return { childId, jobId: job.id, dueReminderId: dueId, image: stored.attachment }
}
