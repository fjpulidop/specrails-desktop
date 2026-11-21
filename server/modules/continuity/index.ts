// Public API of restart continuity (durable per-turn markers, resume offers,
// update deferral support). Adapters are wired at the composition root.
export { createTurnContinuity, SHUTDOWN_INTENT_TTL_MS, type ResumeOffer, type TurnContinuity, type TurnContinuityDeps } from './application'
export {
  INTERRUPT_TRIGGERS,
  emptyContinuityState,
  isInterruptTrigger,
  offerStillValid,
  parseContinuityState,
  promoteMarkers,
  stampShutdown,
  type ContinuityState,
  type InterruptTrigger,
  type MissionView,
  type RunRef,
  type TurnMarker,
} from './domain'
export type { ContinuityStore } from './ports'
