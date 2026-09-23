/**
 * ContextScopeSlider
 *
 * 6-stop snap slider for the Explore-mode context scope. Drag the thumb,
 * click on a stop dot, or use keyboard ← → Home End. Renders a `Custom`
 * pill when the bound booleans don't match any preset.
 *
 * Source of truth = the parent's `ContextScope` (five booleans). The slider
 * derives its visual position from those booleans on every render; user drags
 * write back the booleans of the snapped preset via `onChange`.
 *
 * See openspec/changes/add-spec-context-slider.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  estimateCostUsd, estimateInputTokens, tierFromScope, timeHintForTier,
  type ContextBudget, type ContextScope,
} from '../types/context-scope'

interface Preset {
  id: 'minimal' | 'light' | 'standard' | 'rich' | 'max' | 'desktop'
  scope: ContextScope
}

// Labels and cost summaries live in the `addspec` i18n namespace under
// `contextScope.preset.<id>` / `contextScope.presetCost.<id>`.
export const PRESETS: readonly Preset[] = [
  {
    id: 'minimal',
    scope: { specrails: false, openspec: false, full: false, mcp: false, contractRefine: false },
  },
  {
    id: 'light',
    scope: { specrails: true, openspec: false, full: false, mcp: false, contractRefine: false },
  },
  {
    id: 'standard',
    scope: { specrails: true, openspec: true, full: false, mcp: false, contractRefine: false },
  },
  {
    id: 'rich',
    scope: { specrails: true, openspec: true, full: true, mcp: false, contractRefine: false },
  },
  {
    id: 'max',
    scope: { specrails: true, openspec: true, full: true, mcp: false, contractRefine: true },
  },
  {
    id: 'desktop',
    scope: { specrails: true, openspec: true, full: true, mcp: true, contractRefine: true, userMcp: true },
  },
] as const

function scopesEqual(a: ContextScope, b: ContextScope): boolean {
  return a.specrails === b.specrails
    && a.openspec === b.openspec
    && a.full === b.full
    && a.mcp === b.mcp
    && a.contractRefine === b.contractRefine
    && (a.userMcp ?? false) === (b.userMcp ?? false)
}

/** Finds the preset index matching the given scope exactly, or -1 for Custom. */
export function presetIndexFor(scope: ContextScope): number {
  return PRESETS.findIndex((p) => scopesEqual(p.scope, scope))
}

/** Computes a synthetic float [0..5] cost-rank for an off-preset (Custom) scope. */
function customRank(scope: ContextScope): number {
  // Map each boolean to an additive cost weight; values picked to roughly
  // interpolate between preset stops.
  const weights = {
    specrails: 1.0,
    openspec: 1.0,
    full: 1.0,
    contractRefine: 1.0,
    mcp: 1.0,
    userMcp: 1.0,
  }
  let r = 0
  if (scope.specrails) r += weights.specrails
  if (scope.openspec) r += weights.openspec
  if (scope.full) r += weights.full
  if (scope.contractRefine) r += weights.contractRefine
  if (scope.mcp) r += weights.mcp
  if (scope.userMcp) r += weights.userMcp
  return Math.max(0, Math.min(5, r))
}

interface ContextScopeSliderProps {
  value: ContextScope
  onChange: (next: ContextScope) => void
  budget?: ContextBudget | null
  budgetError?: boolean
  model?: string
  maxPresetId?: Preset['id']
  /** Optional callback to expose the active preset id (or 'custom') to the parent. */
  onPresetChange?: (presetId: Preset['id'] | 'custom') => void
  /** When false, the SMASH-capable hint is not rendered even if contractRefine is
   *  on. Defaults to true for backward compatibility with all existing call sites. */
  smashCapable?: boolean
}

function formatTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tok`
  return `~${n} tok`
}

function formatCost(n: number): string {
  if (n < 0.01) return `~$${n.toFixed(4)}`
  return `~$${n.toFixed(2)}`
}

export function ContextScopeSlider({
  value,
  onChange,
  budget = null,
  budgetError = false,
  model = 'sonnet',
  maxPresetId = 'desktop',
  onPresetChange,
  smashCapable = true,
}: ContextScopeSliderProps) {
  const { t } = useTranslation('addspec')
  const railRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [dragPos, setDragPos] = useState<number | null>(null)

  const maxPresetIndex = Math.max(0, PRESETS.findIndex((p) => p.id === maxPresetId))
  const visiblePresets = PRESETS.slice(0, maxPresetIndex + 1)
  const activeIndex = presetIndexFor(value)
  const isCustom = activeIndex < 0
  const activePreset = activeIndex >= 0 ? PRESETS[activeIndex] : null
  const thumbRank = Math.min(isCustom ? customRank(value) : activeIndex, maxPresetIndex)

  useEffect(() => {
    onPresetChange?.(activePreset?.id ?? 'custom')
  }, [activePreset, onPresetChange])

  const applyPreset = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(maxPresetIndex, idx))
    onChange(PRESETS[clamped].scope)
  }, [maxPresetIndex, onChange])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const last = maxPresetIndex
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      applyPreset((activeIndex < 0 ? Math.round(thumbRank) : activeIndex) + 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      applyPreset((activeIndex < 0 ? Math.round(thumbRank) : activeIndex) - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      applyPreset(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      applyPreset(last)
    }
  }, [activeIndex, thumbRank, maxPresetIndex, applyPreset])

  const positionFromPointer = useCallback((clientX: number): number => {
    const rail = railRef.current
    if (!rail) return 0
    const r = rail.getBoundingClientRect()
    const pct = (clientX - r.left) / Math.max(1, r.width)
    return Math.max(0, Math.min(1, pct))
  }, [])

  const snapFromPointer = useCallback((clientX: number): number => {
    const pct = positionFromPointer(clientX)
    return Math.round(pct * maxPresetIndex)
  }, [maxPresetIndex, positionFromPointer])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    setDragPos(positionFromPointer(e.clientX))
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [positionFromPointer])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    setDragPos(positionFromPointer(e.clientX))
  }, [dragging, positionFromPointer])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    setDragging(false)
    setDragPos(null)
    applyPreset(snapFromPointer(e.clientX))
  }, [dragging, snapFromPointer, applyPreset])

  // While dragging the thumb tracks the pointer; otherwise it sits at the
  // snapped/derived rank.
  const thumbPct = useMemo(() => {
    if (dragging && dragPos !== null) return dragPos
    return maxPresetIndex === 0 ? 0 : thumbRank / maxPresetIndex
  }, [dragging, dragPos, maxPresetIndex, thumbRank])

  const costLine = isCustom
    ? t('contextScope.customMix')
    : (activePreset ? t(`contextScope.presetCost.${activePreset.id}`) : '')
  const tier = tierFromScope(value)
  const numericLine = budgetError || !budget
    ? t('contextScope.estimateUnavailable', { tier })
    : `${tier} · ${formatTokens(estimateInputTokens(value, budget))} · ${formatCost(estimateCostUsd(value, budget, model))} · ${timeHintForTier(tier)}`

  return (
    <div className="space-y-2 select-none" data-testid="context-scope-slider">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t('contextScope.heading')}
          </span>
          {isCustom ? (
            <span
              className="rounded-full bg-accent-warning/15 px-2 py-0.5 text-[10px] font-semibold text-accent-warning"
              data-testid="scope-custom-pill"
            >
              {t('contextScope.custom')}
            </span>
          ) : null}
        </div>
        <span className="text-[11px] font-medium text-foreground" data-testid="context-awareness-tier">{tier}</span>
      </div>
      <div className="flex justify-between text-[10px] font-medium text-muted-foreground">
        {visiblePresets.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(i)}
            className={`px-1 cursor-pointer hover:text-foreground transition-colors ${
              activeIndex === i ? 'text-foreground font-semibold' : ''
            }`}
            data-testid={`scope-stop-${p.id}`}
          >
            {t(`contextScope.preset.${p.id}`)}
          </button>
        ))}
      </div>
      <div
        ref={railRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={maxPresetIndex}
        aria-valuenow={activeIndex < 0 ? Math.round(thumbRank) : activeIndex}
        aria-valuetext={isCustom ? t('contextScope.custom') : (activePreset ? t(`contextScope.preset.${activePreset.id}`) : '')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative h-2 rounded-full bg-muted/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {/* Stops */}
        {visiblePresets.map((_, i) => (
          <span
            key={i}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-muted-foreground/70 pointer-events-none"
            style={{ left: `${maxPresetIndex === 0 ? 0 : (i / maxPresetIndex) * 100}%` }}
          />
        ))}
        {/* Filled portion */}
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-primary/60 pointer-events-none"
          style={{ width: `${thumbPct * 100}%` }}
        />
        {/* Thumb */}
        <div
          data-testid="scope-thumb"
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-background border-2 ${
            isCustom ? 'border-accent-warning' : 'border-primary'
          } shadow-sm pointer-events-none ${dragging ? '' : 'transition-[left] duration-150'}`}
          style={{ left: `${thumbPct * 100}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground" data-testid="scope-cost-line">
        {costLine} · {numericLine}
      </p>
      {value.contractRefine && smashCapable && (
        <div
          className="flex items-start gap-1.5 rounded-md border border-accent-highlight/40 bg-accent-highlight/10 px-2 py-1.5 text-[10px] text-foreground/80"
          data-testid="scope-smash-hint"
        >
          <span aria-hidden className="text-accent-highlight">⊢→</span>
          <span>
            <strong className="text-accent-highlight">{t('contextScope.smashCapable')}</strong> · {t('contextScope.smashHint')}
          </span>
        </div>
      )}
    </div>
  )
}
