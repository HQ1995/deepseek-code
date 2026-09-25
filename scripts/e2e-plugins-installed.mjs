#!/usr/bin/env node
// Keyless acceptance for plugin management on an installed leader over ACP:
// the /dsh plugins table, an optional bundle and one of its rows switched on
// and off live, the core refusals, an override by a DSH-home patch, /doctor,
// the one-time note for a bundle the next start skips, the shell doctor, and
// `dscode doctor --reset-plugins` followed by a clean start.
// Usage: e2e-plugins-installed.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startLeader } from './acp-leader.mjs'

const [runtime, home] = process.argv.slice(2)
if (!runtime || !home) throw new Error('usage: e2e-plugins-installed.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>')
const profile = join(home, 'profiles/dscode')
const REVIEW = '@deepseek-ai/dsh-experimental-auto-review'
const MISSING = 'dsh-plugin-e2e-missing'
const SHIPPED = ['@deepseek-ai/dsh-base', '@hqzhao95/dscode']
const checks = [], samples = {}
const manifest = () => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
const patch = () => existsSync(join(profile, 'cordis.patch.yml')) ? readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') : ''
const waitFor = async (predicate, what, ms = 10000) => {
  for (const deadline = Date.now() + ms; !predicate();) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + what)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function withLeader(run) {
  const socketPath = `/tmp/dscode-plugins-${process.pid}-${Date.now()}.sock`
  // As the managed launcher starts it: DSH_BIN names the runtime /doctor checks.
  const env = { ...process.env, DSH_HOME: home, HOME: home, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1', DSH_BIN: join(runtime, 'bin/dsh') }
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS', 'DSCODE_HOME', 'DSH_PROFILE_DIR', 'DSCODE_LOG']) delete env[name]
  const host = startLeader({ runtime, home, socketPath, env, clientType: 'plugins-acceptance', rpcTimeoutMs: 60_000 })
  try {
    await host.ready
    const open = async () => (await host.rpc('session/new', { cwd: home, mcpServers: [] })).sessionId
    const sessionId = await open()
    const replies = () => host.notes.filter(note => note.method === 'session/update' && note.params.update.sessionUpdate === 'agent_message_chunk')
    const dsh = async text => {
      const before = replies().length
      const done = await host.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      assert.equal(done.stopReason, 'end_turn')
      await waitFor(() => replies().length > before, 'the reply to ' + text)
      return replies().slice(before).map(note => note.params.update.content.text).join('')
    }
    const systemNotes = () => host.notes.filter(note => /^_?x\.ai\/session_notification$/.test(note.method) && note.params.update.sessionUpdate === 'image_dropped')
      .map(note => ({ sessionId: note.params.sessionId, text: note.params.update.notes.join('\n') }))
    const doctor = async () => (await host.rpc('x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.13' })).text
    return await run({ dsh, doctor, open, sessionId, systemNotes })
  } catch (error) {
    throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`)
  } finally {
    await host.stop()
  }
}

const launcherEnv = { ...process.env, HOME: home, DSH_HOME: home, DSH_BIN: join(runtime, 'bin/dsh') }
for (const name of ['DSCODE_HOME', 'DSH_PROFILE_DIR', 'DSCODE_SOCKET', 'DSCODE_LOG']) delete launcherEnv[name]
const launcher = args => spawnSync(process.execPath, [join(profile, 'node_modules/@hqzhao95/dscode/bin/dscode.mjs'), ...args],
  { encoding: 'utf8', timeout: 60_000, env: launcherEnv })

await withLeader(async ({ dsh, doctor }) => {
  const table = await dsh('/dsh plugins')
  samples.table = table
  assert.match(table, /^Plugins in `.*profiles\/dscode`: 2 on · 3 off\n\n\| State \| Plugin \| Package \| Kind \| Rows \|/)
  assert.match(table, /\| on \| \*\*base\*\*: .* \| `@deepseek-ai\/dsh-base@0\.1\.7-rc\.2` \| core \| \d+ rows · \d+ running · \d+ off \|/)
  assert.match(table, /\| on \| \*\*dscode\*\*: .* \| `@hqzhao95\/dscode@[^`]+` \| core \| 18 rows · 17 running · 1 off \|/)
  for (const title of ['Agent Teams', 'Voice input', 'Auto Authorization Review']) {
    assert.match(table, new RegExp(`\\| off \\| \\*\\*${title}\\*\\*: .* \\| official · optional · experimental \\| \\d+ rows? \\|`))
  }
  assert.doesNotMatch(table, /dsh-web-app|Problems:/)
  checks.push('/dsh plugins lists the core bundles and the three optional ones with their rows')

  samples.enable = await dsh('/dsh enable ' + REVIEW)
  assert.equal(samples.enable, `Enabled Auto Authorization Review (${REVIEW}); applied to the running leader.`)
  assert.ok(manifest().dsh.profile.bundles.includes(REVIEW))
  assert.match(await dsh('/dsh plugins'), /\| on \| \*\*Auto Authorization Review\*\*: .* \| 1 row · 1 running \|/)
  samples.rowOff = await dsh(`/dsh disable ${REVIEW}#auto-review`)
  assert.equal(samples.rowOff, 'Disabled the component auto-review of Auto Authorization Review; applied to the running leader.')
  assert.match(patch(), /auto-review[\s\S]*disabled: true/)
  assert.match(await dsh('/dsh inspect ' + REVIEW), /- `auto-review` @deepseek-ai\/dsh-experimental-auto-review · off/)
  assert.equal(await dsh(`/dsh enable ${REVIEW}#auto-review`), 'Enabled the component auto-review of Auto Authorization Review; applied to the running leader.')
  checks.push('an optional bundle and one of its rows switch on and off live')

  // A patch in the DSH home outranks the profile patch the manager writes.
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: auto-review\n  disabled: true\n')
  assert.match(await dsh(`/dsh disable ${REVIEW}#auto-review`), /^Disabled the component/)
  samples.overridden = await dsh(`/dsh enable ${REVIEW}#auto-review`)
  assert.match(samples.overridden, /^auto-review of Auto Authorization Review was saved, but a higher-priority configuration overrides it, so it is not in effect/)
  rmSync(join(home, 'cordis.patch.yml'))
  assert.match(await dsh(`/dsh enable ${REVIEW}#auto-review`), /^The component auto-review is already on\.$|^Enabled the component/)
  checks.push('a row a DSH-home patch overrides is reported as overridden')

  assert.equal(await dsh('/dsh disable ' + REVIEW), `Disabled Auto Authorization Review (${REVIEW}); applied to the running leader.`)
  assert.deepEqual(manifest().dsh.profile.bundles, SHIPPED)
  // The other two optional bundles start and stop live as well; Agent Teams
  // puts Team tools on the host, which /doctor warns about while it is on.
  for (const [name, title] of [['@deepseek-ai/dsh-experimental-agent-team-profile', 'Agent Teams'], ['@deepseek-ai/dsh-experimental-voice-input-bundle', 'Voice input']]) {
    assert.equal(await dsh('/dsh enable ' + name), `Enabled ${title} (${name}); applied to the running leader.`)
    if (title === 'Agent Teams') assert.match(await doctor(), /\[WARN\] Agent Teams: Host-level Team tools \(tool-agent-team\)/)
    assert.equal(await dsh('/dsh disable ' + name), `Disabled ${title} (${name}); applied to the running leader.`)
  }
  assert.deepEqual(manifest().dsh.profile.bundles, SHIPPED)
  const before = readFileSync(join(profile, 'package.json'), 'utf8')
  assert.match(await dsh('/dsh disable @hqzhao95/dscode'), /is part of dscode itself; turning it off would stop dscode from starting/)
  assert.match(await dsh('/dsh disable @deepseek-ai/dsh-base'), /is part of dscode itself/)
  assert.match(await dsh('/dsh disable @hqzhao95/dscode#grok-leader'), /use the command that owns it/)
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), before)
  checks.push('dscode\'s own bundles and rows refuse to switch off')

  const report = await doctor()
  samples.doctor = report.split('\n\n').filter(line => /Plugin rows|Leader log|Profile package manager|Profile bundles/.test(line))
  assert.match(report, /\[OK\] Plugin rows: \d+ running; none failed or waiting for a service\./)
  assert.match(report, /\[INFO\] Leader log: \/tmp\/dscode-plugins-\d+-\d+\.log/)
  assert.match(report, /\[WARN\] Profile package manager: .*pnpm-lock\.yaml exists/, 'dsh plugin add installed this home with pnpm')
  checks.push('/doctor reports plugin rows, the leader log and the pnpm lockfile')
})

