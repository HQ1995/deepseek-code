import { symbols, type Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** Attempts at signalling a foreground group that keeps exiting under us. */
export const FOREGROUND_SIGNAL_ATTEMPTS = 5

/** DSH 0.1.7-rc.2's local subprocess provider (unchanged since rc.1) still
 * inspects the foreground group and then signals it without retrying, so the
 * group can exit in between (ESRCH). A shell loop of short commands replaces
 * its foreground group every few milliseconds, and on a loaded host one
 * reinspection loses that race too: interrupting such a job then failed with
 * "kill ESRCH". Reinspect through the provider up to FOREGROUND_SIGNAL_ATTEMPTS
 * times; never reuse a stale pgid or hide permission errors. Drop once
 * signalForeground retries ESRCH itself. */
export function retryForegroundSignal(handle: SubprocessTerminalHandle): void {
  const signal = handle.signalForeground.bind(handle)
  handle.signalForeground = async value => {
    for (let attempt = 1; ; attempt++) {
      try { return await signal(value) } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH' || attempt >= FOREGROUND_SIGNAL_ATTEMPTS) throw error
      }
    }
  }
}

export function protectTerminalSignals(ctx: Context): void {
  ctx.inject(['subprocess'], scope => {
    let subprocess = scope.subprocess
    while ((subprocess as unknown as Record<symbol, SubprocessRuntime>)[symbols.original] !== undefined) {
      subprocess = (subprocess as unknown as Record<symbol, SubprocessRuntime>)[symbols.original]!
    }
    const descriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawnTerminal')
    const spawn = subprocess.spawnTerminal
    if (spawn === undefined) return
    const wrapped: SubprocessRuntime['spawnTerminal'] = async function (this: SubprocessRuntime, spec) {
      const handle = await spawn.call(this, spec)
      retryForegroundSignal(handle)
      return handle
    }
    subprocess.spawnTerminal = wrapped
    scope.effect(() => () => {
      if (subprocess.spawnTerminal !== wrapped) return
      if (descriptor === undefined) Reflect.deleteProperty(subprocess, 'spawnTerminal')
      else Object.defineProperty(subprocess, 'spawnTerminal', descriptor)
    })
  })
}
