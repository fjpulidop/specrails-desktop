/**
 * LoopStepExplorer — premium step-grouped log exploration for loop jobs.
 *
 * Replaces the flat/phase-grouped LogViewer on BOTH job surfaces (board
 * JobDetailPage + mission JobDetailModal) when `job.command` starts with
 * `loop:`. Non-loop jobs keep the legacy LogViewer untouched.
 *
 * Interaction model:
 *  - Overview strip: the loop's topology as live chips (pending → running →
 *    ok/failed/interrupted), decider verdict arrows, iteration counter.
 *    Clicking a chip focuses that node's LATEST step box.
 *  - Follow mode (default): previous steps auto-collapse, the running step is
 *    expanded with autoscroll. Any focus/toggle/scroll-up pauses follow and a
 *    floating "Resume follow" pill brings it back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Copy, ChevronsUpDown, ChevronsDownUp } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { EventRow } from '../../types'
import {
  buildChips,
  cleanStepTitle,
  groupByLoopStep,
  segmentStatus,
  type LoopLogModel,
} from './loop-log-model'
import { LoopOverviewStrip } from './LoopOverviewStrip'
import { LoopStepSection, LoopSetupSection, SETUP_KEY } from './LoopStepSection'
import { useLogTicketActions } from '../../hooks/useLogTicketActions'

export interface LoopStepExplorerProps {
  events: EventRow[]
  /** Job status — drives running/interrupted derivation and the follow pill. */
  jobStatus?: string
  isLoading?: boolean
  variant?: 'page' | 'glass'
  /** Project scope for `#N` ticket refs in step-box lines — defaults to the
   *  active project (board page); mission JobDetailModal passes its own. */
  projectId?: string
}

function PulseDot() {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60" />
      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent-primary" />
    </span>
  )
}

