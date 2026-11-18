// ─── "Jump back in": the first group of the empty command palette ─────────────
// The most recently active missions and jobs, newest first (the open project's
// newest in front), capped. What needs the person is the inbox's list, not this
// one: the palette shows a single "N things need you" row that opens it. Pure:
// the palette feeds it what its contexts already hold (no fetch of its own) and
// freezes the order for one opening (`refreshJumpEntries`).

import type { RunState } from '../ui/run-state/run-state'
import type { JobSummary } from '../../types'
import type { AgentConversation } from '../../features/missions/lib/agent-api'
import { missionRowRunState, type MissionRowSignal } from '../../features/missions/lib/mission-run-state'
import { jobStatusLook } from '../../features/jobs/lib/job-run-state'
import { parseTimestampMs } from '../../lib/relative-time'

type MissionAttentionKind = NonNullable<MissionRowSignal['attention']>

/** Rows in the group; each gets ⌘1…⌘6 (Ctrl+1… off macOS). */
export const JUMP_BACK_IN_MAX = 6

export type JumpKind = 'mission' | 'job'

interface JumpBase {
  /** `mission:<id>`, `job:<id>`: stable across refreshes. */
  key: string
  id: string
  /** Epoch ms of the last activity (NaN-safe: unknown sorts last). */
  at: number
  /** The row's lamp; null for an idle mission (the row shows the mission itself). */
  state: RunState | null
  /** The project the subject belongs to; null for a mission not pinned to one. */
  projectId: string | null
}

export type JumpEntry =
  | (JumpBase & { kind: 'mission'; title: string | null })
  | (JumpBase & { kind: 'job'; title: string })

export type JumpMission = Pick<AgentConversation, 'id' | 'title' | 'pinned_project_id' | 'updated_at'> & { archivedAt?: string | null }
export type JumpJob = Pick<JobSummary, 'id' | 'command' | 'status' | 'started_at' | 'enqueued_at' | 'finished_at'> & Partial<Pick<JobSummary, 'ticketId' | 'ticketTitle'>>

export interface JumpSources {
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
   * The open project. The newest row of this project (or of a
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
function recentOrder(entries: JumpEntry[], activeProjectId: string | null | undefined): JumpEntry[] {
  const sorted = [...entries].sort(newestFirst)
  if (activeProjectId === undefined) return sorted
  const index = sorted.findIndex((e) => e.projectId === null || e.projectId === activeProjectId)
  if (index <= 0) return sorted
  const [here] = sorted.splice(index, 1)
  return [here!, ...sorted]
}

function missionEntry(mission: JumpMission, src: JumpSources): JumpEntry {
  const attention = src.attention.has(mission.id) ? src.attentionKinds?.get(mission.id) ?? 'decision' : null
  const unread = src.unread.has(mission.id)
  const state = missionRowRunState({ attention, streaming: src.streaming.has(mission.id), unread })
  return {
    kind: 'mission', key: `mission:${mission.id}`, id: mission.id,
    at: ms(mission.updated_at), state, projectId: mission.pinned_project_id ?? null, title: mission.title,
  }
}

function jobEntry(job: JumpJob, projectId: string | null): JumpEntry {
  return {
    kind: 'job', key: `job:${job.id}`, id: job.id,
    at: ms(job.finished_at ?? job.started_at ?? job.enqueued_at), state: jobStatusLook(job.status).state, projectId, title: jobLabel(job),
  }
}

/**
 * The group: the most recently active missions (not archived) and jobs, newest
 * first with the open project's newest row in front, at most `max`. A mission
 * waiting on the person keeps its lamp; it is not moved ahead of the rest.
 */
export function buildJumpBackIn(src: JumpSources, max = JUMP_BACK_IN_MAX): JumpEntry[] {
  const live = src.missions.filter((m) => !m.archivedAt).map((m) => missionEntry(m, src))
  const recent = recentOrder([...live, ...src.jobs.map((job) => jobEntry(job, src.jobsProjectId))], src.activeProjectId)
  const out: JumpEntry[] = []
  for (const entry of recent) {
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
  for (const mission of src.missions) if (wanted.has(`mission:${mission.id}`)) current.set(`mission:${mission.id}`, missionEntry(mission, src))
  for (const job of src.jobs) if (wanted.has(`job:${job.id}`)) current.set(`job:${job.id}`, jobEntry(job, src.jobsProjectId))
  return frozen.map((e) => current.get(e.key) ?? e)
}
