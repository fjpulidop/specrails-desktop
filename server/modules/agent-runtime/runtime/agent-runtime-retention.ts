/** Pure retention policy. The host supplies authoritative settlement/disposal
 * evidence under an execution reservation; UI dismissal is not disposal. */
export interface RuntimeRetentionPolicy {
  /** null preserves history indefinitely. Zero-day deletion is not supported. */
  days: number | null
}
export interface RuntimeRetentionEvidence {
  runId: string
  disposition: 'settled' | 'discarded' | 'recoverable'
  terminalAt: string | null
  active: boolean
  humanPending: boolean
  interruptedWrites: boolean
  deliveryPending: boolean
  forkPending: boolean
}
export type RuntimeRetentionReason = 'disabled' | 'recoverable' | 'active' | 'human_pending' | 'interrupted_writes' | 'delivery_pending' | 'fork_pending' | 'unknown_terminal_time' | 'within_retention'
export interface RuntimeRetentionDecision { runId: string; collect: boolean; reasons: RuntimeRetentionReason[] }
const DAY_MS = 86_400_000
export function validateRuntimeRetentionPolicy(value: unknown): RuntimeRetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'days')) throw new Error('Retention policy requires only days')
  const days = (value as RuntimeRetentionPolicy).days
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) throw new Error('Retention days must be null or an integer from 1 to 3650')
  return { days }
}
export function runtimeRetentionDecision(evidence: RuntimeRetentionEvidence, policy: RuntimeRetentionPolicy, now: number): RuntimeRetentionDecision {
  validateRuntimeRetentionPolicy(policy)
  if (!Number.isFinite(now)) throw new Error('Retention requires a valid clock')
  const reasons: RuntimeRetentionReason[] = []
  if (policy.days === null) reasons.push('disabled')
  if (evidence.disposition !== 'settled' && evidence.disposition !== 'discarded') reasons.push('recoverable')
  if (evidence.active !== false) reasons.push('active')
  if (evidence.humanPending !== false) reasons.push('human_pending')
  if (evidence.interruptedWrites !== false) reasons.push('interrupted_writes')
  if (evidence.deliveryPending !== false) reasons.push('delivery_pending')
  if (evidence.forkPending !== false) reasons.push('fork_pending')
  const at = evidence.terminalAt === null ? NaN : Date.parse(evidence.terminalAt)
  if (!Number.isFinite(at) || at > now) reasons.push('unknown_terminal_time')
  else if (policy.days !== null && now - at < policy.days * DAY_MS) reasons.push('within_retention')
  return { runId: evidence.runId, collect: reasons.length === 0, reasons }
}

export interface RuntimeRetentionReservation {
  evidence: RuntimeRetentionEvidence
  /** Moves only the reserved runtime journal into recoverable owned quarantine. */
  quarantine(): Promise<{ token: string }>
  /** Durable expiration record; also makes future host resumes/forks reject. */
  expire(token: string): Promise<void>
  /** Called only when expiration failed; restores the original journal location. */
  restore(token: string): Promise<void>
  /** Idempotent physical deletion after expiration is durable. */
  remove(token: string): Promise<void>
  release(): void
}
export interface RuntimeRetentionPorts {
  /** Run IDs are scoped by the host, never user-supplied filesystem paths. */
  runIds(): Promise<string[]>
  /** Reserves against resume/fork/settlement and reads fresh Core/host evidence. */
  reserve(runId: string): Promise<RuntimeRetentionReservation | null>
  /** Owns its package lock and rescans all surviving pins before deletion. */
  collectUnreferencedPackages(dryRun: boolean): Promise<string[]>
}
export interface RuntimeRetentionReport {
  dryRun: boolean
  runs: Array<RuntimeRetentionDecision & { state: 'protected' | 'eligible' | 'expired' | 'cleanup_pending' | 'busy' | 'error'; error?: string }>
  packages: string[]
  errors: string[]
}

/** Failure boundaries are intentional: never delete before durable expiration,
 * never resurrect an expired run when cleanup fails, and never collect packages
 * after a run boundary whose integrity could not be established. */
export async function collectRuntimeRetention(ports: RuntimeRetentionPorts, policy: RuntimeRetentionPolicy, options: { dryRun: boolean; now: number }): Promise<RuntimeRetentionReport> {
  validateRuntimeRetentionPolicy(policy)
  const report: RuntimeRetentionReport = { dryRun: options.dryRun, runs: [], packages: [], errors: [] }
  let packageCollectionSafe = true
  for (const runId of [...new Set(await ports.runIds())]) {
    if (policy.days === null) { report.runs.push({ runId, collect: false, reasons: ['disabled'], state: 'protected' }); continue }
    let reservation: RuntimeRetentionReservation | null = null
    try {
      reservation = await ports.reserve(runId)
      if (!reservation) { report.runs.push({ runId, collect: false, reasons: [], state: 'busy' }); continue }
      if (reservation.evidence.runId !== runId) throw new Error('Retention reservation identity changed')
      const decision = runtimeRetentionDecision(reservation.evidence, policy, options.now)
      if (!decision.collect || options.dryRun) {
        report.runs.push({ ...decision, state: decision.collect ? 'eligible' : 'protected' }); continue
      }
      const { token } = await reservation.quarantine()
      try { await reservation.expire(token) }
      catch (error) {
        await reservation.restore(token)
        throw error
      }
      try { await reservation.remove(token); report.runs.push({ ...decision, state: 'expired' }) }
      catch (error) {
        // Restart recovery retries only deletion, never original-run execution.
        report.runs.push({ ...decision, state: 'cleanup_pending', error: error instanceof Error ? error.message : 'Runtime cleanup failed' })
        packageCollectionSafe = false
      }
    } catch (error) {
      packageCollectionSafe = false
      report.runs.push({ runId, collect: false, reasons: [], state: 'error', error: error instanceof Error ? error.message : 'Runtime retention failed' })
    } finally { reservation?.release() }
  }
  if (packageCollectionSafe && policy.days !== null) {
    try { report.packages = await ports.collectUnreferencedPackages(options.dryRun) }
    catch (error) { report.errors.push(error instanceof Error ? error.message : 'Package collection failed') }
  }
  return report
}
