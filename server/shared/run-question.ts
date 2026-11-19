/**
 * The one question a paused run asks the person, in the shape every surface renders
 * (inbox, live board, mission card, run window, notifications, mobile).
 *
 * Built from Core's pending human interrupts. A Core advertising `questionOptions`
 * adds `text`, `asker`, `why`, `options [{id,label,meaning?,detail?}]`, `recommended`,
 * `endsRun` and `detail` to a question and `rejectable` to an approval; an older Core
 * sends only `prompt`, which renders as a plain-text question. Node ids and paths never
 * reach the person: `nodePath` only picks who asks when Core did not say.
 */

export type RunQuestionAsker = 'planner' | 'developer' | 'fixer' | 'reviewer' | 'install' | 'run'
export interface RunQuestionOption { id: string; label: string; meaning?: string; detail?: string }
export interface RunQuestion {
  /** Core's interrupt id: the answer targets exactly this question. */
  interruptId: string
  kind: 'question' | 'approval'
  asker: RunQuestionAsker
  /** The question (or what to approve), without node ids. */
  text: string
  why?: string
  /** Supporting detail shown verbatim, e.g. an exact command. */
  detail?: string
  options: RunQuestionOption[]
  recommended?: string
  /** Choices after which the run ends. */
  endsRun: string[]
  /** Some answer can end the run (a planner told "not here", an `endsRun` choice, a rejection). */
  mayEndRun: boolean
  /** An approval Core lets the person reject with a reason. */
  canReject: boolean
  /** A machine-wide install the run needs (Core `machineInstalls`, `data.kind === 'machine-install'`):
   *  the card names the tool and shows the exact command; its choices are `install` and `self`. */
  install?: { tool: string; command: string }
}

const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const str = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

/** Who asks, in the person's words: Core's `asker` (a role id) first, else the Implement node that paused. */
export function questionAsker(asker: unknown, nodePath: unknown): RunQuestionAsker {
  const key = (typeof asker === 'string' && asker ? asker : typeof nodePath === 'string' ? nodePath.split(/[/.:]/).pop() ?? '' : '').toLowerCase()
  if (['plan', 'architect', 'clarify', 'planner'].includes(key)) return 'planner'
  if (['build', 'developer', 'unblock'].includes(key)) return 'developer'
  if (['correct', 'fixer'].includes(key)) return 'fixer'
  if (['assess', 'reviewer', 'review'].includes(key)) return 'reviewer'
  if (['install', 'installer', 'host-install', 'tool-install'].includes(key)) return 'install'
  return 'run'
}

function options(value: unknown): RunQuestionOption[] {
  if (!Array.isArray(value)) return []
  const out: RunQuestionOption[] = []
  for (const item of value) {
    const record = object(item)
    const id = typeof record?.id === 'string' && OPTION_ID.test(record.id) ? record.id : undefined
    const label = str(record?.label, 80)
    if (!id || !label || out.some(option => option.id === id)) continue
    const meaning = str(record?.meaning, 300), detail = str(record?.detail, 2000)
    out.push({ id, label, ...(meaning ? { meaning } : {}), ...(detail ? { detail } : {}) })
    if (out.length >= 6) break
  }
  return out.length >= 2 ? out : []
}

/** A plain prompt that only carries a node-path prefix (`clarify: …`, older Desktop fallbacks) loses it. */
function withoutNodePrefix(text: string, nodePath: unknown): string {
  return typeof nodePath === 'string' && text.startsWith(nodePath + ': ') ? text.slice(nodePath.length + 2) : text
}

/** The first human interrupt a person must answer, as a question card; null when none is pending. */
export function runQuestionFrom(pending: readonly unknown[] | null | undefined): RunQuestion | null {
  for (const entry of pending ?? []) {
    const item = object(entry)
    if (!item || (item.kind !== 'question' && item.kind !== 'approval' && item.kind !== 'gate') || typeof item.id !== 'string') continue
    const value = object(item.value)
    const raw = typeof item.value === 'string' ? item.value : undefined
    const structured = options(value?.options)
    const text = str(structured.length || value?.why ? value?.text ?? value?.prompt : value?.prompt ?? value?.text ?? value?.question ?? raw, 6000)
    const data = object(value?.data)
    const install = item.kind === 'question' && data?.kind === 'machine-install' && typeof data.command === 'string' && data.command.trim()
      ? { command: data.command.trim().slice(0, 300), tool: str(data.tool, 120) ?? data.command.trim().split(/\s+/).pop()! } : undefined
    const asker = install ? 'install' : questionAsker(value?.asker, item.nodePath)
    const kind = item.kind === 'question' ? 'question' : 'approval'
    const ids = new Set(structured.map(option => option.id))
    // "I'll do it myself" stops the run with the command for the person to run.
    const endsRun = install && ids.has('self') ? ['self'] : Array.isArray(value?.endsRun) ? value.endsRun.filter((id): id is string => typeof id === 'string' && ids.has(id)) : []
    const recommended = typeof value?.recommended === 'string' && ids.has(value.recommended) ? value.recommended : undefined
    const canReject = kind === 'approval' && value?.rejectable === true
    const why = str(value?.why, 600), detail = install?.command ?? str(value?.detail, 2000)
    return {
      interruptId: item.id, kind, asker,
      text: withoutNodePrefix(text ?? '', item.nodePath),
      ...(why ? { why } : {}), ...(detail ? { detail } : {}),
      options: kind === 'question' ? structured : [],
      ...(kind === 'question' && recommended ? { recommended } : {}),
      endsRun: kind === 'question' ? endsRun : [],
      // The Implement planner ends the run when the person says the ticket does not belong here.
      mayEndRun: canReject || endsRun.length > 0 || (kind === 'question' && asker === 'planner'),
      canReject,
      ...(install ? { install } : {}),
    }
  }
  return null
}

/** The question a retained Core status (`loop_runs.runtime_status_json`) still waits on. */
export function runQuestionFromStatus(raw: string | null | undefined): RunQuestion | null {
  if (!raw) return null
  try {
    const status = object(JSON.parse(raw))
    return Array.isArray(status?.pendingInterrupts) ? runQuestionFrom(status.pendingInterrupts) : null
  } catch { return null }
}

/** One line for a notification or a compact row. */
export function shortQuestion(question: Pick<RunQuestion, 'text'> | null | undefined, limit = 140): string | null {
  const flat = question?.text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
