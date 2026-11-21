import { describe, expect, it } from 'vitest'
import { admissionDisabled, admissionVerdict, defaultCapacityLimits, limitsFromEnv, nextBurnEstimate, runBurnSample, type AdmissionCandidate, type CapacityLimits } from '../domain'
import { createRunAdmission, type AdmissionTimers } from '../admission'
import { busyBetween, memAvailableMb } from '../runtime/machine'

const limits = (extra: Partial<CapacityLimits> = {}): CapacityLimits => ({ maxRuns: 3, maxRunsPerProject: 2, perProvider: {}, cpuBusyLimit: 0.9, minAvailableMemoryMb: 1000, quotaReservePercent: 5, ...extra })
const run = (runId: string, projectId = 'p1', provider = 'claude'): AdmissionCandidate => ({ runId, projectId, provider })
const idle = { cpuBusy: 0.2, availableMemoryMb: 8000 }
const noQuota = { usedPercent: null, rejected: false }

describe('capacity limits', () => {
  it('derives 1.2 runs per core, at least 2 and at most 24, half of them per project', () => {
    expect(defaultCapacityLimits({ cores: 10, totalMemoryMb: 16384 })).toMatchObject({ maxRuns: 12, maxRunsPerProject: 6, cpuBusyLimit: 0.98, minAvailableMemoryMb: 1536 })
    expect(defaultCapacityLimits({ cores: 1, totalMemoryMb: 2048 })).toMatchObject({ maxRuns: 2, maxRunsPerProject: 2, minAvailableMemoryMb: 512 })
    expect(defaultCapacityLimits({ cores: 64, totalMemoryMb: 131072 }).maxRuns).toBe(24)
  })

  it('reads environment overrides and ignores invalid ones', () => {
    const base = defaultCapacityLimits({ cores: 10, totalMemoryMb: 16384 })
    expect(limitsFromEnv(base, { SPECRAILS_MAX_ACTIVE_RUNS: '12', SPECRAILS_MAX_RUNS_PER_PROJECT: '20', SPECRAILS_MAX_RUNS_PER_PROVIDER: 'claude=6, codex=2,bad name=3,gemini=x' }))
      .toMatchObject({ maxRuns: 12, maxRunsPerProject: 12, perProvider: { claude: 6, codex: 2 } })
    expect(limitsFromEnv(base, { SPECRAILS_MAX_ACTIVE_RUNS: '-1' }).maxRuns).toBe(12)
    expect(admissionDisabled({ SPECRAILS_RUN_ADMISSION: 'off' })).toBe(true)
    expect(admissionDisabled({})).toBe(false)
  })
})

describe('admission verdict', () => {
  const verdict = (active: AdmissionCandidate[], candidate: AdmissionCandidate, extra: Partial<Parameters<typeof admissionVerdict>[0]> = {}) =>
    admissionVerdict({ candidate, active, limits: limits(), machine: idle, quota: noQuota, perRunPercent: null, ...extra })

  it('applies the machine, project and provider caps', () => {
    expect(verdict([run('a'), run('b', 'p2'), run('c', 'p3')], run('d', 'p4'))).toEqual({ admit: false, waitingFor: 'run_slots' })
    expect(verdict([run('a'), run('b')], run('c'))).toEqual({ admit: false, waitingFor: 'project_slots' })
    expect(verdict([run('a')], run('b', 'p2', 'codex'), { limits: limits({ perProvider: { codex: 1 } }) })).toEqual({ admit: true })
    expect(verdict([run('a', 'p1', 'codex')], run('b', 'p2', 'codex'), { limits: limits({ perProvider: { codex: 1 } }) })).toEqual({ admit: false, waitingFor: 'provider_slots' })
  })

  it('holds new starts on a saturated machine but never the first run', () => {
    expect(verdict([run('a')], run('b', 'p2'), { machine: { cpuBusy: 0.97, availableMemoryMb: 8000 } })).toEqual({ admit: false, waitingFor: 'cpu' })
    expect(verdict([run('a')], run('b', 'p2'), { machine: { cpuBusy: 0.3, availableMemoryMb: 600 } })).toEqual({ admit: false, waitingFor: 'memory' })
    expect(verdict([], run('a'), { machine: { cpuBusy: 1, availableMemoryMb: 10 } })).toEqual({ admit: true })
    expect(verdict([run('a')], run('b', 'p2'), { machine: { cpuBusy: null, availableMemoryMb: null } })).toEqual({ admit: true })
  })

  it('never starts more runs than the usage window can still finish, and none into a refusing account', () => {
    // 80 % used, 4 points per run: the running one and this one need 8 → 88 ≤ 95.
    expect(verdict([run('a')], run('b', 'p2'), { quota: { usedPercent: 80, rejected: false }, perRunPercent: 4 })).toEqual({ admit: true })
    // 88 % used: 88 + 2 × 4 = 96 > 95.
    expect(verdict([run('a')], run('b', 'p2'), { quota: { usedPercent: 88, rejected: false }, perRunPercent: 4 })).toEqual({ admit: false, waitingFor: 'provider_quota' })
    expect(verdict([run('a')], run('b', 'p2'), { quota: { usedPercent: 10, rejected: true } })).toEqual({ admit: false, waitingFor: 'provider_quota' })
    // Another provider's account is not this run's: its first run always starts.
    expect(verdict([run('a')], run('b', 'p2', 'codex'), { quota: { usedPercent: 99, rejected: false }, perRunPercent: 4 })).toEqual({ admit: true })
  })

  it('learns the per-run share of the window from runs that overlapped', () => {
    expect(runBurnSample(6, 3)).toBe(2)
    expect(runBurnSample(-40, 1)).toBeNull()
    expect(nextBurnEstimate(null, 2)).toBe(2)
    expect(nextBurnEstimate(2, 4)).toBeCloseTo(2.6)
    expect(nextBurnEstimate(2, null)).toBe(2)
  })
})

