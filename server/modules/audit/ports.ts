import type { AgentActionCounts, AgentActionRecord, AgentActionRow } from './domain'

/** Outbound persistence contract owned by the audit application. One store is
 * bound to one project connection; it never sees another project's rows. */
export interface AgentActionStore {
  /** Insert a batch atomically. A failure leaves no partial batch. */
  insertMany(rows: readonly AgentActionRow[]): void
  /** Rows of one run (run_id or job_id), oldest first. */
  listByRun(runId: string, limit: number): AgentActionRecord[]
  /** Rows inside an optional [from, to] ISO window, oldest first. */
  listWindow(window: { from?: string; to?: string; limit: number }): AgentActionRecord[]
  /** Per-kind counts across runs (run_id or job_id match). */
  countByKind(runIds: readonly string[]): AgentActionCounts
  /** Delete rows strictly older than the cutoff; returns the number deleted. */
  deleteBefore(cutoffIso: string): number
}
