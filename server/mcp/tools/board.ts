import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, requireProject } from './types'
import { toolResponse, type NextCall } from './envelope'
import { boardColumnsText, readBoardColumns, type BoardColumn } from './specs'

/**
 * `specrails_board`: one project's board in one read — backlog columns with
 * counts and their newest items, every rail with what it holds and what runs on
 * it, and the job queue. Three independent loopback reads; a failing one marks
 * the answer `partial` and names itself in `sources`.
 */

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

export interface BoardRail {
  railIndex: number
  label: string
  availability: string | null
  ticketIds: number[]
  running: Row | null
  delivery: Row | null
}

export interface BoardSnapshot {
  projectId: string
  projectName: string
  columns: BoardColumn[]
  total: number
  rails: BoardRail[]
  running: Row[]
  queue: { queued: number; paused: boolean; activeJobId: string | null } | null
  partial: boolean
  sources: Record<string, string>
}

async function attempt<T>(sources: Record<string, string>, name: string, read: () => Promise<T>): Promise<T | null> {
  try {
    const value = await read()
    sources[name] = 'ok'
    return value
  } catch (err) {
    sources[name] = err instanceof Error ? err.message.slice(0, 160) : 'failed'
    return null
  }
}

export function railsOnBoard(data: Row): BoardRail[] {
  const activeJobs = record(data.activeJobs)
  const activeRuns = record(data.activeLoopRuns)
  const deliveries = record(data.prDeliveries)
  return rows(data.rails).map((rail) => {
    const index = Number(rail.railIndex)
    const job = record(activeJobs[index])
    const run = record(activeRuns[index])
    const delivery = record(deliveries[index])
    const running = str(job.jobId)
      ? { kind: 'job', jobId: job.jobId, mode: job.mode ?? null }
      : str(run.loopRunId)
        ? { kind: 'loop', jobId: run.loopRunId, loop: run.loopName ?? run.loopId ?? null, provider: run.provider ?? null, model: run.model ?? null, startedAt: run.startedAt ?? null }
        : null
    return {
      railIndex: index,
      label: str(rail.name) ?? `Rail ${index + 1}`,
      availability: str(rail.availability),
      ticketIds: Array.isArray(rail.ticketIds) ? rail.ticketIds.filter((id): id is number => typeof id === 'number') : [],
      running,
      delivery: str(delivery.id) ? { id: delivery.id, decision: delivery.decision ?? null, prUrl: delivery.prUrl ?? null, ticketIds: delivery.ticketIds ?? [] } : null,
    }
  })
}

export async function collectBoard(ctx: McpToolContext, projectId: string | undefined, options: { perColumn?: number } = {}): Promise<BoardSnapshot> {
  const { project } = requireProject(ctx, projectId)
  const base = `/projects/${encodeURIComponent(project.id)}`
  const sources: Record<string, string> = {}
  const [board, railsData, queueData] = await Promise.all([
    attempt(sources, 'backlog', () => readBoardColumns(ctx, base, { perColumn: options.perColumn })),
    attempt(sources, 'rails', async () => record(await apiCall(ctx, 'GET', `${base}/rails`))),
    attempt(sources, 'queue', async () => record(await apiCall(ctx, 'GET', `${base}/queue`))),
  ])
  const rails = railsData ? railsOnBoard(railsData) : []
  const railJobIds = new Set(rails.map((rail) => rail.running?.jobId).filter(Boolean))
  const queueJobs = rows(queueData?.jobs)
  const running: Row[] = [
    ...rails.filter((rail) => rail.running).map((rail) => ({ railIndex: rail.railIndex, rail: rail.label, ...rail.running })),
    ...queueJobs.filter((job) => job.status === 'running' && !railJobIds.has(job.id)).map((job) => ({ kind: 'job', jobId: job.id, command: job.command ?? null })),
  ]
  return {
    projectId: project.id,
    projectName: project.name,
    columns: board?.columns ?? [],
    total: board?.total ?? 0,
    rails,
    running,
    queue: queueData ? {
      queued: queueJobs.filter((job) => job.status === 'queued').length,
      paused: queueData.paused === true,
      activeJobId: str(queueData.activeJobId),
    } : null,
    partial: Object.values(sources).some((status) => status !== 'ok'),
    sources,
  }
}

export function boardSummary(board: BoardSnapshot): string {
  const free = board.rails.filter((rail) => rail.availability === 'free').length
  const review = board.rails.filter((rail) => rail.delivery?.decision === 'on_review').length
  const failed = board.rails.filter((rail) => /failed/.test(String(rail.delivery?.decision ?? ''))).length
  const deliveries = `${review ? `, ${review} awaiting review` : ''}${failed ? `, ${failed} failed deliver${failed === 1 ? 'y' : 'ies'} awaiting a decision` : ''}`
  const parts = [
    board.sources.backlog === 'ok' ? `${board.total} specs (${boardColumnsText(board.columns)})` : 'backlog unavailable',
    board.sources.rails === 'ok' ? `${board.rails.length} rails, ${board.running.length ? `${board.running.length} running` : 'nothing running'}, ${free} free${deliveries}` : 'rails unavailable',
    board.queue && board.queue.queued ? `${board.queue.queued} queued${board.queue.paused ? ' (queue paused)' : ''}` : board.queue?.paused ? 'queue paused' : null,
  ].filter(Boolean)
  return `${board.projectName}: ${parts.join('; ')}.`
}

export function boardNext(board: BoardSnapshot): NextCall[] {
  const scope = { projectId: board.projectId }
  const next: NextCall[] = []
  const review = board.rails.find((rail) => rail.delivery?.decision === 'on_review')
  const failed = board.rails.find((rail) => /failed/.test(String(rail.delivery?.decision ?? '')))
  if (review?.delivery) next.push({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: review.delivery.id, ...scope }, why: `${review.label} has a delivery waiting for review.` })
  else if (failed?.delivery) next.push({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: failed.delivery.id, ...scope }, why: `Why the delivery on ${failed.label} failed, before deciding on it.` })
  const work = board.running[0]
  if (work?.jobId) next.push({ tool: 'specrails_watch', args: { ref: work.jobId, ...scope }, why: 'Wait for the running work to settle.' })
  const todo = board.columns.find((column) => column.status === 'todo')?.top[0]
  if (todo?.id !== undefined && next.length < 3) next.push({ tool: 'specrails_specs', args: { action: 'get', id: todo.id, ...scope }, why: 'Read the newest todo spec before proposing a launch.' })
  return next.slice(0, 3)
}

export function boardTools(): McpToolSpec[] {
  return [{
    name: 'specrails_board',
    title: 'Project board',
    description:
      'One project\'s board in one read: backlog columns (draft → cancelled) with counts and the newest items of each, every rail with its label, availability, specs, what runs on it and any delivery, and the job queue. Read-only; sources fail independently (partial:true).',
    tier: 'read',
    inputSchema: {
      projectId: z.string().optional().describe('Project id (defaults to the active project)'),
      perColumn: z.number().int().min(0).max(20).optional().describe('Newest items per column (default 5)'),
    },
    async handler(ctx, args) {
      const board = await collectBoard(ctx, args.projectId as string | undefined, { perColumn: args.perColumn as number | undefined })
      return toolResponse(board, {
        summary: boardSummary(board),
        ids: { projectId: board.projectId },
        next: boardNext(board),
        ...(board.partial ? { partial: true } : {}),
      })
    },
  }]
}
