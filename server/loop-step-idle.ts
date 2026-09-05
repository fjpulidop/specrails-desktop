// Loop AI-step inactivity watchdog contract (premium-milestone-progress).
//
// Factory loops run UNTIMED by design (`aiStepTimeoutMinutes = 0` — implement
// runs legitimately take 30–60 min), and the loop's interactive step session
// armed no wedge detector either, so a provider process that stopped
// producing output stayed `running` forever. Silence — not wall-clock — is the
// real wedge signal (the QueueManager path already keys its zombie timer on
// it), so every loop AI step is bounded by an IDLE threshold that resets on
// provider stream activity. It coexists with the per-step timeout: a timed
// step keeps its hard cap AND the idle bound; an untimed step gets the idle
// bound only.
//
// `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS` overrides the 30-minute default;
// `0` / `false` / `off` disables. The effective value never drops below the
// stuck-run NOTIFICATION threshold, so a `job.stuck` notification always
// precedes a teardown (a lower value is clamped up and logged once).

import { resolveStuckThresholdMs } from './stuck-run-detector'

export const LOOP_STEP_IDLE_DEFAULT_MS = 30 * 60 * 1000

/** Error text the executors/engine attach to a stalled step result. */
export const AI_STEP_STALLED_ERROR = 'AI step stalled'

let warnedClamp = false

/** Test seam: forget the one-time clamp warning. */
export function _resetLoopStepIdleWarningForTests(): void {
  warnedClamp = false
}

/**
 * Effective idle threshold in ms; `0` ⇒ watchdog disabled.
 * `warn` receives the one-time clamp notice (defaults to console.warn).
 */
export function resolveLoopStepIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): number {
  const raw = env.SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS
  let value = LOOP_STEP_IDLE_DEFAULT_MS
  if (raw !== undefined && raw !== '') {
    const normalized = raw.trim().toLowerCase()
    if (normalized === '0' || normalized === 'false' || normalized === 'off') return 0
    const parsed = Number(normalized)
    if (Number.isFinite(parsed) && parsed > 0) value = Math.trunc(parsed)
  }
  const stuck = resolveStuckThresholdMs(env)
  if (stuck !== null && value < stuck) {
    if (!warnedClamp) {
      warnedClamp = true
      warn(`[loop-step-idle] SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS=${value} is below the stuck-run threshold (${stuck} ms); clamping so a stuck notification always precedes teardown`)
    }
    return stuck
  }
  return value
}
