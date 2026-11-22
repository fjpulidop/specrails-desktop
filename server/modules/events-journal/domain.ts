/**
 * Event journal: pure vocabulary. The journal records the STATE TRANSITIONS the
 * app already broadcasts (run status and holds, questions and approvals,
 * delivery decisions, chain advances, Intent sessions, spec status, spend caps,
 * installs, mission turns) as small rows, so an agent can wait for "what
 * changed" or "what needs me" instead of polling. Stream frames (logs, deltas,
 * tool output) never become rows.
 *
 * `classifyMessage` maps one broadcast message to zero or more drafts. It knows
 * the domain words (job statuses, PR decisions, chain statuses); mapping them
 * to the MCP status vocabulary is the reader's job.
 */

/** Entity kinds a row may name. Matches the MCP ref kinds of the same name. */
export const JOURNAL_REF_KINDS = ['run', 'delivery', 'chain', 'intent', 'spec', 'mission', 'project', 'blueprint', 'milestone'] as const
export type JournalRefKind = (typeof JOURNAL_REF_KINDS)[number]

/** Why the person is the next actor. Null on a row = nobody needs to act. */
export const ATTENTION_KINDS = ['question', 'approval', 'review', 'failed', 'blocked', 'budget'] as const
export type Attention = (typeof ATTENTION_KINDS)[number]

/** A run question in the compact shape a wake-up carries (enough to answer without another read). */
export interface JournalQuestion {
  interruptId: string
  kind: 'question' | 'approval'
  text: string
  options: Array<{ id: string; label: string }>
  recommended?: string
  canReject?: boolean
}

/** Small structured extras. Everything here is bounded by `boundData`. */
export interface JournalData {
  question?: JournalQuestion
  railIndex?: number
  prUrl?: string
  prNumber?: number
  ticketIds?: number[]
  resumeAt?: string
  waitingFor?: string
  scope?: 'project' | 'desktop'
  spentUsd?: number
  budgetUsd?: number
}

/** What `classifyMessage` produces; the journal assigns `seq` and `at`. */
export interface JournalDraft {
  projectId: string | null
  refKind: JournalRefKind
  refId: string
  /** `<refKind>.<what>`, e.g. `run.status`, `run.hold`, `delivery.decision`. */
  kind: string
  /** The domain word (job status, PR decision, chain status, …). */
  status: string
  /** Run hold kind (`question`, `approval`, `provider_limit`, `budget`, `queued`, `stuck`, `paused`), when held. */
  hold: string | null
  attention: Attention | null
  /** Terminal for the entity (finished, failed, cancelled, decided): a `settled` wait wakes on it. */
  settled: boolean
  /** Short, untrusted (spec title, branch). */
  title: string | null
  /** One short line, untrusted (failure code, hold reason, question text). */
  detail: string | null
  data: JournalData | null
  /** The broadcast type it came from. */
  source: string
}

export interface JournalEvent extends JournalDraft {
  seq: number
  /** When the journal recorded it (ISO); rows are in time order. */
  at: string
  /** The previous status of the same ref, when the journal knew it. */
  prevStatus: string | null
}

// ── Retention ────────────────────────────────────────────────────────────────

export const JOURNAL_RETENTION = {
  /** Rows older than this are deleted. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Hard row cap across the app (oldest go first). */
  maxRows: 200_000,
  /** Intermediate rows (not the latest of their ref, no attention) older than this are compacted away. */
  compactAfterMs: 24 * 60 * 60 * 1000,
  /** Compaction runs after this many appends, and on a timer. */
  compactEveryAppends: 2_000,
  compactIntervalMs: 15 * 60 * 1000,
} as const

export interface RetentionPolicy {
  maxAgeMs: number
  maxRows: number
  compactAfterMs: number
}

// ── Bounds ───────────────────────────────────────────────────────────────────

const TEXT_MAX = 240
const OPTION_MAX = 6

export function clip(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function ticketIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((id): id is number => typeof id === 'number').slice(0, 10)
  return ids.length ? ids : undefined
}

