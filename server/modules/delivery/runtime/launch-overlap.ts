/**
 * Conflict-aware launches: the other rails of this project a launch will
 * likely collide with (domain/launch-overlap.ts). Peers are the rails working
 * now and the deliveries waiting for their merge; their files are the ones
 * their specs name plus, for runs that have started, the files their agents
 * actually wrote. Read-only SQLite; a failure means "no overlap known".
 */
import type { DbInstance } from '../../../db'
import type { LoopSpec } from '../../loops/runtime/loop-graph'
import { mentionedPaths, predictOverlaps, type LaunchOverlap, type OverlapPeer } from '../domain/launch-overlap'
import { listActivePrDeliveries } from './rail-pr-store'
import { getRails } from './rails-store'

const PENDING = new Set(['building', 'on_review', 'pr_draft', 'pr_ready', 'pr_failed'])
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'edit_file']

const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }

function specPaths(spec: LoopSpec | undefined): string[] {
  if (!spec) return []
  return mentionedPaths([spec.title, spec.description, ...(spec.acceptanceCriteria ?? [])].filter(Boolean).join('\n'))
}

/** Files the agents of these runs wrote, relative to their worktrees. */
export function writtenPaths(db: DbInstance, runIds: readonly string[]): string[] {
  if (!runIds.length) return []
  const rows = db.prepare(`SELECT job_id, payload FROM events WHERE job_id IN (${runIds.map(() => '?').join(',')}) AND event_type = 'agent-event' AND payload LIKE '%targetPaths%'`).all(...runIds) as Array<{ job_id: string; payload: string }>
  const out = new Set<string>()
  for (const row of rows) {
    const event = json<{ event?: { kind?: string; tool?: string; targetPaths?: unknown } }>(row.payload, {}).event
    if (event?.kind !== 'tool-start' || !WRITE_TOOLS.includes(String(event.tool)) || !Array.isArray(event.targetPaths)) continue
    for (const target of event.targetPaths) {
      // Run worktrees live at …/worktrees/<runId>/<unit>/<repository path>.
      const match = typeof target === 'string' ? new RegExp(`[\\\\/]worktrees[\\\\/]${row.job_id}[\\\\/][^\\\\/]+[\\\\/](.+)$`).exec(target) : null
      if (match && !match[1]!.split(/[\\/]/).includes('..')) out.add(match[1]!.replace(/\\/g, '/'))
    }
  }
  return [...out]
}

export function findLaunchOverlaps(input: { db: DbInstance; railIndex: number; ticketIds: readonly number[]; getTicketSpec?: (id: number) => LoopSpec | undefined }): LaunchOverlap[] {
  const { db, railIndex, getTicketSpec } = input
  try {
    const mine = input.ticketIds.flatMap((id) => specPaths(getTicketSpec?.(id)))
    if (!mine.length) return []
    const peers = new Map<number, OverlapPeer & { runIds: string[] }>()
    const peer = (rail: number, state: OverlapPeer['state'], title: string | null, tickets: number[], runIds: string[]): void => {
      if (rail === railIndex) return
      const existing = peers.get(rail)
      const paths = tickets.flatMap((id) => specPaths(getTicketSpec?.(id)))
      if (existing) { existing.runIds.push(...runIds); existing.paths = [...existing.paths, ...paths]; if (state === 'running') existing.state = 'running'; return }
      peers.set(rail, { railIndex: rail, state, title, paths, runIds: [...runIds] })
    }
    const runs = db.prepare("SELECT id, rail_index, ticket_ids_json FROM loop_runs WHERE status IN ('running','paused') AND rail_index IS NOT NULL").all() as Array<{ id: string; rail_index: number; ticket_ids_json: string | null }>
    for (const run of runs) {
      const tickets = json<number[]>(run.ticket_ids_json, []).filter((id) => Number.isInteger(id))
      peer(run.rail_index, 'running', getTicketSpec?.(tickets[0]!)?.title ?? null, tickets, [run.id])
    }
    // Rails holding specs launch now or soon: a burst of launches (Launch all) sees
    // each other before any of their runs exists.
    const deliveries = listActivePrDeliveries(db).filter((delivery) => PENDING.has(delivery.decision))
    const waitingToMerge = new Set(deliveries.filter((delivery) => delivery.decision !== 'building').map((delivery) => delivery.rail_index))
    for (const rail of getRails(db)) {
      if (rail.ticketIds.length && !waitingToMerge.has(rail.railIndex)) peer(rail.railIndex, 'running', getTicketSpec?.(rail.ticketIds[0]!)?.title ?? null, [...rail.ticketIds], [])
    }
    for (const delivery of deliveries) {
      const tickets = json<number[]>(delivery.ticket_ids, []).filter((id) => Number.isInteger(id))
      const runIds = json<unknown[]>(delivery.run_ids, []).filter((id): id is string => typeof id === 'string')
      peer(delivery.rail_index, delivery.decision === 'building' ? 'running' : 'pending', getTicketSpec?.(tickets[0]!)?.title ?? null, tickets, runIds)
    }
    const withWrites = [...peers.values()].map(({ runIds, ...rest }) => ({ ...rest, paths: [...rest.paths, ...writtenPaths(db, [...new Set(runIds)])] }))
    return predictOverlaps(mine, withWrites)
  } catch (error) {
    console.warn('[launch-overlap] unavailable:', error instanceof Error ? error.message : error)
    return []
  }
}
