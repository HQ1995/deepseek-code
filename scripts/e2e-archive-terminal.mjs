import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const text = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const terminalId = results => text(results[0] ?? {}).match(/started terminal session (\S+)/)?.[1]

export function archiveTerminalReply(body) {
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user' && text(message) !== 'Attached image(s) from tool result:')
  const prompt = messages[start] && text(messages[start])
  if (!prompt?.includes('DSCODE_EXTRA_')) return
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  const image = prompt.match(/DSCODE_EXTRA_ARCHIVE_(ROOT|CHILD):([A-Za-z0-9_-]+)/)
  if (image) {
    if (!results.length) return { name: 'read_image', arguments: { file_path: Buffer.from(image[2], 'base64url').toString() } }
    if (image[1] === 'ROOT' && results.length === 1) return { name: 'subagent', arguments: {
      description: 'Archive evidence child', prompt: `DSCODE_EXTRA_ARCHIVE_CHILD:${image[2]}`, run_in_background: false,
    } }
    return { text: `DSCODE_EXTRA_ARCHIVE_${image[1]}_DONE` }
  }
  if (prompt.includes('DSCODE_EXTRA_PTY_SEQUENCE')) {
    if (!results.length) return { name: 'terminal_open', arguments: { type: 'shell', name: 'repl' } }
    const sessionId = terminalId(results)
    const steps = [
      { name: 'terminal_send', arguments: { sessionId, text: 'mkdir -p pty-cwd; cd pty-cwd; export DSCODE_PTY_VALUE=retained' } },
      { name: 'terminal_send', arguments: { sessionId, text: 'printf "DSCODE_PTY_%s:%s:%s\\n" STATE "$DSCODE_PTY_VALUE" "$PWD"; python3 -q' } },
      { name: 'terminal_send', arguments: { sessionId, text: "print('DSCODE_PTY_' + 'REPL', 6 * 7)" } },
      { name: 'terminal_send', arguments: { sessionId, text: 'exit()' } },
      { name: 'terminal_close', arguments: { sessionId } },
    ]
    return steps[results.length - 1] ?? { text: 'DSCODE_EXTRA_PTY_SEQUENCE_DONE' }
  }
  if (prompt.includes('DSCODE_EXTRA_PTY_BACKGROUND')) {
    if (!results.length) return { name: 'terminal_open', arguments: { type: 'shell', name: 'background' } }
    if (results.length === 1) return { name: 'terminal_send', arguments: {
      sessionId: terminalId(results), run_in_background: true,
      // Exercise process-group churn during cancellation, including the native
      // inspect/kill ESRCH boundary. The shell must remain reusable.
      text: "printf 'DSCODE_PTY_%s\\n' EARLY; sleep 1; printf 'DSCODE_PTY_%s\\n' LATE; while :; do printf 'DSCODE_PTY_%s\\n' TICK; sleep 0.1; done",
    } }
    return { text: 'DSCODE_EXTRA_PTY_BACKGROUND_HELD', hold: true, releaseKey: 'extra-pty', releaseText: ' RELEASED' }
  }
  const uiRun = prompt.match(/DSCODE_EXTRA_PTY_UI_RUN:(\S+)/)
  if (uiRun) {
    if (!results.length) return { name: 'terminal_send', arguments: { sessionId: uiRun[1], text: 'sleep 60', run_in_background: true } }
    return { text: 'DSCODE_EXTRA_PTY_UI_HELD', hold: true, releaseKey: 'polish-pty', releaseText: ' RELEASED' }
  }
  const read = prompt.match(/DSCODE_EXTRA_PTY_READ:(\S+)/)
  if (read) {
    if (!results.length) return { name: 'job_output', arguments: { job_id: read[1] } }
    return { text: 'DSCODE_EXTRA_PTY_READ_DONE' }
  }
  const foreign = prompt.match(/DSCODE_EXTRA_PTY_FOREIGN:(\S+)/)
  if (foreign) {
    if (!results.length) return { name: 'terminal_read', arguments: { sessionId: foreign[1] } }
    return { text: 'DSCODE_EXTRA_PTY_FOREIGN_DONE ' + text(results[0]) }
  }
  const owner = prompt.match(/DSCODE_EXTRA_PTY_OWNER:(\S+)/)
  if (owner) {
    if (!results.length) return { name: 'subagent', arguments: {
      description: 'PTY owner isolation', prompt: `DSCODE_EXTRA_PTY_FOREIGN:${owner[1]}`, run_in_background: false,
    } }
    return { text: 'DSCODE_EXTRA_PTY_OWNER_DONE' }
  }
  const reuse = prompt.match(/DSCODE_EXTRA_PTY_REUSE:(\S+)/)
  if (reuse) {
    if (!results.length) return { name: 'terminal_send', arguments: { sessionId: reuse[1], text: "printf 'DSCODE_PTY_%s\\n' RECOVERED" } }
    return { text: 'DSCODE_EXTRA_PTY_REUSE_DONE' }
  }
}

