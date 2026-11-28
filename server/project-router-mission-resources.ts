import type { ProjectRoutesDeps } from './project-router-helpers'
import type { ProjectContext } from './project-registry'
import { listBackgroundProcesses } from './transient-children'
import { getAgentChatManager } from './modules/missions/runtime/agent-chat-registry'
import { missionTapflowRoots, missionsWithRunningMobileTests, withDeviceFootprints } from './modules/tapflow'
import {
  findWorktreeRoots, measureRoots, totalEntries,
  type MissionResourceEntry, type MissionResourceRoot, type MissionResourceTotals, type ProcessSample,
} from './modules/terminals/domain/mission-resources'
import { createDiskScanner, createProcessTableReader, readDiskUsage } from './modules/terminals/runtime/resource-sampler'
import {
  createMissionResourceHistoryStore, createMissionResourceRecorder,
  type MissionResourceHistoryStore,
} from './modules/terminals/runtime/mission-resource-history'
import type { DbInstance } from './db'

/** History points sent with each snapshot: enough for the popover chart. */
const HISTORY_POINTS = 300

const stores = new WeakMap<DbInstance, MissionResourceHistoryStore>()
/** One store (prepared statements) per project database; the key is the project's own connection. */
function historyStore(db: DbInstance): MissionResourceHistoryStore {
  let store = stores.get(db)
  if (!store) { store = createMissionResourceHistoryStore(db); stores.set(db, store) }
  return store
}

/** Called by desktop composition after permanent removal, for every open project. */
export function deleteMissionResourceHistory(c: ProjectContext, conversationId: string): void {
  historyStore(c.db).delete(conversationId)
}

/** Live attribution follows the current pin; retained history does not. */
function ownsMission(c: ProjectContext, chatId: string): boolean {
  const mission = c.desktopDb?.prepare('SELECT pinned_project_id FROM agent_conversations WHERE id = ?').get(chatId) as { pinned_project_id: string | null } | undefined
  return !mission || mission.pinned_project_id === c.project.id
}

function worktreeOf(c: ProjectContext, chatId: string): string | null {
  if (!ownsMission(c, chatId)) return null
  try { return c.flow?.getByConversation(chatId)?.worktreePath ?? null } catch { return null }
}

/** Everything the mission owns in `table`: its agent session, registered background processes and anything
 * launched in its worktree (sub-agents, jobs, tools). */
function measureMission(c: ProjectContext, chatId: string, table: ProcessSample[]): { entries: MissionResourceEntry[]; totals: MissionResourceTotals; worktreePath: string | null } {
  if (!ownsMission(c, chatId)) return { entries: [], totals: totalEntries([]), worktreePath: null }
  // Its mobile tests first (the device it launched, the build in progress, the Tapflow service): the first
  // root that reaches a process claims it, and a build in an Intent worktree would read as mission activity.
  const roots: MissionResourceRoot[] = [...missionTapflowRoots(c.db, chatId, table)]
  const agentPids = new Set([...c.chatManager.getProcessPids(chatId), ...(getAgentChatManager()?.getProcessPids(chatId, table) ?? [])])
  for (const pid of agentPids) roots.push({ id: `agent-session:${pid}`, kind: 'agent-session', label: 'Agent session', pid })
  for (const p of listBackgroundProcesses({ projectId: c.project.id, chatId })) {
    if (p.observed) continue // a mobile test: measured above as such
    roots.push({ id: `background-process:${p.processId}`, kind: 'background-process', label: p.command, pid: p.pid })
  }
  const worktreePath = worktreeOf(c, chatId)
  if (worktreePath) roots.push(...findWorktreeRoots(table, worktreePath, { windows: process.platform === 'win32' }))
  const entries = measureRoots(table, roots)
  return { entries, totals: totalEntries(entries), worktreePath }
}

/**
 * Starts the project's resource recorder: while a mission works it samples the mission's totals on a fixed
 * cadence and persists them, so the Resources popover shows the whole run even after a reload or restart.
 * Owned by the project context; the returned handle stops it with the project.
 */
export function startMissionResourceRecording(c: ProjectContext): { stop(): void } {
  const readProcessTable = createProcessTableReader()
  const store = historyStore(c.db)
  const localConversation = c.db.prepare('SELECT 1 FROM chat_conversations WHERE id = ?')
  const desktopConversation = c.desktopDb.prepare('SELECT 1 FROM agent_conversations WHERE id = ?')
  // Do not filter by pin or deleted_at: moved missions and restorable trash keep history.
  const conversationExists = (id: string) => !!localConversation.get(id) || !!desktopConversation.get(id)
  store.prune(conversationExists)
  const recorder = createMissionResourceRecorder({
    store,
    conversationExists,
    // The agent chat manager is shared by every project: keep only this project's conversations.
    listActiveConversations: () => [...new Set([...c.chatManager.activeConversationIds(), ...(getAgentChatManager()?.activeConversationIds(c.project.id) ?? []), ...missionsWithRunningMobileTests(c.db)])],
    measure: async (conversationId) => {
      const raw = await readProcessTable()
      const table = raw ? withDeviceFootprints(raw) : null
      return table && ownsMission(c, conversationId) ? measureMission(c, conversationId, table).totals : null
    },
  })
  recorder.start()
  return { stop: () => recorder.stop() }
}

/** Read-only per-mission resource view: live CPU/memory by owned process tree, its recorded history,
 * worktree disk on demand. */
export function registerMissionResourceRoutes({ router, ctx }: ProjectRoutesDeps): void {
  const disk = createDiskScanner((dir) => readDiskUsage(dir))
  const readProcessTable = createProcessTableReader()

  const chatIdOf = (value: string) => value.trim()

  router.get('/:projectId/missions/:chatId/resources', async (req, res) => {
    const c = ctx(req)
    const chatId = chatIdOf(req.params.chatId)
    if (!chatId) { res.status(400).json({ error: 'chatId is required' }); return }
    // Simulators by physical footprint, as the app-wide view (RSS counts their shared memory per process).
    const raw = await readProcessTable()
    const table = raw ? withDeviceFootprints(raw) : null
    const measured = table ? measureMission(c, chatId, table) : null
    const worktreePath = measured?.worktreePath ?? worktreeOf(c, chatId)
    const entries = measured?.entries ?? []
    res.json({
      sampledAt: Date.now(),
      supported: table !== null,
      entries,
      totals: measured?.totals ?? totalEntries(entries),
      history: historyStore(c.db).list(chatId, HISTORY_POINTS),
      worktree: worktreePath ? { path: worktreePath, disk: disk.get(`${c.project.id}:${chatId}`) } : null,
    })
  })

  router.post('/:projectId/missions/:chatId/resources/worktree-scan', (req, res) => {
    const c = ctx(req)
    const chatId = chatIdOf(req.params.chatId)
    const worktreePath = chatId ? worktreeOf(c, chatId) : null
    if (!worktreePath) { res.status(404).json({ error: 'this mission has no worktree to measure' }); return }
    res.status(202).json({ disk: disk.start(`${c.project.id}:${chatId}`, worktreePath) })
  })
}
