import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const bridge = join(root, 'bridge/grok-leader')
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
const metadata = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8'))

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dscode-install-selection-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'home'), profile = join(home, '.dsh/profiles/dscode')
  const release = join(base, 'release'), packed = join(base, 'packed/package')
  const requests = join(base, 'requests'), shim = join(base, 'fetch.mjs')
  mkdirSync(home, { recursive: true })
  mkdirSync(release, { recursive: true })
  mkdirSync(packed, { recursive: true })
  cpSync(join(bridge, 'bin'), join(packed, 'bin'), { recursive: true })
  writeFileSync(join(packed, 'package.json'), JSON.stringify(metadata))
  symlinkSync(join(bridge, 'node_modules'), join(packed, 'node_modules'))
  const plugin = join(release, 'dscode-plugin.tgz')
  execFileSync('tar', ['-czf', plugin, '-C', join(base, 'packed'), 'package'])
  writeFileSync(join(plugin + '.sha256'), createHash('sha256').update(readFileSync(plugin)).digest('hex') + '\n')
  writeFileSync(shim, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async url => {
  appendFileSync(${JSON.stringify(requests)}, String(url) + '\\n');
  if (String(url).includes('api.github.com')) {
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('', { status: 404 });
};
`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('DSCODE_') && key !== 'NODE_OPTIONS' && key !== 'DSC_CHANNEL'
    && key !== 'DEEPSEEK_CODE_TUI_RELEASE' && key !== 'DSH_HOME'))
  const run = (args = [], overrides = {}) => spawnSync('bash', [join(root, 'scripts/install.sh'), ...args], {
    encoding: 'utf8', timeout: 20000,
    env: {
      ...env, HOME: home, DSCODE_HOME: profile, DSCODE_RELEASE_DIR: release,
      NODE_OPTIONS: `--import ${pathToFileURL(shim).href}`, DSCODE_FETCH_LOG: requests, ...overrides,
    },
  })
  const log = () => {
    try { return readFileSync(requests, 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  }
  return { home, profile, release, run, log }
}

test('CLI channel flags win over ambient DSC_CHANNEL', t => {
  const f = fixture(t)
  const result = f.run(['--stable'], { DSC_CHANNEL: 'alpha' })
  assert.doesNotMatch(result.stderr + result.stdout, /choose only one/)
  assert.match(result.stderr + result.stdout, /no release available for stable/)
  assert.match(f.log(), /api\.github\.com/)
})

test('ambient DSC_CHANNEL without a selection still builds checkout VERSION', t => {
  const f = fixture(t)
  const result = f.run([], { DSC_CHANNEL: 'alpha' })
  const output = result.stderr + result.stdout
  assert.doesNotMatch(f.log(), /api\.github\.com|github\.com\/HQ1995/, output)
  assert.doesNotMatch(output, /choose only one|no release available/)
})

test('CLI --version wins over DEEPSEEK_CODE_TUI_RELEASE without duplicating the flag', t => {
  const f = fixture(t)
  const result = f.run(['--version', version], { DEEPSEEK_CODE_TUI_RELEASE: '9.9.9' })
  const output = result.stderr + result.stdout
  assert.doesNotMatch(output, /duplicate --version/)
  assert.match(f.log(), new RegExp(`releases/download/v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
  assert.doesNotMatch(f.log(), /releases\/download\/v9\.9\.9\//)
})
