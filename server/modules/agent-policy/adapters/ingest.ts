/**
 * Placing a spooled denial (see `spool.ts`) in a project's agent actions audit.
 *
 * - Mission cwd denials are skipped: mission turns (legacy and Core) always
 *   carry tool results, so their stream already recorded them.
 * - A run worktree is matched to its rail run through `rail_worktrees`; the
 *   row is recorded unless the run's stream already recorded the same denial.
 * - Anything else waits (`retry`) until the spool's max age drops it.
 */
import path from 'path'
import type { DbInstance } from '../../../db/types'
import { recordPolicyDenial, redactCommand, type AgentAuditRecorder, type AgentAuditService } from '../../audit'
import type { DenialReport } from '../domain/report'
import type { DenialIngestResult } from './spool'

export interface DenialIngestProject {
  db: DbInstance
  audit: { recorder: Pick<AgentAuditRecorder, 'record'>; service: Pick<AgentAuditService, 'hasPolicyDenial'> } | null | undefined
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function runForWorktree(db: DbInstance, worktree: string): string | null {
  try {
    const row = db.prepare(
      'SELECT run_id FROM rail_worktrees WHERE worktree_path = ? AND run_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
    ).get(worktree) as { run_id?: string } | undefined
    return row?.run_id ?? null
  } catch {
    return null
  }
}

export function createDenialIngest(deps: {
  missionCwd: () => string
  projects: () => DenialIngestProject[]
  realpath?: (p: string) => string
}): (report: DenialReport) => DenialIngestResult {
  const realpath = deps.realpath ?? ((p: string) => p)
  return (report) => {
    const dirs = [...new Set([report.projectDir, realpath(report.projectDir)])]
    const missionCwd = deps.missionCwd()
    if (dirs.some((dir) => inside(dir, missionCwd) || inside(dir, realpath(missionCwd)))) return 'done'
    for (const project of deps.projects()) {
      if (!project.audit) continue
      const runId = dirs.map((dir) => runForWorktree(project.db, dir)).find((id): id is string => !!id)
      if (!runId) continue
      if (!project.audit.service.hasPolicyDenial(runId, report.rule, report.at)) {
        const input = report.tool.toLowerCase() === 'bash' ? { command: redactCommand(report.target) } : { file_path: report.target }
        recordPolicyDenial(project.audit.recorder, { runId, role: 'agent' }, { rule: report.rule, reason: report.reason }, { name: report.tool, input })
      }
      return 'done'
    }
    return 'retry'
  }
}
