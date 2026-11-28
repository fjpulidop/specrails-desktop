import { API_ORIGIN } from '../../../lib/origin'
import { requestJson } from '../../../lib/api-response'

export type MissionResourceKind = 'agent-session' | 'background-process' | 'mission-activity' | 'mobile-device' | 'mobile-build' | 'tapflow-service'

export interface MissionResourceEntry {
  id: string
  kind: MissionResourceKind
  label: string
  pid: number
  running: boolean
  cpuPercent: number
  memoryBytes: number
  processCount: number
}

export type WorktreeDiskState =
  | { status: 'not-scanned' }
  | { status: 'scanning'; startedAt: number }
  | { status: 'done'; bytes: number; scannedAt: number }
  | { status: 'failed'; error: string; scannedAt: number }

/** One recorded point of a mission's history (recorded by the server while the mission works). */
export interface ResourceSample { at: number; cpuPercent: number; memoryBytes: number; processCount: number }

export interface MissionResourcesSnapshot {
  sampledAt: number
  supported: boolean
  entries: MissionResourceEntry[]
  totals: { cpuPercent: number; memoryBytes: number; processCount: number }
  /** Oldest first. Absent from servers that predate history recording. */
  history?: ResourceSample[]
  worktree: { path: string; disk: WorktreeDiskState } | null
}

const base = (projectId: string, chatId: string) =>
  `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/missions/${encodeURIComponent(chatId)}/resources`

export async function getMissionResources(projectId: string, chatId: string, signal?: AbortSignal): Promise<MissionResourcesSnapshot> {
  const data = await requestJson<MissionResourcesSnapshot>(base(projectId, chatId), { signal })
  if (!data || !Array.isArray(data.entries) || !data.totals) throw new Error('Invalid mission resources snapshot')
  return data
}

export async function startWorktreeScan(projectId: string, chatId: string, signal?: AbortSignal): Promise<WorktreeDiskState> {
  const data = await requestJson<{ disk: WorktreeDiskState }>(`${base(projectId, chatId)}/worktree-scan`, { method: 'POST', signal })
  return data.disk
}
