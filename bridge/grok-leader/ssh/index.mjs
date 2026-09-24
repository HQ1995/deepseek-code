/** dscode's remote workspace: one SSH connection owns this profile's
 * filesystem, subprocess, sandbox and PTC providers. Only a dedicated remote
 * profile inserts this row (`dscode remote init`); the leader reports the
 * remote world from this row's configuration, connected or not, so the TUI
 * refuses host paths. Both endpoints must be POSIX. */
import { checkRemote, sshProbeAsync } from '../bin/remote-check.mjs'
import { importRuntime } from '../shared/runtime-modules.mjs'

const { default: SshConnection } = await importRuntime('@deepseek-ai/dsh-ssh')
const { default: SshFileSystem } = await importRuntime('@deepseek-ai/dsh-fs-ssh')
const { default: SshSubprocessRuntime } = await importRuntime('@deepseek-ai/dsh-subprocess-ssh')
const { default: SshSandboxProvider } = await importRuntime('@deepseek-ai/dsh-sandbox-ssh')
const { default: NodePtcRuntime } = await importRuntime('@deepseek-ai/dsh-ptc-runtime-node')

export const name = 'dscode-ssh'
export const inject = ['sandboxPolicy']
export const Config = SshConnection.Config

/** Why the connection failed; the leader shows it when a session cannot start. */
const FAILURE = Symbol.for('dscode.ssh.failure')

const message = error => error instanceof Error ? error.message : String(error)
/** The finding alone: the session refusal already names the host, and
 * `dscode doctor --runtime` repeats the check with the fix spelled out. */
const finding = text => {
  const end = text.indexOf('. ')
  return (end === -1 ? text : text.slice(0, end)).replace(/\.$/, '').replace(/^ssh \S+ failed: /, '')
}

/** dsh-ssh drops ssh's own stderr, so its error only says the helper went
 * away. One probe run the way `dscode remote status --check` runs it names the
 * cause: an unknown alias, a refused key, or Node or a helper missing there.
 * When the host checks out, what dsh-ssh reported stands. */
export async function explainFailure(config, error, probe = sshProbeAsync) {
  let result
  try { result = await probe(config) } catch { return message(error) }
  try { checkRemote(config, { probe: () => result }) } catch (cause) { return finding(message(cause)) }
  return message(error)
}

export async function apply(ctx, config) {
  if (!config.bootstrapPath || !config.bootstrapHash) throw new Error('dscode SSH requires a preinstalled, digest-pinned remote PTC bootstrap')
  try { await ctx.plugin(SshConnection, config) } catch (error) {
    // Readable at once; replaced by the named cause when the probe returns.
    globalThis[FAILURE] = message(error)
    globalThis[FAILURE] = await explainFailure(config, error)
    throw error
  }
  delete globalThis[FAILURE]
  await ctx.plugin(SshFileSystem)
  await ctx.plugin(SshSubprocessRuntime)
  await ctx.plugin(SshSandboxProvider)
  const ssh = ctx.get('ssh')
  await ctx.plugin(NodePtcRuntime, { nodeExecutable: ssh.nodeExecutable, bootstrapPath: ssh.bootstrapPath })
}
