import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  prepareMilestoneChunks,
  launchMilestoneChunk,
  isRailIdle,
  milestoneLabel,
} from '../lib/milestone-launch'

// ─── Sequential milestone launch (user decision 2026-07-22) ──────────────────
//
// "Launch Milestone" in SEQUENTIAL mode launches chunk 1 immediately and
// chains each remaining chunk when the PREVIOUS chunk's rail SETTLES (run
// finished — its specs park at on_review; PR decisions are NOT waited on).
// The plan is persisted to localStorage so a page refresh resumes the chain;
// a chunk-launch failure stops the remaining chain (never skips ahead).
// Settle detection polls GET /rails: a rail is settled when it has been
// OBSERVED busy at least once and is now absent from activeJobs/activeLoopRuns.

const STORAGE_KEY = 'specrails-desktop:milestone-sequential-plans'
const POLL_MS = 10_000
export const MILESTONE_LAUNCH_MODE_KEY = 'specrails-desktop:milestone-launch-mode'

export type MilestoneLaunchMode = 'sequential' | 'parallel'

export function readMilestoneLaunchMode(): MilestoneLaunchMode {
  try {
    return localStorage.getItem(MILESTONE_LAUNCH_MODE_KEY) === 'parallel' ? 'parallel' : 'sequential'
  } catch {
    return 'sequential'
  }
}

export function saveMilestoneLaunchMode(mode: MilestoneLaunchMode): void {
  try { localStorage.setItem(MILESTONE_LAUNCH_MODE_KEY, mode) } catch { /* ignore */ }
}

export interface SequentialPlan {
  projectId: string
  milestone: number
  chunks: number[][]
  /** Index of the NEXT chunk to launch. */
  nextChunk: number
  /** Rail index of the chunk currently running (null = about to launch next). */
  currentRailIndex: number | null
  /** The current rail has been observed busy at least once (settle guard). */
  observedBusy: boolean
  launchedTickets: number
}

interface SequencerContextValue {
  /** Start a sequential milestone launch. Returns false when nothing to launch. */
  startSequential: (projectId: string, milestone: number) => Promise<boolean>
  /** The active plan for a project (drives optional UI affordances). */
  planFor: (projectId: string) => SequentialPlan | null
}

const MilestoneSequencerContext = createContext<SequencerContextValue | null>(null)

function loadPlans(): SequentialPlan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as SequentialPlan[] : []
    return Array.isArray(parsed) ? parsed.filter((p) => p && Array.isArray(p.chunks)) : []
  } catch {
    return []
  }
}

function savePlans(plans: SequentialPlan[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)) } catch { /* ignore */ }
}

// MODULE-level tick mutex: StrictMode double-mounts (and any overlapping
// provider instances) must never run two concurrent ticks — a duplicated tick
// would double-launch a chunk. localStorage is the AUTHORITATIVE plan store;
// React state only mirrors it for `planFor` consumers.
let _ticking = false

export function MilestoneSequencerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('builder')
  const [plans, setPlans] = useState<SequentialPlan[]>(() => loadPlans())
  const plansRef = useRef(plans)
  plansRef.current = plans

  const updatePlans = useCallback((next: SequentialPlan[]) => {
    setPlans(next)
    savePlans(next)
  }, [])

  const launchNext = useCallback(async (plan: SequentialPlan): Promise<SequentialPlan | null> => {
    const chunk = plan.chunks[plan.nextChunk]
    const result = await launchMilestoneChunk(
      plan.projectId, plan.milestone, chunk, plan.nextChunk, plan.chunks.length,
    )
    if (!result.ok) {
      toast.error(t('sequential.chunkFailed', {
        milestone: milestoneLabel(plan.milestone),
        chunk: plan.nextChunk + 1,
        total: plan.chunks.length,
      }), { description: result.detail ?? result.reason })
      return null // stop the chain — never skip ahead past a failed chunk
    }
    toast.success(t('sequential.chunkLaunched', {
      milestone: milestoneLabel(plan.milestone),
      chunk: plan.nextChunk + 1,
      total: plan.chunks.length,
    }))
    return {
      ...plan,
      nextChunk: plan.nextChunk + 1,
      currentRailIndex: result.railIndex,
      observedBusy: false,
      launchedTickets: plan.launchedTickets + chunk.length,
    }
  }, [t])

  // The chain driver: one poll tick advances every active plan.
  useEffect(() => {
    if (plans.length === 0) return
    const tick = async () => {
      if (_ticking) return
      _ticking = true
      try {
        // Storage is authoritative — a stale StrictMode twin or a pre-refresh
        // provider may have advanced the plan after this instance rendered.
        const current = loadPlans()
        const next: SequentialPlan[] = []
        let changed = false
        for (const plan of current) {
          if (plan.currentRailIndex === null) {
            // Resume path (refresh mid-plan before a rail was recorded).
            const advanced = await launchNext(plan)
            changed = true
            if (advanced && advanced.nextChunk <= advanced.chunks.length) next.push(advanced)
            continue
          }
          const idle = await isRailIdle(plan.projectId, plan.currentRailIndex)
          if (idle === null) { next.push(plan); continue } // transient fetch failure
          if (!idle) {
            if (!plan.observedBusy) { changed = true; next.push({ ...plan, observedBusy: true }) }
            else next.push(plan)
            continue
          }
          // Idle: only trust it as SETTLED once the rail was seen busy (the
          // spawn is async — right after launch the maps may not list it yet).
          if (!plan.observedBusy) { next.push(plan); continue }
          changed = true
          if (plan.nextChunk >= plan.chunks.length) {
            toast.success(t('sequential.done', {
              milestone: milestoneLabel(plan.milestone),
              count: plan.launchedTickets,
            }))
            continue // plan complete — drop it
          }
          const advanced = await launchNext(plan)
          if (advanced) next.push(advanced)
        }
        if (changed || next.length !== current.length) updatePlans(next)
      } finally {
        _ticking = false
      }
    }
    const timer = setInterval(() => { void tick() }, POLL_MS)
    void tick()
    return () => clearInterval(timer)
  }, [plans.length, launchNext, updatePlans, t])

  const startSequential = useCallback(async (projectId: string, milestone: number): Promise<boolean> => {
    if (loadPlans().some((p) => p.projectId === projectId && p.milestone === milestone)) {
      return true // already chaining this milestone
    }
    const prepared = await prepareMilestoneChunks(projectId, milestone)
    if (!prepared) return false
    const seed: SequentialPlan = {
      projectId,
      milestone,
      chunks: prepared.chunks,
      nextChunk: 0,
      currentRailIndex: null,
      observedBusy: false,
      launchedTickets: 0,
    }
    const advanced = await launchNext(seed)
    if (!advanced) return false
    if (advanced.nextChunk >= advanced.chunks.length) {
      // Single-chunk milestone: nothing to chain — behaves like today.
      toast.success(t('sequential.done', { milestone: milestoneLabel(milestone), count: advanced.launchedTickets }))
      return true
    }
    updatePlans([...loadPlans(), advanced])
    return true
  }, [launchNext, updatePlans, t])

  const planFor = useCallback(
    (projectId: string) => plansRef.current.find((p) => p.projectId === projectId) ?? null,
    [],
  )

  const value = useMemo(() => ({ startSequential, planFor }), [startSequential, planFor])
  return <MilestoneSequencerContext.Provider value={value}>{children}</MilestoneSequencerContext.Provider>
}

const NOOP: SequencerContextValue = {
  startSequential: async () => false,
  planFor: () => null,
}

export function useMilestoneSequencer(): SequencerContextValue {
  return useContext(MilestoneSequencerContext) ?? NOOP
}
