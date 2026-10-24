import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Scale } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import type { Period } from '../types/spending'
import { durationParts, type DecisionTimeGroup } from './DecisionTimesCard'
import { CostValue } from './CostValue'

export interface LoopEconomicsGroup {
  hasData: boolean
  delivered: number
  merged: number
  discarded: number
  superseded: number
  onReview: number
  discardRate: number | null
  cost: {
    pricedDeliveries: number
    unpricedDeliveries: number
    incompleteDeliveries: number
    totalUsd: number | null
    authoritativeUsd: number | null
    estimatedUsd: number | null
    avgCostUsd: number | null
    estimatedShare: number | null
  }
  decisionTimes: DecisionTimeGroup
  rounds: {
    measuredDeliveries: number
    reviewRounds: number
    fixerRounds: number
    reviewPerDelivery: number | null
    fixerPerDelivery: number | null
  }
  escapedDefects: number | null
  requirementsDemonstrated: { demonstrated: number; total: number; deliveries?: number } | null
  triageAccuracy: { matched: number; total: number } | null
}

export interface LoopEconomicsResponse {
  period: string
  from: string
  to: string
  sources: { escapedDefects: 'tracked' | 'untracked'; requirementsDemonstrated: string; triageAccuracy: string }
  project: LoopEconomicsGroup
  byLoop: Array<LoopEconomicsGroup & { loopId: string | null; loopName: string }>
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const maybeNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const validGroup = (value: unknown): value is LoopEconomicsGroup => {
  const g = value as LoopEconomicsGroup | null
  return !!g && typeof g.hasData === 'boolean' &&
    [g.delivered, g.merged, g.discarded].every(count) && maybeNumber(g.discardRate) &&
    !!g.cost && maybeNumber(g.cost.avgCostUsd) && maybeNumber(g.cost.estimatedShare) && count(g.cost.unpricedDeliveries) &&
    !!g.rounds && maybeNumber(g.rounds.reviewPerDelivery) && maybeNumber(g.rounds.fixerPerDelivery) &&
    !!g.decisionTimes?.toDecision && !!g.decisionTimes?.toMerge &&
    (g.escapedDefects === null || count(g.escapedDefects))
}

/** Reject malformed payloads instead of rendering a manufactured zero. */
export function parseLoopEconomics(value: unknown): LoopEconomicsResponse {
  const body = value as LoopEconomicsResponse | null
  if (!body || !validGroup(body.project) || !Array.isArray(body.byLoop) ||
    body.byLoop.some((loop) => !validGroup(loop) || typeof loop.loopName !== 'string')) throw new Error('Invalid loop economics')
  return body
}

const fmtRatio = (value: number) => (Math.round(value * 10) / 10).toString()
const fmtPercent = (value: number) => `${Math.round(value * 100)}%`

interface Props {
  projectId: string
  period: Period
  from?: string
  to?: string
}

/**
 * Loop economics: per loop, what was delivered, what it cost and how much
 * rework and escaped defects it produced over the period. Unknown values
 * render as "—" and loops without deliveries as "no data" — never zero.
 */
export function LoopEconomicsCard({ projectId, period, from, to }: Props) {
  const { t } = useTranslation('analytics')
  const cache = useRef(new Map<string, LoopEconomicsResponse>())
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
        const response = await fetch(`${getApiBase()}/analytics/loop-economics?${key.slice(key.indexOf('?') + 1)}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Loop economics unavailable')
        const parsed = parseLoopEconomics(await response.json())
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
  const dash = t('loopEconomics.unknownValue')

  const duration = (ms: number | null) => {
    if (ms === null) return dash
    const { value, unit } = durationParts(ms)
    return t(`decisionTimes.units.${unit}`, { value })
  }
  const cost = (group: LoopEconomicsGroup) => {
    if (group.cost.avgCostUsd === null) return <span className="text-muted-foreground">{dash}</span>
    const share = group.cost.estimatedShare
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <CostValue usd={group.cost.avgCostUsd} estimated={share !== null && share > 0} />
        {share !== null && share > 0 && (
          <span className="text-[10px] text-accent-warning">{t('loopEconomics.estimatedShare', { share: fmtPercent(share) })}</span>
        )}
        {group.cost.unpricedDeliveries > 0 && (
          <span className="text-[10px] text-muted-foreground">{t('loopEconomics.unpriced', { count: group.cost.unpricedDeliveries })}</span>
        )}
      </span>
    )
  }
  const value = (text: string | null) => text === null ? <span className="text-muted-foreground">{dash}</span> : text
  const noData = <span className="text-muted-foreground">{t('loopEconomics.noData')}</span>

  const columns = [
    'delivered', 'merged', 'discarded', 'avgCost', 'toDecision', 'toMerge', 'reviewRounds', 'fixerRounds',
    'escapedDefects', 'requirementsDemonstrated', 'triageAccuracy',
  ] as const

  const cells = (group: LoopEconomicsGroup) => [
    group.delivered,
    group.merged,
    <span key="d">{group.discarded}{group.discardRate !== null && <span className="text-muted-foreground"> · {fmtPercent(group.discardRate)}</span>}</span>,
    cost(group),
    `${duration(group.decisionTimes.toDecision.medianMs)} · ${duration(group.decisionTimes.toDecision.p90Ms)}`,
    `${duration(group.decisionTimes.toMerge.medianMs)} · ${duration(group.decisionTimes.toMerge.p90Ms)}`,
    value(group.rounds.reviewPerDelivery === null ? null : fmtRatio(group.rounds.reviewPerDelivery)),
    value(group.rounds.fixerPerDelivery === null ? null : fmtRatio(group.rounds.fixerPerDelivery)),
    group.escapedDefects === null ? noData : group.escapedDefects,
    group.requirementsDemonstrated === null ? noData : (
      <span key="r">
        {group.requirementsDemonstrated.demonstrated}/{group.requirementsDemonstrated.total}
        {group.requirementsDemonstrated.total > 0 && <span className="text-muted-foreground"> · {fmtPercent(group.requirementsDemonstrated.demonstrated / group.requirementsDemonstrated.total)}</span>}
      </span>
    ),
    group.triageAccuracy === null ? noData : `${group.triageAccuracy.matched}/${group.triageAccuracy.total}`,
  ]

  return (
    <section className="rounded-xl border border-border/50 bg-card p-4 space-y-3" aria-label={t('loopEconomics.title')} data-testid="loop-economics-card">
      <div className="flex items-center gap-2">
        <Scale className="h-4 w-4 text-accent-highlight" aria-hidden="true" />
        <h3 className="text-sm font-medium">{t('loopEconomics.title')}</h3>
        <span className="text-[10px] text-muted-foreground">{t('loopEconomics.subtitle')}</span>
      </div>
      {failed && <p role="status" className="text-xs text-destructive">{t('loopEconomics.unavailable')}</p>}
      {!data && loading && <p role="status" className="text-xs text-muted-foreground">{t('loopEconomics.loading')}</p>}
      {data && data.byLoop.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="loop-economics-empty">{t('loopEconomics.empty')}</p>
      )}
      {data && data.byLoop.length > 0 && <>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{t('loopEconomics.title')}</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-normal">{t('loopEconomics.columns.loop')}</th>
                {columns.map((column) => (
                  <th key={column} scope="col" className="py-1.5 pr-3 font-normal text-right whitespace-nowrap">{t(`loopEconomics.columns.${column}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.byLoop.map((loop) => (
                <tr key={loop.loopId ?? `name:${loop.loopName}`} className="border-t border-border/30" data-testid="loop-economics-row">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap">{loop.loopName || t('loopEconomics.unnamedLoop')}</th>
                  {loop.hasData
                    ? cells(loop).map((cell, index) => <td key={columns[index]} className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">{cell}</td>)
                    : <td colSpan={columns.length} className="py-1.5 pr-3 text-left text-muted-foreground">{t('loopEconomics.noData')}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('loopEconomics.note')}</p>
        {data.sources.escapedDefects === 'untracked' && (
          <p className="text-[11px] text-muted-foreground" data-testid="loop-economics-untracked">{t('loopEconomics.escapedUntracked')}</p>
        )}
      </>}
    </section>
  )
}