/** Compact question card (text, up to 6 options) from a `RunQuestion`. */
export function compactQuestion(value: unknown): JournalQuestion | null {
  const q = obj(value)
  if (!q) return null
  const interruptId = str(q.interruptId)
  const text = clip(q.text)
  if (!interruptId || !text) return null
  const options = (Array.isArray(q.options) ? q.options : [])
    .map(obj).filter((o): o is Record<string, unknown> => !!o && typeof o.id === 'string')
    .slice(0, OPTION_MAX)
    .map((o) => ({ id: String(o.id), label: clip(o.label, 80) ?? String(o.id) }))
  return {
    interruptId,
    kind: q.kind === 'approval' ? 'approval' : 'question',
    text,
    options,
    ...(typeof q.recommended === 'string' ? { recommended: q.recommended } : {}),
    ...(q.canReject === true ? { canReject: true } : {}),
  }
}

function boundData(data: JournalData): JournalData | null {
  const out: JournalData = {}
  for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value
  return Object.keys(out).length ? out : null
}

// ── Classification ───────────────────────────────────────────────────────────

const TERMINAL_JOB = new Set(['completed', 'failed', 'canceled', 'cancelled', 'skipped', 'zombie_terminated', 'stopped'])
const FAILED_JOB = new Set(['failed', 'zombie_terminated'])
const REVIEW_DECISIONS = new Set(['on_review', 'pr_draft', 'pr_ready'])
const FAILED_DECISIONS = new Set(['pr_failed', 'implementation_failed'])
const SETTLED_CHAIN = new Set(['completed', 'cancelled', 'paused', 'awaiting_approval'])
const SETTLED_INTENT = new Set(['delivered', 'discarded', 'closed', 'handed_off', 'needs-review'])
const SETTLED_SPEC = new Set(['done', 'cancelled', 'on_review'])

interface Base { projectId: string | null; source: string }

function draft(base: Base, fields: Partial<JournalDraft> & Pick<JournalDraft, 'refKind' | 'refId' | 'kind' | 'status'>): JournalDraft {
  return {
    projectId: base.projectId, source: base.source,
    hold: null, attention: null, settled: false, title: null, detail: null, data: null,
    ...fields,
  }
}

function runFinished(base: Base, id: string, status: string, data: JournalData = {}): JournalDraft {
  return draft(base, {
    refKind: 'run', refId: id, kind: 'run.status', status,
    settled: TERMINAL_JOB.has(status), attention: FAILED_JOB.has(status) ? 'failed' : null, data: boundData(data),
  })
}

function questionHold(base: Base, id: string, question: JournalQuestion | null, fallbackKind: string | null): JournalDraft {
  const hold = question?.kind ?? (fallbackKind === 'approval' || fallbackKind === 'gate' ? 'approval' : 'question')
  return draft(base, {
    refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold,
    attention: hold === 'approval' ? 'approval' : 'question', settled: false,
    detail: question?.text ?? null, data: question ? { question } : null,
  })
}

/**
 * Drafts for one broadcast message. Pure and total: an unknown or malformed
 * message yields `[]`, never throws.
 */
export function classifyMessage(message: unknown): JournalDraft[] {
  const msg = obj(message)
  if (!msg || typeof msg.type !== 'string') return []
  const type = msg.type
  const base: Base = { projectId: str(msg.projectId), source: type }
  try {
    return classify(type, msg, base)
  } catch {
    return []
  }
}