export async function archiveTerminalAcceptance(ui) {
  const { send, key, type, wait, waitFor, state, waitState, capture, readRequests, artifact, restart, fresh, cwd } = ui
  const imagePath = join(cwd, 'archive-image.png')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await writeFile(imagePath, png)
  console.log('[archive-terminal] native logs, descendants and attachments')
  await send(`DSCODE_EXTRA_ARCHIVE_ROOT:${Buffer.from(imagePath).toString('base64url')}`)
  await wait(/DSCODE_EXTRA_ARCHIVE_ROOT_DONE/, 60000)
  const root = await waitState(value => value.status === 'idle' && value.images.length > 0, 'archive-root-ready')
  const storedImage = root.images.findLast(image => image.attachment.name === 'archive-image.png')
  assert.ok(storedImage?.path)
  const storedBytes = await readFile(storedImage.path)
  const before = (await readRequests()).length
  const filename = 'archives/native session.zip'
  await send(`/export ${filename}`)
  await wait(/Session archive exported to/)
  assert.equal((await readRequests()).length, before, 'Export must not run the model')
  const path = join(cwd, filename)
  const inspect = await promisify(execFile)('python3', ['-c', `
import base64,hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 names=z.namelist()
 assert len(names)==len(set(names))
 logs=[n for n in names if n.endswith('.jsonl')]
 roots=[n for n in logs if '/' not in n]
 assert len(roots)==1
 root=z.read(roots[0]).decode()
 assert json.loads(root.splitlines()[0])['id']==sys.argv[2]
 assert 'DSCODE_EXTRA_ARCHIVE_ROOT_DONE' in root
 children=[n for n in logs if n.startswith('subagents/')]
 assert any('DSCODE_EXTRA_ARCHIVE_CHILD_DONE' in z.read(n).decode() for n in children)
 images=[n for n in names if n.startswith('media/')]
 assert sum(z.read(n)==base64.b64decode(sys.argv[3]) for n in images)==1
 assert 'sha256:'+hashlib.sha256(base64.b64decode(sys.argv[3])).hexdigest()==sys.argv[4]
 print(json.dumps({'logs':logs,'images':images,'crc':'valid','rootId':sys.argv[2]}))
`, path, root.id, storedBytes.toString('base64'), storedImage.attachment.attachmentId])
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const original = await readFile(path)
  await send(`/export ${filename}`)
  await wait(/EEXIST|file already exists/)
  assert.deepEqual(await readFile(path), original, 'Repeated exports must preserve existing files')
  await restart()
  await send('/export archives/resumed.zip')
  await wait(/Session archive exported to/)
  await artifact('native-archive', { ...JSON.parse(inspect.stdout), path, screen: await capture(), restarted: true })

  console.log('[archive-terminal] persistent shell and real Python REPL')
  await fresh('terminal')
  await send('DSCODE_EXTRA_PTY_SEQUENCE')
  await wait(/DSCODE_EXTRA_PTY_SEQUENCE_DONE/, 90000)
  await waitState(value => value.status === 'idle', 'pty-sequence-idle')
  const sequence = (await readRequests()).findLast(body => body.messages?.some(message => text(message) === 'DSCODE_EXTRA_PTY_SEQUENCE'))
  const results = sequence.messages.filter(message => message.role === 'tool')
  assert.equal(results.length, 6)
  assert.match(text(results[2]), /DSCODE_PTY_STATE:retained:.*pty-cwd/)
  assert.match(text(results[3]), /DSCODE_PTY_REPL 42/)
  assert.ok(results.every(result => !/tool_error|isError|FOREIGN_SESSION/.test(text(result))))
  assert.equal((await state()).terminals.length, 0, 'terminal_close must release the native session')
  const standard = (await readRequests()).find(body => body.messages?.some(message => text(message).startsWith('DSCODE_EXTRA_ARCHIVE_ROOT:')))
  assert.ok(!standard.tools.some(tool => tool.function.name === 'terminal_open'), 'Terminal tools must remain opt-in')
  await artifact('terminal-repl', { results, screen: await capture() })

  console.log('[archive-terminal] passive Tasks output, interrupt and owner isolation')
  await send('DSCODE_EXTRA_PTY_BACKGROUND')
  await wait(/DSCODE_EXTRA_PTY_BACKGROUND_HELD/, 30000)
  const running = await waitState(value => value.jobs.some(job => job.kind === 'pty-send' && job.status === 'running'), 'pty-background-running')
  const job = running.jobs.find(job => job.kind === 'pty-send')
  const terminal = running.terminals.find(row => row.name === 'background')
  assert.ok(terminal?.pid)
  assert.equal(job.reported, false)
  await key('C-g'); await key('Home'); await key('Right'); await key('/'); await key('C-u'); await type('DSCODE_PTY_'); await key('Enter'); await key('Enter')
  await wait(/DSCODE_PTY_EARLY/); await wait(/DSCODE_PTY_LATE/)
  assert.equal((await state()).jobs.find(row => row.id === job.id).reported, false)
  await artifact('terminal-live-task-log', { screen: await capture(), state: await state() })
  await key('q'); await key('C-g'); await key('x')
  await waitState(value => value.jobs.find(row => row.id === job.id)?.status === 'killed', 'pty-task-killed')
  await key('C-g')
  const release = await fetch(`${process.env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=extra-pty`, { method: 'POST' })
  assert.ok(release.ok)
  await waitState(value => value.status === 'idle', 'pty-background-parent-idle')
  await send(`DSCODE_EXTRA_PTY_READ:${job.id}`)
  await wait(/DSCODE_EXTRA_PTY_READ_DONE/)
  const read = (await readRequests()).findLast(body => body.messages?.some(message => text(message) === `DSCODE_EXTRA_PTY_READ:${job.id}`))
  const output = read.messages.filter(message => message.role === 'tool').at(-1)
  assert.match(text(output), /DSCODE_PTY_EARLY/); assert.match(text(output), /DSCODE_PTY_LATE/)
  await send(`DSCODE_EXTRA_PTY_OWNER:${terminal.sessionId}`)
  await wait(/DSCODE_EXTRA_PTY_OWNER_DONE/, 60000)
  const denied = (await readRequests()).findLast(body => body.messages?.some(message => text(message) === `DSCODE_EXTRA_PTY_FOREIGN:${terminal.sessionId}`))
  assert.ok(denied?.tools.some(tool => tool.function.name === 'terminal_read'), 'Ownership must be tested through the real child tool')
  assert.match(text(denied.messages.filter(message => message.role === 'tool').at(-1)), /FOREIGN_SESSION|another agent|not owned/i)
  await send(`DSCODE_EXTRA_PTY_REUSE:${terminal.sessionId}`)
  await wait(/DSCODE_EXTRA_PTY_REUSE_DONE/, 30000)
  const reused = (await readRequests()).findLast(body => body.messages?.some(message => text(message) === `DSCODE_EXTRA_PTY_REUSE:${terminal.sessionId}`))
  assert.match(text(reused.messages.filter(message => message.role === 'tool').at(-1)), /DSCODE_PTY_RECOVERED/)
  console.log('[polish] runtime doctor and direct terminal management')
  let modelCalls = (await readRequests()).length
  await send('/doctor')
  await wait(/Dscode Doctor/)
  await key('Tab')
  const doctor = await waitFor(async () => {
    const screen = await capture()
    if (!/PTY backend[\s\S]*shell backend registered/.test(screen)) await key('NPage')
    return screen
  }, screen => /PTY backend[\s\S]*shell backend registered/.test(screen), 'polish-doctor-report', 40000)
  assert.match(doctor, /Runtime provenance[\s\S]*native artifacts verified/)
  assert.match(doctor, /Shipped LSP preset[\s\S]*resolve in the execution host/)
  assert.equal((await readRequests()).length, modelCalls, '/doctor must not call the model')
  await artifact('polish-doctor', { screen: doctor })
  await key('Space')
  await send('/tasks terminals')
  await wait(/Persistent terminals[\s\S]*shell alive/)
  await waitFor(async () => {
    const screen = await capture()
    if (!screen.includes('DSCODE_PTY_RECOVERED')) await key('NPage')
    return screen
  }, screen => screen.includes('DSCODE_PTY_RECOVERED'), 'polish-terminal-retained-output')
  await artifact('polish-idle-terminal', { screen: await capture(), state: await state() })
  await key('Escape')
  assert.equal((await readRequests()).length, modelCalls, 'Terminal inspection must not call the model')
  await send(`DSCODE_EXTRA_PTY_UI_RUN:${terminal.sessionId}`)
  await wait(/DSCODE_EXTRA_PTY_UI_HELD/)
  const uiRunning = await waitState(value => value.jobs.some(row => row.kind === 'pty-send' && row.status === 'running'), 'polish-terminal-running')
  const uiJob = uiRunning.jobs.find(row => row.kind === 'pty-send' && row.status === 'running')
  modelCalls = (await readRequests()).length
  await key('C-g'); await key('t')
  await wait(/Persistent terminals[\s\S]*shell alive/)
  await key('i')
  await waitState(value => value.jobs.find(row => row.id === uiJob.id)?.status !== 'running', 'polish-interrupted-command')
  assert.ok((await state()).terminals.some(row => row.sessionId === terminal.sessionId), 'Interrupt keeps the shell available')
  assert.equal((await state()).jobs.find(row => row.id === uiJob.id).reported, false, 'Terminal read must not consume job output')
  await artifact('polish-terminal-interrupt', { screen: await capture(), state: await state() })
  await key('x'); await wait(/Shell state and running processes will be lost/)
  await key('Escape')
  assert.ok((await state()).terminals.some(row => row.sessionId === terminal.sessionId), 'Cancelled close keeps the terminal')
  await key('x'); await key('Enter')
  await wait(/No persistent terminals in this session/)
  await waitState(value => value.terminals.length === 0, 'polish-closed-terminal')
  assert.equal((await readRequests()).length, modelCalls, 'Interrupt and close must not run the model')
  await artifact('polish-terminal-close', { screen: await capture(), state: await state() })
  await key('Escape'); await key('C-g')
  const uiRelease = await fetch(`${process.env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=polish-pty`, { method: 'POST' })
  assert.ok(uiRelease.ok)
  await waitState(value => value.status === 'idle', 'polish-terminal-parent-idle')
  await restart()
  assert.equal((await state()).terminals.length, 0, 'A fresh runtime must not resurrect old PTYs')
  await waitFor(async () => {
    try { await stat(`/proc/${terminal.pid}`); return false }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  }, Boolean, 'owned-pty-reaped')
  await artifact('terminal-cleanup', { pid: terminal.pid, terminalId: terminal.sessionId, reaped: true, state: await state() })
  return { archive: JSON.parse(inspect.stdout), terminal: { sessionId: (await state()).id, repl: true, taskPreview: true, modelOutputIntact: true, ownerIsolation: true, interrupted: true, userControls: true, runtimeDoctor: true, reapedPid: terminal.pid } }
}
