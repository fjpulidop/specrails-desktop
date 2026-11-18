import { API_ORIGIN } from '../../../lib/origin'
import { requestJson } from '../../../lib/api-response'

/** The rail run a worktree belongs to (labels only). */
export interface RunPortRun {
  projectId: string
  projectName: string
  railIndex: number
  ticketId: number
  branch: string
  runId: string | null
}

/** How the owner was established: the listener's working folder, its command line, or neither. */
export type PortAttributionConfidence = 'cwd' | 'command' | 'none'

export interface RunPort {
  port: number
  host: string
  pid: number | null
  command: string | null
  cwd: string | null
  confidence: PortAttributionConfidence
  /** The port sits in a run's assigned block but belongs to another process. */
  squatting: boolean
  worktreePath: string | null
  assigned: { start: number; end: number } | null
  run: RunPortRun | null
}

/** `GET /api/resources/ports`: listening ports of run worktrees and the blocks they were assigned. */
export interface RunPortsSnapshot {
  supported: boolean
  scannedAt: number
  ports: RunPort[]
  leases: Array<{ worktreePath: string; start: number; end: number; run: RunPortRun | null }>
}

export async function getRunPorts(signal?: AbortSignal): Promise<RunPortsSnapshot> {
  const body = await requestJson<RunPortsSnapshot | null>(`${API_ORIGIN}/api/resources/ports`, { signal })
  if (!body || !Array.isArray(body.ports) || !Array.isArray(body.leases)) throw new Error('Invalid ports snapshot')
  return body
}
