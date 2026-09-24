/** Native Agent Teams in presets. The Team tools attach to an agent when it is
 * created under a preset that mounts them (they listen for `agent/created`), so
 * such a preset can be chosen only as a session opens. Mounting one while
 * dscode runs is also unsafe: the tools' initial pass reaches every live agent. */
export const TEAM_TOOLS_MODULE = '@deepseek-ai/dsh-experimental-tool-agent-team'

interface PluginRow { name?: unknown; disabled?: unknown; group?: unknown; config?: unknown }

const teamModule = (name: unknown): boolean => name === TEAM_TOOLS_MODULE
  // Imported legacy presets carry first-party modules as resolved file URLs.
  || (typeof name === 'string' && name.startsWith('file:') && name.includes('/@deepseek-ai/dsh-experimental-tool-agent-team/'))

/** Whether preset plugin rows mount the Team tools. Only a literal `disabled: true`
 * row or group is skipped; a conditional one counts. */
export function carriesTeamTools(plugins: unknown): boolean {
  if (!Array.isArray(plugins)) return false
  return plugins.some(row => {
    if (row === null || typeof row !== 'object') return false
    const { name, disabled, group, config } = row as PluginRow
    if (disabled === true) return false
    return teamModule(name) || (group === true && carriesTeamTools(config))
  })
}
