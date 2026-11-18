// ─── "Jump back in": the first group of the empty command palette ─────────────
// What needs the person (inbox items, missions waiting on them) newest first,
// then the most recently active missions and jobs, newest first, capped. Pure:
// the palette feeds it what its contexts already hold (no fetch of its own) and
// freezes the order for one opening (`refreshJumpEntries`).

import type { RunState } from '../ui/run-state/run-state'
import type { JobSummary } from '../../types'
import type { AgentConversation } from '../../features/missions/lib/agent-api'
import type { InboxValue } from '../../features/inbox/context/InboxContext'
import { inboxKindRunState } from '../../features/inbox/lib/inbox-run-state'
import { missionRowRunState, type MissionRowSignal } from '../../features/missions/lib/mission-run-state'
import { jobStatusLook } from '../../features/jobs/lib/job-run-state'
import { parseTimestampMs } from '../../lib/relative-time'

type InboxItem = InboxValue['items'][number]
type MissionAttentionKind = NonNullable<MissionRowSignal['attention']>

/** Rows in the group; each gets ⌘1…⌘6 (Ctrl+1… off macOS). */
export const JUMP_BACK_IN_MAX = 6

export type JumpKind = 'inbox' | 'mission' | 'job'

interface JumpBase {
  /** `inbox:<id>`, `mission:<id>`, `job:<id>`: stable across refreshes. */
  key: string
  id: string
  /** Waits for the person (inbox item, mission attention or unread reply). */
  needsYou: boolean
  /** Epoch ms of the last activity (NaN-safe: unknown sorts last). */
  at: number
  /** The row's lamp; null for an idle mission (the row shows the mission itself). */
  state: RunState | null
  /** The project the subject belongs to; null for a mission not pinned to one. */
  projectId: string | null
}

export type JumpEntry =
  | (JumpBase & { kind: 'inbox'; title: string; item: InboxItem })
  | (JumpBase & { kind: 'mission'; title: string | null })
  | (JumpBase & { kind: 'job'; title: string })

export type JumpMission = Pick<AgentConversation, 'id' | 'title' | 'pinned_project_id' | 'updated_at'> & { archivedAt?: string | null }
export type JumpJob = Pick<JobSummary, 'id' | 'command' | 'status' | 'started_at' | 'enqueued_at' | 'finished_at'> & Partial<Pick<JobSummary, 'ticketId' | 'ticketTitle'>>

export interface JumpSources {
  /** The inbox's open items (not snoozed or done). */
  inbox: readonly InboxItem[]
  missions: readonly JumpMission[]
  /** Missions whose delivery waits for the person, and why. */
  attention: ReadonlySet<string>
  attentionKinds?: ReadonlyMap<string, MissionAttentionKind>
  streaming: ReadonlySet<string>
  unread: ReadonlySet<string>
  /** The active project's recent jobs (the palette's own list). */
  jobs: readonly JumpJob[]
  /** The project the jobs list belongs to. */
  jobsProjectId: string | null
  /**
   * The open project. Within each tier the newest row of this project (or of a
   * mission pinned to no project) leads, so Enter right after opening the
   * palette stays here; the rest keeps its newest-first order.
   */
  activeProjectId?: string | null
}

/** What a job is called in lists: its spec (`#14 Add login`) when it has one, else the raw command. */
export function jobLabel(job: Pick<JobSummary, 'command'> & Partial<Pick<JobSummary, 'ticketId' | 'ticketTitle'>>): string {
  return job.ticketTitle ? `#${job.ticketId} ${job.ticketTitle}` : job.command
}

