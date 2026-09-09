import { symbols, type Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** DSH 0.1.5 can lose the inspected foreground group before kill(2). Reinspect
 * through the provider once; never reuse a stale pgid or hide permission errors. */
export function retryForegroundSignal(handle: SubprocessTerminalHandle): void {
  const signal = handle.signalForeground.bind(handle)
  handle.signalForeground = async value => {
    try { return await signal(value) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error
      return await signal(value)
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
