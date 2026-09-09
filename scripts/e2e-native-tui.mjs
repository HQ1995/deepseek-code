import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function nativeTuiReply(body) {
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user' && String(message.content).startsWith('DSCODE_NATIVE_'))
  if (start < 0) return
  const prompt = String(messages[start].content)
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  if (prompt.startsWith('DSCODE_NATIVE_REFERENCE_SOURCE:')) return { text: `Source fact: ${prompt.split(':')[1]}` }
  if (prompt.startsWith('DSCODE_NATIVE_REFERENCE_USE')) {
    return { text: JSON.stringify(messages).includes('<referenced-sessions>') ? 'DSCODE_NATIVE_REFERENCE_RESOLVED' : 'DSCODE_NATIVE_REFERENCE_MISSING' }
  }
  if (prompt.startsWith('DSCODE_NATIVE_TODO')) {
    if (!results.length) return { name: 'todo_write', arguments: { todos: [
      { content: 'Native completed item', status: 'completed' },
      { content: 'Native remaining item', status: 'pending' },
    ] } }
    return { text: 'DSCODE_NATIVE_TODO_READY' }
  }
  const child = prompt.match(/^DSCODE_NATIVE_WORKER_([AB])/)
  if (child) {
    if (!results.length) return { name: 'todo_write', arguments: { todos: [
      { content: `Native child ${child[1]} checklist`, status: 'pending' },
    ] } }
    return { text: `DSCODE_NATIVE_WORKER_${child[1]}_RUNNING`, hold: true,
      releaseKey: `native-${child[1]}`, releaseText: ` DSCODE_NATIVE_WORKER_${child[1]}_DONE` }
  }
  if (prompt.startsWith('DSCODE_NATIVE_WORKFLOW')) {
    if (!results.length) return { name: 'workflow', arguments: {
      meta: { name: 'dscode-native-review', description: 'Review two independent inputs', phases: [{ title: 'Read' }] },
      script: "phase('Read'); return await parallel([() => agent('DSCODE_NATIVE_WORKER_A', { label: 'Native reader A' }), () => agent('DSCODE_NATIVE_WORKER_B', { label: 'Native reader B' })]);",
    } }
    return { text: 'DSCODE_NATIVE_WORKFLOW_DONE' }
  }
}

