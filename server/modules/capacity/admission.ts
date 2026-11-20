/**
 * The machine's run admission queue (one per server process, shared by every
 * project). A run asks for a slot before Core starts working on it; over
 * capacity it waits in launch order, with the reason it waits, and starts by
 * itself when a slot frees or the machine/quota allows it again. A run blocked
 * only by its own project or provider never blocks a later run of another one.
 *
 * Effects are injected (limits, machine and quota samples, timers, clock), so
 * the queue is tested without a machine. It keeps run ids, project ids and
 * provider names only: machine accounting, never project data.
 */
import { admissionVerdict, nextBurnEstimate, runBurnSample, type AdmissionCandidate, type CapacityLimits, type MachineSample, type QuotaSample, type WaitingFor } from './domain'

export interface AdmissionTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface RunAdmissionDeps {
  limits: () => CapacityLimits
  machine: () => MachineSample
  quota: (provider: string) => QuotaSample
  now?: () => number
  timers?: AdmissionTimers
  /** Re-evaluation period while runs wait (machine and quota change on their own). */
  pollMs?: number
  /** A queued run's wait reason changed, it started, or it left the queue. */
  onChange?: (event: QueueEvent) => void
}

export type QueueEvent =
  | { type: 'queued'; run: AdmissionCandidate; waitingFor: WaitingFor; position: number }
  | { type: 'admitted'; run: AdmissionCandidate; waitedMs: number }
  | { type: 'left'; run: AdmissionCandidate }

export interface QueuedRun { run: AdmissionCandidate; waitingFor: WaitingFor; since: number; position: number }

export interface AcquireOptions {
  signal?: AbortSignal
  /** Called once when the run has to wait, and again whenever its reason changes. */
  onWait?: (waitingFor: WaitingFor, position: number) => void
}

export type ReleaseSlot = () => void

interface Waiter { run: AdmissionCandidate; since: number; waitingFor: WaitingFor; resolve: (release: ReleaseSlot) => void; reject: (error: Error) => void; onWait?: AcquireOptions['onWait'] }
interface Active { run: AdmissionCandidate; since: number; quotaAtStart: number | null; concurrencyMs: number; lastMark: number }

export class AdmissionAbortedError extends Error {
  constructor() { super('The run was stopped while it waited for capacity'); this.name = 'AbortError' }
}

