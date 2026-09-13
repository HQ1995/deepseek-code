/** Passive TUI output snapshots. Never call the model's consuming jobs.read(). */
import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SubprocessCollectedOutputs, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalSessionService } from '@deepseek-ai/dsh-terminal'

const MAX_OUTPUT_CHARS = 256 * 1024
type Capture = {
  streams: SubprocessCollectedOutputs[]; terminal?: () => string; final?: string; settled?: boolean
}

function boundedOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? '[Earlier output truncated in TUI]\n' + text.slice(-MAX_OUTPUT_CHARS).replace(/^[\uDC00-\uDFFF]/, '') : text
}

function original<T extends object>(value: T): T {
  for (;;) {
    const next = (value as T & Record<symbol, T>)[symbols.original]
    if (next === undefined) return value
    value = next
  }
}

export function outputSnapshot(capture: Capture): string {
  const sections: string[] = []
  for (const streams of capture.streams) {
    for (const name of ['stdout', 'stderr'] as const) {
      // The native reader already caps retained bytes (bash defaults to 64KB).
      // Its readFrom still copies that buffer; deltas would not avoid the copy
      // and can corrupt UTF-8 when a sampled chunk ends inside a code point.
      const read = streams[name]?.readFrom(0)
      if (read === undefined || (read.text.length === 0 && !read.lossy)) continue
      if (name === 'stderr' && read.text.length > 0) sections.push('[stderr]')
      if (read.lossy) sections.push('[Earlier output truncated' + (read.spillPath === undefined ? '' : '; full output: ' + read.spillPath) + ']')
      sections.push(boundedOutput(read.text))
    }
  }
  if (capture.terminal !== undefined) sections.push(capture.terminal())
  if (capture.final !== undefined) sections.push(capture.final)
  const text = sections.join('\n')
  return boundedOutput(text)
}

/** Full snapshots establish/reset the window; ordinary growth sends only its suffix. */
export function jobOutputPatch(previous: string | undefined, output: string): Record<string, unknown> {
  return { type: 'Bash', ...(previous !== undefined && output.startsWith(previous)
    ? { output_append: output.slice(previous.length) } : { output_for_prompt: output }) }
}

/** Associate public collected-output handles with the job starter's async scope. */
export function observeJobOutputs(ctx: Context): (registry: object, owner: Agent, id: string) => string | undefined {
  const active = new AsyncLocalStorage<Capture>()
  const registries = new WeakMap<object, WeakMap<Agent, Map<string, Capture>>>()
  ctx.inject(['terminals'], (scope) => {
    const terminals = original(scope.terminals)
    const descriptor = Object.getOwnPropertyDescriptor(terminals, 'startSend')
    const startSend = terminals.startSend
    if (typeof startSend !== 'function' || typeof terminals.read !== 'function') return
    function observedSend(this: TerminalSessionService, ...args: Parameters<TerminalSessionService['startSend']>) {
      const operation = Reflect.apply(startSend, this, args) as ReturnType<TerminalSessionService['startSend']>
      const capture = active.getStore()
      if (capture !== undefined) {
        const [owner, id] = args
        let last = ''
        capture.terminal = () => {
          try {
            // Retained scrollback is non-consuming; operation.readOutput() belongs to the model.
            const page = terminals.read(owner, id, { offset: 0, count: 1000 })
            last = boundedOutput('[Terminal scrollback]\n' + (page.truncated ? '[Earlier output truncated]\n' : '') + page.text)
          } catch { /* The terminal may already be closed; retain the last readable snapshot. */ }
          return last
        }
        capture.terminal()
        const finish = () => {
          capture.final = capture.terminal?.() ?? last
          capture.terminal = undefined
        }
        void operation.done.then(finish, finish)
      }
      return operation
    }
    terminals.startSend = observedSend
    scope.effect(() => () => {
      if (terminals.startSend !== observedSend) return
      if (descriptor === undefined) Reflect.deleteProperty(terminals, 'startSend')
      else Object.defineProperty(terminals, 'startSend', descriptor)
    })
  })
  ctx.inject(['jobs', 'subprocess'], (scope) => {
    const jobs = original(scope.jobs)
    const subprocess = original(scope.subprocess)
    const owners = new WeakMap<Agent, Map<string, Capture>>()
    registries.set(jobs, owners)
    const startDescriptor = Object.getOwnPropertyDescriptor(jobs, 'start')
    const spawnDescriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawn')
    const start = jobs.start
    const spawn = subprocess.spawn
    if (typeof start !== 'function' || typeof spawn !== 'function') return
    function observedSpawn(this: SubprocessRuntime, ...args: Parameters<SubprocessRuntime['spawn']>) {
      const handle = Reflect.apply(spawn, this, args) as ReturnType<SubprocessRuntime['spawn']>
      const capture = active.getStore()
      if (capture !== undefined && (handle.collected.stdout !== undefined || handle.collected.stderr !== undefined)) {
        capture.streams.push(handle.collected)
      }
      return handle
    }
    function observedStart(this: JobRegistry, spec: JobStart) {
      if (spec.owner === undefined) return Reflect.apply(start, this, [spec]) as ReturnType<JobRegistry['start']>
      const capture: Capture = { streams: [] }
      const id = Reflect.apply(start, this, [{ ...spec, run: () => active.run(capture, () => {
        const hooks = spec.run()
        // Final-only producers already provide immutable settlement output.
        // Observing it neither consumes a stream nor acknowledges completion.
        const finish = () => {
          let final = capture.final
          try { final = outputSnapshot(capture) }
          catch { /* Output handles may already be disposed; release them regardless. */ }
          capture.streams = []
          capture.terminal = undefined
          capture.final = final
          capture.settled = true
          // ponytail: retain the latest 64 finished previews per owner. Native
          // job output remains authoritative; older previews become unavailable.
          const outputs = owners.get(spec.owner!)
          const finished = [...outputs ?? []].filter(([, row]) => row.settled)
          for (const [id] of finished.slice(0, -64)) outputs!.delete(id)
        }
        void hooks.done.then(outcome => {
          if (hooks.readOutput === undefined) {
            const output = outcome.output ?? ''
            capture.final = boundedOutput(output)
          }
          finish()
        }, finish).catch(() => { /* Passive previews must not fail the producer. */ })
        return hooks
      }) }]) as ReturnType<JobRegistry['start']>
      let outputs = owners.get(spec.owner)
      if (outputs === undefined) { outputs = new Map(); owners.set(spec.owner, outputs) }
      outputs.set(id, capture)
      return id
    }
    jobs.start = observedStart
    subprocess.spawn = observedSpawn
    scope.effect(() => () => {
      if (jobs.start === observedStart) {
        if (startDescriptor === undefined) Reflect.deleteProperty(jobs, 'start')
        else Object.defineProperty(jobs, 'start', startDescriptor)
      }
      if (subprocess.spawn === observedSpawn) {
        if (spawnDescriptor === undefined) Reflect.deleteProperty(subprocess, 'spawn')
        else Object.defineProperty(subprocess, 'spawn', spawnDescriptor)
      }
      registries.delete(jobs)
    })
  })
  return (registry, owner, id) => {
    const capture = registries.get(original(registry))?.get(owner)?.get(id)
    return capture === undefined || (capture.streams.length === 0 && capture.terminal === undefined && capture.final === undefined)
      ? undefined : outputSnapshot(capture)
  }
}
