/** Passive TUI output snapshots from the native, non-consuming job ring. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobRegistry, type JobOutputRead } from '@deepseek-ai/dsh-jobs'

const MAX_OUTPUT_CHARS = 256 * 1024

/** Keep stream gaps, stderr and spill locations visible without advancing the model cursor. */
export function outputSnapshot(read: JobOutputRead, spillPaths: readonly string[] = []): string {
  const sections: string[] = []
  if (read.lossy) sections.push('[Earlier output truncated' + (spillPaths.length === 0 ? '' : '; full output: ' + spillPaths.join(', ')) + ']')
  let channel: string | undefined
  for (const chunk of read.chunks) {
    if (chunk.gapBefore) sections.push('[Output gap]')
    if (chunk.channel !== channel && chunk.channel === 'stderr') sections.push('[stderr]')
    channel = chunk.channel
    sections.push(chunk.text)
  }
  const text = sections.join('')
  return text.length > MAX_OUTPUT_CHARS
    ? '[Earlier output truncated in TUI]\n' + text.slice(-MAX_OUTPUT_CHARS).replace(/^[\uDC00-\uDFFF]/, '') : text
}

/** Full snapshots establish/reset the window; ordinary growth sends only its suffix. */
export function jobOutputPatch(previous: string | undefined, output: string): Record<string, unknown> {
  return { type: 'Bash', ...(previous !== undefined && output.startsWith(previous)
    ? { output_append: output.slice(previous.length) } : { output_for_prompt: output }) }
}

/** Read under the session's native ownership check; never consumes or acknowledges completion. */
export function jobOutputSnapshot(registry: object, owner: Agent, id: string): string | undefined {
  const jobs = registry as Pick<JobRegistry, 'readAt' | 'get'>
  if (typeof jobs.readAt !== 'function' || typeof jobs.get !== 'function') return undefined
  const jobId = JobId(id), caller = owner.session.id
  return outputSnapshot(jobs.readAt(jobId, 0, caller), jobs.get(jobId, caller).output.spillPaths)
}
