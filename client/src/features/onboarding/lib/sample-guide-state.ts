import { GUIDE_STEPS } from './sample-model'

/**
 * Per-viewer progress of the 3-step guide, keyed by the sample's project id so a
 * re-created sample is guided again. Browser storage is a convenience only: every
 * access is wrapped, and the guide still works (from step 1) without it.
 */
export const SAMPLE_GUIDE_KEY = 'specrails-desktop:onboarding:sample-guide'

export interface SampleGuideState {
  projectId: string
  /** Index into {@link GUIDE_STEPS}. */
  step: number
  /** Finished or dismissed: the guide stays collapsed to a pill. */
  done: boolean
  /** The first run was launched from the guide (the call to action is not offered twice). */
  launched: boolean
}

export function readGuideState(projectId: string): SampleGuideState {
  const fresh: SampleGuideState = { projectId, step: 0, done: false, launched: false }
  try {
    const raw = localStorage.getItem(SAMPLE_GUIDE_KEY)
    if (!raw) return fresh
    const value = JSON.parse(raw) as Partial<SampleGuideState>
    if (value.projectId !== projectId) return fresh
    const step = typeof value.step === 'number' && Number.isInteger(value.step) ? Math.min(Math.max(value.step, 0), GUIDE_STEPS.length - 1) : 0
    return { projectId, step, done: value.done === true, launched: value.launched === true }
  } catch {
    return fresh
  }
}

export function writeGuideState(state: SampleGuideState): void {
  try { localStorage.setItem(SAMPLE_GUIDE_KEY, JSON.stringify(state)) } catch { /* private window / blocked storage */ }
}

export function clearGuideState(): void {
  try { localStorage.removeItem(SAMPLE_GUIDE_KEY) } catch { /* ignore */ }
}
