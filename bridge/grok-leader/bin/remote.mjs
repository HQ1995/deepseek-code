/** `dscode remote`: turn the dscode profile of a dedicated DSH_HOME into one
 * remote workspace. That profile's leader runs every tool over one SSH
 * connection (the shipped `@hqzhao95/dscode/ssh` row); local workspaces keep
 * the default home. The rows are literals in the profile patch, so a shared
 * leader reads the same configuration whoever starts it. The patch is edited
 * as text: it may hold `!!js` entries this launcher cannot round-trip. The
 * block is found by whole marker lines only, so a value quoting a marker cannot
 * move it. Writes are atomic and take the profile lock when the home has a
 * runtime; a running leader keeps its configuration until it exits. */
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

const BEGIN = '# >>> dscode remote workspace (managed by `dscode remote`; edit with care)'
const END = '# <<< dscode remote workspace'
const HASH = /^[0-9a-f]{64}$/

export const REMOTE_USAGE = `Usage: DSH_HOME=<dedicated home> dscode remote init --host <ssh alias> --workspace <remote dir>
         --node <remote node> --helper <remote helper> --helper-hash <sha256>
         --bootstrap <remote PTC bootstrap> --bootstrap-hash <sha256>
       DSH_HOME=<dedicated home> dscode remote status
       DSH_HOME=<dedicated home> dscode remote remove`

const FLAGS = { '--host': 'host', '--workspace': 'workspace', '--node': 'node', '--helper': 'helper', '--helper-hash': 'helperHash',
  '--bootstrap': 'bootstrapPath', '--bootstrap-hash': 'bootstrapHash' }

/** Parse and validate `init` flags; every value is required. */
export function remoteConfig(args) {
  const config = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = FLAGS[args[index]]
    const value = args[index + 1]
    if (key === undefined || value === undefined || value.startsWith('--')) throw new Error(REMOTE_USAGE)
    if (config[key] !== undefined) throw new Error(`${args[index]} was given twice`)
    config[key] = value
  }
  for (const [flag, key] of Object.entries(FLAGS)) if (config[key] === undefined) throw new Error(`${flag} is required\n${REMOTE_USAGE}`)
  // An alias is passed to ssh as one argument; it must not read as an option.
  if (!/^[A-Za-z0-9._@-]+$/.test(config.host) || config.host.startsWith('-')) throw new Error(`--host must be an OpenSSH alias: ${config.host}`)
  for (const key of ['workspace', 'node', 'helper', 'bootstrapPath']) {
    if (!posix.isAbsolute(config[key]) || /[\0\n\r]/.test(config[key])) throw new Error(`remote paths must be absolute POSIX paths: ${config[key]}`)
    config[key] = posix.normalize(config[key])
  }
  if (config.workspace.length > 1 && config.workspace.endsWith('/')) config.workspace = config.workspace.slice(0, -1)
  for (const key of ['helperHash', 'bootstrapHash']) {
    config[key] = config[key].toLowerCase()
    if (!HASH.test(config[key])) throw new Error(`${key === 'helperHash' ? '--helper-hash' : '--bootstrap-hash'} must be a SHA-256 hex digest`)
  }
  return config
}

const quote = value => JSON.stringify(value)

/** The managed rows: remote providers replace the local ones as a unit. */
export function remoteBlock(config) {
  return [BEGIN,
    ...['subprocess', 'sandbox', 'fs-sandbox', 'ptc-runtime'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- id: sandbox-policy', '  config:', '    mode: workspace-write', `    workspaceRoot: ${quote(config.workspace)}`,
    '- insert:', '    - id: dscode-ssh', "      name: '@hqzhao95/dscode/ssh'", '      config:',
    ...['host', 'node', 'helper', 'helperHash', 'workspace', 'bootstrapPath', 'bootstrapHash'].map(key => `        ${key}: ${quote(config[key])}`),
    END].join('\n') + '\n'
}

/** Offset of the line that is exactly `marker`, or -1. */
const markerLine = (text, marker) => {
  const match = new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').exec(text)
  return match === null ? -1 : match.index
}

const withoutBlock = text => {
  const start = markerLine(text, BEGIN), end = markerLine(text, END)
  if (start === -1 && end === -1) return { text, found: false }
  if (start === -1 || end < start) throw new Error('the profile patch has a damaged dscode remote block; fix it by hand')
  return { text: text.slice(0, start) + text.slice(end + END.length).replace(/^\n/, ''), found: true }
}

const entryLines = text => text.split('\n').filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))

