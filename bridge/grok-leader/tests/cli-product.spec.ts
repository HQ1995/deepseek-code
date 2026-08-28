import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const defaultTui = fileURLToPath(new URL('../../../third_party/grok-build/target/release/dscode', import.meta.url))
const tui = resolve(process.env.DSCODE_TUI_BIN ?? defaultTui)
const productVersion = readFileSync(fileURLToPath(new URL('../../../VERSION', import.meta.url)), 'utf8').trim()
const productVersionPattern = new RegExp(`^${productVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-dev)?(?: \\([0-9a-f]+\\))?$`)
const homes: string[] = []

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

const run = (home: string, args: string[]): RunResult => {
  const profile = join(home, '.dsh', 'profiles', 'dscode')
  const result = spawnSync(tui, args, {
    cwd: home,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: join(home, '.dsh'),
      DSC_HOME: profile,
      DSCODE_HOME: profile,
      DSCODE_MANAGED_LAUNCHER: '1',
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const freshHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-cli-e2e-'))
  homes.push(home)
  return home
}

const expectOk = (result: RunResult): void => {
  expect(result.status, result.stderr).toBe(0)
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!existsSync(tui))('compiled dscode CLI', () => {
  it('reports version, diagnostics, discovered config, and disk usage as JSON', () => {
    const home = freshHome()
    const version = run(home, ['version', '--json'])
    expectOk(version)
    expect(JSON.parse(version.stdout).currentVersion).toMatch(productVersionPattern)

    const doctor = run(home, ['doctor', '--json'])
    expectOk(doctor)
    expect(JSON.parse(doctor.stdout)).toMatchObject({ schemaVersion: '1', facts: { terminal: expect.any(Object) as object } })

    const inspect = run(home, ['inspect', '--json'])
    expectOk(inspect)
    const inspected = JSON.parse(inspect.stdout)
    expect(inspected.grokVersion).toMatch(productVersionPattern)
    expect(inspected).toMatchObject({
      cwd: realpathSync(home),
      permissions: { sources: expect.any(Array) as unknown[] },
    })

    const usage = run(home, ['du', '--json'])
    expectOk(usage)
    expect(JSON.parse(usage.stdout)).toMatchObject({
      schema_version: 1,
      grok_home: join(realpathSync(home), '.dsh', 'profiles', 'dscode'),
      total_bytes: expect.any(Number) as number,
    })
  }, 60_000)

  it('generates shell completions and wraps a real child process', () => {
    const home = freshHome()
    const completions = run(home, ['completions', 'bash'])
    expectOk(completions)
    expect(completions.stdout).toContain('_dscode()')

    const wrapped = run(home, ['wrap', '/bin/sh', '-c', 'printf dscode-wrap-ok'])
    expectOk(wrapped)
    expect(wrapped.stdout).toContain('dscode-wrap-ok')
  })

  it('lists empty session and leader state without contacting a cloud service', () => {
    const home = freshHome()
    const sessions = run(home, ['sessions', 'list'])
    expectOk(sessions)
    expect(sessions.stdout).toContain('No sessions found')

    const leaders = run(home, ['leader', 'list'])
    expectOk(leaders)
    expect(leaders.stdout).toContain('No leader candidates found')
  })

  it('performs MCP add, list, disable, enable, and remove in an isolated home', () => {
    const home = freshHome()
    expectOk(run(home, ['mcp', 'add', 'e2e', '/bin/cat']))

    const listed = run(home, ['mcp', 'list', '--json'])
    expectOk(listed)
    expect(JSON.parse(listed.stdout)).toEqual([{
      command: '/bin/cat',
      args: [],
      enabled: true,
      name: 'e2e',
      scope: 'user',
    }])

    expectOk(run(home, ['mcp', 'disable', 'e2e']))
    const disabled = run(home, ['mcp', 'list', '--json'])
    expectOk(disabled)
    expect(JSON.parse(disabled.stdout)[0]).toMatchObject({ name: 'e2e', enabled: false })

    expectOk(run(home, ['mcp', 'enable', 'e2e']))
    expectOk(run(home, ['mcp', 'remove', 'e2e']))
    const removed = run(home, ['mcp', 'list', '--json'])
    expectOk(removed)
    expect(JSON.parse(removed.stdout)).toEqual([])
  })
})