describe('admission queue', () => {
  function harness(initial: Partial<CapacityLimits> = {}) {
    let clock = 0
    const machine = { ...idle }
    const quota = { usedPercent: null as number | null, rejected: false }
    const ticks: Array<() => void> = []
    const timers: AdmissionTimers = { setInterval: (fn) => { ticks.push(fn); return fn }, clearInterval: (fn) => { ticks.splice(ticks.indexOf(fn as () => void), 1) } }
    const events: string[] = []
    const admission = createRunAdmission({ limits: () => limits(initial), machine: () => machine, quota: () => quota, now: () => clock, timers,
      onChange: (event) => events.push(`${event.type}:${event.run.runId}${event.type === 'queued' ? `:${event.waitingFor}:${event.position}` : ''}`) })
    return { admission, machine, quota, events, tick: () => ticks.forEach(fn => fn()), advance: (ms: number) => { clock += ms }, ticking: () => ticks.length }
  }

  it('queues runs over capacity in launch order and starts them as slots free', async () => {
    const h = harness()
    const a = await h.admission.acquire(run('a'))
    await h.admission.acquire(run('b', 'p2'))
    await h.admission.acquire(run('c', 'p3'))
    const waits: string[] = []
    const d = h.admission.acquire(run('d', 'p4'), { onWait: (why, position) => waits.push(`${why}:${position}`) })
    const e = h.admission.acquire(run('e', 'p5'))
    expect(h.admission.waiting('d')).toMatchObject({ waitingFor: 'run_slots', position: 1 })
    expect(h.admission.waiting('e')).toMatchObject({ position: 2 })
    expect(waits).toEqual(['run_slots:1'])
    a()
    await d
    expect(h.admission.waiting('d')).toBeNull()
    expect(h.admission.waiting('e')).toMatchObject({ position: 1 })
    expect(h.events).toContain('admitted:d')
    a() // idempotent: releasing twice frees one slot only
    expect(h.admission.waiting('e')).not.toBeNull()
    void e
  })

  it('lets a later run of another project pass one blocked by its own project cap', async () => {
    const h = harness({ maxRuns: 4 })
    await h.admission.acquire(run('a'))
    await h.admission.acquire(run('b'))
    const c = h.admission.acquire(run('c'))
    const d = await h.admission.acquire(run('d', 'p2'))
    expect(typeof d).toBe('function')
    expect(h.admission.waiting('c')).toMatchObject({ waitingFor: 'project_slots' })
    void c
  })

  it('re-evaluates the machine while runs wait and stops the timer when the queue empties', async () => {
    const h = harness()
    await h.admission.acquire(run('a'))
    h.machine.cpuBusy = 0.99
    const b = h.admission.acquire(run('b', 'p2'))
    expect(h.admission.waiting('b')).toMatchObject({ waitingFor: 'cpu' })
    expect(h.ticking()).toBe(1)
    h.machine.cpuBusy = 0.5
    h.tick()
    await b
    expect(h.ticking()).toBe(0)
  })

  it('counts a run that switched provider against the new provider, freeing the old provider slot', async () => {
    const h = harness({ maxRuns: 4, perProvider: { codex: 1, claude: 1 } })
    await h.admission.acquire(run('a', 'p1', 'codex'))
    // A second codex run waits for the codex slot; a claude run would start.
    const b = h.admission.acquire(run('b', 'p2', 'codex'))
    expect(h.admission.waiting('b')).toMatchObject({ waitingFor: 'provider_slots' })
    // Run a hit codex's limit and continues on claude: b gets the codex slot, and claude is now taken.
    h.admission.reassign('a', 'claude')
    await b
    expect(h.admission.snapshot().active.map(entry => `${entry.runId}:${entry.provider}`)).toEqual(['a:claude', 'b:codex'])
    const c = h.admission.acquire(run('c', 'p3', 'claude'))
    expect(h.admission.waiting('c')).toMatchObject({ waitingFor: 'provider_slots' })
    h.admission.reassign('missing', 'claude')
    void c
  })

  it('stops waiting when the run is cancelled, and lets the next one through', async () => {
    const h = harness({ maxRuns: 1 })
    const a = await h.admission.acquire(run('a'))
    const stop = new AbortController()
    const b = h.admission.acquire(run('b', 'p2'), { signal: stop.signal })
    const c = h.admission.acquire(run('c', 'p3'))
    stop.abort()
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.admission.waiting('c')).toMatchObject({ position: 1 })
    a()
    await c
    expect(h.events).toContain('left:b')
  })

  it('learns the provider burn from the window growth of overlapping runs', async () => {
    const h = harness()
    h.quota.usedPercent = 10
    const a = await h.admission.acquire(run('a'))
    const b = await h.admission.acquire(run('b', 'p2'))
    h.advance(60_000)
    h.quota.usedPercent = 14
    a(); b()
    // Each saw +4 points while two runs shared the window: 2 points per run.
    expect(h.admission.snapshot().perRunPercent.claude).toBeCloseTo(2)
  })
})

describe('machine sampling', () => {
  it('reads the busy fraction from tick deltas and Linux available memory', () => {
    expect(busyBetween({ idle: 100, total: 200 }, { idle: 125, total: 300 })).toBeCloseTo(0.75)
    expect(busyBetween({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBeNull()
    expect(memAvailableMb('MemTotal: 16000000 kB\nMemAvailable:    2048000 kB\n')).toBe(2000)
    expect(memAvailableMb('nothing')).toBeNull()
  })
})
