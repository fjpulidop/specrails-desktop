import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, Clock, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import { ARG_ACTIONS, deriveFrameActivity } from '../lib/frame-activity'
import type { EventRow, JobSummary, PhaseDefinition } from '../types'

function formatWallClock(startedAt: string, finishedAt: string | number): string {
  const endMs = typeof finishedAt === 'number' ? finishedAt : new Date(finishedAt).getTime()
  const ms = endMs - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins < 60) return `${mins}m ${s}s`
  const hrs = Math.floor(mins / 60)
  const m = mins % 60
  return `${hrs}h ${m}m`
}

interface PipelineTotals {
  totalCostUsd: number
  /** True when at least one phase reports a null cost — the sum is a lower
   *  bound, rendered with a "≥" prefix + a partial hint (HIGH-10). */
  hasNullCost?: boolean
  /** True when at least one phase's cost is a pricing-table estimate. */
  costEstimated?: boolean
  /** How many phases have no cost recorded (drives the partial hint copy). */
  nullCostCount?: number
  totalTokensIn: number
  totalTokensOut: number
  totalTokensCacheRead: number
  totalTokensCacheCreate: number
  jobCount: number
}

interface JobStatusPanelProps {
  job: JobSummary
  events: EventRow[]
  defaultOpen?: boolean
  pipelineTotals?: PipelineTotals
  /** Live pipeline phase states (key → state); used to label the activity pill. */
  phases?: Record<string, string>
  /** Phase definitions (key → human label) paired with `phases`. */
  phaseDefinitions?: PhaseDefinition[]
}

function extractModifiedFiles(events: EventRow[]): string[] {
  const files = new Set<string>()
  for (const ev of events) {
    if (ev.event_type !== 'log') continue
    try {
      const payload = JSON.parse(ev.payload) as { line?: string }
      const line = payload.line ?? ''
      const match = line.match(
        /(?:Writing|Editing|Created?|Updated?)\s+(?:file:\s*)?([\w./\-]+\.\w+)/i,
      )
      if (match) files.add(match[1])
    } catch {
      // skip unparseable events
    }
  }
  return Array.from(files).slice(0, 20)
}

// Activity derivation (steps + action label) lives in ../lib/frame-activity so
// the dashboard rail metrics count "pasos" from the SAME source as this panel.

interface ActivityState {
  steps: number
  actionKey: string
  actionArg: string
  lastSeenIdx: number
}

const INITIAL_ACTIVITY: ActivityState = { steps: 0, actionKey: '', actionArg: '', lastSeenIdx: 0 }

type ActivityAction = { type: 'reset' } | { type: 'consume'; events: EventRow[] }

function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.type === 'reset') return INITIAL_ACTIVITY
  if (action.type === 'consume') {
    const { events } = action
    // Re-anchor when JobDetailPage front-truncates events[] (the 10000→8000
    // cap reindexes the array). A stale absolute lastSeenIdx would otherwise
    // permanently freeze the steps counter and the action label.
    const start = state.lastSeenIdx > events.length ? events.length : state.lastSeenIdx
    if (events.length <= start) {
      return start === state.lastSeenIdx ? state : { ...state, lastSeenIdx: start }
    }
    let { steps, actionKey, actionArg } = state
    for (let i = start; i < events.length; i++) {
      const d = deriveFrameActivity(events[i])
      if (d.step) steps += d.stepCount ?? 1
      if (d.actionKey) {
        actionKey = d.actionKey
        actionArg = d.actionArg ?? ''
      }
    }
    return { steps, actionKey, actionArg, lastSeenIdx: events.length }
  }
  return state
}

