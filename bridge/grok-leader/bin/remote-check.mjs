/** What `dscode remote` checks before it writes a profile, and what
 * `dscode doctor --runtime` checks for a remote one: the SSH alias connects
 * non-interactively, the remote Node runs, the workspace exists, and the
 * helper and PTC bootstrap there are byte-identical to the ones this dscode's
 * DSH runtime ships. Those local copies also supply the default digests. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

export const HELPER_PACKAGE = '@deepseek-ai/dsh-ssh'
export const BOOTSTRAP_PACKAGE = '@deepseek-ai/dsh-ptc-runtime-node'
const HELPER_FILE = 'lib/helper.js'
const BOOTSTRAP_FILE = 'lib/process.js'
const MIN_NODE_MAJOR = 22

/** Remote paths below one npm install directory (`npm install` run in `dir`). */
export const installedPaths = dir => ({
  helper: `${dir}/node_modules/${HELPER_PACKAGE}/${HELPER_FILE}`,
  bootstrapPath: `${dir}/node_modules/${BOOTSTRAP_PACKAGE}/${BOOTSTRAP_FILE}`,
})

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The helper and bootstrap this DSH runtime ships, located beside a package
 * its CLI graph reaches, or undefined when no runtime is installed here. */
export function localHelpers(dshBin) {
  try {
    const reached = createRequire(realpathSync(dshBin)).resolve('@deepseek-ai/dsh-mcp-client/package.json')
    const marker = sep + 'node_modules' + sep
    const require = createRequire(join(reached.slice(0, reached.lastIndexOf(marker) + marker.length - 1), '.dscode-remote.cjs'))
    const helperRoot = dirname(require.resolve(HELPER_PACKAGE + '/package.json'))
    const bootstrapRoot = dirname(require.resolve(BOOTSTRAP_PACKAGE + '/package.json'))
    return {
      version: JSON.parse(readFileSync(join(helperRoot, 'package.json'), 'utf8')).version,
      helperHash: sha256(join(helperRoot, HELPER_FILE)),
      bootstrapHash: sha256(join(bootstrapRoot, BOOTSTRAP_FILE)),
    }
  } catch {
    return undefined
  }
}

/** How to install the matching packages: one command when the directory is known. */
export const installHint = (host, install) => install.dir === undefined
  ? `Install ${HELPER_PACKAGE}@${install.version} and ${BOOTSTRAP_PACKAGE}@${install.version} there.`
  : `Install them with: ssh ${host} "mkdir -p '${install.dir}' && cd '${install.dir}' && npm install ${HELPER_PACKAGE}@${install.version} ${BOOTSTRAP_PACKAGE}@${install.version}"`

const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`

// Runs on the host with its own Node: no shell tools beyond `sh` are assumed.
const PROBE = `const fs = require('node:fs'), crypto = require('node:crypto')
const [workspace, ...files] = process.argv.slice(1)
const digest = path => { try { return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex') } catch { return null } }
let directory = false
try { directory = fs.statSync(workspace).isDirectory() } catch {}
console.log(JSON.stringify({ node: process.version, workspace: directory, digests: files.map(digest) }))`

/** Run the probe with `ssh` exactly as the leader connects: batch mode and a known host key. */
export function sshProbe(config, spawn = spawnSync) {
  const command = [config.node, '-e', PROBE, config.workspace, config.helper, config.bootstrapPath].map(shellQuote).join(' ')
  const result = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', config.host, command],
    { encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

const lastLine = text => text.trim().split('\n').filter(Boolean).at(-1) ?? ''

/**
 * Check one remote configuration; returns the remote Node version.
 * @param install - `{ dir?, version }` of the expected packages, for the install hint.
 * @throws a user-facing Error naming what to fix.
 */
export function checkRemote(config, { probe = sshProbe, install } = {}) {
  const result = probe(config)
  const hint = install === undefined ? '' : ' ' + installHint(config.host, install)
  if (result.error !== undefined) throw new Error(`could not run ssh: ${result.error.message}`)
  if (result.status === 255) {
    throw new Error(`ssh ${config.host} failed: ${lastLine(result.stderr) || 'no output'}. The alias must connect with`
      + ` \`ssh -o BatchMode=yes ${config.host}\` (no password prompt) and a known host key.`)
  }
  let report
  try { report = JSON.parse(lastLine(result.stdout)) } catch { report = undefined }
  if (result.status !== 0 || report === undefined) {
    throw new Error(`${config.node} did not run on ${config.host}: ${lastLine(result.stderr) || 'exit ' + String(result.status)}. --node must be an absolute path to Node ${MIN_NODE_MAJOR} or newer there.`)
  }
  const major = Number(/^v(\d+)/.exec(report.node)?.[1])
  if (!(major >= MIN_NODE_MAJOR)) throw new Error(`${config.node} on ${config.host} is Node ${report.node}; the helper needs Node ${MIN_NODE_MAJOR} or newer.`)
  if (!report.workspace) throw new Error(`${config.workspace} is not a directory on ${config.host}; create it first.`)
  for (const [path, actual, expected, name] of [
    [config.helper, report.digests[0], config.helperHash, HELPER_PACKAGE],
    [config.bootstrapPath, report.digests[1], config.bootstrapHash, BOOTSTRAP_PACKAGE],
  ]) {
    if (actual === null) throw new Error(`${path} is missing on ${config.host}.${hint}`)
    if (actual !== expected) {
      throw new Error(`${path} on ${config.host} is not the ${name} this dscode expects (sha256 ${actual}, expected ${expected}).${hint}`)
    }
  }
  return report.node
}
