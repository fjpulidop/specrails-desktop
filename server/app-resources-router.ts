import type { Router } from 'express'
import type { DbInstance } from './db'
import type { ProjectRegistry } from './project-registry'
import { listBackgroundProcesses } from './transient-children'
import { getAgentChatManager } from './modules/missions/runtime/agent-chat-registry'
import type { AppResourceRoot } from './modules/terminals/domain/app-resources'
import type { ProcessSample } from './modules/terminals/domain/mission-resources'
import { createAppResourcesSampler } from './modules/terminals/runtime/app-resources'
import { cacheProcessTableReader, createProcessTableReader, type ProcessTableReader } from './modules/terminals/runtime/resource-sampler'
import { getTerminalManager } from './modules/terminals/runtime/terminal-manager'
import { attributeListeners, type AttributedListener, type RunPortLease } from './modules/terminals/domain/run-ports'
import { listeningPorts, type ListenerReader } from './modules/terminals/runtime/listening-ports'
import { runPortLeases } from './modules/terminals/runtime/run-port-leases'
import { listRailWorktrees } from './modules/delivery/runtime/rail-worktrees-store'
import fs from 'node:fs'

type Registry = Pick<ProjectRegistry, 'listContexts' | 'getProjectRow' | 'desktopDb'>

const LIVE_BACKGROUND = new Set(['starting', 'running', 'stopping'])

function titleOf(db: DbInstance | undefined, table: 'chat_conversations' | 'agent_conversations', id: string): { title: string | null; pinned: string | null } {
  try {
    if (table === 'agent_conversations') {
      const row = db?.prepare('SELECT title, pinned_project_id FROM agent_conversations WHERE id = ?').get(id) as { title: string | null; pinned_project_id: string | null } | undefined
      return { title: row?.title ?? null, pinned: row?.pinned_project_id ?? null }
    }
    const row = db?.prepare('SELECT title FROM chat_conversations WHERE id = ?').get(id) as { title: string | null } | undefined
    return { title: row?.title ?? null, pinned: null }
  } catch {
    return { title: null, pinned: null }
  }
}

/** Every process tree with a known owner, in attribution priority: agent sessions, rails/loops/jobs, background
 * processes, terminals. */
export function listAppResourceRoots(registry: Registry, table: ProcessSample[]): AppResourceRoot[] {
  const roots: AppResourceRoot[] = []
  const projectName = (id: string | null | undefined) => (id ? registry.getProjectRow(id)?.name : undefined)

  const agents = getAgentChatManager()
  for (const chatId of agents?.activeConversationIds() ?? []) {
    const { title, pinned } = titleOf(registry.desktopDb, 'agent_conversations', chatId)
    for (const pid of agents?.getProcessPids(chatId, table) ?? []) {
      roots.push({ category: 'missions', label: title ?? '', pid, chatId, projectId: pinned ?? undefined, projectName: projectName(pinned) })
    }
  }
  for (const c of registry.listContexts()) {
    for (const chatId of c.chatManager.activeConversationIds()) {
      const { title } = titleOf(c.db, 'chat_conversations', chatId)
      for (const pid of c.chatManager.getProcessPids(chatId)) {
        roots.push({ category: 'missions', label: title ?? '', pid, chatId, projectId: c.project.id, projectName: c.project.name })
      }
    }
  }
  // Rails, loops and queued jobs: the run's own child (a step spawn or the Core definition runtime, whose
  // children are the provider CLIs) and the queue's job processes.
  for (const c of registry.listContexts()) {
    for (const run of c.loopRunManager?.listProcessRoots?.() ?? []) {
      roots.push({ category: 'rails', label: run.label, pid: run.pid, projectId: c.project.id, projectName: c.project.name, runId: run.runId })
    }
    for (const job of c.queueManager?.listProcessRoots?.() ?? []) {
      roots.push({ category: 'rails', label: job.label, pid: job.pid, projectId: c.project.id, projectName: c.project.name, runId: job.jobId })
    }
  }
  for (const p of listBackgroundProcesses()) {
    if (!LIVE_BACKGROUND.has(p.status)) continue
    roots.push({ category: 'background', label: p.command, pid: p.pid, chatId: p.chatId || undefined, projectId: p.projectId, projectName: projectName(p.projectId) })
  }
  for (const t of getTerminalManager().listProcessRoots()) {
    roots.push({ category: 'terminals', label: t.name, pid: t.pid, projectId: t.projectId, projectName: projectName(t.projectId) })
  }
  return roots
}

