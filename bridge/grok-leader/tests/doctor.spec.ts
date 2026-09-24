import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
