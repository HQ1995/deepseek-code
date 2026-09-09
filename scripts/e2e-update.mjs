// Exercise the real launcher and complete release tuple against a local asset
// server. No real profile, npm installation, or published release is changed.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'bridge/grok-leader/package.json'), 'utf8'))
const asset = { 'linux-x64': 'dscode-linux-x86_64', 'darwin-arm64': 'dscode-macos-aarch64' }[`${process.platform}-${process.arch}`]
assert.ok(asset, 'unsupported test platform')
const home = await mkdtemp(join(tmpdir(), 'dscode-update-e2e-'))
const files = new Map([
  [asset, resolve(process.env.DSCODE_TUI_BIN)],
  ['dscode-plugin.tgz', resolve(process.env.DSCODE_E2E_PLUGIN_TGZ)],
  [asset.replace('dscode-', 'dscode-runtime-') + '.tar.gz', resolve(process.env.DSCODE_E2E_RUNTIME_TGZ)],
])
const hashes = new Map()
for (const [name, path] of files) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  hashes.set(name, hash.digest('hex'))
}
let corrupt = false
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1)
  if (name.endsWith('.sha256') && hashes.has(name.slice(0, -7))) {
    res.end(`${corrupt ? '0'.repeat(64) : hashes.get(name.slice(0, -7))}  ${name.slice(0, -7)}\n`)
  } else if (files.has(name)) {
    const stream = createReadStream(files.get(name))
    stream.on('error', error => res.destroy(error))
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } else { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const origin = `http://127.0.0.1:${server.address().port}`
  const redirect = join(home, 'fetch.mjs')
  const prefix = `https://github.com/HQ1995/deepseek-code/releases/download/v${manifest.version}/`
  await writeFile(redirect, `const original = globalThis.fetch; globalThis.fetch = (url, options) => {
    if (!String(url).startsWith(${JSON.stringify(prefix)})) throw new Error('unexpected release request: ' + url);
    return original(${JSON.stringify(origin + '/')} + String(url).slice(${prefix.length}), options);
  };\n`)
  const profile = join(home, '.dsh/profiles/dscode')
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), DSCODE_HOME: profile, DSH_TELEMETRY_DISABLED: '1' }
  delete env.DSH_BIN
  delete env.DSCODE_BIN
  const run = (launcher, args) => execute(process.execPath, ['--import', redirect, launcher, ...args], { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  const update = ['update', '--alpha', '--version', manifest.version]
  const unpacked = join(home, 'initial')
  await mkdir(unpacked)
  await execute('tar', ['-xzf', files.get('dscode-plugin.tgz'), '-C', unpacked])
  const initial = await run(join(unpacked, 'package/bin/dscode.mjs'), update)
  assert.match(initial.stdout, /dscode updated to/)
  const installed = join(profile, 'node_modules/@hqzhao95/dscode/bin/dscode.mjs')
  const doctor = async () => {
    const result = await run(installed, ['doctor', '--runtime', '--json'])
    assert.deepEqual(JSON.parse(result.stdout).filter(row => row.status === 'ERROR'), [])
  }
  await doctor()
  const composed = await execute(join(profile, 'runtime/bin/dsh'), ['--profile', 'dscode', '--dump-config'], { env, timeout: 30000 })
  assert.match(composed.stdout, /grok-leader/)
  const config = await readFile(join(profile, 'config.toml'), 'utf8')
  await writeFile(join(profile, 'user-kept.txt'), 'preserved')
  // Repair the invalid empty overlay produced by older installRelease builds.
  await writeFile(join(profile, 'cordis.patch.yml'), '# Your patch layer for this dsh profile\n')
  const helper = process.platform === 'linux'
    ? join(profile, `runtime/node_modules/@deepseek-ai/node-addon-system-linux-${process.arch}/bin/landlock-run`)
    : join(profile, 'runtime/bin/dsh')
  await rm(join(profile, 'bin/dscode'))
  await rm(helper)
  await run(installed, update)
  await stat(helper)
  await doctor()
  const repaired = await execute(join(profile, 'runtime/bin/dsh'), ['--profile', 'dscode', '--dump-config'], { env, timeout: 30000 })
  assert.match(repaired.stdout, /grok-leader/)
  const banner = await run(installed, ['--version'])
  assert.ok(banner.stdout.includes(manifest.version))
  corrupt = true
  await assert.rejects(run(installed, update), /SHA-256 mismatch/)
  assert.equal(await readFile(join(profile, 'config.toml'), 'utf8'), config)
  assert.equal(await readFile(join(profile, 'user-kept.txt'), 'utf8'), 'preserved')
  await doctor()
  const report = { version: manifest.version, sourceCommit: manifest.dsh.sourceCommit, installedAndRepaired: true, repairedLegacyOverlay: true, composedProfile: true, rejectedCorruptAsset: true, preservedUserFiles: true, installedLauncher: true }
  if (process.env.DSCODE_E2E_OUT_DIR) {
    await mkdir(process.env.DSCODE_E2E_OUT_DIR, { recursive: true })
    await writeFile(join(process.env.DSCODE_E2E_OUT_DIR, 'update-PASS.json'), JSON.stringify(report, null, 2) + '\n')
  }
  console.log('PASS managed update E2E', JSON.stringify(report))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}
