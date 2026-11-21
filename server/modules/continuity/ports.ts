import type { ContinuityState } from './domain'

/** Durable home of the continuity state (one small document). */
export interface ContinuityStore {
  load(): ContinuityState
  /** Atomic replace. May throw; callers keep running. */
  save(state: ContinuityState): void
}