// A selected bundle that is not installed: boot skips it.
const broken = manifest()
broken.dsh.profile.bundles.push(MISSING)
writeFileSync(join(profile, 'package.json'), JSON.stringify(broken, null, 2) + '\n')
const shell = launcher(['doctor', '--runtime', '--json'])
const skippedFinding = JSON.parse(shell.stdout).find(finding => finding.name === `Profile bundle ${MISSING}`)
assert.equal(skippedFinding?.status, 'ERROR', shell.stdout + shell.stderr)
assert.match(skippedFinding.detail, /^Skipped at startup: cannot resolve profile bundle "dsh-plugin-e2e-missing"/)
checks.push('dscode doctor --runtime names a bundle boot skips')

await withLeader(async ({ dsh, doctor, open, sessionId, systemNotes }) => {
  await waitFor(() => systemNotes().some(note => note.text.includes('dscode started without')), 'the skipped-bundle note')
  const note = systemNotes().find(candidate => candidate.text.includes('dscode started without'))
  samples.note = note.text
  assert.equal(note.sessionId, sessionId)
  assert.match(note.text, /^dscode started without a plugin bundle: dsh-plugin-e2e-missing \(cannot resolve profile bundle .*\)\. Run \/doctor for details, or \/dsh disable dsh-plugin-e2e-missing to stop loading it\. Leader log: \/tmp\/dscode-plugins-.*\.log$/)
  assert.match(await dsh('/dsh plugins'), /Problems:\n- `dsh-plugin-e2e-missing`: /)
  assert.match(await doctor(), /\[ERROR\] Profile bundle dsh-plugin-e2e-missing: Skipped at startup: cannot resolve profile bundle/)
  await open()
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(systemNotes().filter(candidate => candidate.text.includes('dscode started without')).length, 1)
  // A switch the reset will drop with the patch.
  assert.match(await dsh('/dsh enable @hqzhao95/dscode#dscode-browser'), /^Enabled the component dscode-browser of dscode; applied to the running leader\.$/)
  // The note's own advice: a skipped bundle can be deselected from inside dscode.
  assert.equal(await dsh('/dsh disable ' + MISSING), `Disabled plugin-e2e-missing (${MISSING}); applied to the running leader.`)
  assert.deepEqual(manifest().dsh.profile.bundles, SHIPPED)
})
checks.push('the first session of a start that skipped a bundle gets one note; /doctor and /dsh plugins give the reason')

