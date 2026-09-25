#!/usr/bin/env node
// Interrupt a shell loop of short commands through the local subprocess
// provider, many times, under process-table load: the way a Tasks-pane stop
// reaches a background terminal job. A provider that resolves the foreground
// group and then scans the process table before the kill reports ESRCH here
// (the `sleep 0.1` it read had exited); the pinned runtime must stop the loop
// every time.
//
// Usage: node scripts/e2e-foreground-signal.mjs <runtime node_modules> [trials=30] [hogs=4]
// Exit status is 1 when any trial failed to stop the loop.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const [modulesArg, trialsArg = '30', hogsArg = '4'] = process.argv.slice(2)
if (!modulesArg) {
  console.error('usage: node scripts/e2e-foreground-signal.mjs <runtime node_modules> [trials] [hogs]')
  process.exit(2)
}
const modules = resolve(modulesArg)
const require = createRequire(modules + '/x.js')
const { Context } = require('@deepseek-ai/cordis')
const { LocalSubprocessRuntime } = require('@deepseek-ai/dsh-subprocess-local')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Load as a busy host has it: processes that keep reading /proc, so every
// process-table scan the inspector makes takes longer.
const hogs = Array.from({ length: Number(hogsArg) }, () =>
  spawn('sh', ['-c', 'while :; do cat /proc/[0-9]*/stat > /dev/null 2>&1; done'], { stdio: 'ignore' }))
const stopHogs = () => { for (const hog of hogs) { try { process.kill(hog.pid, 'SIGKILL') } catch { /* gone */ } } }
process.on('exit', stopHogs)

const runtime = new LocalSubprocessRuntime(new Context())
const handle = await runtime.spawnTerminal({
  argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 2000,
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TERM: 'xterm-256color', PS1: 'P$ ' },
})
let output = ''
handle.output.on('data', chunk => { output += chunk.toString('utf8') })
const ticks = () => output.split('TICK').length - 1
await sleep(400)

const counts = { stopped: 0, esrch: 0, other: 0, running: 0 }
const trials = Number(trialsArg)
for (let trial = 0; trial < trials; trial++) {
  await handle.write("while :; do printf 'TICK\\n'; sleep 0.1; done\r")
  await sleep(350 + Math.floor(Math.random() * 100))
  let stopped = false
  try {
    await handle.signalForeground('SIGINT')
    // Let output already in the pty buffer drain before the baseline count:
    // the provider's synchronous scans block the event loop, so a line printed
    // just before the signal can arrive after the call returned.
    await sleep(300)
    const before = ticks()
    await sleep(400)
    stopped = ticks() === before
    if (stopped) counts.stopped++
    else counts.running++
  } catch (error) {
    if (error?.code === 'ESRCH') counts.esrch++
    else { counts.other++; console.error('signalForeground failed:', error?.message) }
  }
  if (!stopped) { await handle.write('\u0003'); await sleep(300) }
}
stopHogs()
await handle.terminate()
const failed = trials - counts.stopped
console.log(JSON.stringify({ runtime: modules, trials, hogs: hogs.length, ...counts }))
console.log(failed === 0 ? `PASS foreground signal: ${trials}/${trials} loops stopped` : `FAIL foreground signal: ${failed}/${trials} loops not stopped`)
process.exit(failed === 0 ? 0 : 1)