export async function nativeTuiAcceptance(ui) {
  const { send, key, type, wait, waitFor, capture, state, waitState, artifact, restart, readRequests, runHeadless, cwd } = ui
  const release = async name => {
    const response = await fetch(`${process.env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=native-${name}`, { method: 'POST' })
    assert.ok(response.ok, `Release worker ${name}: ${response.status}`)
  }
  const openReferences = async query => {
    await key('C-p'); await type('reference'); await key('Enter')
    await wait(/Reference session/)
    await type(query)
    await waitFor(capture, screen => screen.includes(query) && !screen.includes('Searching sessions') && !screen.includes('No matching sessions'), 'native-reference-candidates')
  }
  const sourceId = randomUUID(), secret = `fact-${randomUUID()}`
  await runHeadless({ cwd, preset: 'standard', sessionId: sourceId, prompt: `DSCODE_NATIVE_REFERENCE_SOURCE:${secret}` })
  await type('DSCODE_NATIVE_REFERENCE_USE ')
  const before = (await readRequests()).length
  await openReferences(sourceId)
  await key('Escape')
  assert.ok((await capture()).includes('DSCODE_NATIVE_REFERENCE_USE'))
  await openReferences(sourceId)
  await artifact('native-reference-picker', { sourceId, screen: await capture() })
  await key('Enter')
  await wait(/dsh-session:/)
  assert.equal((await readRequests()).length, before, 'Choosing/cancelling a reference must not send a model request')
  await key('Enter')
  await wait(/DSCODE_NATIVE_REFERENCE_RESOLVED/)
  await waitState(value => value.status === 'idle', 'reference-turn-idle')
  const request = (await readRequests()).findLast(body => JSON.stringify(body.messages).includes('<referenced-sessions>'))
  assert.ok(request && JSON.stringify(request.messages).includes(secret), 'Native snapshot must contain the selected source fact')
  assert.ok(JSON.stringify(request.messages).includes('untrusted, read-only snapshot'))
  await artifact('native-reference-resolved', { sourceId, request, screen: await capture() })

  await send('DSCODE_NATIVE_TODO')
  await wait(/DSCODE_NATIVE_TODO_READY/)
  await waitState(value => value.status === 'idle', 'native-todo-idle')
  for (const fresh of [false, true]) {
    if (fresh) await restart()
    await key('C-t')
    await wait(/Native remaining item/)
    await artifact(`native-todo-${fresh ? 'restarted' : 'live'}`, { screen: await capture(), state: await state() })
    await key('C-t')
  }

  let firstRun
  for (const iteration of [1, 2]) {
    const requestStart = (await readRequests()).length
    await send(`DSCODE_NATIVE_WORKFLOW ${iteration}`)
    const snapshot = await waitState(value => value.workflows.filter(event => event.type === 'tool-workflow/agent-start').length >= iteration * 2, `workflow-${iteration}-members`)
    const run = snapshot.workflows.filter(event => event.type === 'tool-workflow/run-start').at(-1).data.runId
    if (iteration === 1) firstRun = run
    else assert.notEqual(run, firstRun, 'Same workflow name must keep distinct run identities')
    await waitFor(readRequests, requests => ['A', 'B'].every(name => requests.slice(requestStart).some(body =>
      body.messages.some(message => message.role === 'user' && message.content === `DSCODE_NATIVE_WORKER_${name}`)
      && body.messages.some(message => message.role === 'tool' && String(message.content).includes('Updated todo list'))
    )), `workflow-${iteration}-children-ready`)
    if (iteration === 1) {
      await key('C-g')
      await wait(/Workflow dscode-native-review/)
      const tasks = await capture()
      assert.ok(!tasks.includes('Native reader A') && !tasks.includes('Native reader B'), 'Workflow members belong under their workflow, not duplicate top-level Tasks rows')
      await artifact('native-workflow-tasks', { screen: tasks })
      await key('C-g')
    }
    await send('/workflows')
    await wait(/dscode-native-review/)
    if (iteration === 2) await key('Enter')
    await wait(/Native reader A[\s\S]*Native reader B/)
    const screen = await capture()
    assert.ok(!/p pause|r resume|x stop|s save/.test(screen), 'Native workflow details must be read-only')
    await artifact(`native-workflow-${iteration}-active`, { run, screen, state: snapshot })
    await key('Tab'); await key('Tab'); await key('Enter')
    await wait(/Native reader B[^\n]*\[✗\]/)
    await key('C-t'); await wait(/Native child B checklist/)
    await artifact(`native-workflow-${iteration}-child`, { screen: await capture() })
    await key('C-t')
    await key('Escape')
    await key('g')
    await release('A'); await release('B')
    await waitState(value => value.workflows.some(event => event.type === 'tool-workflow/run-end' && event.data.runId === run), `workflow-${iteration}-durable-end`)
    await waitState(value => value.status === 'idle', `workflow-${iteration}-parent-idle`)
  }
  await restart()
  await send('/workflows')
  const runs = await waitFor(capture, screen => screen.split('dscode-native-review').length >= 3, 'native-workflow-restarted-runs')
  await artifact('native-workflow-restarted-runs', { screen: runs, state: await state() })
  await key('Enter')
  await wait(/Native reader A[\s\S]*Native reader B/)
  await key('Tab'); await key('Tab'); await key('Enter')
  await wait(/Native reader B[^\n]*\[✗\]/)
  await key('C-t'); await wait(/Native child B checklist/)
  await artifact('native-workflow-restarted-child-todo', { screen: await capture() })
  await key('C-t'); await key('Escape'); await key('g')
  return { sourceId, firstRun, workflowRuns: 2 }
}