/** `GET /api/resources`: read-only, app-wide view of what everything Specrails launched consumes. */
/** The rail run a worktree belongs to, for labels. */
export interface RunPortRun {
  projectId: string
  projectName: string
  railIndex: number
  ticketId: number
  branch: string
  runId: string | null
}

export interface RunPortsSnapshot {
  /** False when listeners cannot be read on this platform; leases are still listed. */
  supported: boolean
  scannedAt: number
  ports: Array<Omit<AttributedListener, 'owner'> & { worktreePath: string | null; assigned: { start: number; end: number } | null; run: RunPortRun | null }>
  leases: Array<{ worktreePath: string; start: number; end: number; run: RunPortRun | null }>
}

function canonicalPath(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return value }
}

/** Rail runs by canonical worktree path, across open projects (only the leased paths). */
function runsByWorktree(registry: Registry, leases: readonly RunPortLease[]): Map<string, RunPortRun> {
  const wanted = new Set(leases.map((lease) => lease.worktreePath))
  const out = new Map<string, RunPortRun>()
  if (wanted.size === 0) return out
  for (const c of registry.listContexts()) {
    let rows: ReturnType<typeof listRailWorktrees> = []
    try { rows = listRailWorktrees(c.db) } catch { continue }
    for (const row of rows) {
      const key = wanted.has(row.worktree_path) ? row.worktree_path : canonicalPath(row.worktree_path)
      if (!wanted.has(key)) continue
      // Newest row wins: a revision may reuse the mount.
      out.set(key, { projectId: c.project.id, projectName: c.project.name, railIndex: row.rail_index, ticketId: row.ticket_id, branch: row.branch, runId: row.run_id })
    }
  }
  return out
}

/** Listening ports of run worktrees: what each run serves, and who squats a run's block. */
export async function snapshotRunPorts(registry: Registry, readListeners: ListenerReader, readProcessTable: ProcessTableReader): Promise<RunPortsSnapshot> {
  const leases = runPortLeases.list()
  const [scan, table] = await Promise.all([readListeners(), readProcessTable()])
  const runs = runsByWorktree(registry, leases)
  const owners = leases.map((lease) => ({ worktreePath: lease.worktreePath, lease }))
  const ports = attributeListeners(scan.listeners, table, owners).map(({ owner, ...listener }) => ({
    ...listener,
    worktreePath: owner?.worktreePath ?? null,
    assigned: owner?.lease ? { start: owner.lease.start, end: owner.lease.end } : null,
    run: owner ? runs.get(owner.worktreePath) ?? null : null,
  }))
  return {
    supported: scan.supported,
    scannedAt: scan.scannedAt,
    ports,
    leases: leases.map((lease) => ({ worktreePath: lease.worktreePath, start: lease.start, end: lease.end, run: runs.get(lease.worktreePath) ?? null })),
  }
}

export function registerAppResourceRoutes(router: Router, registry: Registry, options: { readProcessTable?: ProcessTableReader; serverPid?: number; listRoots?: (table: ProcessSample[]) => AppResourceRoot[]; readListeners?: ListenerReader } = {}): void {
  const readProcessTable = options.readProcessTable ?? cacheProcessTableReader(createProcessTableReader())
  const readListeners = options.readListeners ?? (() => listeningPorts.read())
  router.get('/resources/ports', async (_req, res) => {
    try {
      res.json(await snapshotRunPorts(registry, readListeners, readProcessTable))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'ports unavailable' })
    }
  })
  const sampler = createAppResourcesSampler({
    readProcessTable,
    listRoots: options.listRoots ?? ((table) => listAppResourceRoots(registry, table)),
    serverPid: options.serverPid,
  })
  router.get('/resources', async (_req, res) => {
    try {
      res.json(await sampler.snapshot())
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'resources unavailable' })
    }
  })
}
