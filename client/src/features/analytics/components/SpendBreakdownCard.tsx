import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import type { CategoryBreakdownEntry, SpendCategory, SpendingResponse, Surface } from '../types/spending'
import { SURFACE_LABEL } from '../types/spending'
import { useCategoryColors } from '../lib/category-colors'
import { InfoHint } from './InfoHint'
import { formatTokens } from '../../../lib/format-tokens'
import { isPlanBilledSpend, useBilling } from '../lib/use-billing'
import { CostValue } from './CostValue'
import { Skeleton } from '../../../components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  /** Surfaces currently filtered (pressed state of the surface buttons). */
  activeSurfaces?: Surface[]
  /** Toggle a surface filter from an expanded category. */
  onSelectSurface?: (surface: Surface) => void
}

// Estimated part: the category colour, hatched with the card behind it.
const HATCH = 'repeating-linear-gradient(135deg, transparent 0 2px, var(--color-card) 2px 4px)'

/**
 * "On what and why": every AI call of the window folded into five categories
 * (implementation, missions, specs, code, support), each with its cost, share,
 * calls, tokens and the one-line reason it exists. Expanding a category lists
 * its surfaces (click to filter) and, for missions, the costliest conversations.
 */
export function SpendBreakdownCard({ data, loading, activeSurfaces, onSelectSurface }: Props) {
  const { t } = useTranslation('analytics')
  const billing = useBilling()
  const [open, setOpen] = useState<SpendCategory | null>(null)

  if (loading && !data) return <Skeleton className="h-40" />
  if (!data) return null

  const categories = data.byCategory ?? []
  const total = data.summary.totalCostUsd
  const active = categories.filter((c) => c.count > 0)
  const idle = categories.filter((c) => c.count === 0)
  const allUnpriced = data.summary.totalRuns > 0 && (data.summary.pricedRuns ?? 1) === 0
  // Same rule as SpendingHero: when every engine is plan-billed the dollars are an
  // API-equivalent estimate, never money that was charged.
  const planBilled = billing.ready && billing.snapshot != null && total > 0 && !allUnpriced && isPlanBilledSpend(data.byProvider, billing)

  return (
    <section aria-labelledby="spend-breakdown-title" className="rounded-xl border border-border/50 bg-card p-4" data-testid="spend-breakdown">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="spend-breakdown-title" className="text-title">{t('breakdown.title')}</h2>
        {planBilled && <p className="text-caption text-muted-foreground" data-testid="breakdown-api-equivalent">{t('hero.apiEquivalent')}</p>}
      </div>

      {active.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/40 p-6 text-center text-sm text-muted-foreground" data-testid="breakdown-empty">
          {t('breakdown.empty')}
        </div>
      ) : (
        <TooltipProvider delayDuration={300}>
        <ul className="flex flex-col divide-y divide-border/40">
          {active.map((entry) => (
            <CategoryRow
              key={entry.category}
              entry={entry}
              total={total}
              expanded={open === entry.category}
              onToggle={() => setOpen((cur) => (cur === entry.category ? null : entry.category))}
              activeSurfaces={activeSurfaces}
              onSelectSurface={onSelectSurface}
              conversations={entry.category === 'missions' ? data.agentMissions?.topConversations ?? [] : []}
            />
          ))}
        </ul>
        </TooltipProvider>
      )}

      {active.length > 0 && idle.length > 0 && (
        <p className="mt-3 text-caption text-muted-foreground" data-testid="breakdown-idle">
          {t('breakdown.noActivity', { categories: idle.map((c) => t(`categories.${c.category}.label`)).join(' · ') })}
        </p>
      )}
    </section>
  )
}

interface RowProps {
  entry: CategoryBreakdownEntry
  total: number
  expanded: boolean
  onToggle: () => void
  activeSurfaces?: Surface[]
  onSelectSurface?: (surface: Surface) => void
  conversations: NonNullable<SpendingResponse['agentMissions']>['topConversations']
}

