// Compare managed --version startup using real TUI/runtime executables in
// isolated profiles. This includes all startup validation, not interactive UI.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const [before, after, runtime, tui] = process.argv.slice(2).map(value => resolve(value))
assert.ok(before && after && runtime && tui,
  'usage: node scripts/bench-launcher.mjs <before-package> <after-package> <runtime-dir> <tui-bin>')
const root = mkdtempSync(join(tmpdir(), 'dscode-launch-bench-'))
function prepare(source, label) {
  const home = join(root, label), profile = join(home, 'profile')
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  assert.equal(metadata.dscode?.release, metadata.version, 'Use a stamped release package')
  const plugin = join(profile, 'node_modules', ...metadata.name.split('/'))
  mkdirSync(plugin, { recursive: true })
  cpSync(join(source, 'bin'), join(plugin, 'bin'), { recursive: true })
  cpSync(join(source, 'package.json'), join(plugin, 'package.json'))
  symlinkSync(join(source, 'node_modules'), join(plugin, 'node_modules'))
  symlinkSync(runtime, join(profile, 'runtime'))
  mkdirSync(join(profile, 'bin'))
  symlinkSync(tui, join(profile, 'bin/dscode'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [metadata.name] } } }))
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), DSCODE_HOME: profile,
    DSH_BIN: '', DSCODE_BIN: '', DSH_TELEMETRY_DISABLED: '1', GROK_DISABLE_AUTOUPDATER: '1',
    NODE_DISABLE_COMPILE_CACHE: '1', PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) }
  delete env.NODE_OPTIONS
  delete env.NODE_COMPILE_CACHE
  return { version: metadata.version, entry: join(plugin, 'bin/dscode.mjs'), env }
}
const variants = { before: prepare(before, 'before'), after: prepare(after, 'after') }
assert.equal(variants.before.version, variants.after.version)
function run(label) {
  const { entry, env, version } = variants[label]
  const start = performance.now()
  const result = spawnSync(process.execPath, [entry, '--version'], { env, encoding: 'utf8', timeout: 30000 })
  const processMs = performance.now() - start
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(version), result.stdout)
  return +processMs.toFixed(2)
}
const firstRunMs = { before: run('before'), after: run('after') }
const samplesMs = { before: [], after: [] }
for (let i = 0; i < 6; i++) {
  for (const label of i % 2 ? ['after', 'before'] : ['before', 'after']) samplesMs[label].push(run(label))
}
const medianMs = Object.fromEntries(Object.entries(samplesMs).map(([label, samples]) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return [label, +((sorted[2] + sorted[3]) / 2).toFixed(2)]
}))
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  root, before, after, runtime, tui, firstRunMs, medianMs, samplesMs }, null, 2))
