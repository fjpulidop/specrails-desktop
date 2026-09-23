// ─── Mission run-failure briefing (mission-rail-cards) ───────────────────────
// When a mission-originated run fails, the app starts ONE bounded agent turn
// whose "user" text is this briefing: what ran, what failed, what the runtime
// offers, and the conduct rule (explain briefly, propose the next action via
// the card, never relaunch by yourself). Pure — no I/O, no model — so the
// content is deterministic and testable. The briefing row carries a
// `system-briefing` context ref so the client renders it compactly instead of
// as a user bubble.

import type { MissionRunFailure } from '../../../types'

export const FAILURE_BRIEFING_REF_KIND = 'system-briefing'
export const FAILURE_BRIEFING_MAX_TAIL = 1200

export interface FailureBriefingInput {
  runId: string
  railIndex: number
  railName?: string | null
  ticketIds: number[]
  tickets?: Array<{ id: number; title?: string | null }>
  failure: MissionRunFailure
  /** Last lines of the verify / provider output when available (≤ FAILURE_BRIEFING_MAX_TAIL chars kept). */
  outputTail?: string | null
  recovery?: { canResume?: boolean; recoverableSteps?: string[]; pendingApproval?: boolean; pendingQuestion?: string | null } | null
  /** False for shared-cwd (no git) runs: no PR phase exists. */
  hasDelivery?: boolean
  prDeliveryId?: string | null
}

export const FAILURE_CODE_LABELS: Record<string, string> = {
  implementation_failed: 'the implementation failed',
  launch_failed: 'the launch could not start',
  delivery_failed: 'the delivery could not be prepared',
  stalled: 'the run stalled (no provider output for the whole idle budget)',
  provider_limit: 'the AI provider reported a usage or rate limit',
  stuck: 'the run appears stuck (no activity checkpoint for a long time)',
  cancelled: 'the run was cancelled',
  push_failed: 'pushing the branch failed',
}

export function describeFailureCode(code: string): string {
  return FAILURE_CODE_LABELS[code] ?? `it stopped with status "${code}"`
}

export function railLabel(railIndex: number, railName?: string | null): string {
  return railName && railName.trim() ? `Rail ${railIndex + 1} (${railName.trim()})` : `Rail ${railIndex + 1}`
}

function trimTail(tail: string | null | undefined): string | null {
  if (!tail) return null
  const t = tail.trim()
  if (!t) return null
  return t.length > FAILURE_BRIEFING_MAX_TAIL ? `…${t.slice(-FAILURE_BRIEFING_MAX_TAIL)}` : t
}

/** The exact user-turn text of the automatic failure turn. */
export function buildFailureBriefing(input: FailureBriefingInput): string {
  const specs = input.ticketIds.map((id) => {
    const title = input.tickets?.find((t) => t.id === id)?.title
    return title ? `#${id} — ${title}` : `#${id}`
  })
  const lines: string[] = []
  lines.push('[Specrails run-failure briefing — automatic, not typed by the user]')
  lines.push('')
  lines.push(`${railLabel(input.railIndex, input.railName)} · run ${input.runId} stopped: ${describeFailureCode(input.failure.code)}.`)
  lines.push(`Specs: ${specs.join(', ') || 'none'}.`)
  if (input.failure.stepId) lines.push(`Failed step: ${input.failure.stepId}.`)
  if (input.failure.detail) lines.push(`Detail: ${input.failure.detail.trim()}`)
  const tail = trimTail(input.outputTail)
  if (tail) {
    lines.push('')
    lines.push('Last output:')
    lines.push('```')
    lines.push(tail)
    lines.push('```')
  }
  const options: string[] = []
  const r = input.recovery
  if (r?.pendingQuestion) options.push(`the run is waiting for an answer: "${r.pendingQuestion}"`)
  if (r?.pendingApproval) options.push('a step is waiting for approval')
  if (r?.canResume) options.push('Resume (continue from the saved runtime state)')
  if (r?.recoverableSteps?.length) options.push(`Recover & retry the interrupted step(s): ${r.recoverableSteps.join(', ')}`)
  options.push('Relaunch (a fresh run on the same rail)')
  options.push('Discard')
  lines.push('')
  lines.push(`The card in this mission offers: ${options.join('; ')}.`)
  if (input.hasDelivery === false) lines.push('This run had no git isolation (shared project folder) — there is no PR phase.')
  if (input.prDeliveryId) lines.push(`Delivery id: ${input.prDeliveryId}.`)
  lines.push('')
  lines.push('Conduct: explain the failure in at most 6 short lines, name the ONE next action you recommend and why, and stop. Do NOT relaunch, resume or discard by yourself — the user decides on the card. If you need evidence, read it with specrails_jobs (get / runtime_runs / runtime_evidence) before answering.')
  return lines.join('\n')
}

/** The context ref persisted on the briefing row so the client renders it compactly. */
export function failureBriefingRef(runId: string, railIndex: number, code: string): { kind: string; id: string; label: string; token: string; metadata: Record<string, unknown> } {
  return { kind: FAILURE_BRIEFING_REF_KIND, id: runId, label: 'Run failure briefing', token: '', metadata: { railIndex, code } }
}
