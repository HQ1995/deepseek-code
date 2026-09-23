import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionEventToUpdates } from '../src/projection.ts'

// Fixtures follow the pinned dsh-tool-bash renderResult contract: ordinary
// nonzero exits and timeouts are result values, not infrastructure errors.
for (const mode of ['direct', 'ptc'] as const) {
  for (const [name, text, expected] of [
    ['successful command control', 'OK\n', { exit_code: 0, signal: null, timed_out: false }],
    ['nonzero command exit', '(no output)\n[exit code: 7]', { exit_code: 7 }],
    ['timed out command', '(no output)\n[timed out after 1000ms]\n[killed by signal: SIGTERM]', { signal: 'SIGTERM', timed_out: true }],
  ] as const) {
    for (const replay of [false, true]) it(`${mode} preserves ${name} (replay=${replay})`, () => {
      const content = [{ type: 'text', text }]
      const event = (mode === 'direct'
        ? { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', content: content } } }
        : { type: 'tool/ptc-dispatch', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'call-1', name: 'bash', arguments: {}, isError: false, content } }
      ) as unknown as SessionEvent
      const updates = sessionEventToUpdates(event, { replay, toolCall: () => ({ name: 'bash', arguments: { command: 'fixture' } }) })
      expect(updates[0]).toMatchObject({ toolCallId: 'call-1', rawOutput: { type: 'Bash', ...expected } })
    })
  }
}

it.each([
  { name: 'bash', args: { command: 'fixture', run_in_background: true }, error: false },
  { name: 'run_code', args: { code: 'fixture' }, error: false },
  { name: 'bash', args: { command: 'fixture' }, error: true },
])('does not invent process status for $name/$error', ({ name, args, error }) => {
  const event = { type: 'tool/ptc-dispatch', data: { subCallId: 'call', isError: error, content: [{ type: 'text', text: 'result' }] } } as unknown as SessionEvent
  expect(sessionEventToUpdates(event, { replay: false, toolCall: () => ({ name, arguments: args }) })[0]).not.toHaveProperty('rawOutput')
})
