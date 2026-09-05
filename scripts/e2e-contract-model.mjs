import { goalReply } from './e2e-goals.mjs'
import { historyReply } from './e2e-history.mjs'

export function contractReply(body) {
  // DSH appends live policy as a user-role snapshot after the actual prompt.
  body = { ...body, messages: (body.messages ?? []).filter(message =>
    message.role !== 'user' || typeof message.content !== 'string' ||
    !message.content.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) }
  const history = historyReply(body)
  if (history) return history
  const goal = goalReply(body)
  if (goal) return goal
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user')
  const prompt = JSON.stringify(messages[start]?.content ?? '')
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
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
    if (!results.length) return { name: 'bash', arguments: {
      command: 'sleep 120 # DSCODE controlled background job', description: 'DSCODE controlled background job', run_in_background: true,
    } }
    if (results.length === 1) return { name: 'subagent', arguments: {
      description: 'DSCODE controlled child', prompt: 'DSCODE_CHILD_HOLD', run_in_background: true,
    } }
    return { text: 'DSCODE_TASKS_READY' }
  }
  if (prompt.includes('DSCODE_CONTEXT_PROBE')) return { text: 'DSCODE_CONTEXT_DONE' }
}
