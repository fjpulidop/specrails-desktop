import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { getApiBase } from '../../../lib/api'

interface PlanEntry { repositoryId: string; name: string; version: string; reason: string; applied: boolean }

/**
 * An environment remedy the host can apply itself: the project pins a Python version (its image,
 * a version file) and checks should run in a venv built from it, not on a newer system python3.
 * Saving writes the project's setup and verification commands; the next launch uses them.
 */
export function EnvironmentPlanOffer() {
  const { t } = useTranslation('recovery')
  const [plans, setPlans] = useState<PlanEntry[]>([])
  const [state, setState] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({})
  useEffect(() => {
    let live = true
    let base: string
    try { base = getApiBase() } catch { return }
    fetch(`${base}/agent-runtime/environment-plan`)
      .then(async (response) => (response.ok ? (await response.json()) as { plans?: PlanEntry[] } : { plans: [] }))
      .then((body) => { if (live) setPlans((body.plans ?? []).filter((plan) => !plan.applied)) })
      .catch(() => { /* offline detection only; nothing to offer */ })
    return () => { live = false }
  }, [])
  if (!plans.length) return null
  const apply = async (plan: PlanEntry) => {
    setState((current) => ({ ...current, [plan.repositoryId]: 'saving' }))
    try {
      const response = await fetch(`${getApiBase()}/agent-runtime/environment-plan/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId: plan.repositoryId }),
      })
      setState((current) => ({ ...current, [plan.repositoryId]: response.ok ? 'saved' : 'failed' }))
    } catch { setState((current) => ({ ...current, [plan.repositoryId]: 'failed' })) }
  }
  return (
    <div data-testid="failure-environment-plan" className="space-y-1.5 rounded-control border border-border/50 bg-background/40 px-3 py-2 text-body">
      {plans.map((plan) => {
        const status = state[plan.repositoryId]
        return (
          <div key={plan.repositoryId} className="space-y-1">
            <p className="text-foreground">{t('environmentPlan.offer', { version: plan.version, repository: plan.name })}</p>
            {status === 'saved' ? (
              <p role="status" className="text-caption text-accent-success">{t('environmentPlan.saved')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" data-testid="failure-environment-plan-apply" disabled={status === 'saving'} aria-busy={status === 'saving' || undefined} onClick={() => void apply(plan)}>
                  <Wrench className="mr-1 h-3 w-3" aria-hidden />
                  {t('environmentPlan.apply', { version: plan.version })}
                </Button>
                {status === 'failed' && <span role="alert" className="text-caption text-destructive">{t('environmentPlan.failed')}</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