// Select it again, as a plugin that breaks the next start would stay selected.
writeFileSync(join(profile, 'package.json'), JSON.stringify(broken, null, 2) + '\n')
const reset = launcher(['doctor', '--reset-plugins'])
assert.equal(reset.status, 0, reset.stderr)
samples.reset = reset.stdout.trim()
assert.match(reset.stdout, new RegExp(`- Bundles: @deepseek-ai/dsh-base, @hqzhao95/dscode, ${MISSING} -> @deepseek-ai/dsh-base, @hqzhao95/dscode`))
assert.match(reset.stdout, /- Profile patch moved to .*cordis\.patch\.yml\.bak-\d+; it held row switches [^\n]*dscode-browser on/)
assert.match(reset.stdout, /mv '.*cordis\.patch\.yml\.bak-\d+' '.*cordis\.patch\.yml'/)
assert.deepEqual(manifest().dsh.profile.bundles, SHIPPED)
assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false)
assert.equal(readdirSync(profile).filter(name => name.startsWith('cordis.patch.yml.bak-')).length, 1)
assert.ok(existsSync(join(profile, 'node_modules/@hqzhao95/dscode/package.json')), 'installed packages stay')
checks.push('dscode doctor --reset-plugins backs up the patch and keeps the shipped bundles')

await withLeader(async ({ dsh, systemNotes }) => {
  const table = await dsh('/dsh plugins')
  assert.doesNotMatch(table, /Problems:/)
  assert.match(table, /\| on \| \*\*dscode\*\*: .* \| core \| 18 rows · 17 running · 1 off \|/, 'the browser row is off again')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(systemNotes().filter(note => note.text.includes('dscode started without')).length, 0)
})
checks.push('the reset profile starts cleanly')

console.log(JSON.stringify({ node: process.version, plugins: 'passed', checks, samples }, null, 2))
