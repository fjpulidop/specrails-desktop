import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, getActiveProject, requireProject } from './types'
import { McpToolError, toolResponse, type NextCall } from './envelope'

/**
 * `specrails_resources`: CPU and memory of everything Specrails launched —
 * app-wide by category (`GET /api/resources`) or one mission's process trees,
 * recorded history and worktree disk (`GET /projects/:id/missions/:chatId/resources`).
 * Read-only; never starts a disk scan.
 */

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown memory'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

const cpu = (value: number | null) => value === null ? '?% CPU' : `${Math.round(value)}% CPU`

function totalsOf(value: unknown) {
  const totals = record(value)
  return { cpuPercent: num(totals.cpuPercent), memoryBytes: num(totals.memoryBytes), processCount: num(totals.processCount) }
}

async function appResources(ctx: McpToolContext, top: number): Promise<unknown> {
  const data = record(await apiCall(ctx, 'GET', '/resources'))
  const totals = totalsOf(data.totals)
  const categories = rows(data.categories)
    .map((category) => ({
      id: category.id, ...totalsOf(category),
      items: rows(category.items).sort((a, b) => (num(b.cpuPercent) ?? 0) - (num(a.cpuPercent) ?? 0)).slice(0, top).map((item) => ({
        label: item.label, projectId: item.projectId ?? null, projectName: item.projectName ?? null,
        ...(item.chatId ? { conversationId: item.chatId } : {}), ...(item.runId ? { runId: item.runId } : {}), ...totalsOf(item),
      })),
      itemCount: rows(category.items).length,
    }))
    .filter((category) => (category.processCount ?? 0) > 0 || category.itemCount > 0)
  const heaviest = [...categories].sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))[0]
  const mission = categories.find((category) => category.id === 'missions')?.items.find((item) => 'conversationId' in item) as Row | undefined
  const next: NextCall[] = mission?.conversationId
    ? [{ tool: 'specrails_resources', args: { conversationId: mission.conversationId, ...(mission.projectId ? { projectId: mission.projectId } : {}) }, why: `Process trees and worktree disk of “${String(mission.label || 'the mission')}”.` }]
    : []
  return toolResponse({ scope: 'app', supported: data.supported !== false, measuredAt: data.measuredAt ?? null, totals, categories }, {
    summary: data.supported === false
      ? 'Resource usage is not available on this platform (the process table could not be read).'
      : `Everything Specrails launched uses ${cpu(totals.cpuPercent)} and ${formatBytes(totals.memoryBytes)} across ${totals.processCount ?? '?'} processes.${heaviest ? ` Most memory: ${String(heaviest.id)} (${formatBytes(heaviest.memoryBytes)}).` : ''}`,
    status: data.supported === false ? 'unsupported' : 'ok',
    next,
  })
}

async function missionResources(ctx: McpToolContext, conversationId: string, projectId: string | undefined, top: number): Promise<unknown> {
  let project = projectId
  if (!project) {
    try {
      const conversation = record(record(await apiCall(ctx, 'GET', `/agent/conversations/${encodeURIComponent(conversationId)}`)).conversation)
      if (typeof conversation.pinned_project_id === 'string') project = conversation.pinned_project_id
    } catch { /* fall back to the active project */ }
  }
  project ??= getActiveProject(ctx) ?? undefined
  if (!project) throw new McpToolError('ambiguous', 'This mission is not pinned to a project; pass projectId.')
  const { project: row } = requireProject(ctx, project)
  const data = record(await apiCall(ctx, 'GET', `/projects/${encodeURIComponent(row.id)}/missions/${encodeURIComponent(conversationId)}/resources`))
  const totals = totalsOf(data.totals)
  const entries = rows(data.entries).sort((a, b) => (num(b.cpuPercent) ?? 0) - (num(a.cpuPercent) ?? 0))
  const history = rows(data.history)
  const worktree = data.worktree && typeof data.worktree === 'object' ? record(data.worktree) : null
  const disk = worktree ? record(worktree.disk) : null
  const diskBytes = disk ? num(disk.bytes) ?? num(disk.sizeBytes) : null
  return toolResponse({
    scope: 'mission', conversationId, projectId: row.id, supported: data.supported !== false, sampledAt: data.sampledAt ?? null,
    totals, entries: entries.slice(0, top), entryCount: entries.length,
    history: history.slice(-20), historyPoints: history.length,
    worktree,
  }, {
    summary: data.supported === false
      ? 'Resource usage is not available on this platform.'
      : `This mission uses ${cpu(totals.cpuPercent)} and ${formatBytes(totals.memoryBytes)} across ${totals.processCount ?? entries.length} processes.${worktree ? ` Its worktree is ${diskBytes === null ? 'not measured yet' : formatBytes(diskBytes)} on disk.` : ''}`,
    status: data.supported === false ? 'unsupported' : 'ok',
    ids: { conversationId, projectId: row.id },
    next: [{ tool: 'specrails_missions', args: { action: 'get', conversationId }, why: 'What the mission is doing.' }],
  })
}

export function resourcesTools(): McpToolSpec[] {
  return [{
    name: 'specrails_resources',
    title: 'Resource usage',
    description:
      'CPU and memory of everything Specrails launched (missions, rails, background processes, terminals, agent CLIs, MCP, git, the server), by category with the heaviest items; with conversationId, one mission\'s process trees, recorded history and worktree disk. Read-only.',
    tier: 'read',
    inputSchema: {
      conversationId: z.string().min(1).max(200).optional().describe('A mission conversation id; omit for the app-wide view'),
      projectId: z.string().optional().describe('With conversationId: its project (defaults to the mission pin)'),
      top: z.number().int().min(1).max(50).optional().describe('Heaviest items per category / process entries (default 5)'),
    },
    async handler(ctx, args) {
      const top = typeof args.top === 'number' ? args.top : 5
      return typeof args.conversationId === 'string'
        ? missionResources(ctx, args.conversationId, args.projectId as string | undefined, top)
        : appResources(ctx, top)
    },
  }]
}
