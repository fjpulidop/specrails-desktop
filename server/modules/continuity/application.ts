import {
  offerStillValid, promoteMarkers, stampShutdown,
  emptyContinuityState,
  type ContinuityState, type InterruptTrigger, type MissionView, type RunRef, type TurnMarker,
} from './domain'
import type { ContinuityStore } from './ports'

/** How long an "update" shutdown intent stays valid (the restart follows it within seconds). */
export const SHUTDOWN_INTENT_TTL_MS = 5 * 60_000

export interface TurnContinuityDeps {
  store: ContinuityStore
  /** The mission as it is now (null: unknown). */
  mission: (conversationId: string) => MissionView | null
  /** Rail/loop runs running right now (read at a graceful shutdown). */
  runningRuns?: () => RunRef[]
  now?: () => number
  log?: (message: string) => void
}

export interface ResumeOffer extends TurnMarker {}

/**
 * Durable per-turn markers and the resume offers they become. Every method is
 * synchronous and never throws (a storage failure is logged; the turn or the
 * shutdown proceeds).
 */
export function createTurnContinuity(deps: TurnContinuityDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.warn(message))
  let state: ContinuityState = (() => {
    try { return deps.store.load() } catch (error) { log(`[continuity] state unreadable: ${(error as Error).message}`); return emptyContinuityState() }
  })()
  let intent: { trigger: 'update'; at: number } | null = null
  let stopping = false

  const save = () => {
    try { deps.store.save(state) } catch (error) { log(`[continuity] state not saved: ${(error as Error).message}`) }
  }

  return {
    /** Startup, before any turn runs: what the previous process left in flight becomes offers. */
    recoverAtStartup(): number {
      const count = Object.keys(state.markers).length
      if (count > 0 || state.runsAtShutdown.length > 0) {
        state = promoteMarkers(state)
        save()
      }
      return count
    },

    /** A mission turn started: durable marker (a crash leaves it as `crash`). A new turn supersedes any offer. */
    turnStarted(conversationId: string, info: { provider: string | null; sessionId: string | null }): void {
      if (stopping) return
      const at = new Date(now()).toISOString()
      state = {
        ...state,
        markers: { ...state.markers, [conversationId]: { conversationId, startedAt: at, provider: info.provider, sessionId: info.sessionId, trigger: 'crash', stoppedAt: at } },
        offers: Object.fromEntries(Object.entries(state.offers).filter(([id]) => id !== conversationId)),
      }
      save()
    },

    /**
     * A mission turn settled. A turn cut by the shutdown itself keeps its
     * marker: that is exactly the turn to offer back.
     */
    turnSettled(conversationId: string, outcome: 'terminal' | 'aborted' | 'interrupted'): void {
      if (stopping || outcome === 'interrupted') return
      if (!state.markers[conversationId]) return
      const markers = { ...state.markers }
      delete markers[conversationId]
      state = { ...state, markers }
      save()
    },

    /** The person is restarting to install an update (called right before the restart). */
    noteUpdateRestart(): void {
      intent = { trigger: 'update', at: now() }
    },

    /** Graceful shutdown: stamp in-flight turns, then ignore the lifecycle noise of the teardown. */
    recordShutdown(): void {
      if (stopping) return
      const trigger: Exclude<InterruptTrigger, 'crash'> = intent && now() - intent.at < SHUTDOWN_INTENT_TTL_MS ? 'update' : 'quit'
      stopping = true
      let runs: RunRef[] = []
      try { runs = deps.runningRuns?.() ?? [] } catch (error) { log(`[continuity] running runs unknown: ${(error as Error).message}`) }
      if (Object.keys(state.markers).length === 0 && runs.length === 0 && state.runsAtShutdown.length === 0) return
      state = stampShutdown(state, trigger, new Date(now()).toISOString(), runs)
      save()
    },

    /** Offers that still apply, oldest first; stale ones are dropped. */
    offers(): ResumeOffer[] {
      const valid: ResumeOffer[] = []
      let changed = false
      const offers = { ...state.offers }
      for (const offer of Object.values(state.offers)) {
        let view: MissionView | null = null
        try { view = deps.mission(offer.conversationId) } catch { view = null }
        if (offerStillValid(offer, view)) valid.push(offer)
        else { delete offers[offer.conversationId]; changed = true }
      }
      if (changed) { state = { ...state, offers }; save() }
      return valid.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    },

    /** The person resumed or dismissed these offers. Returns how many were removed. */
    settleOffers(conversationIds: readonly string[]): number {
      const offers = { ...state.offers }
      let removed = 0
      for (const id of conversationIds) if (offers[id]) { delete offers[id]; removed++ }
      if (removed > 0) { state = { ...state, offers }; save() }
      return removed
    },

    /** Runs the last restart interrupted (the client matches them to their Resume actions). */
    interruptedRuns(): RunRef[] {
      return [...state.interruptedRuns]
    },

    /** The person decided about the interrupted runs (resumed or left them in the Inbox). */
    clearInterruptedRuns(): void {
      if (state.interruptedRuns.length === 0) return
      state = { ...state, interruptedRuns: [] }
      save()
    },

    /** Turns in flight right now (for diagnostics/tests). */
    inFlight(): TurnMarker[] {
      return Object.values(state.markers)
    },
  }
}

export type TurnContinuity = ReturnType<typeof createTurnContinuity>
