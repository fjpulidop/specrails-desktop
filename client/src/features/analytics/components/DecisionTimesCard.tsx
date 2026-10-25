import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Timer } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import type { Period } from '../types/spending'

export interface DurationStats {
  measured: number
  pending: number
  unknown: number
  medianMs: number | null
  p90Ms: number | null
}

export interface DecisionTimeGroup {
  deliveries: number
  toDecision: DurationStats
  toMerge: DurationStats
}

export interface DecisionTimesResponse {
  period: string
  from: string
  to: string
  project: DecisionTimeGroup
  byLoop: Array<DecisionTimeGroup & { loopId: string | null; loopName: string }>
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const duration = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const validStats = (value: unknown): value is DurationStats => {
  const stats = value as DurationStats | null
  return !!stats && count(stats.measured) && count(stats.pending) && count(stats.unknown) && duration(stats.medianMs) && duration(stats.p90Ms)
}
const validGroup = (value: unknown): value is DecisionTimeGroup => {
  const group = value as DecisionTimeGroup | null
  return !!group && count(group.deliveries) && validStats(group.toDecision) && validStats(group.toMerge)
}

/** Reject malformed payloads instead of rendering a manufactured zero. */
export function parseDecisionTimes(value: unknown): DecisionTimesResponse {
  const body = value as DecisionTimesResponse | null
  if (!body || !validGroup(body.project) || !Array.isArray(body.byLoop) ||
    body.byLoop.some((loop) => !validGroup(loop) || typeof loop.loopName !== 'string')) throw new Error('Invalid decision times')
  return body
}

type Unit = 'minutes' | 'hours' | 'days'
/** Compact duration split into a value + unit key so every locale words the unit. */
export function durationParts(ms: number): { value: string; unit: Unit } {
  const minutes = ms / 60_000
  if (minutes < 60) return { value: String(Math.max(0, Math.round(minutes))), unit: 'minutes' }
  const hours = minutes / 60
  if (hours < 48) return { value: hours < 10 ? hours.toFixed(1) : String(Math.round(hours)), unit: 'hours' }
  const days = hours / 24
  return { value: days < 10 ? days.toFixed(1) : String(Math.round(days)), unit: 'days' }
}

interface Props {
  projectId: string
  period: Period
  from?: string
  to?: string
}

/**
 * Time to decision / time to merge for this project's deliveries (median and
 * p90 from when each delivery became reviewable). Missing instants are shown
 * as unknown — never as a zero duration.
 */
export function DecisionTimesCard({ projectId, period, from, to }: Props) {
  const { t } = useTranslation('analytics')
  const cache = useRef(new Map<string, DecisionTimesResponse>())
  const query = new URLSearchParams({ period })
  if (period === 'custom' && from && to) { query.set('from', from); query.set('to', to) }
  const key = `${projectId}?${query.toString()}`
  const [state, setState] = useState<{ key: string; loading: boolean; error: boolean }>({ key, loading: true, error: false })

  useEffect(() => {
    if (period === 'custom' && (!from || !to)) return
    let current = true
    const controller = new AbortController()
    setState({ key, loading: true, error: false })
    void (async () => {
      try {
        const response = await fetch(`${getApiBase()}/analytics/decision-times?${key.slice(key.indexOf('?') + 1)}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Decision times unavailable')
        const parsed = parseDecisionTimes(await response.json())
        if (!current) return
        cache.current.set(key, parsed)
        setState({ key, loading: false, error: false })
      } catch {
        if (current) setState({ key, loading: false, error: true })
      }
    })()
    return () => { current = false; controller.abort() }
  }, [key, period, from, to])

  const data = cache.current.get(key)
  const loading = state.key !== key || state.loading
  const failed = state.key === key && state.error

  const fmt = (ms: number | null) => {
    if (ms === null) return t('decisionTimes.unknownValue')
    const { value, unit } = durationParts(ms)
    return t(`decisionTimes.units.${unit}`, { value })
  }

  const tile = (label: string, stats: DurationStats, testId: string) => (
    <div className="rounded-lg border border-border/40 bg-background/40 p-3" data-testid={testId}>
      <p className="text-caption text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-3">
        <span className="text-2xl font-semibold num tracking-tight">{fmt(stats.medianMs)}</span>
        <span className="text-xs text-muted-foreground">{t('decisionTimes.median')}</span>
      </div>
      <p className="text-xs text-muted-foreground num">
        {t('decisionTimes.p90')} <span className="text-foreground">{fmt(stats.p90Ms)}</span>
      </p>
      <p className="mt-2 text-caption text-muted-foreground num">
        {t('decisionTimes.counts', { measured: stats.measured, pending: stats.pending, unknown: stats.unknown })}
      </p>
    </div>
  )

  return (
    <section className="rounded-xl border border-border/50 bg-card p-4 space-y-3" aria-label={t('decisionTimes.title')} data-testid="decision-times-card">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-accent-highlight" aria-hidden="true" />
        <h3 className="text-strong">{t('decisionTimes.title')}</h3>
        <span className="text-caption text-muted-foreground">{t('decisionTimes.subtitle')}</span>
      </div>
      {failed && <p role="status" className="text-xs text-destructive">{t('decisionTimes.unavailable')}</p>}
      {!data && loading && <p role="status" className="text-xs text-muted-foreground">{t('decisionTimes.loading')}</p>}
      {data && data.project.deliveries === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="decision-times-empty">{t('decisionTimes.empty')}</p>
      )}
      {data && data.project.deliveries > 0 && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tile(t('decisionTimes.toDecision'), data.project.toDecision, 'decision-times-to-decision')}
          {tile(t('decisionTimes.toMerge'), data.project.toMerge, 'decision-times-to-merge')}
        </div>
        {data.byLoop.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">{t('decisionTimes.byLoop')}</caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-normal">{t('decisionTimes.loop')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal text-right">{t('decisionTimes.deliveries')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal text-right">{t('decisionTimes.decisionMedianP90')}</th>
                  <th scope="col" className="py-1.5 font-normal text-right">{t('decisionTimes.mergeMedianP90')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byLoop.map((loop) => (
                  <tr key={loop.loopId ?? `name:${loop.loopName}`} className="border-t border-border/30">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{loop.loopName || t('decisionTimes.unnamedLoop')}</th>
                    <td className="py-1.5 pr-3 text-right num">{loop.deliveries}</td>
                    <td className="py-1.5 pr-3 text-right num">{fmt(loop.toDecision.medianMs)} · {fmt(loop.toDecision.p90Ms)}</td>
                    <td className="py-1.5 text-right num">{fmt(loop.toMerge.medianMs)} · {fmt(loop.toMerge.p90Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-caption text-muted-foreground">{t('decisionTimes.note')}</p>
      </>}
    </section>
  )
}
