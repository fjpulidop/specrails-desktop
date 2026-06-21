// Writes `.specrails/backlog-config.json` so specrails-core treats the
// materialized `local-tickets.json` as a plain LOCAL backlog it READS but never
// mutates. This is the mechanism that keeps core at ZERO changes:
//   - provider:"local"  → core reads `.specrails/local-tickets.json` (the cache).
//   - write_access:false → core's implement pipeline enters its read-only branch
//     and never mutates ticket status nor talks to Jira; Desktop's
//     applyJobOutcomeToTickets + the Jira outbox are the sole status authority.
//
// We deliberately write provider:"local" (NOT "jira") so core never authenticates
// to Jira — Desktop is the only thing that holds the credential.

import fs from 'fs'
import path from 'path'

export interface BacklogConfig {
  provider: string
  write_access: boolean
  git_auto: boolean
}

export function backlogConfigPath(projectPath: string): string {
  return path.join(projectPath, '.specrails', 'backlog-config.json')
}

export function readBacklogConfig(projectPath: string): BacklogConfig | null {
  try {
    const raw = fs.readFileSync(backlogConfigPath(projectPath), 'utf-8')
    return JSON.parse(raw) as BacklogConfig
  } catch {
    return null
  }
}

/** Idempotently write the Jira-mode backlog config (local provider, read-only). */
export function writeJiraBacklogConfig(projectPath: string): void {
  const target = backlogConfigPath(projectPath)
  const desired: BacklogConfig = { provider: 'local', write_access: false, git_auto: false }
  const existing = readBacklogConfig(projectPath)
  if (
    existing &&
    existing.provider === desired.provider &&
    existing.write_access === desired.write_access &&
    existing.git_auto === desired.git_auto
  ) {
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(desired, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/**
 * Restore write access (used when hot-swapping a project back to local specs, so
 * core can manage the local backlog normally again).
 */
export function writeLocalBacklogConfig(projectPath: string): void {
  const target = backlogConfigPath(projectPath)
  const desired: BacklogConfig = { provider: 'local', write_access: true, git_auto: false }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(desired, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}
