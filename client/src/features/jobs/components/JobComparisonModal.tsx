import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { CostValue } from '../../analytics/components/CostValue'
import type { JobCompareEntry, JobCompareResponse } from '../../../types'

interface JobComparisonModalProps {
  jobIds: [string, string]
  onClose: () => void
  /** Per-job "cost is a pricing-table estimate" flags, in `jobIds` order. */
  estimatedCost?: [boolean, boolean]
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function formatTokens(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface RowProps {
  label: string
  a: ReactNode
  b: ReactNode
  highlight?: 'a' | 'b' | null
}

function CompareRow({ label, a, b, highlight }: RowProps) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/20 last:border-0 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums text-right ${highlight === 'a' ? 'text-accent-success font-semibold' : ''}`}>{a}</span>
      <span className={`tabular-nums text-right ${highlight === 'b' ? 'text-accent-success font-semibold' : ''}`}>{b}</span>
    </div>
  )
}

function pickBetter(aVal: number | null, bVal: number | null, lowerIsBetter = true): 'a' | 'b' | null {
  if (aVal == null || bVal == null) return null
  if (aVal === bVal) return null
  return lowerIsBetter ? (aVal < bVal ? 'a' : 'b') : (aVal > bVal ? 'a' : 'b')
}

export function JobComparisonModal({ jobIds, onClose, estimatedCost }: JobComparisonModalProps) {
  const { t } = useTranslation('jobs')
  const [data, setData] = useState<JobCompareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${getApiBase()}/jobs/compare?jobIds=${jobIds.join(',')}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<JobCompareResponse>
      })
      .then((d) => { setData(d); setLoading(false) })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        setError(err.message)
        setLoading(false)
      })
    return () => controller.abort()
  }, [jobIds])

  function header(job: JobCompareEntry, idx: number) {
    return (
      <div className="text-center space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('comparison.jobN', { n: idx + 1 })}</p>
        <code className="text-xs text-foreground block truncate max-w-[160px] mx-auto">
          {job.command}
        </code>
        <div className="flex items-center justify-center gap-1 text-xs">
          {job.status === 'completed'
            ? <CheckCircle2 className="w-3 h-3 text-accent-success" aria-hidden />
            : <XCircle className="w-3 h-3 text-destructive" aria-hidden />
          }
          <span className="text-muted-foreground">{t(`statusLabel.${job.status}`, { defaultValue: job.status })}</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono">{job.id.slice(0, 8)}</p>
      </div>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{t('comparison.title')}</DialogTitle>
          <DialogDescription>{t('comparison.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">

        {loading && (
          <div role="status" aria-busy="true" aria-label={t('comparison.loading')} className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-8 bg-muted/20 rounded motion-safe:animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive" title={error}>{t('comparison.loadFailed')}</p>
        )}

        {data && (() => {
          const [a, b] = data.jobs

          const durationHighlight = pickBetter(a.durationMs, b.durationMs, true)
          const aEstimated = estimatedCost?.[0] ?? false
          const bEstimated = estimatedCost?.[1] ?? false
          // An estimate is not comparable with a billed cost: no "better" mark.
          const costHighlight = aEstimated || bEstimated
            ? null
            : pickBetter(a.totalCostUsd, b.totalCostUsd, true)
          const tokensHighlight = pickBetter(
            a.tokensOut != null ? a.tokensOut : null,
            b.tokensOut != null ? b.tokensOut : null,
            true,
          )

          return (
            <div>
              {/* Column headers */}
              <div className="grid grid-cols-3 gap-2 pb-3 border-b border-border/30 mb-1">
                <div />
                {header(a, 0)}
                {header(b, 1)}
              </div>

              {/* Metrics */}
              <CompareRow
                label={t('comparison.duration')}
                a={formatDuration(a.durationMs)}
                b={formatDuration(b.durationMs)}
                highlight={durationHighlight}
              />
              <CompareRow
                label={t('comparison.cost')}
                a={<CostValue usd={a.totalCostUsd} estimated={aEstimated} />}
                b={<CostValue usd={b.totalCostUsd} estimated={bEstimated} />}
                highlight={costHighlight}
              />
              <CompareRow
                label={t('comparison.tokensOut')}
                a={formatTokens(a.tokensOut)}
                b={formatTokens(b.tokensOut)}
                highlight={tokensHighlight}
              />
              <CompareRow
                label={t('comparison.tokensIn')}
                a={formatTokens(a.tokensIn)}
                b={formatTokens(b.tokensIn)}
                highlight={null}
              />
              <CompareRow
                label={t('comparison.cacheRead')}
                a={formatTokens(a.tokensCacheRead)}
                b={formatTokens(b.tokensCacheRead)}
                highlight={null}
              />
              <CompareRow
                label={t('comparison.model')}
                a={a.model ?? '—'}
                b={b.model ?? '—'}
                highlight={null}
              />
              <CompareRow
                label={t('comparison.phasesDone')}
                a={a.phasesCompleted.length > 0 ? a.phasesCompleted.join(', ') : '—'}
                b={b.phasesCompleted.length > 0 ? b.phasesCompleted.join(', ') : '—'}
                highlight={null}
              />
            </div>
          )
        })()}

        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
