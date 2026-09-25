/** Host-served option pickers: the rows a command's bare invocation offers
 * (`x.ai/commands/options`), in DSH's SelectOption shape. DSH 0.1.7-rc.2 hangs
 * such pickers on host commands only in its web client (a `popupSelect`
 * decoration); dscode serves them from the bridge's own features instead, so
 * the TUI needs no per-command code. Pure: shapes, bounds and the goal rows. */

/** DSH's SelectConfirmation (packages/client/ui-commands contract.ts): copy
 * for a row that must be acknowledged before it runs. */
export interface SelectConfirmation {
  readonly title: string
  readonly description: string
  readonly acknowledgeLabel: string
  readonly cancelLabel: string
  readonly confirmLabel: string
}

/** DSH's SelectOption, plus dscode's `next`. Picking a row submits
 * `/<command> <id>` (an empty id: the bare command). A `next` row instead asks
 * for the options at `query: id`, one argument further. `active` marks the
 * value in use, where the picker's highlight starts. */
export interface SelectOption {
  readonly id: string
  readonly label: string
  readonly badge?: string
  readonly detail?: string
  readonly active?: boolean
  readonly confirmation?: SelectConfirmation
  readonly next?: true
}

/** Rows one reply carries at most; the text bound of each field. */
const MAX_OPTIONS = 200
const LIMITS = { id: 512, label: 120, badge: 24, detail: 300 } as const

const oneLine = (text: string, limit: number): string => {
  const line = [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()]
  return line.length > limit ? line.slice(0, limit - 1).join('') + '…' : line.join('')
}

/** Copy for a row whose pick needs acknowledging, in DSH's wording. */
export const confirmation = (title: string, description: string, confirmLabel: string): SelectConfirmation =>
  ({ title, description, acknowledgeLabel: 'I understand', cancelLabel: 'Cancel', confirmLabel })

/** What leaves the bridge: one-line bounded text, rows with a label and a
 * whole id (never truncated: it is the command line), at most one active row. */
export function boundOptions(options: readonly SelectOption[]): SelectOption[] {
  const rows: SelectOption[] = []
  let active = false
  for (const option of options) {
    if (rows.length === MAX_OPTIONS) break
    const id = option.id.trim(), label = oneLine(option.label, LIMITS.label)
    if (label === '' || id.length > LIMITS.id || /[\p{Cc}\p{Cf}]/u.test(id)) continue
    const badge = option.badge === undefined ? '' : oneLine(option.badge, LIMITS.badge)
    const detail = option.detail === undefined ? '' : oneLine(option.detail, LIMITS.detail)
    const current = option.active === true && !active
    if (current) active = true
    rows.push({ id, label, ...badge === '' ? {} : { badge }, ...detail === '' ? {} : { detail }, ...current ? { active: true } : {},
      ...option.confirmation === undefined ? {} : { confirmation: {
        title: oneLine(option.confirmation.title, LIMITS.label), description: oneLine(option.confirmation.description, LIMITS.detail),
        acknowledgeLabel: option.confirmation.acknowledgeLabel, cancelLabel: option.confirmation.cancelLabel, confirmLabel: option.confirmation.confirmLabel } },
      ...option.next === true ? { next: true } : {} })
  }
  return rows
}

/** DSH's goal view, as far as its controls depend on it. */
export interface GoalFacts { objective: string; phase: 'active' | 'paused' | 'blocked' | 'complete'; activation: 'armed' | 'disarmed' }

/** `/goal`: what the DSH goal command accepts in the goal's phase (its own
 * `commandHint`), after the goal itself. No goal offers nothing, so the bare
 * command says there is none. */
export function goalOptions(goal: GoalFacts | undefined): SelectOption[] {
  if (goal === undefined) return []
  const running = goal.phase === 'active' && goal.activation === 'armed'
  return [
    { id: '', label: 'Show the goal', detail: goal.objective },
    ...running ? [{ id: 'pause', label: 'Pause the goal', detail: 'No new goal rounds start until you resume it' }]
      : goal.phase === 'complete' ? [] : [{ id: 'resume', label: 'Resume the goal', detail: 'Goal rounds start again' }],
    { id: 'clear', label: 'Clear the goal', confirmation: confirmation('Clear the goal?', 'Its objective and progress are discarded.', 'Clear') },
  ]
}
