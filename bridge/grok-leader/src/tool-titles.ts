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
 * card shape) names what it asks. */
export function argumentTitle(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const questions = (args as { questions?: unknown }).questions
  if (Array.isArray(questions) && questions.length > 0 && questions.every(item =>
    item !== null && typeof item === 'object' && typeof (item as { question?: unknown }).question === 'string')) {
    const first = titleExcerpt((questions[0] as { question: string }).question)
    return questions.length > 1 ? `Ask ${questions.length} questions` : first === '' ? undefined : 'Ask: ' + first
  }
  return undefined
}
