import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { releaseAssets } from './build-release-payload.mjs'

export function assertReleaseRun(run, sha, tag) {
  if (run?.headSha !== sha || run?.headBranch !== tag || run?.status !== 'completed' || run?.conclusion !== 'success') {
    throw new Error(`release checks have not succeeded for ${tag} at ${sha}`)
  }
}

/** The manifest of the commit being released, never the live working tree.
 * A release waits hours for CI, and a version bump landing in that window used
 * to fail provenance verification for payloads that were correctly built. */
export function releasedManifest(sha, root = fileURLToPath(new URL('..', import.meta.url))) {
  const result = spawnSync('git', ['-C', root, 'show', `${sha}:bridge/grok-leader/package.json`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot read the manifest of ${sha}: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

const hashFile = async (path, gzip = false) => {
  const hash = createHash('sha256')
  const streams = [createReadStream(path), ...(gzip ? [createGunzip()] : []), hash]
  await pipeline(streams)
  return hash.digest('hex')
}
const archiveJson = (path, entry) => {
  const result = spawnSync('tar', ['-xOf', path, entry], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error(`cannot inspect ${path}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

/** Validate the downloaded draft, including compressed binaries and provenance,
 * before it becomes discoverable by either update or npm installation. */
export async function verifyReleaseAssets(directory, manifest) {
  for (const name of releaseAssets(manifest.dsh.sourceCommit)) {
    if (!statSync(join(directory, name)).isFile()) throw new Error(`missing release file ${name}`)
    if (!name.endsWith('.sha256')) continue
    const asset = name.slice(0, -7)
    const expected = readFileSync(join(directory, name), 'utf8').trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(expected) || await hashFile(join(directory, asset)) !== expected.toLowerCase()) throw new Error(`checksum mismatch: ${asset}`)
    if (asset === 'dscode-linux-x86_64' || asset === 'dscode-macos-aarch64') {
      if (await hashFile(join(directory, `${asset}.gz`), true) !== expected.toLowerCase()) throw new Error(`compressed binary mismatch: ${asset}`)
    }
  }
  const plugin = archiveJson(join(directory, 'dscode-plugin.tgz'), 'package/package.json')
  if (plugin.name !== manifest.name || plugin.version !== manifest.version || plugin.dscode?.release !== manifest.version
    || plugin.dsh?.sourceCommit !== manifest.dsh.sourceCommit || plugin.dsh?.testedVersion !== manifest.dsh.testedVersion) throw new Error('plugin release provenance mismatch')
  if (manifest.dsh.sourceCommit) for (const [asset, platform, arch] of [['linux-x86_64', 'linux', 'x64'], ['macos-aarch64', 'darwin', 'arm64']]) {
    const runtime = archiveJson(join(directory, `dscode-runtime-${asset}.tar.gz`), './dscode-runtime.json')
    if (runtime.schema !== 1 || runtime.platform !== platform || runtime.arch !== arch || runtime.sourceCommit !== manifest.dsh.sourceCommit || runtime.dshVersion !== manifest.dsh.testedVersion) throw new Error(`runtime release provenance mismatch: ${asset}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, runFile, sha, tag] = process.argv.slice(2)
  assertReleaseRun(JSON.parse(readFileSync(runFile, 'utf8')), sha, tag)
  await verifyReleaseAssets(directory, releasedManifest(sha))
  console.log('PASS release checks, checksums, compressed binaries, and product provenance')
}