export function createRunAdmission(deps: RunAdmissionDeps) {
  const now = deps.now ?? Date.now
  const timers: AdmissionTimers = deps.timers ?? { setInterval: (fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle }, clearInterval: handle => clearInterval(handle as NodeJS.Timeout) }
  const active = new Map<string, Active>()
  const queue: Waiter[] = []
  const burn = new Map<string, number | null>()
  let ticker: unknown = null

  const emit = (event: QueueEvent): void => { try { deps.onChange?.(event) } catch { /* advisory */ } }
  const sameProviderCount = (provider: string): number => [...active.values()].filter(entry => entry.run.provider === provider).length

  /** Advance each active run's "runs of my provider working with me" integral. */
  const markConcurrency = (): void => {
    const at = now()
    for (const entry of active.values()) {
      entry.concurrencyMs += Math.max(0, at - entry.lastMark) * sameProviderCount(entry.run.provider)
      entry.lastMark = at
    }
  }

  const start = (run: AdmissionCandidate): ReleaseSlot => {
    markConcurrency()
    const at = now()
    active.set(run.runId, { run, since: at, quotaAtStart: safeQuota(run.provider).usedPercent, concurrencyMs: 0, lastMark: at })
    let released = false
    return () => {
      if (released) return
      released = true
      const entry = active.get(run.runId)
      if (!entry) return
      markConcurrency()
      active.delete(run.runId)
      const used = safeQuota(run.provider).usedPercent
      const worked = now() - entry.since
      if (entry.quotaAtStart !== null && used !== null && worked > 0) {
        burn.set(run.provider, nextBurnEstimate(burn.get(run.provider) ?? null, runBurnSample(used - entry.quotaAtStart, entry.concurrencyMs / worked)))
      }
      pump()
    }
  }

  const safeQuota = (provider: string): QuotaSample => { try { return deps.quota(provider) } catch { return { usedPercent: null, rejected: false } } }
  const safeMachine = (): MachineSample => { try { return deps.machine() } catch { return { cpuBusy: null, availableMemoryMb: null } } }

  const verdictFor = (run: AdmissionCandidate, machine: MachineSample) => admissionVerdict({
    candidate: run, active: [...active.values()].map(entry => entry.run), limits: deps.limits(), machine, quota: safeQuota(run.provider), perRunPercent: burn.get(run.provider) ?? null,
  })

  /** Admit every waiter that fits, in launch order; refresh the others' reasons. */
  const pump = (): void => {
    const machine = safeMachine()
    let position = 0
    for (let index = 0; index < queue.length;) {
      const waiter = queue[index]!
      const verdict = verdictFor(waiter.run, machine)
      if (verdict.admit) {
        queue.splice(index, 1)
        emit({ type: 'admitted', run: waiter.run, waitedMs: now() - waiter.since })
        waiter.resolve(start(waiter.run))
        // A CPU sample predates this start: admit at most one run per pump on a machine check.
        if (machine.cpuBusy !== null && queue.length) break
        continue
      }
      position++
      if (verdict.waitingFor !== waiter.waitingFor) {
        waiter.waitingFor = verdict.waitingFor
        try { waiter.onWait?.(verdict.waitingFor, position) } catch { /* advisory */ }
        emit({ type: 'queued', run: waiter.run, waitingFor: verdict.waitingFor, position })
      }
      index++
    }
    if (queue.length && ticker === null) ticker = timers.setInterval(pump, deps.pollMs ?? 2_000)
    if (!queue.length && ticker !== null) { timers.clearInterval(ticker); ticker = null }
  }

  return {
    /**
     * Take a run slot, waiting in launch order when the machine is at capacity.
     * Rejects with an `AbortError` when `signal` aborts while waiting.
     */
    acquire(run: AdmissionCandidate, options: AcquireOptions = {}): Promise<ReleaseSlot> {
      if (options.signal?.aborted) return Promise.reject(new AdmissionAbortedError())
      const existing = active.get(run.runId)
      if (existing) return Promise.resolve(() => {})
      if (!queue.length) {
        const verdict = verdictFor(run, safeMachine())
        if (verdict.admit) return Promise.resolve(start(run))
      }
      return new Promise<ReleaseSlot>((resolve, reject) => {
        const waiter: Waiter = { run, since: now(), waitingFor: 'run_slots', resolve, reject, onWait: options.onWait }
        const initial = verdictFor(run, safeMachine())
        waiter.waitingFor = initial.admit ? 'run_slots' : initial.waitingFor
        queue.push(waiter)
        const position = queue.length
        try { options.onWait?.(waiter.waitingFor, position) } catch { /* advisory */ }
        emit({ type: 'queued', run, waitingFor: waiter.waitingFor, position })
        options.signal?.addEventListener('abort', () => {
          const index = queue.indexOf(waiter)
          if (index < 0) return
          queue.splice(index, 1)
          emit({ type: 'left', run })
          reject(new AdmissionAbortedError())
          pump()
        }, { once: true })
        pump()
      })
    },
    /**
     * The run continues on another provider (a switch at a usage limit): from now on its slot
     * counts against that provider's slots and quota. The old provider's burn sample closes
     * here; the new provider's starts from its current usage.
     */
    reassign(runId: string, provider: string): void {
      const entry = active.get(runId)
      if (!entry || entry.run.provider === provider) return
      markConcurrency()
      const at = now(), used = safeQuota(entry.run.provider).usedPercent, worked = at - entry.since
      if (entry.quotaAtStart !== null && used !== null && worked > 0) {
        burn.set(entry.run.provider, nextBurnEstimate(burn.get(entry.run.provider) ?? null, runBurnSample(used - entry.quotaAtStart, entry.concurrencyMs / worked)))
      }
      active.set(runId, { run: { ...entry.run, provider }, since: at, quotaAtStart: safeQuota(provider).usedPercent, concurrencyMs: 0, lastMark: at })
      pump()
    },
    /** Why a run waits, or null when it is not queued. */
    waiting(runId: string): QueuedRun | null {
      const index = queue.findIndex(waiter => waiter.run.runId === runId)
      if (index < 0) return null
      const waiter = queue[index]!
      return { run: waiter.run, waitingFor: waiter.waitingFor, since: waiter.since, position: index + 1 }
    },
    snapshot() {
      return {
        limits: deps.limits(),
        active: [...active.values()].map(entry => ({ ...entry.run, since: entry.since })),
        queued: queue.map((waiter, index) => ({ ...waiter.run, waitingFor: waiter.waitingFor, since: waiter.since, position: index + 1 })),
        perRunPercent: Object.fromEntries(burn),
      }
    },
    /** Re-evaluate now (a quota or limits change). */
    poke: pump,
    dispose(): void {
      if (ticker !== null) timers.clearInterval(ticker)
      ticker = null
    },
  }
}

export type RunAdmission = ReturnType<typeof createRunAdmission>
