import { createHash } from 'node:crypto'
import type { DbInstance } from '../../../db/types'
import { createAgentAuditRecorder, createAgentAuditService, type AgentAuditRecorder, type AgentAuditService } from '../application'
import { DEFAULT_AGENT_AUDIT_RETENTION_DAYS } from '../domain'
import { createSqliteAgentActionStore } from './sqlite'

export const AGENT_AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** One project's audit runtime: recorder (batched writer), queries, retention. */
export interface ProjectAgentAudit {
  recorder: AgentAuditRecorder
  service: AgentAuditService
  /** Run retention now. Never throws; returns the number of rows deleted (0 on failure). */
  pruneNow(): number
  /** Flush pending rows and stop timers. Call BEFORE closing the connection. */
  dispose(): void
}

/**
 * Compose the audit runtime for a single project connection. Retention runs
 * shortly after startup and then daily, reading the project setting each time
 * so a change applies without a restart. Timers are unref'd.
 */
export function createProjectAgentAudit(db: DbInstance, options: {
  retentionDays: () => number | null | undefined
  label?: string
  startupDelayMs?: number
  intervalMs?: number
  autoStartRetention?: boolean
}): ProjectAgentAudit {
  const store = createSqliteAgentActionStore(db)
  const recorder = createAgentAuditRecorder({ store, hash: sha256 })
  const service = createAgentAuditService({ store, recorder })
  const label = options.label ? ` for ${options.label}` : ''
  const pruneNow = (): number => {
    try {
      const days = options.retentionDays() ?? DEFAULT_AGENT_AUDIT_RETENTION_DAYS
      const removed = service.prune(days)
      if (removed > 0) console.log(`[agent-audit] retention removed ${removed} action(s)${label} (older than ${days} day(s))`)
      return removed
    } catch (error) {
      console.warn(`[agent-audit] retention failed${label}: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }
  const timers: Array<ReturnType<typeof setTimeout>> = []
  let interval: ReturnType<typeof setInterval> | null = null
  if (options.autoStartRetention !== false) {
    const startup = setTimeout(pruneNow, options.startupDelayMs ?? 5_000)
    startup.unref?.()
    timers.push(startup)
    interval = setInterval(pruneNow, options.intervalMs ?? AGENT_AUDIT_RETENTION_INTERVAL_MS)
    interval.unref?.()
  }
  return {
    recorder,
    service,
    pruneNow,
    dispose() {
      for (const timer of timers.splice(0)) clearTimeout(timer)
      if (interval) { clearInterval(interval); interval = null }
      recorder.dispose()
    },
  }
}
