import type { TFunction } from 'i18next'
import { PR_CI_LOOP_ID } from '../../delivery/lib/pr-ci'

/** Plain-language step of a `factory:pr-ci` run for the run strip (pr-ci-loop). */
const STEP_KEYS: Readonly<Record<string, string>> = {
  init: 'checks', checks: 'checks', 'ci-evidence': 'fixing', 'round-budget': 'fixing', 'count-round': 'fixing',
  fixer: 'fixing', 'fix-summary': 'fixing', 'fixer-blocker': 'fixing', progress: 'fixing',
  'rerun-guard': 'rerun', 'count-rerun': 'rerun', rerun: 'rerun',
  base: 'base', 'conflict-reason': 'base', diverged: 'base',
  'conflict-budget': 'conflicts', 'count-conflict': 'conflicts', resolver: 'conflicts', resolved: 'conflicts', 'merge-summary': 'conflicts',
  local: 'verify', 'local-evidence': 'verify', push: 'push',
}

export function describePrCiStep(t: TFunction, loopId: string | null | undefined, stepId: string | null | undefined): string | null {
  if (loopId !== PR_CI_LOOP_ID || !stepId) return null
  const parts = stepId.split('/'); const node = parts[parts.length - 1] || stepId
  const key = STEP_KEYS[node]
  return key ? t(`prCi.step.${key}`) : null
}
