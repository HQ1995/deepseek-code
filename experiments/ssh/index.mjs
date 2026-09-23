import SshConnection from '@deepseek-ai/dsh-ssh'
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import SshSandboxProvider from '@deepseek-ai/dsh-sandbox-ssh'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'

export const name = 'dscode-experimental-ssh'
export const inject = ['sandboxPolicy']
export const Config = SshConnection.Config

/** One owner for all remote execution coordinates. Never mix local providers. */
export async function apply(ctx, config) {
  if (!config.bootstrapPath || !config.bootstrapHash) throw new Error('dscode SSH requires a preinstalled, digest-pinned remote PTC bootstrap')
  await ctx.plugin(SshConnection, config)
  await ctx.plugin(SshFileSystem)
  await ctx.plugin(SshSubprocessRuntime)
  await ctx.plugin(SshSandboxProvider)
  const ssh = ctx.get('ssh')
  await ctx.plugin(NodePtcRuntime, { nodeExecutable: ssh.nodeExecutable, bootstrapPath: ssh.bootstrapPath })
}
