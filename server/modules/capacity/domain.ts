/**
 * Run capacity: how many rail runs this machine works on at once, and why a
 * launched run waits. Pure: limits, the admission verdict and the burn
 * estimate; the queue lives in `admission.ts`, the probes in `runtime/`.
 *
 * Every launch used to start at once. On a 10-core machine, 16 equivalent runs
 * at once delivered fewer per hour than 12 (119/h against 126/h), waited 100 s
 * on average for a verification turn and stalled the server's event loop up to
 * 7 s. A run over capacity now starts as queued, says what it waits for, and
 * starts by itself when a slot frees.
 */

export const WAITING_FOR = ['run_slots', 'project_slots', 'provider_slots', 'cpu', 'memory', 'provider_quota'] as const
export type WaitingFor = typeof WAITING_FOR[number]

export interface CapacityLimits {
  /** Runs working at once on this machine (every project, every provider). */
  maxRuns: number
  /** Runs working at once in one project (they share its repository and lock). */
  maxRunsPerProject: number
  /** Runs working at once per provider account; absent = no own cap. */
  perProvider: Readonly<Record<string, number>>
  /** CPU busy fraction (0..1, every core) above which no further run starts. */
  cpuBusyLimit: number
  /** Available memory (MB) below which no further run starts; null = not checked. */
  minAvailableMemoryMb: number | null
  /** Usage-window share (percentage points) kept free for the person's own work. */
  quotaReservePercent: number
}

export interface MachineShape { cores: number; totalMemoryMb: number }

/**
 * Defaults from the parallel benchmark (10 cores, 16 GB, haiku, a CPU-bound
 * suite; 1/2/4/8/12/16 equivalent runs launched at once): deliveries per hour
 * grew up to 12 runs (126/h) and fell at 16 (119/h), when runs waited 100 s on
 * average for a verification turn and the server stalled up to 7 s. So: 1.2
 * runs per core (at least 2, at most 24), half of them in one project. The CPU
 * check only holds new starts on a machine that stays fully saturated (98 %
 * on two consecutive samples), which is mostly other work than Specrails'.
 * Memory: keep 1.5 GB free (a run with its agent, verification and Core child
 * peaked at ~0.4 GB).
 */
export function defaultCapacityLimits(machine: MachineShape): CapacityLimits {
  const cores = Number.isFinite(machine.cores) && machine.cores > 0 ? Math.floor(machine.cores) : 1
  const maxRuns = Math.max(2, Math.min(24, Math.round(cores * 1.2)))
  return {
    maxRuns,
    maxRunsPerProject: Math.max(2, Math.ceil(maxRuns / 2)),
    perProvider: {},
    cpuBusyLimit: 0.98,
    minAvailableMemoryMb: machine.totalMemoryMb >= 4096 ? 1536 : 512,
    quotaReservePercent: 5,
  }
}

const positive = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value <= 256 ? value : null
}

/**
 * Environment overrides: `SPECRAILS_MAX_ACTIVE_RUNS`, `SPECRAILS_MAX_RUNS_PER_PROJECT`,
 * `SPECRAILS_MAX_RUNS_PER_PROVIDER` (`claude=8,codex=2`). Invalid values are ignored.
 */
export function limitsFromEnv(base: CapacityLimits, env: Readonly<Record<string, string | undefined>>): CapacityLimits {
  const perProvider: Record<string, number> = { ...base.perProvider }
  for (const pair of String(env.SPECRAILS_MAX_RUNS_PER_PROVIDER ?? '').split(',')) {
    const [name, value] = pair.split('=').map(part => part?.trim())
    const cap = positive(value)
    if (name && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) && cap) perProvider[name] = cap
  }
  const maxRuns = positive(env.SPECRAILS_MAX_ACTIVE_RUNS) ?? base.maxRuns
  return { ...base, maxRuns, maxRunsPerProject: Math.min(maxRuns, positive(env.SPECRAILS_MAX_RUNS_PER_PROJECT) ?? base.maxRunsPerProject), perProvider }
}

/** `SPECRAILS_RUN_ADMISSION=off` turns admission off (every run starts at once, as before). */
export function admissionDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return /^(off|0|false|no)$/i.test(String(env.SPECRAILS_RUN_ADMISSION ?? '').trim())
}

export interface AdmissionCandidate { runId: string; projectId: string; provider: string }

export interface MachineSample {
  /** Busy fraction of every core since the previous sample (0..1); null when unknown. */
  cpuBusy: number | null
  availableMemoryMb: number | null
}

export interface QuotaSample {
  /** The provider account's highest usage-window utilization (percent), null when unknown. */
  usedPercent: number | null
  /** The account refuses requests now (a rejected window). */
  rejected: boolean
}

export type AdmissionVerdict = { admit: true } | { admit: false; waitingFor: WaitingFor }

/**
 * May `candidate` start now, given the runs already working? Caps first (they
 * never let one run more through), then the machine and the provider account.
 * The machine and quota checks never hold the FIRST run of the machine or of
 * its provider: one run always makes progress, so a busy machine or a nearly
 * used window only slows work down, it never starves it. `perRunPercent` is the
 * learned usage-window share one run of this provider costs (null = unknown).
 */
export function admissionVerdict(input: {
  candidate: AdmissionCandidate
  active: readonly AdmissionCandidate[]
  limits: CapacityLimits
  machine: MachineSample
  quota: QuotaSample
  perRunPercent: number | null
}): AdmissionVerdict {
  const { candidate, active, limits, machine, quota, perRunPercent } = input
  if (active.length >= limits.maxRuns) return { admit: false, waitingFor: 'run_slots' }
  if (active.filter(run => run.projectId === candidate.projectId).length >= limits.maxRunsPerProject) return { admit: false, waitingFor: 'project_slots' }
  const sameProvider = active.filter(run => run.provider === candidate.provider).length
  const providerCap = limits.perProvider[candidate.provider]
  if (providerCap !== undefined && sameProvider >= providerCap) return { admit: false, waitingFor: 'provider_slots' }
  if (active.length > 0) {
    if (machine.cpuBusy !== null && machine.cpuBusy >= limits.cpuBusyLimit) return { admit: false, waitingFor: 'cpu' }
    if (limits.minAvailableMemoryMb !== null && machine.availableMemoryMb !== null && machine.availableMemoryMb < limits.minAvailableMemoryMb) return { admit: false, waitingFor: 'memory' }
  }
  if (sameProvider > 0) {
    if (quota.rejected) return { admit: false, waitingFor: 'provider_quota' }
    // Never start more runs than the window can still finish: the runs working
    // now and this one, each at the learned share, must fit under the reserve.
    if (quota.usedPercent !== null && perRunPercent !== null && perRunPercent > 0
      && quota.usedPercent + (sameProvider + 1) * perRunPercent > 100 - limits.quotaReservePercent) return { admit: false, waitingFor: 'provider_quota' }
  }
  return { admit: true }
}

/**
 * One run's share of its provider's usage window: the window grew by `delta`
 * points while the run worked, shared with on average `concurrency` runs of the
 * same provider. Null when the window reset meanwhile (negative delta) or the
 * sample is meaningless.
 */
export function runBurnSample(delta: number, concurrency: number): number | null {
  if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(concurrency) || concurrency < 1) return null
  return delta / concurrency
}

/** Exponentially weighted per-run burn (alpha 0.3); the first sample seeds it. */
export function nextBurnEstimate(previous: number | null, sample: number | null): number | null {
  if (sample === null) return previous
  return previous === null ? sample : previous * 0.7 + sample * 0.3
}
