/** `dscode doctor --reset-plugins` in a temporary profile. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mirrorSanitizeProfile, patchSummary, resetPlugins, runtimeSanitizer } from '../bin/plugin-reset.mjs'
import { dshInstallAnchor } from '../bin/doctor.mjs'
import { withProfileLock } from '../bin/update.mjs'

const DSH_BIN = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const PATCH = ['# user layer', '- id: llm-deepseek', '  disabled: false', '- id: dscode-browser', '  disabled: false',
  '- id: llm-pi-ai', '  config:', '    providers: {}', '- id: session-title-llm', '  disabled: !!js "false"', '- insert:', '    - id: ssh', "      name: '@deepseek-ai/dsh-ssh'", ''].join('\n')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function profile(bundles: string[], patch: string | null = PATCH) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-reset-'))
  roots.push(root)
  const dir = join(root, 'profiles', 'dscode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-dscode', private: true,
    dependencies: { '@hqzhao95/dscode': '0.0.14', 'dsh-plugin-mine': '1.0.0' }, dsh: { profile: { bundles }, testedVersion: 'kept' } }, null, 2))
  if (patch !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  const manifest = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: object; dsh: { profile: { bundles: string[] }; testedVersion: string } }
  return { root, dir, manifest }
}
const SHIPPED = ['@deepseek-ai/dsh-base', '@hqzhao95/dscode']

describe('dscode doctor --reset-plugins', () => {
  it('keeps only the shipped bundles, moves the patch aside with the runtime\'s sanitizeProfile, and says how to undo it', async () => {
    const f = profile(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dsh-plugin-mine', '@deepseek-ai/dsh-experimental-auto-review'])
    const official = await runtimeSanitizer(dshInstallAnchor(DSH_BIN))
    expect(official).toBeTypeOf('function')
    expect(official).not.toBe(mirrorSanitizeProfile)
    expect(await runtimeSanitizer(undefined)).toBeUndefined()
    const lines: string[] = []
    const result = await resetPlugins({ profile: f.dir, packageName: '@hqzhao95/dscode', dshBin: DSH_BIN, log: (text: string) => lines.push(text) })
    expect(f.manifest().dsh.profile.bundles).toEqual(SHIPPED)
    expect(f.manifest().dependencies).toEqual({ '@hqzhao95/dscode': '0.0.14', 'dsh-plugin-mine': '1.0.0' })
    expect(f.manifest().dsh.testedVersion).toBe('kept')
    expect(existsSync(join(f.dir, 'cordis.patch.yml'))).toBe(false)
    expect(result.backup).toMatch(/\/cordis\.patch\.yml\.bak-\d+$/)
    expect(readFileSync(result.backup, 'utf8')).toBe(PATCH)
    const text = lines.join('\n')
    expect(text).toContain('- Bundles: @deepseek-ai/dsh-base, @hqzhao95/dscode, dsh-plugin-mine, @deepseek-ai/dsh-experimental-auto-review -> @deepseek-ai/dsh-base, @hqzhao95/dscode')
    expect(text).toContain('- No longer selected: dsh-plugin-mine, @deepseek-ai/dsh-experimental-auto-review; installed packages stay. Turn one back on inside dscode with /dsh enable <bundle>.')
    expect(text).toContain('it held row switches llm-deepseek on, dscode-browser on; settings of llm-pi-ai; inserted rows ssh.')
    expect(text).toContain('Warning: what that patch saved is off until you restore it: row switches such as the native DeepSeek route\n(llm-deepseek, turned on by /provider) and /browser on')
    expect(text).toContain(`  mv '${result.backup}' '${join(f.dir, 'cordis.patch.yml')}'`)
    expect(text).toContain('a running leader keeps its current plugins until it exits.')
    // Running it again has nothing left to change.
    lines.length = 0
    expect(await resetPlugins({ profile: f.dir, packageName: '@hqzhao95/dscode', dshBin: DSH_BIN, log: (text: string) => lines.push(text) })).toMatchObject({ changed: false })
    expect(lines).toEqual([`Nothing to reset in ${f.dir}: it selects only dscode's shipped bundles (@deepseek-ai/dsh-base, @hqzhao95/dscode) and has no profile patch.`])
  })

  it('mirrors sanitizeProfile exactly when the runtime cannot be loaded', async () => {
    const a = profile(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'x']), b = profile(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'x'])
    const { sanitizeProfile } = await import('@deepseek-ai/dsh-app-boot')
    const official = sanitizeProfile('dscode', a.dir, SHIPPED)!, mirrored = mirrorSanitizeProfile('dscode', b.dir, SHIPPED)
    expect(readFileSync(join(b.dir, 'package.json'), 'utf8')).toBe(readFileSync(join(a.dir, 'package.json'), 'utf8'))
    expect(readdirSync(b.dir).map(name => name.replace(/\d+$/, 'N')).sort()).toEqual(readdirSync(a.dir).map(name => name.replace(/\d+$/, 'N')).sort())
    expect(mirrored.slice(b.dir.length)).toMatch(/^\/cordis\.patch\.yml\.bak-\d+$/)
    expect(official.slice(a.dir.length)).toMatch(/^\/cordis\.patch\.yml\.bak-\d+$/)
    // A second backup in the same millisecond gets an ordinal; no patch, no backup.
    writeFileSync(join(b.dir, 'cordis.patch.yml'), '[]\n')
    const now = Date.now
    Date.now = () => Number(mirrored.slice(mirrored.lastIndexOf('-') + 1))
    try { expect(mirrorSanitizeProfile('dscode', b.dir, SHIPPED)).toBe(mirrored + '-1') } finally { Date.now = now }
    expect(mirrorSanitizeProfile('dscode', b.dir, SHIPPED)).toBeUndefined()
    // Through the launcher path without a runtime: bundles only, since there is no patch.
    const c = profile([...SHIPPED, 'x'], null)
    const lines: string[] = []
    expect(await resetPlugins({ profile: c.dir, packageName: '@hqzhao95/dscode', dshBin: undefined, log: (text: string) => lines.push(text) }))
      .toEqual({ changed: true, before: [...SHIPPED, 'x'], bundles: SHIPPED, backup: undefined })
    expect(c.manifest().dsh.profile.bundles).toEqual(SHIPPED)
    expect(lines[0]).not.toContain('Profile patch moved')
    await resetPlugins({ profile: c.dir, packageName: '@hqzhao95/dscode', dshBin: undefined, log: (text: string) => lines.push(text) })
    expect(lines[1]).toContain('Nothing to reset')
  })

  it('waits for the profile lock, and refuses a directory that is not a profile', async () => {
    const f = profile(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'x'])
    let reset!: Promise<unknown>
    await withProfileLock(f.dir, async () => {
      reset = resetPlugins({ profile: f.dir, packageName: '@hqzhao95/dscode', dshBin: DSH_BIN, log: () => {} })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(f.manifest().dsh.profile.bundles).toContain('x')
    })
    await reset
    expect(f.manifest().dsh.profile.bundles).toEqual(SHIPPED)
    await expect(resetPlugins({ profile: join(f.root, 'nowhere'), packageName: '@hqzhao95/dscode', dshBin: DSH_BIN, log: () => {} })).rejects.toThrow('no dscode profile at')
  })

  it('says when the patch held a remote workspace, whose tools now run locally', async () => {
    const { remoteBlock } = await import('../bin/remote.mjs')
    const f = profile(SHIPPED, remoteBlock({ host: 'build', workspace: '/srv/w', node: '/n', helper: '/h.js', helperHash: 'a'.repeat(64), bootstrapPath: '/b.js', bootstrapHash: 'b'.repeat(64) }))
    const lines: string[] = []
    await resetPlugins({ profile: f.dir, packageName: '@hqzhao95/dscode', dshBin: DSH_BIN, log: (text: string) => lines.push(text) })
    expect(lines.join('\n')).toContain("This home's remote workspace (ssh build:/srv/w) was in that patch:\nuntil you restore it, tools, shells and file edits run on this computer.")
  })

  it('summarizes an unreadable patch without failing the reset', () => {
    expect(patchSummary('- id: a\n  disabled: true\n')).toBe('row switches a off')
    expect(patchSummary('[]\n')).toBe('nothing')
    expect(patchSummary('{ torn')).toMatch(/^text that is not readable YAML \(/)
    expect(patchSummary('just: a map\n')).toBe('a value that is not a YAML list')
  })

  it('runs from the launcher before any provisioning', () => {
    const f = profile(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dsh-plugin-mine'])
    const launcher = fileURLToPath(new URL('../bin/dscode.mjs', import.meta.url))
    const env = { ...process.env, HOME: f.root, DSH_HOME: f.root, DSCODE_HOME: f.dir, DSH_PROFILE_DIR: '', DSH_BIN, DSCODE_BIN: '/nonexistent/dscode' }
    const result = spawnSync(process.execPath, [launcher, 'doctor', '--reset-plugins'], { encoding: 'utf8', timeout: 20000, env })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`Reset the plugins of the dscode profile ${f.dir}:`)
    expect(f.manifest().dsh.profile.bundles).toEqual(SHIPPED)
    expect(readdirSync(f.dir).some(name => name.startsWith('cordis.patch.yml.bak-'))).toBe(true)
    const extra = spawnSync(process.execPath, [launcher, 'doctor', '--reset-plugins', '--json'], { encoding: 'utf8', timeout: 20000, env })
    expect(extra.status).toBe(1)
    expect(extra.stderr).toContain('Usage: dscode doctor --reset-plugins')
  })
})
