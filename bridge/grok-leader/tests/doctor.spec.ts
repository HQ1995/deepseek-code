import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { unsupportedPlatformMessage } from '../bin/update.mjs'
import { fixtureEnvironment } from './fixtures/environment.ts'

it('explains x64 Node on Apple Silicon without claiming Intel prebuilt support', () => {
  expect(unsupportedPlatformMessage('darwin', 'x64')).toContain('native arm64 Node.js')
  expect(unsupportedPlatformMessage('darwin', 'x64')).toContain('Intel Macs require a source build')
  expect(unsupportedPlatformMessage('linux', 'arm64')).not.toContain('Apple Silicon')
})

it('can import runtime diagnostics from the shell installer stdin entrypoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-doctor-import-'))
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `await import(${JSON.stringify(new URL('../bin/doctor.mjs', import.meta.url).href)})`,
      encoding: 'utf8', timeout: 10000, env: fixtureEnvironment(root),
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
    expect(readdirSync(root)).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('diagnoses a broken installation before startup without provisioning or requiring optional tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-doctor-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/dscode.mjs', import.meta.url)), 'doctor', '--runtime', '--json'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: root, DSCODE_HOME: join(root, 'missing-profile'), DSH_PROFILE_DIR: '', DSH_BIN: '/nonexistent/dsh', DSCODE_BIN: '/nonexistent/dscode', PATH: '' },
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    const findings = JSON.parse(result.stdout)
    expect(findings.find(f => f.name === 'Host').detail).toContain(process.execPath)
    expect(findings.find(f => f.name === 'Shipped terminal preset').detail).toContain('profile-free bash')
    expect(findings.find(f => f.name === 'Shipped terminal preset').detail).toMatch(/^\/bin\/bash \d+\.\d+\.\d+/)
    expect(findings.find(f => f.name === 'DSH runtime')).toMatchObject({ status: 'ERROR' })
    expect(findings.find(f => f.name === 'Shipped LSP preset')).toMatchObject({ status: 'INFO' })
    expect(findings.find(f => f.name === 'Shipped LSP preset').detail).toContain('typescript-language-server, tsc')
    expect(readdirSync(root)).toEqual([])
    expect(result.stderr).not.toMatch(/installing|upgrading/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('checks a remote profile\'s connection only when asked, and says what to fix', async () => {
  const { installationReport } = await import('../bin/doctor.mjs')
  const { remoteBlock } = await import('../bin/remote.mjs')
  const { writeFileSync } = await import('node:fs')
  const profile = mkdtempSync(join(tmpdir(), 'dscode-doctor-remote-'))
  try {
    writeFileSync(join(profile, 'cordis.patch.yml'), remoteBlock({ host: 'swoop', workspace: '/w', node: '/n/node', helper: '/h.js',
      helperHash: 'a'.repeat(64), bootstrapPath: '/b.js', bootstrapHash: 'b'.repeat(64) }))
    const remote = (findings: Array<{ status: string; name: string; detail: string }>) => findings.find(finding => finding.name === 'Remote workspace')
    const failing = () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host swoop port 22: Connection refused' })
    expect(remote(installationReport({ profile, dshBin: '/nonexistent/dsh', optional: false, probe: failing }))).toBeUndefined()
    expect(remote(installationReport({ profile, dshBin: '/nonexistent/dsh', optional: false, remote: true, probe: failing }))).toEqual({
      status: 'ERROR', name: 'Remote workspace', detail: expect.stringMatching(/^ssh swoop:\/w: ssh swoop failed: ssh: connect to host swoop port 22: Connection refused\. .*`dscode remote status --check`/),
    })
    const healthy = () => ({ status: 0, stderr: '', stdout: JSON.stringify({ node: 'v24.0.0', workspace: true, digests: ['a'.repeat(64), 'b'.repeat(64)] }) })
    expect(remote(installationReport({ profile, dshBin: '/nonexistent/dsh', optional: false, remote: true, probe: healthy }))).toMatchObject({ status: 'OK', detail: expect.stringContaining('Node v24.0.0') })
  } finally { rmSync(profile, { recursive: true, force: true }) }
})

it('reports the bundles boot skips, with their reason', async () => {
  const { profileBundleFindings } = await import('../bin/doctor.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dscode-doctor-skipped-'))
  try {
    const require = createRequire(import.meta.url)
    const install = join(root, 'runtime/node_modules/@deepseek-ai'), profile = join(root, 'profile'), anchor = join(install, 'dsh/package.json')
    mkdirSync(join(install, 'dsh'), { recursive: true })
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }))
    symlinkSync(dirname(require.resolve('@deepseek-ai/dsh-app-boot/package.json')), join(install, 'dsh-app-boot'))
    symlinkSync(dirname(require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')), join(install, 'dsh-base'))
    mkdirSync(join(profile, 'node_modules/plain'), { recursive: true })
    writeFileSync(join(profile, 'node_modules/plain/package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'vanished', 'plain'] } } }))
    const findings = profileBundleFindings({ anchor, profile })
    expect(findings.map(f => [f.status, f.name])).toEqual([['ERROR', 'Profile bundle vanished'], ['ERROR', 'Profile bundle plain']])
    expect(findings[0]!.detail).toMatch(/^Skipped at startup: cannot resolve profile bundle "vanished" from the dsh installation or .*profile\. Inside dscode, \/dsh disable vanished stops loading it and \/dsh remove vanished uninstalls it\.$/)
    expect(findings[0]!.detail).not.toContain('dsh plugin')
    expect(findings[1]!.detail).toContain('Skipped at startup: profile bundle "plain" declares no dsh.bundle')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('names the leader log the TUI wrote', async () => {
  const { installationReport, leaderLog } = await import('../bin/doctor.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dscode-doctor-log-'))
  try {
    const uid = process.getuid?.() ?? 0
    for (const [name, seconds] of [[`dscode-${uid}-old.log`, 1000], [`dscode-${uid}-new.log`, 2000], ['dscode-999999-other.log', 3000], [`dscode-${uid}-x.sock`, 4000]] as const) {
      writeFileSync(join(root, name), '')
      utimesSync(join(root, name), seconds, seconds)
    }
    expect(leaderLog({}, root)).toEqual({ path: join(root, `dscode-${uid}-new.log`), exact: false })
    expect(leaderLog({ DSCODE_SOCKET: '/tmp/dscode-1-abc.sock' }, root)).toEqual({ path: '/tmp/dscode-1-abc.log', exact: true })
    expect(leaderLog({ DSCODE_LOG: '/var/d.log', DSCODE_SOCKET: '/tmp/x.sock' }, root)).toEqual({ path: '/var/d.log', exact: true })
    expect(leaderLog({}, join(root, 'missing'))).toBeUndefined()
    const profile = join(root, 'profile')
    mkdirSync(profile)
    const report = () => installationReport({ profile, dshBin: '/nonexistent/dsh', optional: false, env: { DSCODE_SOCKET: '/tmp/dscode-1-abc.sock' } })
    expect(report().find(f => f.name === 'Leader log')).toEqual({ status: 'INFO', name: 'Leader log', detail: '/tmp/dscode-1-abc.log' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
