import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { fixtureEnvironment } from './fixtures/environment.ts'

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
    expect(findings.find(f => f.name === 'DSH runtime')).toMatchObject({ status: 'ERROR' })
    expect(findings.find(f => f.name === 'Shipped LSP preset')).toMatchObject({ status: 'INFO' })
    expect(findings.find(f => f.name === 'Shipped LSP preset').detail).toContain('typescript-language-server, tsc')
    expect(readdirSync(root)).toEqual([])
    expect(result.stderr).not.toMatch(/installing|upgrading/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