export function JobStatusPanel({
  job,
  events,
  defaultOpen = true,
  pipelineTotals,
  phases,
  phaseDefinitions,
}: JobStatusPanelProps) {
  const { t } = useTranslation('jobs')
  const [open, setOpen] = useState(defaultOpen)
  const modifiedFiles = useMemo(() => extractModifiedFiles(events), [events])

  const isRunning = job.status === 'running'
  const isSuccess = job.status === 'completed'

  // Live duration tick (every 1s) while running — the ONLY genuinely live number.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  // Incremental activity accumulator (steps + current action). Reset on job change.
  const [activity, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY)
  const lastJobIdRef = useRef<string>(job.id)
  useEffect(() => {
    if (lastJobIdRef.current !== job.id) {
      lastJobIdRef.current = job.id
      dispatch({ type: 'reset' })
    }
    dispatch({ type: 'consume', events })
  }, [job.id, events])

  // Auto-hiding explainer (first 8s of a running job).
  const [showExplainer, setShowExplainer] = useState(true)
  useEffect(() => {
    if (!isRunning) return
    setShowExplainer(true)
    const id = window.setTimeout(() => setShowExplainer(false), 8000)
    return () => window.clearTimeout(id)
  }, [isRunning, job.id])

  const durationDisplay = job.finished_at
    ? formatWallClock(job.started_at, job.finished_at)
    : isRunning
      ? formatWallClock(job.started_at, now)
      : '—'

  // Authoritative figures — only meaningful at exit. Never approximated live.
  const costEstimated = !!job.total_cost_usd_estimated
  const costValue =
    job.total_cost_usd != null ? `${costEstimated ? '~' : ''}$${job.total_cost_usd.toFixed(4)}` : null
  const turnsValue = job.num_turns != null ? String(job.num_turns) : null
  const tokensTotal =
    job.tokens_in != null
      ? (job.tokens_in ?? 0) +
        (job.tokens_out ?? 0) +
        (job.tokens_cache_read ?? 0) +
        (job.tokens_cache_create ?? 0)
      : null
  const tokensValue = tokensTotal != null ? `${(tokensTotal / 1000).toFixed(1)}k` : null

  // Activity line.
  const runningPhaseLabel = useMemo(() => {
    if (!phases || !phaseDefinitions) return null
    const def = phaseDefinitions.find((d) => phases[d.key] === 'running')
    return def?.label ?? null
  }, [phases, phaseDefinitions])

  const effectiveActionKey =
    isRunning && activity.steps === 0 ? 'connecting' : activity.actionKey || 'thinking'
  // An ARG action with an empty arg (e.g. Bash with no command) would render a
  // dangling "Running: " / "Searching “”"; fall back to the no-arg "working".
  const hasArg = ARG_ACTIONS.has(effectiveActionKey) && activity.actionArg !== ''
  const labelKey = ARG_ACTIONS.has(effectiveActionKey) && !hasArg ? 'working' : effectiveActionKey
  const actionLabel = hasArg
    ? t(`statusPanel.activity.${labelKey}`, { arg: activity.actionArg })
    : t(`statusPanel.activity.${labelKey}`)
  const pillLabel =
    runningPhaseLabel ?? (isRunning && activity.steps === 0 ? t('statusPanel.activity.starting') : null)
  const stepsLabel = activity.steps > 0 ? t('statusPanel.steps', { count: activity.steps }) : null

  const headerLabel = isRunning
    ? t('statusPanel.inProgress')
    : isSuccess
      ? t('statusPanel.completed')
      : t('statusPanel.failed')

  const frameClass = isRunning
    ? 'border-accent-info/20 bg-accent-info/5'
    : isSuccess
      ? 'border-emerald-500/20 aurora-light:border-accent-success/30 bg-emerald-500/5 aurora-light:bg-accent-success/5'
      : 'border-red-500/20 aurora-light:border-destructive/30 bg-red-500/5 aurora-light:bg-destructive/5'

  const HeaderIcon = isRunning ? Loader2 : isSuccess ? CheckCircle2 : XCircle
  const headerIconClass = isRunning
    ? 'w-4 h-4 text-accent-info shrink-0 animate-spin'
    : isSuccess
      ? 'w-4 h-4 text-emerald-400 aurora-light:text-accent-success shrink-0'
      : 'w-4 h-4 text-red-400 aurora-light:text-destructive shrink-0'

  return (
    <div className={cn('mx-4 my-2 rounded-xl border transition-colors duration-500', frameClass)}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3"
      >
        <HeaderIcon className={headerIconClass} aria-hidden="true" />
        <span className="text-sm font-semibold flex-1 text-left">{headerLabel}</span>

        {/* Quick stat chips — running: duration + pasos (NO cost). terminal: duration + cost + files. */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{durationDisplay}</span>
          {isRunning ? (
            stepsLabel && <span className="tabular-nums">{stepsLabel}</span>
          ) : (
            <>
              {costValue && <span className="tabular-nums text-yellow-400 aurora-light:text-accent-warning">{costValue}</span>}
              {modifiedFiles.length > 0 && (
                <span>{t('statusPanel.filesCount', { count: modifiedFiles.length })}</span>
              )}
            </>
          )}
        </div>

        <ChevronDown
          className={cn(
            'w-4 h-4 text-muted-foreground/40 transition-transform duration-150 shrink-0',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Expandable detail */}
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/20">
          {isRunning ? (
            <>
              {/* ── ZONE 1 · EN CURSO (real facts only) ───────────────────── */}
              <p className="pt-3 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
                {t('statusPanel.zoneInProgress')}
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-stretch">
                {/* Live duration card */}
                <div className="bg-muted/20 rounded-lg px-3 py-2 sm:w-44 shrink-0">
                  <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
                    {t('statusPanel.duration')}
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full bg-accent-info animate-pulse"
                      title={t('statusPanel.liveTooltip')}
                      aria-label={t('statusPanel.liveTooltip')}
                    />
                  </p>
                  <p className="text-sm font-semibold tabular-nums mt-0.5 text-accent-info">
                    {durationDisplay}
                  </p>
                </div>
                {/* Activity strip */}
                <div className="flex-1 flex items-center gap-2 bg-muted/10 rounded-lg px-3 py-2 min-w-0">
                  <Loader2 className="w-3.5 h-3.5 text-accent-info shrink-0 animate-spin" aria-hidden="true" />
                  {pillLabel && (
                    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-accent-info/15 text-accent-info shrink-0">
                      {pillLabel}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {actionLabel}
                  </span>
                  {stepsLabel && (
                    <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
                      · {stepsLabel}
                    </span>
                  )}
                </div>
              </div>

              {showExplainer && (
                <p className="text-[11px] text-muted-foreground/40 leading-snug">
                  {t('statusPanel.explainer')}
                </p>
              )}

              {/* ── ZONE 2 · RESUMEN FINAL — se calcula al terminar ───────── */}
              <p className="pt-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider border-t border-accent-info/10 mt-1">
                {t('statusPanel.zoneFinalPending')}
              </p>
              <div className="grid grid-cols-3 gap-2">
                <PendingMetric
                  label={t('statusPanel.cost')}
                  caption={t('statusPanel.pendingCaption')}
                  tooltip={t('statusPanel.costTooltip')}
                />
                <PendingMetric
                  label={t('statusPanel.turns')}
                  caption={t('statusPanel.pendingCaption')}
                  tooltip={t('statusPanel.pendingTooltip')}
                />
                <PendingMetric
                  label={t('statusPanel.tokens')}
                  caption={t('statusPanel.pendingCaption')}
                  tooltip={t('statusPanel.pendingTooltip')}
                />
              </div>
            </>
          ) : (
            <>
              {/* ── RESUMEN FINAL (authoritative reveal) ──────────────────── */}
              <p className="pt-3 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
                {t('statusPanel.zoneFinal')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SummaryMetric label={t('statusPanel.duration')} value={durationDisplay} />
                <FinalMetric
                  label={t('statusPanel.cost')}
                  value={costValue}
                  valueClass="text-yellow-400 aurora-light:text-accent-warning"
                  naCaption={t('statusPanel.notAvailable')}
                />
                <FinalMetric
                  label={t('statusPanel.turns')}
                  value={turnsValue}
                  naCaption={t('statusPanel.notAvailable')}
                />
                <FinalMetric
                  label={t('statusPanel.tokens')}
                  value={tokensValue}
                  naCaption={t('statusPanel.notAvailable')}
                />
              </div>

              {/* Pipeline total */}
              {pipelineTotals && (
                <div>
                  <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1.5">
                    {t('statusPanel.pipelineTotal', { count: pipelineTotals.jobCount })}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <SummaryMetric
                      label={t('statusPanel.totalCost')}
                      value={`${pipelineTotals.costEstimated ? '~' : ''}${pipelineTotals.hasNullCost ? '≥' : ''}$${pipelineTotals.totalCostUsd.toFixed(4)}`}
                      valueClass="text-yellow-400 aurora-light:text-accent-warning"
                    />
                    <SummaryMetric
                      label={t('statusPanel.totalTokens')}
                      value={`${((pipelineTotals.totalTokensIn +
                        pipelineTotals.totalTokensOut +
                        pipelineTotals.totalTokensCacheRead +
                        pipelineTotals.totalTokensCacheCreate) / 1000).toFixed(1)}k`}
                    />
                  </div>
                  {pipelineTotals.hasNullCost && (
                    <p
                      data-testid="pipeline-partial-hint"
                      className="text-[10px] text-muted-foreground/70 mt-1.5"
                      title={t('statusPanel.pipelinePartialTooltip')}
                    >
                      {t('statusPanel.pipelinePartial', { count: pipelineTotals.nullCostCount ?? 0 })}
                    </p>
                  )}
                </div>
              )}

              {/* Modified files list */}
              {modifiedFiles.length > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1.5">
                    {t('statusPanel.filesModified')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {modifiedFiles.map((f) => (
                      <code
                        key={f}
                        className="text-[10px] font-mono bg-muted/30 px-2 py-0.5 rounded text-cyan-400/80 aurora-light:text-accent-info"
                      >
                        {f}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SummaryMetric({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="bg-muted/20 rounded-lg px-3 py-2">
      <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums mt-0.5', valueClass)}>{value}</p>
    </div>
  )
}

/** Terminal card whose authoritative value may legitimately be null (rare
 *  provider gap) — shows an em-dash + "No disponible" instead of a fake 0. */
function FinalMetric({
  label,
  value,
  valueClass,
  naCaption,
}: {
  label: string
  value: string | null
  valueClass?: string
  naCaption: string
}) {
  return (
    <div className="bg-muted/20 rounded-lg px-3 py-2">
      <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">{label}</p>
      <p
        className={cn(
          'text-sm font-semibold tabular-nums mt-0.5',
          value != null ? valueClass : 'text-muted-foreground',
        )}
      >
        {value ?? '—'}
      </p>
      {value == null && (
        <p className="text-[10px] text-muted-foreground/30 mt-0.5">{naCaption}</p>
      )}
    </div>
  )
}

/** Running-state card for a metric that is unknowable until exit. Never a fake
 *  number — a held em-dash + a clock + "Se calcula al terminar". */
function PendingMetric({
  label,
  caption,
  tooltip,
}: {
  label: string
  caption: string
  tooltip: string
}) {
  return (
    <div
      className="bg-muted/20 rounded-lg px-3 py-2 ring-1 ring-accent-info/10"
      title={tooltip}
    >
      <p className="flex items-center gap-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider">
        {label}
        <Clock className="w-2.5 h-2.5 text-muted-foreground/30" aria-hidden="true" />
      </p>
      <p className="text-sm font-semibold tabular-nums mt-0.5 text-muted-foreground/40">—</p>
      <p className="text-[10px] text-muted-foreground/30 mt-0.5">{caption}</p>
    </div>
  )
}
