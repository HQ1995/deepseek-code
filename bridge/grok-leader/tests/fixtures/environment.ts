import { isAbsolute, join, relative } from 'node:path'

/** Child launchers must never inherit the dscode session hosting the tests. */
export function fixtureEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}, inherited = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(home)) throw new Error('fixture HOME must be absolute')
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(DSCODE_|DSH_|GROK_|XAI_)/.test(key)
    && !['DSC_HOME', 'NODE_OPTIONS', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(key)))
  const dshHome = overrides.DSH_HOME ?? join(home, '.dsh')
  const profile = overrides.DSCODE_HOME ?? join(dshHome, 'profiles', 'dscode')
  const result: NodeJS.ProcessEnv = { ...env, HOME: home, DSH_HOME: dshHome, DSCODE_HOME: profile, DSC_HOME: profile, DSH_PROFILE_DIR: profile,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), ...overrides }
  for (const key of ['HOME', 'DSH_HOME', 'DSCODE_HOME', 'DSC_HOME', 'DSH_PROFILE_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    const path = result[key]
    const suffix = path === undefined ? '..' : relative(home, path)
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw new Error(`fixture ${key} must stay inside HOME`)
  }
  return result
}
