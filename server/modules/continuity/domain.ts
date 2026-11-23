/**
 * Restart continuity — pure rules.
 *
 * A mission turn in flight leaves a durable marker. A graceful shutdown stamps
 * every marker with why the app stopped (`quit`, or `update` when the person
 * installed an update); a marker that was never stamped means the app stopped
 * unexpectedly (`crash`). On the next start the markers become resume OFFERS.
 * Nothing is replayed automatically: an offer only becomes a turn when the
 * person picks it.
 *
 * An offer goes stale (and is dropped) when the mission moved on: it was
 * deleted or archived, another turn started in it, or its provider session is
 * no longer the one the interrupted turn ran in. Sessions are compared by
 * their ROOT — the provider and the session id the turn started with — and a
 * session born during the interrupted turn (no id at start) still matches.
 */

export const INTERRUPT_TRIGGERS = ['quit', 'update', 'crash'] as const
export type InterruptTrigger = typeof INTERRUPT_TRIGGERS[number]

export function isInterruptTrigger(value: unknown): value is InterruptTrigger {
  return typeof value === 'string' && (INTERRUPT_TRIGGERS as readonly string[]).includes(value)
}

export interface TurnMarker {
  conversationId: string
  /** When the turn started (ISO). */
  startedAt: string
  /** Provider the turn ran on. */
  provider: string | null
  /** Provider session id when the turn started (null: the session was new). */
  sessionId: string | null
  /** Why the app stopped while the turn ran. `crash` until a graceful shutdown says otherwise. */
  trigger: InterruptTrigger
  /** When the trigger was recorded (shutdown time; the start time for a crash). */
  stoppedAt: string
}

/** A rail/loop run (loop_runs row) of a project. */
export interface RunRef {
  projectId: string
  runId: string
}

export interface ContinuityState {
  version: 1
  /** Turns in flight in the CURRENT process. */
  markers: Record<string, TurnMarker>
  /** Turns a previous process left interrupted, waiting for the person. */
  offers: Record<string, TurnMarker>
  /** Runs that were running when this process stopped gracefully (written at shutdown). */
  runsAtShutdown: RunRef[]
  /** Runs the last restart interrupted, waiting for the person (their Resume is the run's own). */
  interruptedRuns: RunRef[]
}

export function emptyContinuityState(): ContinuityState {
  return { version: 1, markers: {}, offers: {}, runsAtShutdown: [], interruptedRuns: [] }
}

function parseRuns(value: unknown): RunRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): RunRef[] => {
    const r = (raw ?? {}) as Record<string, unknown>
    return typeof r.projectId === 'string' && typeof r.runId === 'string' && r.projectId && r.runId ? [{ projectId: r.projectId, runId: r.runId }] : []
  }).slice(0, 500)
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function parseMarker(value: unknown): TurnMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const m = value as Record<string, unknown>
  if (typeof m.conversationId !== 'string' || !ID_RE.test(m.conversationId)) return null
  if (typeof m.startedAt !== 'string' || Number.isNaN(Date.parse(m.startedAt))) return null
  if (!isInterruptTrigger(m.trigger)) return null
  return {
    conversationId: m.conversationId,
    startedAt: m.startedAt,
    provider: typeof m.provider === 'string' ? m.provider : null,
    sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
    trigger: m.trigger,
    stoppedAt: typeof m.stoppedAt === 'string' && !Number.isNaN(Date.parse(m.stoppedAt)) ? m.stoppedAt : m.startedAt,
  }
}

function parseMap(value: unknown): Record<string, TurnMarker> {
  const out: Record<string, TurnMarker> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const raw of Object.values(value as Record<string, unknown>)) {
    const marker = parseMarker(raw)
    if (marker) out[marker.conversationId] = marker
  }
  return out
}

/** Tolerant read of a stored state: junk entries are dropped, never thrown. */
export function parseContinuityState(raw: string | null): ContinuityState {
  if (!raw) return emptyContinuityState()
  let value: unknown
  try { value = JSON.parse(raw) } catch { return emptyContinuityState() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyContinuityState()
  const v = value as Record<string, unknown>
  return { version: 1, markers: parseMap(v.markers), offers: parseMap(v.offers), runsAtShutdown: parseRuns(v.runsAtShutdown), interruptedRuns: parseRuns(v.interruptedRuns) }
}

/**
 * Startup: everything the previous process left in flight becomes an offer,
 * and the runs it stopped with replace the previous restart's list.
 */
export function promoteMarkers(state: ContinuityState): ContinuityState {
  return {
    version: 1,
    markers: {},
    offers: { ...state.offers, ...state.markers },
    runsAtShutdown: [],
    interruptedRuns: state.runsAtShutdown.length ? state.runsAtShutdown : state.interruptedRuns,
  }
}

/** Graceful shutdown: stamp every in-flight turn with why the app stopped, and remember the running runs. */
export function stampShutdown(state: ContinuityState, trigger: Exclude<InterruptTrigger, 'crash'>, at: string, runs: readonly RunRef[] = []): ContinuityState {
  const markers: Record<string, TurnMarker> = {}
  for (const [id, marker] of Object.entries(state.markers)) markers[id] = { ...marker, trigger, stoppedAt: at }
  return { ...state, markers, runsAtShutdown: [...runs] }
}

/** What the server knows about a mission right now. */
export interface MissionView {
  exists: boolean
  archived: boolean
  provider: string | null
  sessionId: string | null
  /** A turn is running in it right now. */
  turnActive: boolean
}

/** Is this offer still about the mission as it is now? */
export function offerStillValid(offer: TurnMarker, mission: MissionView | null): boolean {
  if (!mission || !mission.exists || mission.archived || mission.turnActive) return false
  if (offer.provider && mission.provider && offer.provider !== mission.provider) return false
  // Root comparison: a session the turn started with must still be the mission's.
  if (offer.sessionId && mission.sessionId && offer.sessionId !== mission.sessionId) return false
  if (offer.sessionId && !mission.sessionId) return false
  return true
}
