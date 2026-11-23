import type { CrashMarker, ReportSources } from './domain'

/** Gathers the raw material of a problem report (IO lives in adapters/runtime). */
export type ReportCollector = () => Promise<Omit<ReportSources, 'createdAtMs'>>

/**
 * Crash markers written by the desktop host and the server's acknowledgement.
 * `available` is false outside the desktop app (no host log folder).
 */
export interface CrashMarkerStore {
  readonly available: boolean
  list(): CrashMarker[]
  acknowledgedThrough(): number
  acknowledge(throughMs: number): void
}