function CategoryRow({ entry, total, expanded, onToggle, activeSurfaces, onSelectSurface, conversations }: RowProps) {
  const { t } = useTranslation('analytics')
  const label = t(`categories.${entry.category}.label`)
  const color = useCategoryColors()[entry.category]
  const costUnavailable = entry.count > 0 && entry.unpricedCount === entry.count
  const sharePct = total > 0 && !costUnavailable ? (entry.costUsd / total) * 100 : null
  // Hatch only a mixed bar: when all of it is estimated, the "~" already says so.
  const rawEstimatedPct = entry.costUsd > 0 ? Math.min(100, (entry.estimatedCostUsd / entry.costUsd) * 100) : 0
  const estimatedPct = rawEstimatedPct >= 99.5 ? 0 : rawEstimatedPct
  const regionId = `spend-breakdown-${entry.category}`

  return (
    <li className="py-2.5" data-testid={`breakdown-row-${entry.category}`}>
      {/* The one-line "why" is a hover/focus tooltip (and read by screen readers), not visible prose. */}
      <Tooltip>
      <TooltipTrigger asChild>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        data-testid={`breakdown-toggle-${entry.category}`}
        onClick={onToggle}
        className="flex w-full items-start gap-2 rounded-md text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform', expanded && 'rotate-90')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-label font-medium text-foreground">{label}</span>
            <span className="num text-label font-medium" data-testid={`breakdown-cost-${entry.category}`}>
              {costUnavailable ? (
                <span className="text-muted-foreground">{t('breakdown.costUnavailable')}</span>
              ) : (
                <CostValue usd={entry.costUsd} estimated={entry.estimatedCostUsd > 0} />
              )}
            </span>
          </span>
          <span className="sr-only">{t(`categories.${entry.category}.why`)}</span>
          <span className="mt-1.5 flex items-center gap-3">
            <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-background-deep" aria-hidden>
              {sharePct !== null && sharePct > 0 && (
                <span className="flex h-full" style={{ width: `${sharePct}%` }} data-testid={`breakdown-bar-${entry.category}`}>
                  <span className="h-full" style={{ width: `${100 - estimatedPct}%`, background: color }} />
                  {estimatedPct > 0 && <span className="h-full" style={{ width: `${estimatedPct}%`, background: color, backgroundImage: HATCH }} />}
                </span>
              )}
            </span>
            <span className="w-10 shrink-0 text-right text-caption text-foreground num" data-testid={`breakdown-share-${entry.category}`}>
              {sharePct !== null ? `${sharePct < 1 && sharePct > 0 ? '<1' : sharePct.toFixed(0)}%` : '—'}
            </span>
          </span>
        </span>
      </button>
      </TooltipTrigger>
      <TooltipContent>{t(`categories.${entry.category}.why`)}</TooltipContent>
      </Tooltip>
      <div className="ml-5 mt-1 flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground num">
        <span>{t('breakdown.invocations', { count: entry.count })}</span>
        {entry.tokens > 0 && <span>{t('breakdown.tokens', { tokens: formatTokens(entry.tokens) })}</span>}
        {entry.unpricedCount > 0 && !costUnavailable && (
          <InfoHint tone="caution" testId={`breakdown-unpriced-${entry.category}`}>{t('breakdown.unpriced', { count: entry.unpricedCount })}</InfoHint>
        )}
      </div>

      {expanded && (
        <div id={regionId} className="mt-2 ml-5 flex flex-col gap-2">
          <ul className="flex flex-col gap-0.5">
            {entry.surfaces.map((s) => {
              const pressed = activeSurfaces?.includes(s.surface) ?? false
              return (
                <li key={s.surface}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    title={t('breakdown.surfaceFilter', { surface: SURFACE_LABEL[s.surface] })}
                    onClick={() => onSelectSurface?.(s.surface)}
                    data-testid={`breakdown-surface-${s.surface}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      pressed && 'bg-accent/40 ring-1 ring-border',
                    )}
                  >
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="min-w-0 flex-1 truncate text-left text-foreground">{SURFACE_LABEL[s.surface]}</span>
                    <span className="shrink-0 text-muted-foreground num">{t('breakdown.invocations', { count: s.count })}</span>
                    {s.tokens > 0 && <span className="shrink-0 text-muted-foreground num">{formatTokens(s.tokens)}</span>}
                    <CostValue usd={s.costUsd} className="w-16 shrink-0 text-right font-medium" />
                  </button>
                </li>
              )
            })}
          </ul>
          {conversations.length > 0 && (
            <div data-testid="breakdown-conversations">
              <h3 className="px-2 text-caption font-medium text-muted-foreground">{t('breakdown.topConversations')}</h3>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {conversations.map((c) => (
                  <li key={c.conversationId ?? 'unknown'} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                    <span className="min-w-0 flex-1 truncate text-foreground">{c.title?.trim() || t('breakdown.untitled')}</span>
                    <span className="shrink-0 text-muted-foreground num">{t('breakdown.turns', { count: c.turns })}</span>
                    <CostValue usd={c.costUsd} estimated={c.estimatedCostUsd > 0} className="w-16 shrink-0 text-right font-medium" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
