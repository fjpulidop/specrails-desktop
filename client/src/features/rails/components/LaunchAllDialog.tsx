import { keyboardLabel } from '../../../lib/keyboard-label'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatUsdBand } from '../../../lib/launch-forecast'
import type { BulkForecast } from '../../../hooks/useLaunchForecast'
import { Rocket, GitBranch, Layers, DollarSign, Inbox, Gauge } from 'lucide-react'
import { LaunchPreflightChips } from '../../provider-quota/components/LaunchPreflightChips'
import { useLaunchPreflight } from '../../provider-quota/lib/useLaunchPreflight'
import { useProviderQuotas } from '../../provider-quota/lib/useProviderQuota'
import { formatResetTime } from '../../provider-quota/lib/format-reset'
import { providerLabel, windowLabel } from '../../provider-quota/lib/labels'

const NO_PROVIDERS: readonly string[] = []
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { prepareRunCheckouts, releaseRunCheckouts } from '../lib/worktree-preparation'

interface Props {
  open: boolean
  /** How many rails the batch will launch. */
  railCount: number
  /** Total specs across those rails. */
  specCount: number
  onConfirm: () => void
  onCancel: () => void
  /** Rails held back by the project's review WIP limit (null when none). */
  reviewLimit?: { limit: number; pending: number; held: number } | null
  /** Summed forecast of the whole batch (bulk launch); absent where there is none. */
  forecast?: BulkForecast | null
  /** Project the rails run in: enables the launch preflight (disk, sign-in, quota). */
  projectId?: string | null
  /** Each rail's engine ('' = the project's primary provider). */
  providers?: readonly string[]
}

/**
 * Confirmation modal shown before "Launch all" starts every ready rail in
 * parallel. Frames the batch honestly: N independent AI pipelines spawn at
 * once (cost scales with the rail count), each isolated in its own git
 * worktree so the parallel runs never collide. Confirm is the affirmative
 * (green) action; ⌘/Ctrl+Enter triggers it.
 */
export function LaunchAllDialog({ open, railCount, specCount, onConfirm, onCancel, reviewLimit = null, forecast = null, projectId = null, providers = NO_PROVIDERS }: Props) {
  const { t, i18n } = useTranslation('dashboard')
  const { t: tQuota } = useTranslation('providerQuota')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const preflight = useLaunchPreflight(open && !!projectId, projectId, providers.length ? providers : [''])
  const blocked = preflight.report?.blocking === true
  // Quota left: warn before launching N rails into a window ≥80 % or a refusal.
  const quotaWarnings = (preflight.report?.chips ?? []).flatMap((chip) => chip.kind === 'quota' && chip.state === 'warn' ? [chip] : [])
  const quotas = useProviderQuotas()

  // Populate up to three run worktrees while the person reads the dialog;
  // dismissing it drops them (a confirmed launch adopts them instead).
  useEffect(() => {
    if (!open || railCount === 0) return
    void prepareRunCheckouts(Math.min(railCount, 3))
  }, [open, railCount])
  const cancel = () => {
    void releaseRunCheckouts()
    onCancel()
  }

  // ⌘/Ctrl + Enter confirms while the dialog is open.
  useEffect(() => {
    if (!open || railCount === 0 || blocked) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onConfirm, railCount, blocked])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent
        size="confirm"
        showCloseButton={false}
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}
      >
        <DialogHeader icon={<Rocket />}>
          <DialogTitle>{t('launchAllDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('launchAllDialog.railsCount', { count: railCount })}
            {' · '}
            {t('launchAllDialog.specsCount', { count: specCount })}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {reviewLimit && (
            <div
              role="status"
              data-testid="launch-all-review-limit"
              className="flex items-start gap-2.5 rounded-lg border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-accent-warning"
            >
              <Inbox className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-medium">{t('launchAllDialog.reviewLimitTitle', { pending: reviewLimit.pending, limit: reviewLimit.limit })}</span>{' '}
                {railCount === 0
                  ? t('launchAllDialog.reviewLimitNone', { count: reviewLimit.held })
                  : t('launchAllDialog.reviewLimitPartial', { count: reviewLimit.held, launched: railCount })}
              </span>
            </div>
          )}

          {forecast && (forecast.cost || forecast.mayPause) && (
            <div className="flex flex-col gap-1" data-testid="launch-all-forecast">
              {forecast.cost && (
                <p className="num text-caption text-muted-foreground" data-testid="launch-all-forecast-total">
                  {t('launchAllDialog.forecastTotal', { count: forecast.runs, cost: formatUsdBand(forecast.cost.lowUsd, forecast.cost.highUsd, i18n.language || 'en') })}
                </p>
              )}
              {forecast.mayPause && (
                <p className="inline-flex items-center gap-1.5 text-caption text-accent-warning" role="status" data-testid="launch-all-may-pause">
                  <span className="size-1.5 shrink-0 rounded-full bg-accent-warning" aria-hidden />
                  {t('launchAllDialog.mayPause')}
                </p>
              )}
            </div>
          )}

          {projectId && <LaunchPreflightChips report={preflight.report} loading={preflight.loading} onRecheck={preflight.recheck} />}

          {quotaWarnings.map((chip) => {
            const provider = providerLabel(chip.providerId)
            const quota = quotas.find((item) => item.providerId === chip.providerId)
            const text = chip.level === 'rejected'
              ? chip.rejectedUntil ? tQuota('preflight.quotaRejected', { provider, time: formatResetTime(chip.rejectedUntil, i18n.language), count: railCount }) : tQuota('preflight.quotaRejectedNoReset', { provider })
              : tQuota('preflight.quotaWarning', { provider, percent: Math.round(chip.usedPercent ?? 0), window: windowLabel(quota?.windowId ?? null), count: railCount })
            return (
              <div key={chip.id} role="status" data-testid="launch-all-quota-warning" data-level={chip.level}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs ${chip.level === 'rejected' || chip.level === 'critical' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning'}`}>
                <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{text}</span>
              </div>
            )
          })}

          <ul className="space-y-2.5 text-xs text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-info" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.isolationTitle')}</span>{' '}{t('launchAllDialog.isolationBody')}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-secondary" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.pipelinesTitle', { count: railCount })}</span>{' '}{t('launchAllDialog.pipelinesBody')}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <DollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.costTitle')}</span>{' '}{t('launchAllDialog.costBody')}</span>
            </li>
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            disabled={railCount === 0 || blocked}
            className="gap-2 bg-accent-success text-background hover:bg-accent-success/90 focus-visible:ring-accent-success"
            onClick={onConfirm}
          >
            {t('launchAllDialog.launch', { count: railCount })}
            <kbd className="hidden sm:inline-flex items-center rounded border border-background/30 bg-background/15 px-1 text-label leading-4">{keyboardLabel('⌘↵')}</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
