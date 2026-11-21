/**
 * Server side of the hook's disk spool (`<specrails home>/.specrails/agent-policy/denials/`).
 *
 * Most denials reach the audit through the run's own stream (the blocked
 * call's hook-error result). Core's role executor does not forward tool
 * results, so for those runs the spool is the only record. The drain waits a
 * short grace period (streams record first), hands each report to `ingest`,
 * and deletes it once ingested. Reports nobody can place are kept for an hour
 * (the run may register late), then dropped. Never throws.
 */
import fs from 'fs'
import path from 'path'
import { resolveSpecrailsHome } from '../../../util/specrails-home'
import { DENIAL_SPOOL_DIR, parseDenialReport, type DenialReport } from '../domain/report'
import { policyHookDir } from './install'

export const DENIAL_SPOOL_GRACE_MS = 20_000
export const DENIAL_SPOOL_MAX_AGE_MS = 60 * 60 * 1000
const DEFAULT_INTERVAL_MS = 15_000

/** `done`: recorded or deliberately skipped; `retry`: no run found yet. */
export type DenialIngestResult = 'done' | 'retry'

export interface DenialSpoolOptions {
  dir?: string
  ingest: (report: DenialReport) => DenialIngestResult
  now?: () => number
}

export function denialSpoolDir(specrailsHome: string = resolveSpecrailsHome()): string {
  return path.join(policyHookDir(specrailsHome), DENIAL_SPOOL_DIR)
}

/** Process the spool once. Returns how many reports were ingested. */
export function drainDenialSpool(options: DenialSpoolOptions): number {
  const dir = options.dir ?? denialSpoolDir()
  const now = (options.now ?? Date.now)()
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let ingested = 0
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const file = path.join(dir, name)
    try {
      const age = now - fs.statSync(file).mtimeMs
      if (age < DENIAL_SPOOL_GRACE_MS) continue
      const report = parseDenialReport(fs.readFileSync(file, 'utf8'))
      const result = report ? options.ingest(report) : 'done'
      if (result === 'done' || age > DENIAL_SPOOL_MAX_AGE_MS) fs.unlinkSync(file)
      if (report && result === 'done') ingested++
    } catch (error) {
      console.warn(`[agent-policy] denial spool entry ${name} skipped: ${(error as Error).message}`)
    }
  }
  return ingested
}

/** Drain on an interval (unref'd). */
export function startDenialSpool(options: DenialSpoolOptions & { intervalMs?: number }): { stop(): void } {
  const timer = setInterval(() => drainDenialSpool(options), options.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
