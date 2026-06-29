import { useEffect, useState } from 'react'
import { X, CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../lib/api'
import { useMovableResizableModal } from '../hooks/useMovableResizableModal'
import { ResizeGrips } from './ui/ResizeGrips'
import type { JobCompareEntry, JobCompareResponse } from '../types'

interface JobComparisonModalProps {
  jobIds: [string, string]
  onClose: () => void
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function formatCost(cost: number | null): string {
  if (cost == null) return '—'
  if (cost === 0) return '$0'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(3)}`
}

function formatTokens(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface RowProps {
  label: string
  a: string
  b: string
  highlight?: 'a' | 'b' | null
}

function CompareRow({ label, a, b, highlight }: RowProps) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/20 last:border-0 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono text-right ${highlight === 'a' ? 'text-emerald-400 aurora-light:text-accent-success font-semibold' : ''}`}>{a}</span>
      <span className={`font-mono text-right ${highlight === 'b' ? 'text-emerald-400 aurora-light:text-accent-success font-semibold' : ''}`}>{b}</span>
    </div>
  )
}

function pickBetter(aVal: number | null, bVal: number | null, lowerIsBetter = true): 'a' | 'b' | null {
  if (aVal == null || bVal == null) return null
  if (aVal === bVal) return null
  return lowerIsBetter ? (aVal < bVal ? 'a' : 'b') : (aVal > bVal ? 'a' : 'b')
}

export function JobComparisonModal({ jobIds, onClose }: JobComparisonModalProps) {
  const { t } = useTranslation('jobs')
  const [data, setData] = useState<JobCompareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating, guardBackdrop } = useMovableResizableModal()

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
        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{t('comparison.jobN', { n: idx + 1 })}</p>
        <code className="text-[10px] text-foreground/70 block truncate max-w-[160px] mx-auto">
          {job.command}
        </code>
        <div className="flex items-center justify-center gap-1 text-[10px]">
          {job.status === 'completed'
            ? <CheckCircle2 className="w-3 h-3 text-emerald-400 aurora-light:text-accent-success" />
            : <XCircle className="w-3 h-3 text-rose-400 aurora-light:text-destructive" />
          }
          <span className="capitalize text-muted-foreground">{t(`statusLabel.${job.status}`, { defaultValue: job.status })}</span>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono">{job.id.slice(0, 8)}</p>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={guardBackdrop(onClose)}
    >
      <div
        ref={panelRef}
        className="w-full max-w-lg rounded-xl border border-border/30 bg-popover p-5 shadow-xl space-y-4 mx-4"
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between ${isFloating ? 'cursor-grab active:cursor-grabbing' : ''}`}
          {...headerHandleProps}
        >
          <h2 className="text-sm font-semibold">{t('comparison.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading && (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-8 bg-muted/20 rounded animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 aurora-light:text-destructive">{t('comparison.loadFailed', { error })}</p>
        )}

        {data && (() => {
          const [a, b] = data.jobs

          const durationHighlight = pickBetter(a.durationMs, b.durationMs, true)
          const costHighlight = pickBetter(a.totalCostUsd, b.totalCostUsd, true)
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
                a={formatCost(a.totalCostUsd)}
                b={formatCost(b.totalCostUsd)}
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

        {data && (
          <p className="text-[10px] text-muted-foreground/60 text-center">
            {t('comparison.betterValueHint')}
          </p>
        )}
      </div>
      <ResizeGrips handles={resizeHandles} />
    </div>
  )
}