export function LoopStepExplorer({
  events,
  jobStatus,
  isLoading,
  variant = 'page',
  projectId,
}: LoopStepExplorerProps) {
  const { t, i18n: i18nInstance } = useTranslation('jobs')
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<'follow' | 'manual'>('follow')
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionElsRef = useRef(new Map<string, HTMLDivElement>())
  const onOpenTicket = useLogTicketActions(projectId)

  // i18nInstance.language: parseEvent localises the result summary line —
  // recompute when the UI language changes (same rule as LogViewer).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model = useMemo(() => groupByLoopStep(events), [events, i18nInstance.language])

  const settled = jobStatus != null && jobStatus !== 'running' && jobStatus !== 'queued'
  const isJobRunning = jobStatus === 'running'

  const segStatuses = useMemo(
    () =>
      model.segments.map((s, i) =>
        segmentStatus(s, { isLast: i === model.segments.length - 1, jobSettled: settled }),
      ),
    [model, settled],
  )

  const allKeys = useMemo(() => {
    const keys = model.segments.map((s) => s.key)
    if (model.setup.length > 0) keys.push(SETUP_KEY)
    return keys
  }, [model])

  // Follow mode keeps exactly the latest section open (the running step, or the
  // final step once settled; setup when no step has started yet).
  const followKey =
    model.segments.length > 0 ? model.segments[model.segments.length - 1].key : SETUP_KEY

  const effectiveExpanded = useMemo(() => {
    if (filter) return new Set(allKeys) // filtering searches EVERY section
    if (mode === 'follow') return new Set([followKey])
    return manualExpanded
  }, [filter, mode, followKey, manualExpanded, allKeys])

  const effectiveExpandedRef = useRef(effectiveExpanded)
  effectiveExpandedRef.current = effectiveExpanded
  const modelRef = useRef<LoopLogModel>(model)
  modelRef.current = model

  // ── Follow / focus actions ────────────────────────────────────────────────
  const toManual = useCallback((mutate?: (draft: Set<string>) => void) => {
    const draft = new Set(effectiveExpandedRef.current)
    mutate?.(draft)
    setManualExpanded(draft)
    setMode('manual')
  }, [])

  const handleToggle = useCallback(
    (key: string) => {
      toManual((draft) => {
        if (draft.has(key)) draft.delete(key)
        else draft.add(key)
      })
    },
    [toManual],
  )

  const focusSegment = useCallback(
    (key: string) => {
      toManual((draft) => draft.add(key))
      // Scroll after the expansion renders.
      requestAnimationFrame(() => {
        sectionElsRef.current.get(key)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      })
    },
    [toManual],
  )

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const resumeFollow = useCallback(() => {
    setMode('follow')
    requestAnimationFrame(scrollToBottom)
  }, [scrollToBottom])

  const expandAll = useCallback(() => {
    setManualExpanded(new Set(allKeys))
    setMode('manual')
  }, [allKeys])

  const collapseAll = useCallback(() => {
    setManualExpanded(new Set())
    setMode('manual')
  }, [])

  // Autoscroll while following.
  useEffect(() => {
    if (mode === 'follow' && !filter) scrollToBottom()
  }, [model.totalLines, model.segments.length, mode, filter, scrollToBottom])

  // Scrolling away from the bottom pauses follow (programmatic scrolls land AT
  // the bottom, so they never trip this — same idiom as LogViewer's autoScroll).
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el || mode !== 'follow') return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance > 80) toManual()
  }, [mode, toManual])

  const setSectionRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) sectionElsRef.current.set(key, el)
    else sectionElsRef.current.delete(key)
  }, [])

  // ── Copy ──────────────────────────────────────────────────────────────────
  const handleCopyStep = useCallback(
    (key: string) => {
      const seg = modelRef.current.segments.find((s) => s.key === key)
      const text =
        key === SETUP_KEY
          ? modelRef.current.setup.map((l) => l.content).join('\n')
          : (seg?.lines ?? []).map((l) => l.content).join('\n')
      navigator.clipboard
        .writeText(text)
        .then(() => toast.success(t('loopExplorer.copied')))
        .catch(() => toast.error(t('logViewer.copyFailed')))
    },
    [t],
  )

  const handleCopyAll = useCallback(() => {
    const m = modelRef.current
    const parts: string[] = m.setup.map((l) => l.content)
    for (const seg of m.segments) {
      parts.push(`── Step ${seg.meta.index} · ${cleanStepTitle(seg.meta.title)} ──`)
      for (const l of seg.lines) parts.push(l.content)
    }
    navigator.clipboard
      .writeText(parts.join('\n'))
      .then(() => toast.success(t('logViewer.copySuccess')))
      .catch(() => toast.error(t('logViewer.copyFailed')))
  }, [t])

  // ── Derived UI data ───────────────────────────────────────────────────────
  const chips = useMemo(
    () => buildChips(model, { jobSettled: settled, jobFailed: jobStatus === 'failed' }),
    [model, settled, jobStatus],
  )

  const iterLimit =
    model.graphMeta?.iterationLimit ?? model.graphMeta?.graph.config.maxIterations ?? null
  const iterationInfo =
    model.maxIteration > 0 ? { current: model.maxIteration, limit: iterLimit } : null

  const filteredCount = useMemo(() => {
    if (!filter) return model.totalLines
    const f = filter.toLowerCase()
    let n = model.setup.filter((l) => l.content.toLowerCase().includes(f)).length
    for (const s of model.segments) {
      n += s.lines.filter((l) => l.content.toLowerCase().includes(f)).length
    }
    return n
  }, [filter, model])

  const lastSegment = model.segments[model.segments.length - 1]
  const waiting = isJobRunning && (model.segments.length === 0 || lastSegment?.end != null)

  // ── Empty / loading states (mirrors LogViewer) ────────────────────────────
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">{t('logViewer.loading')}</p>
      </div>
    )
  }

  if (model.totalLines === 0 && model.segments.length === 0) {
    return (
      <div data-testid="loop-step-explorer" className="flex-1 flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          {isJobRunning && <PulseDot />}
          {isJobRunning ? t('loopExplorer.waiting') : t('logViewer.empty')}
        </p>
      </div>
    )
  }

  const barPad = variant === 'glass' ? 'px-3 py-1.5' : 'px-4 py-2'

  return (
    <div data-testid="loop-step-explorer" className="relative flex flex-col h-full">
      {/* Top bar — filter, expand/collapse all, follow state, copy + count in
          the SAME trailing position as LogViewer. */}
      <div className={cn('border-b border-border flex items-center gap-2', barPad)}>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder={t('logViewer.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-7 h-7"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground/50 hover:text-foreground"
          onClick={expandAll}
          aria-label={t('loopExplorer.expandAll')}
          title={t('loopExplorer.expandAll')}
        >
          <ChevronsUpDown className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground/50 hover:text-foreground"
          onClick={collapseAll}
          aria-label={t('loopExplorer.collapseAll')}
          title={t('loopExplorer.collapseAll')}
        >
          <ChevronsDownUp className="w-3.5 h-3.5" />
        </Button>
        {mode === 'follow' && isJobRunning && (
          <span className="flex items-center gap-1.5 text-[10px] text-accent-primary shrink-0">
            <PulseDot />
            {t('loopExplorer.follow')}
          </span>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground/50 hover:text-foreground"
          onClick={handleCopyAll}
          aria-label={t('logViewer.copySuccess')}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {t('logViewer.lineCount', { filtered: filteredCount, total: model.totalLines })}
        </span>
      </div>

      {/* Overview strip — the loop's live circuit */}
      <LoopOverviewStrip
        chips={chips}
        iteration={iterationInfo}
        onChipClick={focusSegment}
        variant={variant}
      />

      {/* Step-grouped log */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 text-xs"
      >
        {model.setup.length > 0 && (
          <LoopSetupSection
            lines={model.setup}
            collapsed={!effectiveExpanded.has(SETUP_KEY)}
            filter={filter}
            onToggle={handleToggle}
            setRef={setSectionRef}
            onOpenTicket={onOpenTicket}
          />
        )}
        {model.segments.map((seg, i) => (
          <LoopStepSection
            key={seg.key}
            segment={seg}
            status={segStatuses[i]}
            collapsed={!effectiveExpanded.has(seg.key)}
            filter={filter}
            onToggle={handleToggle}
            onCopy={handleCopyStep}
            setRef={setSectionRef}
            onOpenTicket={onOpenTicket}
          />
        ))}
        {waiting && (
          <div
            data-testid="loop-waiting-row"
            className="mt-3 flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground/70 italic"
          >
            <PulseDot />
            {t('loopExplorer.waiting')}
          </div>
        )}
      </div>

      {/* Resume-follow pill — floating premium affordance while paused live */}
      {mode === 'manual' && isJobRunning && !filter && (
        <button
          type="button"
          data-testid="resume-follow-pill"
          onClick={resumeFollow}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full glass-card border border-accent-primary/30 px-3 py-1.5 text-[11px] font-medium text-foreground shadow-lg hover:border-accent-primary/60 transition-colors cursor-pointer animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <PulseDot />
          {t('loopExplorer.resumeFollow')}
        </button>
      )}
    </div>
  )
}