const ms = (raw: string | null | undefined): number => {
  const value = raw ? parseTimestampMs(raw) : Number.NaN
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

const newestFirst = (a: JumpEntry, b: JumpEntry): number => (b.at === a.at ? 0 : b.at > a.at ? 1 : -1)

/** Newest first, with the open project's newest row moved to the front. */
function tierOrder(entries: JumpEntry[], activeProjectId: string | null | undefined): JumpEntry[] {
  const sorted = [...entries].sort(newestFirst)
  if (activeProjectId === undefined) return sorted
  const index = sorted.findIndex((e) => e.projectId === null || e.projectId === activeProjectId)
  if (index <= 0) return sorted
  const [here] = sorted.splice(index, 1)
  return [here!, ...sorted]
}

/** Opening an inbox item lands in its job or its mission: those rows would say the same thing again. */
function coveredBy(item: InboxItem): string[] {
  const keys: string[] = []
  if (item.conversationId) keys.push(`mission:${item.conversationId}`)
  if (item.action === 'open-run' || item.action === 'resume-run') keys.push(`job:${item.subjectId}`)
  return keys
}

function inboxEntry(item: InboxItem): JumpEntry {
  return { kind: 'inbox', key: `inbox:${item.id}`, id: item.id, needsYou: true, at: ms(item.at), state: inboxKindRunState(item.kind), projectId: item.projectId, title: item.title, item }
}

function missionEntry(mission: JumpMission, src: JumpSources): JumpEntry {
  const attention = src.attention.has(mission.id) ? src.attentionKinds?.get(mission.id) ?? 'decision' : null
  const unread = src.unread.has(mission.id)
  const state = missionRowRunState({ attention, streaming: src.streaming.has(mission.id), unread })
  return {
    kind: 'mission', key: `mission:${mission.id}`, id: mission.id, needsYou: attention !== null || state === 'needs-input',
    at: ms(mission.updated_at), state, projectId: mission.pinned_project_id ?? null, title: mission.title,
  }
}

function jobEntry(job: JumpJob, projectId: string | null): JumpEntry {
  return {
    kind: 'job', key: `job:${job.id}`, id: job.id, needsYou: false,
    at: ms(job.finished_at ?? job.started_at ?? job.enqueued_at), state: jobStatusLook(job.status).state, projectId, title: jobLabel(job),
  }
}

/**
 * The group, in order: what needs the person (inbox items and missions waiting
 * on them), then the most recently active missions and jobs; each tier newest
 * first with the open project's newest row in front; without a row that an earlier one
 * already leads to; at most `max`.
 */
export function buildJumpBackIn(src: JumpSources, max = JUMP_BACK_IN_MAX): JumpEntry[] {
  const taken = new Set<string>()
  const inbox = src.inbox.map(inboxEntry)
  for (const item of src.inbox) for (const key of coveredBy(item)) taken.add(key)
  const live = src.missions.filter((m) => !m.archivedAt).map((m) => missionEntry(m, src))
  const needsYou = tierOrder([...inbox, ...live.filter((e) => e.needsYou && !taken.has(e.key))], src.activeProjectId)
  for (const entry of needsYou) taken.add(entry.key)
  const recent = tierOrder([...live, ...src.jobs.map((job) => jobEntry(job, src.jobsProjectId))].filter((e) => !taken.has(e.key)), src.activeProjectId)
  const out: JumpEntry[] = []
  for (const entry of [...needsYou, ...recent]) {
    if (out.length >= Math.max(0, max)) break
    if (out.some((e) => e.key === entry.key)) continue
    out.push(entry)
  }
  return out
}

/**
 * The frozen rows with today's data: the order (and the rows) chosen when the
 * palette opened stay; state, title and project update in place. A row whose
 * subject is gone keeps its last known look (opening it falls back to the
 * regular handler of its kind).
 */
export function refreshJumpEntries(frozen: readonly JumpEntry[], src: JumpSources): JumpEntry[] {
  if (frozen.length === 0) return []
  const wanted = new Set(frozen.map((e) => e.key))
  const current = new Map<string, JumpEntry>()
  for (const item of src.inbox) if (wanted.has(`inbox:${item.id}`)) current.set(`inbox:${item.id}`, inboxEntry(item))
  for (const mission of src.missions) if (wanted.has(`mission:${mission.id}`)) current.set(`mission:${mission.id}`, missionEntry(mission, src))
  for (const job of src.jobs) if (wanted.has(`job:${job.id}`)) current.set(`job:${job.id}`, jobEntry(job, src.jobsProjectId))
  return frozen.map((e) => current.get(e.key) ?? e)
}
