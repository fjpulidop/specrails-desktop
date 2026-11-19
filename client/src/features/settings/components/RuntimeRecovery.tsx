import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import type { TFunction } from 'i18next'
import { Button } from '../../../components/ui/button'
import type { RuntimeRun } from '../lib/agent-runtime'

type Attempt = { attemptId: string; nodePath: string | null; scopeId: string | null; effect?: string }

/** The interrupted attempts Core would re-run, with their step when Core named it. */
export function recoveryAttemptsOf(run: Pick<RuntimeRun, 'recoverableSteps' | 'recoveryAttempts'>): Attempt[] {
  return run.recoverableSteps.map(id => {
    const known = run.recoveryAttempts?.find(item => item.attemptId === id)
    return { attemptId: id, nodePath: known?.nodePath || null, scopeId: known?.scopeId ?? null, ...(known?.effect ? { effect: known.effect } : {}) }
  })
}

/**
 * Whether the person has a real choice. Continue authorizes every interrupted
 * attempt; that is the only sensible move while they are all the same kind of
 * step re-running its own workspace writes. Steps of different roles, or one
 * Core does not mark as a workspace write (it could repeat an outside effect),
 * are the person's call.
 */
export function recoveryNeedsChoice(attempts: readonly Attempt[]): boolean {
  if (attempts.some(attempt => attempt.effect !== undefined && attempt.effect !== 'write')) return true
  return new Set(attempts.map(attempt => attempt.nodePath ?? '')).size > 1
}

function stepName(t: TFunction, nodePath: string | null): string | null {
  if (!nodePath) return null
  const words = nodePath.split('/').pop()!.replace(/[-_]+/g, ' ').trim()
  return t(`roles.${nodePath}`, { defaultValue: words ? words[0]!.toUpperCase() + words.slice(1) : nodePath })
}

/**
 * Continue a run whose steps were interrupted (an app restart, a cut write).
 * One primary Continue re-runs exactly the interrupted attempts (`recover[]`)
 * and says what that does. Only when a real choice exists does it list them,
 * by step name, never by internal ids.
 */
export function RuntimeRecovery({ run, busy, onRecover }: { run: RuntimeRun; busy: boolean; onRecover(attempts: string[]): void }) {
  const { t } = useTranslation('agentRuntime')
  const attempts = recoveryAttemptsOf(run)
  const choice = recoveryNeedsChoice(attempts)
  const [excluded, setExcluded] = useState<string[]>([])
  const selected = attempts.filter(attempt => !excluded.includes(attempt.attemptId)).map(attempt => attempt.attemptId)
  const steps = [...new Set(attempts.map(attempt => stepName(t, attempt.nodePath)))]
  const consequence = steps.length === 1 && steps[0]
    ? t('runs.continueConsequence', { step: steps[0] })
    : t('runs.continueConsequenceMany')
  const button = (ids: string[]) => (
    <Button size="sm" className="h-7 shrink-0" disabled={busy || !ids.length} onClick={() => onRecover(ids)} data-testid="runtime-recovery-continue">
      <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('runs.continue')}
    </Button>
  )
  if (!choice) {
    return <div className="flex min-w-0 items-center gap-2" data-testid="runtime-recovery">
      <span className="max-w-[15rem] text-caption leading-tight text-muted-foreground" data-testid="runtime-recovery-consequence">{consequence}</span>
      {button(attempts.map(attempt => attempt.attemptId))}
    </div>
  }
  const perStep = new Map<string, number>()
  return <fieldset className="space-y-2 rounded-md border border-border p-2" disabled={busy} data-testid="runtime-recovery">
    <legend className="px-1 text-xs">{t('runs.selectRecovery')}</legend>
    <p className="text-xs text-muted-foreground">{t('runs.recoveryHint')}</p>
    {attempts.map(attempt => {
      const name = stepName(t, attempt.nodePath) ?? t('runs.status.interrupted')
      const sameStep = attempts.filter(other => other.nodePath === attempt.nodePath).length
      const index = (perStep.get(attempt.nodePath ?? '') ?? 0) + 1
      perStep.set(attempt.nodePath ?? '', index)
      return <label key={attempt.attemptId} className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={!excluded.includes(attempt.attemptId)} onChange={event => setExcluded(values => event.target.checked ? values.filter(value => value !== attempt.attemptId) : [...values, attempt.attemptId])} />
        <span>{sameStep > 1 ? t('runs.recoveryBranch', { step: name, index }) : name}</span>
      </label>
    })}
    {button(selected)}
  </fieldset>
}
