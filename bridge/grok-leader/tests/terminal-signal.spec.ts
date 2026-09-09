import { expect, it, vi } from 'vitest'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { retryForegroundSignal } from '../src/terminal-signal.ts'

it('reinspects an exited foreground group and preserves the actual successful target', async () => {
  const signal = vi.fn().mockRejectedValueOnce(Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })).mockResolvedValue(456)
  const handle = { signalForeground: signal } as unknown as SubprocessTerminalHandle
  retryForegroundSignal(handle)
  expect(await handle.signalForeground('SIGINT')).toBe(456)
  expect(signal.mock.calls).toEqual([['SIGINT'], ['SIGINT']])
})

it.each(['EPERM', 'EIO', 'ESRCH'])('surfaces %s when signalling cannot succeed', async code => {
  const error = Object.assign(new Error(code), { code })
  const signal = vi.fn().mockRejectedValue(error)
  const handle = { signalForeground: signal } as unknown as SubprocessTerminalHandle
  retryForegroundSignal(handle)
  await expect(handle.signalForeground('SIGINT')).rejects.toBe(error)
  expect(signal).toHaveBeenCalledTimes(code === 'ESRCH' ? 2 : 1)
})
