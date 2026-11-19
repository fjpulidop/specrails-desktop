// ─── The one question a paused run asks the person ──────────────────────────
// Mirrors server/modules/loops/runtime/run-question.ts. Every surface (inbox,
// live board, mission card, run window) renders it with <RunQuestionCard>, and
// every answer goes through `submitRunAnswer`, so the same question never reads
// or behaves differently in two places.

import { API_ORIGIN } from '../../lib/origin'

export type RunQuestionAsker = 'planner' | 'developer' | 'fixer' | 'reviewer' | 'install' | 'run'
export interface RunQuestionOption { id: string; label: string; meaning?: string; detail?: string }
export interface RunQuestion {
  /** Core's interrupt id ('' for a legacy pause, answered by plain text). */
  interruptId: string
  kind: 'question' | 'approval'
  asker: RunQuestionAsker
  text: string
  why?: string
  detail?: string
  options: RunQuestionOption[]
  recommended?: string
  endsRun: string[]
  mayEndRun: boolean
  canReject: boolean
}

const ASKERS: readonly string[] = ['planner', 'developer', 'fixer', 'reviewer', 'install', 'run']
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Defensive read of the wire card: anything malformed is dropped, never thrown. */
export function readRunQuestion(raw: unknown): RunQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof v[key] === 'string' && (v[key] as string).trim() ? (v[key] as string) : undefined)
  const text = str('text')
  if (!text || typeof v.interruptId !== 'string' || (v.kind !== 'question' && v.kind !== 'approval')) return null
  const options = (Array.isArray(v.options) ? v.options : []).flatMap((item): RunQuestionOption[] => {
    const o = item as Record<string, unknown> | null
    if (!o || typeof o.id !== 'string' || !OPTION_ID.test(o.id) || typeof o.label !== 'string' || !o.label.trim()) return []
    return [{ id: o.id, label: o.label, ...(typeof o.meaning === 'string' && o.meaning ? { meaning: o.meaning } : {}), ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}) }]
  })
  const ids = new Set(options.map((option) => option.id))
  const why = str('why'), detail = str('detail'), recommended = str('recommended')
  return {
    interruptId: v.interruptId, kind: v.kind, text,
    asker: ASKERS.includes(String(v.asker)) ? v.asker as RunQuestionAsker : 'run',
    ...(why ? { why } : {}), ...(detail ? { detail } : {}),
    options, ...(recommended && ids.has(recommended) ? { recommended } : {}),
    endsRun: (Array.isArray(v.endsRun) ? v.endsRun : []).filter((id): id is string => typeof id === 'string' && ids.has(id)),
    mayEndRun: v.mayEndRun === true,
    canReject: v.kind === 'approval' && v.canReject === true,
  }
}

/** A question an older Core (or a legacy pause) asked as plain text. */
export function plainRunQuestion(text: string, interruptId = '', kind: RunQuestion['kind'] = 'question'): RunQuestion {
  return { interruptId, kind, asker: 'run', text, options: [], endsRun: [], mayEndRun: false, canReject: false }
}

export type RunAnswer =
  | { type: 'option'; optionId: string; label: string }
  | { type: 'text'; text: string }
  | { type: 'approve' }
  | { type: 'reject'; reason: string }

export interface SubmitRunAnswerInput {
  projectId: string
  /** The run's job / loop-run id. */
  runId: string
  question: RunQuestion
  answer: RunAnswer
  /** 1: a legacy runtime execution answered through `agent-runtime/runs/:id/resume`. */
  engine?: 1 | 2
  fetchImpl?: typeof fetch
}

/** What the server said when it refused the answer (shown as the error detail). */
export class RunAnswerError extends Error {}

async function post(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

/**
 * Answer the question. A run paused in this process takes it on its turn door
 * (`POST /jobs/:id/messages`); a run retained across a restart is resumed with
 * the same controls (`POST /loop-runs/:id/resume`).
 */
export async function submitRunAnswer({ projectId, runId, question, answer, engine = 2, fetchImpl = fetch }: SubmitRunAnswerInput): Promise<void> {
  const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
  const id = question.interruptId
  const target = id ? { interruptId: id } : {}
  if (engine === 1) {
    const text = answer.type === 'option' ? answer.label : answer.type === 'text' ? answer.text : ''
    const res = await post(fetchImpl, `${base}/agent-runtime/runs/${encodeURIComponent(runId)}/resume`, answer.type === 'approve' ? {} : { answer: text })
    if (!res.ok) throw new RunAnswerError(await errorOf(res))
    return
  }
  const message = answer.type === 'option' ? { text: answer.label, ...target, optionId: answer.optionId }
    : answer.type === 'text' ? { text: answer.text, ...target }
      : answer.type === 'approve' ? { text: '', ...target, approve: true }
        : { text: answer.reason, ...target, reject: true }
  const live = await post(fetchImpl, `${base}/jobs/${encodeURIComponent(runId)}/messages`, message)
  if (live.ok) return
  // Not paused in this process (a restart retained it): resume the retained run instead.
  if (!id || (live.status !== 409 && live.status !== 403)) throw new RunAnswerError(await errorOf(live))
  const controls = answer.type === 'option' ? { answer: answer.label, interruptId: id, optionId: answer.optionId }
    : answer.type === 'text' ? { answer: answer.text, interruptId: id }
      : answer.type === 'approve' ? { approve: [id], interruptId: id }
        : { reject: id, reason: answer.reason }
  const retained = await post(fetchImpl, `${base}/loop-runs/${encodeURIComponent(runId)}/resume`, controls)
  if (!retained.ok) throw new RunAnswerError(await errorOf(retained))
}

async function errorOf(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({})) as { error?: unknown; detail?: unknown; message?: unknown }
  const text = [data.detail, data.message, data.error].find((value): value is string => typeof value === 'string' && !!value)
  return text ?? ''
}

// ─── Instant cross-surface update ───────────────────────────────────────────
// An answer from one surface hides the question on every other surface of this
// window at once; other windows follow the server's job.interactive /
// loop.run_resumed events.

const ANSWERED_EVENT = 'specrails:run-question-answered'
export interface RunQuestionAnswered { projectId: string; runId: string }

export function announceRunQuestionAnswered(detail: RunQuestionAnswered): void {
  try { window.dispatchEvent(new CustomEvent<RunQuestionAnswered>(ANSWERED_EVENT, { detail })) } catch { /* no window (tests) */ }
}

export function onRunQuestionAnswered(listener: (detail: RunQuestionAnswered) => void): () => void {
  const handler = (event: Event): void => { const detail = (event as CustomEvent<RunQuestionAnswered>).detail; if (detail) listener(detail) }
  window.addEventListener(ANSWERED_EVENT, handler)
  return () => window.removeEventListener(ANSWERED_EVENT, handler)
}

/** Is this server event the end of a run's question (answered, resumed, stopped or finished)? */
export function runQuestionSettledBy(message: unknown): RunQuestionAnswered | null {
  if (!message || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  const projectId = typeof m.projectId === 'string' ? m.projectId : null
  const runId = typeof m.jobId === 'string' ? m.jobId : typeof m.loopRunId === 'string' ? m.loopRunId : null
  if (!projectId || !runId) return null
  if (m.type === 'job.interactive' && m.question === null) return { projectId, runId }
  if (m.type === 'loop.run_resumed' || m.type === 'loop.run_stopped' || m.type === 'loop.run_completed') return { projectId, runId }
  return null
}