/** Insert or replace the managed block. Only an empty (`[]`) or block-style
 * patch is edited; anything else is left for the user. */
export function applyRemote(text, config) {
  const base = withoutBlock(text).text
  const entries = entryLines(base)
  if (entries.length === 1 && entries[0].trim() === '[]') {
    return base.replace(/^\s*\[\]\s*$/m, '').replace(/\n*$/, '\n') + remoteBlock(config)
  }
  if (entries.length > 0 && !entries[0].startsWith('- ')) {
    throw new Error('the profile patch is not a block-style list; add the rows from `dscode remote init --print` by hand')
  }
  return base.replace(/\n*$/, '\n') + remoteBlock(config)
}

/** Remove the managed block; an emptied patch becomes `[]` again. */
export function removeRemote(text) {
  const { text: base, found } = withoutBlock(text)
  if (!found) return { text, removed: false }
  return { text: entryLines(base).length === 0 ? base.replace(/\n*$/, '\n') + '[]\n' : base, removed: true }
}

/** The managed configuration, when this profile is remote. */
export function remoteStatus(text) {
  const start = markerLine(text, BEGIN), end = markerLine(text, END)
  if (start === -1 || end < start) return undefined
  const block = text.slice(start, end)
  const value = key => { const match = new RegExp(`^ {8}${key}: (".*")$`, 'm').exec(block); return match === null ? undefined : JSON.parse(match[1]) }
  return { host: value('host'), workspace: value('workspace'), helperHash: value('helperHash') }
}

/** Run `dscode remote <init|status|remove>` against one profile directory. */
export async function remoteCommand(args, { profileDir, dedicatedHome, withLock, scaffold, write, log }) {
  const [verb, ...rest] = args
  const patchPath = `${profileDir}/cordis.patch.yml`
  if (verb === 'status' && rest.length === 0) {
    const status = existsSync(patchPath) ? remoteStatus(readFileSync(patchPath, 'utf8')) : undefined
    log(status === undefined ? `${profileDir}: local workspace profile` : `${profileDir}: remote workspace ssh ${status.host}:${status.workspace} (helper sha256 ${status.helperHash})`)
    return
  }
  if (verb === 'init' && rest[0] === '--print') {
    log(remoteBlock(remoteConfig(rest.slice(1))))
    return
  }
  if (!dedicatedHome) {
    throw new Error('use a dedicated DSH_HOME for each remote workspace (for example DSH_HOME=~/.dsh-remote/<name>); the default home keeps local workspaces')
  }
  if (verb === 'init') {
    const config = remoteConfig(rest)
    await withLock(async () => {
      scaffold()
      write(patchPath, applyRemote(readFileSync(patchPath, 'utf8'), config))
    })
    log(`${profileDir} now runs tools in ssh ${config.host}:${config.workspace}. Start it with DSH_HOME set to the same home; a running leader keeps its old configuration until it exits.`)
    return
  }
  if (verb === 'remove' && rest.length === 0) {
    const removed = await withLock(async () => {
      const next = existsSync(patchPath) ? removeRemote(readFileSync(patchPath, 'utf8')) : { removed: false }
      if (next.removed) write(patchPath, next.text)
      return next.removed
    })
    log(removed ? `${profileDir} is a local workspace profile again; restart its leader.` : `${profileDir}: local workspace profile`)
    return
  }
  throw new Error(REMOTE_USAGE)
}
