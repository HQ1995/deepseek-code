/** dscode's remote workspace: one SSH connection owns this profile's
 * filesystem, subprocess, sandbox and PTC providers. Only a dedicated remote
 * profile inserts this row (`dscode remote init`); the leader reports the
 * remote world from this row's configuration, connected or not, so the TUI
 * refuses host paths. Both endpoints must be POSIX. */
import { importRuntime } from '../shared/runtime-modules.mjs'

const { default: SshConnection } = await importRuntime('@deepseek-ai/dsh-ssh')
const { default: SshFileSystem } = await importRuntime('@deepseek-ai/dsh-fs-ssh')
const { default: SshSubprocessRuntime } = await importRuntime('@deepseek-ai/dsh-subprocess-ssh')
const { default: SshSandboxProvider } = await importRuntime('@deepseek-ai/dsh-sandbox-ssh')
const { default: NodePtcRuntime } = await importRuntime('@deepseek-ai/dsh-ptc-runtime-node')

export const name = 'dscode-ssh'
export const inject = ['sandboxPolicy']
export const Config = SshConnection.Config

export async function apply(ctx, config) {
  if (!config.bootstrapPath || !config.bootstrapHash) throw new Error('dscode SSH requires a preinstalled, digest-pinned remote PTC bootstrap')
  await ctx.plugin(SshConnection, config)
  await ctx.plugin(SshFileSystem)
  await ctx.plugin(SshSubprocessRuntime)
  await ctx.plugin(SshSandboxProvider)
  const ssh = ctx.get('ssh')
  await ctx.plugin(NodePtcRuntime, { nodeExecutable: ssh.nodeExecutable, bootstrapPath: ssh.bootstrapPath })
}
