/**
 * Tool card titles read off a call's arguments rather than its tool name, by
 * argument shape only: no tool is named here. Pure, like the projection that
 * uses them.
 *
 * @module dscode/tool-titles
 */

/** Longest argument excerpt a card title carries, in code points. */
const TITLE_EXCERPT = 80

/** One line of argument text for a card title: whitespace runs and control or
 * format characters collapse to a space, and long text ends in an ellipsis. */
function titleExcerpt(text: string): string {
  const line = [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()]
  return line.length > TITLE_EXCERPT ? line.slice(0, TITLE_EXCERPT - 1).join('') + '…' : line.join('')
}

/** A title read off the arguments' shape rather than the tool's name. A
 * question tool (`questions: [{question}]`, the TUI's own question-and-answer
 * card shape) names what it asks. A call of the `execute` kind (the ACP kind
 * the projection derived) that runs `code` rather than a shell `command` names
 * its first line: the TUI puts the title in the command slot of an execute
 * card, after its own "Run " (or "$ ") prefix, and shows the whole program in
 * the expanded card from rawInput. A lone markdown `plan` is a plan review. */
export function argumentTitle(kind: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const questions = (args as { questions?: unknown }).questions
  if (Array.isArray(questions) && questions.length > 0 && questions.every(item =>
    item !== null && typeof item === 'object' && typeof (item as { question?: unknown }).question === 'string')) {
    const first = titleExcerpt((questions[0] as { question: string }).question)
    return questions.length > 1 ? `Ask ${questions.length} questions` : first === '' ? undefined : 'Ask: ' + first
  }
  // A markdown plan submitted for review (`plan` alone, opening with a `#`
  // heading). With this title the TUI's plan approval view quotes the plan
  // lines a review comment is on, rather than citing a plan file.
  const plan = (args as { plan?: unknown }).plan
  if (typeof plan === 'string' && Object.keys(args).length === 1 && /^#\s+\S/.test(plan.trimStart())) return 'Plan: Submit for approval'
  const { code, command } = args as { code?: unknown; command?: unknown }
  if (kind === 'execute' && typeof code === 'string' && command === undefined) {
    const first = code.split('\n').map(titleExcerpt).find(line => line !== '')
    return first === undefined ? undefined : 'code: ' + first
  }
  return undefined
}
