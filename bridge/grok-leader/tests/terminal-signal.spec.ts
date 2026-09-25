import { expect, it, vi } from 'vitest'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { FOREGROUND_SIGNAL_ATTEMPTS, retryForegroundSignal } from '../src/terminal-signal.ts'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'

it.each(['darwin', 'linux'])('bounds %s polling cost without weakening the silence guard', platform => {
  const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').replace(/!!js\b/g, '')) as Array<{ insert?: Array<{ id: string; config?: Record<string, string> }> }>
  const config = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'terminal-bash')!.config!
  expect(runInNewContext(config.pollIntervalMs!, { process: { platform } }, { timeout: 100 })).toBe(platform === 'darwin' ? 200 : 50)
  expect(config).not.toHaveProperty('idleSilenceMs')
  expect(config).not.toHaveProperty('exactProbeAfterMs')
})

it('reinspects an exited foreground group and preserves the actual successful target', async () => {
  const signal = vi.fn().mockRejectedValueOnce(Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })).mockResolvedValue(456)
  const handle = { signalForeground: signal } as unknown as SubprocessTerminalHandle
  retryForegroundSignal(handle)
  expect(await handle.signalForeground('SIGINT')).toBe(456)
  expect(signal.mock.calls).toEqual([['SIGINT'], ['SIGINT']])
})

it('keeps reinspecting a foreground group that exits again, within a bound', async () => {
  const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  const signal = vi.fn().mockRejectedValueOnce(esrch()).mockRejectedValueOnce(esrch()).mockRejectedValueOnce(esrch()).mockResolvedValue(789)
  const handle = { signalForeground: signal } as unknown as SubprocessTerminalHandle
  retryForegroundSignal(handle)
  expect(await handle.signalForeground('SIGINT')).toBe(789)
  expect(signal).toHaveBeenCalledTimes(4)
})

it.each(['EPERM', 'EIO', 'ESRCH'])('surfaces %s when signalling cannot succeed', async code => {
  const error = Object.assign(new Error(code), { code })
  const signal = vi.fn().mockRejectedValue(error)
  const handle = { signalForeground: signal } as unknown as SubprocessTerminalHandle
  retryForegroundSignal(handle)
  await expect(handle.signalForeground('SIGINT')).rejects.toBe(error)
  expect(signal).toHaveBeenCalledTimes(code === 'ESRCH' ? FOREGROUND_SIGNAL_ATTEMPTS : 1)
})
