import { nextSixReply } from './e2e-next-six.mjs'
import { archiveTerminalReply } from './e2e-archive-terminal.mjs'
import { readFileSync } from 'node:fs'
import { goalReply } from './e2e-goals.mjs'
import { historyReply } from './e2e-history.mjs'
import { nativeTuiReply } from './e2e-native-tui.mjs'
import { nativeControlsReply } from './e2e-native-controls.mjs'

export function contractReply(body) {
  // DSH appends live policy and skill reminders as user-role messages.
  body = { ...body, messages: (body.messages ?? []).filter(message =>
    message.role !== 'user' || typeof message.content !== 'string' ||
    !(message.content.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.') ||
      message.content.startsWith('<system-reminder>\nA skill is a reusable set of task-specific instructions.'))) }
  const extra = archiveTerminalReply(body)
  if (extra) return extra
  const six = nextSixReply(body)
  if (six) return six
  const controls = nativeControlsReply(body)
  if (controls) return controls
  const history = historyReply(body)
  if (history) return history
  const native = nativeTuiReply(body)
  if (native) return native
  const goal = goalReply(body)
  if (goal) return goal
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user')
  const prompt = JSON.stringify(messages[start]?.content ?? '')
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  if (prompt.includes('exercise upstream markdown copy')) return { text: readFileSync(process.env.DSCODE_E2E_MARKDOWN, 'utf8') }
  if (prompt.includes('exercise upstream table copy')) return { text: readFileSync(process.env.DSCODE_E2E_TABLE, 'utf8') }
  if (prompt.includes('exercise live screen switch')) return { text: 'DSCODE_MODE_RUNNING', hold: true, releaseText: ' DSCODE_MODE_COMPLETE' }
  if (prompt.includes('exercise active preset selection')) return { text: 'PRESET_SWITCH_RUNNING', hold: true, releaseText: ' PRESET_SWITCH_COMPLETE' }
  if (prompt.includes('DSCODE_CHILD_HISTORY_LIVE')) {
    if (!results.length) return { name: 'bash', arguments: { command: 'printf DSCODE_CHILD_HISTORY_TOOL', description: 'DSCODE_CHILD_HISTORY_TOOL' } }
    return { text: 'DSCODE_CHILD_HISTORY_START', hold: true, releaseKey: 'child-history', releaseText: ' DSCODE_CHILD_HISTORY_END' }
  }
  if (prompt.includes('DSCODE_CHILD_CONTROL_HOLD')) return { text: 'DSCODE_CHILD_CONTROL_RUNNING', hold: true, releaseKey: 'child', releaseText: ' DSCODE_CHILD_CONTROL_END' }
  if (/DSCODE_CHILD_(EDITED|KEEP_[12]|DIRECT_STEER|RESUME)/.test(prompt)) return { text: 'DSCODE_CHILD_CONTROL_DONE' }
  if (prompt.includes('DSCODE_CHILD_HOLD')) return { text: '', hold: true }
  const match = prompt.match(/DSCODE_PERMISSION_(PROBE|ESCALATED):([A-Za-z0-9_-]+)/)
  if (match) {
    const path = Buffer.from(match[2], 'base64url').toString('utf8')
    const quotedPath = `'${path.replaceAll("'", "'\\''")}'`
    if (!results.length) return { name: 'bash', arguments: {
      command: `printf approved > ${quotedPath}`, description: 'DSCODE permission probe',
      ...(match[1] === 'ESCALATED' ? { sandbox_permissions: 'danger-full-access', justification: 'Exercise approval transport by writing only this isolated fixture marker.' } : {}),
    } }
    return { text: 'DSCODE_PERMISSION_DONE' }
  }
  if (prompt.includes('DSCODE_TASKS_PROBE')) {
    const descendant = prompt.match(/DSCODE_TASKS_PROBE:([A-Za-z0-9_-]+)/)
    const pidPath = descendant && Buffer.from(descendant[1], 'base64url').toString('utf8')
    const escaped = pidPath && `'${pidPath.replaceAll("'", "'\\''")}'`
    if (!results.length) return { name: 'bash', arguments: {
      command: escaped ? `setsid sh -c 'echo $$ > "$1"; exec sleep 120' dscode-containment ${escaped} & wait` : 'sleep 120 # DSCODE controlled background job', description: 'DSCODE controlled background job', run_in_background: true,
    } }
    if (results.length === 1) return { name: 'subagent', arguments: {
      description: 'DSCODE controlled child', prompt: 'DSCODE_CHILD_HOLD', run_in_background: true,
    } }
    return { text: 'DSCODE_TASKS_READY' }
  }
  if (prompt.includes('DSCODE_CONTEXT_PROBE')) return { text: 'DSCODE_CONTEXT_DONE' }
}