function classify(type: string, msg: Record<string, unknown>, base: Base): JournalDraft[] {
  switch (type) {
    // ── Runs (jobs and loop runs share ids) ──
    case 'queue': {
      // Only active jobs: a finished job already has its own completion event.
      const jobs = Array.isArray(msg.jobs) ? msg.jobs : []
      return jobs.map(obj).filter((job): job is Record<string, unknown> => !!job && typeof job.id === 'string')
        .filter((job) => job.status === 'queued' || job.status === 'running')
        .map((job) => draft(base, {
          refKind: 'run', refId: String(job.id), kind: 'run.status', status: String(job.status),
          ...(job.status === 'queued' ? { hold: 'queued' } : {}),
          // A queued/running row from the queue snapshot never overrides a known hold (see application.ts).
          data: null,
        }))
    }
    case 'rail.job_started': {
      const id = str(msg.jobId)
      return id ? [draft(base, { refKind: 'run', refId: id, kind: 'run.status', status: 'running', data: boundData({ railIndex: num(msg.railIndex) }) })] : []
    }
    case 'loop.run_started':
    case 'loop.run_resumed': {
      const id = str(msg.loopRunId)
      return id ? [draft(base, { refKind: 'run', refId: id, kind: 'run.status', status: 'running', data: boundData({ railIndex: num(msg.railIndex) ?? undefined }) })] : []
    }
    case 'rail.job_stopped': {
      const id = str(msg.jobId)
      return id ? [runFinished(base, id, 'canceled', { railIndex: num(msg.railIndex) })] : []
    }
    case 'loop.run_stopped': {
      const id = str(msg.loopRunId)
      return id ? [runFinished(base, id, 'canceled', { railIndex: num(msg.railIndex) ?? undefined })] : []
    }
    case 'rail.job_completed': {
      const id = str(msg.jobId)
      return id ? [runFinished(base, id, str(msg.status) ?? 'completed', { railIndex: num(msg.railIndex), ticketIds: ticketIds(msg.ticketIds) })] : []
    }
    case 'loop.run_completed': {
      const id = str(msg.loopRunId)
      return id ? [runFinished(base, id, str(msg.status) ?? 'completed', { railIndex: num(msg.railIndex) ?? undefined, ticketIds: ticketIds(msg.ticketIds) })] : []
    }
    case 'job.finalized': {
      const id = str(msg.jobId)
      return id ? [runFinished(base, id, str(msg.status) ?? 'completed')] : []
    }
    case 'loop.run_queued': {
      const id = str(msg.loopRunId)
      return id ? [draft(base, { refKind: 'run', refId: id, kind: 'run.hold', status: 'queued', hold: 'queued', detail: clip(msg.waitingFor), data: boundData({ waitingFor: str(msg.waitingFor) ?? undefined }) })] : []
    }
    case 'loop.run_paused': {
      const id = str(msg.loopRunId)
      if (!id) return []
      const question = compactQuestion(msg.question)
      if (question) return [questionHold(base, id, question, null)]
      const limit = obj(msg.limit)
      const budget = obj(msg.budget)
      if (msg.pauseKind === 'budget_paused' || budget) {
        return [draft(base, {
          refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'budget', attention: 'budget', settled: false,
          detail: clip(msg.reason), data: boundData({ scope: budget?.scope === 'desktop' ? 'desktop' : budget ? 'project' : undefined, spentUsd: num(budget?.spentUsd), budgetUsd: num(budget?.budgetUsd) }),
        })]
      }
      if (msg.pauseKind === 'limit_paused' || limit) {
        return [draft(base, {
          refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'provider_limit', attention: 'blocked',
          detail: clip(limit?.message ?? msg.reason), data: boundData({ resumeAt: str(limit?.resumeAt) ?? undefined }),
        })]
      }
      // The person paused it (or another non-blocking pause): a transition, nobody needs to act.
      return [draft(base, { refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'paused', detail: clip(msg.reason) })]
    }
    case 'loop.limit_pause': {
      const id = str(msg.loopRunId)
      const limit = obj(msg.limit)
      return id ? [draft(base, {
        refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'provider_limit', attention: 'blocked',
        detail: clip(limit?.message), data: boundData({ resumeAt: str(limit?.resumeAt) ?? undefined }),
      })] : []
    }
    case 'loop.provider_limit': {
      const id = str(msg.runId)
      return id ? [draft(base, {
        refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'provider_limit', attention: 'blocked',
        detail: clip(msg.message), data: boundData({ resumeAt: str(msg.resumeAt) ?? str(msg.resetsAt) ?? undefined }),
      })] : []
    }
    case 'job.interactive': {
      const id = str(msg.jobId)
      if (!id) return []
      const question = compactQuestion(msg.question)
      const pending = Array.isArray(msg.pendingInterrupts) ? msg.pendingInterrupts.map(obj).filter(Boolean) as Record<string, unknown>[] : []
      if (question || pending.length) return [questionHold(base, id, question, str(pending[0]?.kind))]
      // No pending question any more: the hold cleared (answered, approved, or finalizing).
      return [draft(base, { refKind: 'run', refId: id, kind: 'run.hold', status: 'running' })]
    }
    case 'job.stuck': {
      const id = str(msg.jobId)
      const minutes = num(msg.staleMs) !== undefined ? Math.round((msg.staleMs as number) / 60_000) : null
      return id ? [draft(base, {
        refKind: 'run', refId: id, kind: 'run.hold', status: 'running', hold: 'stuck', attention: 'blocked',
        detail: clip(`${str(msg.stepKey) ?? 'step'}${minutes !== null ? ` · ${minutes} min` : ''}`),
      })] : []
    }
    case 'agent_run_failure': {
      const id = str(msg.runId)
      return id ? [draft(base, {
        refKind: 'run', refId: id, kind: 'run.failure', status: 'failed', attention: 'failed', settled: true,
        detail: clip([str(msg.code), str(msg.detail)].filter(Boolean).join(': ')), data: boundData({ railIndex: num(msg.railIndex), ticketIds: ticketIds(msg.ticketIds) }),
      })] : []
    }

    // ── Deliveries ──
    case 'rail.pr_state':
    case 'agent_pr_decision': {
      const id = str(msg.prDeliveryId)
      const decision = str(msg.decision)
      if (!id || !decision) return []
      return [draft(base, {
        refKind: 'delivery', refId: id, kind: 'delivery.decision', status: decision,
        settled: decision !== 'building',
        attention: REVIEW_DECISIONS.has(decision) ? 'review' : FAILED_DECISIONS.has(decision) ? 'failed' : null,
        title: clip(msg.branch, 120), detail: clip(msg.statusDetail ?? msg.statusCode),
        data: boundData({ railIndex: num(msg.railIndex), prUrl: str(msg.prUrl) ?? undefined, prNumber: num(msg.prNumber), ticketIds: ticketIds(msg.ticketIds) }),
      })]
    }

    // ── Chains, Intent, specs ──
    case 'milestone.chain_changed': {
      const chain = obj(msg.chain)
      const id = str(chain?.id)
      const status = str(chain?.status)
      if (!chain || !id || !status) return []
      return [draft(base, {
        refKind: 'chain', refId: id, kind: 'chain.status', status,
        settled: SETTLED_CHAIN.has(status),
        attention: status === 'awaiting_approval' ? 'approval' : status === 'paused' ? 'blocked' : null,
        title: clip(`M${num(chain.milestoneN) ?? '?'} · ${num(chain.nextChunk) ?? 0}/${num(chain.totalChunks) ?? 0}`),
        detail: clip(chain.pauseReason),
      })]
    }
    case 'flow.state': {
      const flow = obj(msg.flow)
      const id = str(msg.flowId) ?? str(flow?.id)
      const state = str(flow?.state)
      if (!id || !state) return []
      return [draft(base, {
        refKind: 'intent', refId: id, kind: 'intent.state', status: state,
        settled: SETTLED_INTENT.has(state), attention: state === 'needs-review' ? 'review' : null,
        title: clip(flow?.branch, 120),
      })]
    }
    case 'ticket_created':
    case 'ticket_updated': {
      const ticket = obj(msg.ticket)
      if (!ticket || ticket.id === undefined || ticket.id === null) return []
      const status = str(ticket.status) ?? 'unknown'
      return [draft(base, {
        refKind: 'spec', refId: String(ticket.id), kind: 'spec.status', status,
        settled: SETTLED_SPEC.has(status), title: clip(ticket.title, 120),
      })]
    }
    case 'ticket_deleted': {
      const id = msg.ticketId
      return typeof id === 'number' ? [draft(base, { refKind: 'spec', refId: String(id), kind: 'spec.status', status: 'deleted', settled: true })] : []
    }
    case 'smash.completed': {
      const id = msg.ticketId
      return typeof id === 'number' ? [draft(base, { refKind: 'spec', refId: String(id), kind: 'spec.smash', status: 'completed', settled: true, data: boundData({ ticketIds: ticketIds(msg.childrenIds) }) })] : []
    }
    case 'smash.failed': {
      const id = msg.ticketId
      return typeof id === 'number' ? [draft(base, { refKind: 'spec', refId: String(id), kind: 'spec.smash', status: 'failed', settled: true, attention: 'failed', detail: clip([str(msg.reason), str(msg.detail)].filter(Boolean).join(': ')) })] : []
    }

    // ── Spend caps ──
    case 'daily_budget_exceeded':
    case 'desktop_daily_budget_exceeded': {
      if (!base.projectId) return []
      const desktop = type === 'desktop_daily_budget_exceeded'
      return [draft(base, {
        refKind: 'project', refId: base.projectId, kind: 'project.budget', status: 'cap_reached', attention: 'budget', settled: true,
        detail: clip(str(msg.period) ?? 'day'),
        data: boundData({ scope: desktop ? 'desktop' : 'project', spentUsd: num(desktop ? msg.desktopDailySpend : msg.dailySpend), budgetUsd: num(desktop ? msg.desktopBudget : msg.budget) }),
      })]
    }

    // ── Project setup / install ──
    case 'setup_install_done':
    case 'setup_complete':
      return base.projectId ? [draft(base, { refKind: 'project', refId: base.projectId, kind: 'project.setup', status: type === 'setup_complete' ? 'completed' : 'installed', settled: true })] : []
    case 'setup_error':
      return base.projectId ? [draft(base, { refKind: 'project', refId: base.projectId, kind: 'project.setup', status: 'failed', settled: true, attention: 'failed', detail: clip(msg.error) })] : []
    case 'setup_checkpoint':
      return base.projectId && msg.status === 'done'
        ? [draft(base, { refKind: 'project', refId: base.projectId, kind: 'project.setup', status: 'running', detail: clip(msg.checkpoint, 80) })]
        : []

    // ── Blueprint ──
    case 'blueprint.commit_done': {
      const id = str(msg.commitId)
      return id ? [draft(base, { refKind: 'blueprint', refId: id, kind: 'blueprint.commit', status: 'completed', settled: true })] : []
    }
    case 'blueprint.commit_failed': {
      const id = str(msg.commitId)
      return id ? [draft(base, { refKind: 'blueprint', refId: id, kind: 'blueprint.commit', status: 'failed', settled: true, attention: 'failed', detail: clip([str(msg.step), str(msg.error)].filter(Boolean).join(': ')) })] : []
    }
    case 'blueprint.milestone_completed': {
      const id = str(msg.milestoneId)
      return id ? [draft(base, { refKind: 'milestone', refId: id, kind: 'milestone.status', status: 'completed', settled: true, title: clip(msg.title, 120) })] : []
    }

    // ── Missions (app-global) ──
    case 'agent_done': {
      const id = str(msg.conversationId)
      return id ? [draft({ ...base, projectId: null }, { refKind: 'mission', refId: id, kind: 'mission.turn', status: 'completed', settled: true })] : []
    }
    case 'agent_turn_done': {
      // Core-session turns (background / steered) close with their own status.
      const id = str(msg.conversationId)
      if (!id) return []
      const status = str(msg.status) ?? 'completed'
      const failed = status === 'failed'
      return [draft({ ...base, projectId: null }, {
        refKind: 'mission', refId: id, kind: 'mission.turn', status: failed ? 'failed' : status === 'completed' ? 'completed' : 'cancelled', settled: true,
        ...(failed ? { attention: 'failed' as const } : {}),
      })]
    }
    case 'agent_error': {
      const id = str(msg.conversationId)
      return id ? [draft({ ...base, projectId: null }, { refKind: 'mission', refId: id, kind: 'mission.turn', status: 'failed', settled: true, attention: 'failed', detail: clip(msg.error) })] : []
    }
    case 'agent_limit_continue': {
      const id = str(msg.conversationId)
      return id ? [draft({ ...base, projectId: null }, { refKind: 'mission', refId: id, kind: 'mission.turn', status: 'paused', hold: 'provider_limit', attention: 'blocked', settled: true, data: boundData({ resumeAt: str(msg.at) ?? undefined }) })] : []
    }
    default:
      return []
  }
}

/** The signature a row is deduplicated by: the same signature twice in a row for one ref is one transition. */
export function signatureOf(d: Pick<JournalDraft, 'kind' | 'status' | 'hold' | 'attention' | 'detail'> & { data?: JournalData | null }): string {
  return [d.status, d.hold ?? '', d.attention ?? '', d.detail ?? '', d.data?.question?.interruptId ?? ''].join('|')
}

export const refKey = (kind: string, id: string): string => `${kind}:${id}`
