import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../lib/api'
import { getDateFnsLocale } from '../lib/i18n'
import { formatDistanceToNow } from 'date-fns'
import { Trash2, ClipboardList, GitCompareArrows, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { JobComparisonModal } from './JobComparisonModal'
import type { JobSummary, JobStatus, JobPriority } from '../types'
import { useDesktop } from '../hooks/useDesktop'
import { formatCommandForProvider } from '../lib/format-command'
import { useMovableResizableModal } from '../hooks/useMovableResizableModal'
import { ResizeGrips } from './ui/ResizeGrips'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<JobStatus, { variant: BadgeVariant; labelKey: string; tooltipKey: string }> = {
  running: { variant: 'running', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { variant: 'success', labelKey: 'statusLabel.done', tooltipKey: 'statusTooltip.completed' },
  failed: { variant: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  canceled: { variant: 'canceled', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  queued: { variant: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queuedToRun' },
  zombie_terminated: { variant: 'failed', labelKey: 'statusLabel.zombie', tooltipKey: 'statusTooltip.zombie' },
  skipped: { variant: 'warning', labelKey: 'statusLabel.skipped', tooltipKey: 'statusTooltip.skipped' },
}

const ALL_STATUSES: JobStatus[] = ['running', 'completed', 'failed', 'canceled', 'zombie_terminated', 'queued', 'skipped']

const PRIORITY_STYLES: Record<JobPriority, { className: string; labelKey: string }> = {
  critical: { className: 'bg-red-500/15 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive border-red-500/30 aurora-light:border-destructive/30', labelKey: 'recent.priority.critical' },
  high: { className: 'bg-orange-500/15 aurora-light:bg-accent-warning/10 text-orange-400 aurora-light:text-accent-warning border-orange-500/30 aurora-light:border-accent-warning/30', labelKey: 'recent.priority.high' },
  normal: { className: '', labelKey: 'recent.priority.normal' },
  low: { className: 'bg-gray-500/15 aurora-light:bg-muted text-gray-400 aurora-light:text-muted-foreground border-gray-500/30 aurora-light:border-border', labelKey: 'recent.priority.low' },
}

function formatCost(cost: number | null | undefined): string | null {
  if (cost == null || cost === 0) return null
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(3)}`
}

/** Wall-clock duration from started_at / finished_at timestamps */
function formatWallDuration(startedAt: string, finishedAt: string | null | undefined): string | null {
  if (!finishedAt) return null
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 0) return null
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins < 60) return `${mins}m ${s}s`
  const hrs = Math.floor(mins / 60)
  const m = mins % 60
  return `${hrs}h ${m}m`
}

function formatTokens(n: number | null | undefined): string | null {
  if (n == null || n === 0) return null
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatRelTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: getDateFnsLocale() })
  } catch {
    return dateStr
  }
}

// ─── Local-day range helpers ─────────────────────────────────────────────────
// `started_at` is a UTC ISO timestamp (`new Date().toISOString()` server-side)
// while <input type="date"> yields a local calendar day (`YYYY-MM-DD`).
// Comparing them as strings implicitly treats the picked day as a *UTC* day,
// so any job near local midnight lands on the wrong side of the boundary
// (e.g. 00:30 local in UTC+2 is stored under the previous UTC day), and
// `> "${to}T23:59:59"` drops the last second of the "to" day. Compare epoch
// millis against local-day boundaries instead.

/** Epoch ms of local midnight at the start of a `YYYY-MM-DD` day. */
export function localDayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** Epoch ms of the last millisecond of a `YYYY-MM-DD` day, local time. */
export function localDayEndMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  // Date ctor rolls day-overflow into the next month/year.
  return new Date(y, m - 1, d + 1).getTime() - 1
}

/** Whether a timestamp falls within [from, to] local days (inclusive). */
export function isWithinLocalDayRange(startedAt: string, from: string, to: string): boolean {
  if (!from && !to) return true
  const t = new Date(startedAt).getTime()
  if (Number.isNaN(t)) return true // unparsable timestamp — keep the job visible
  if (from && t < localDayStartMs(from)) return false
  if (to && t > localDayEndMs(to)) return false
  return true
}

interface RecentJobsProps {
  jobs: JobSummary[]
  isLoading?: boolean
  onJobsCleared?: () => void
  onProposalClick?: (proposalId: string) => void
  onProposalDelete?: (proposalId: string) => void
}

const PAGE_SIZE = 10

export function RecentJobs({ jobs, isLoading, onJobsCleared, onProposalClick, onProposalDelete }: RecentJobsProps) {
  const { t } = useTranslation('jobs')
  const navigate = useNavigate()
  const { activeProjectId, projects } = useDesktop()
  const activeProvider = projects.find((p) => p.id === activeProjectId)?.provider
  const [statusFilter, setStatusFilter] = useState<JobStatus | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showClearModal, setShowClearModal] = useState(false)
  const [clearFrom, setClearFrom] = useState('')
  const [clearTo, setClearTo] = useState('')
  const [isClearing, setIsClearing] = useState(false)
  const [confirmDeleteProposalId, setConfirmDeleteProposalId] = useState<string | null>(null)
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE)
  const [compareMode, setCompareMode] = useState(false)
  const [compareSelection, setCompareSelection] = useState<string[]>([])
  const [compareJobIds, setCompareJobIds] = useState<[string, string] | null>(null)

  // Movable + resizable geometry for the clear-history confirm modal.
  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating, guardBackdrop } = useMovableResizableModal()

  // Reset display limit when jobs list changes (new job added, etc.)
  useEffect(() => {
    setDisplayLimit(PAGE_SIZE)
  }, [jobs.length])

  function toggleCompareMode() {
    setCompareMode((prev) => !prev)
    setCompareSelection([])
  }

  function toggleCompareSelect(jobId: string) {
    setCompareSelection((prev) => {
      if (prev.includes(jobId)) return prev.filter((id) => id !== jobId)
      if (prev.length >= 2) return prev
      const next = [...prev, jobId]
      if (next.length === 2) setCompareJobIds(next as [string, string])
      return next
    })
  }

  const filteredJobs = jobs.filter((j) => {
    if (statusFilter && j.status !== statusFilter) return false
    return isWithinLocalDayRange(j.started_at, dateFrom, dateTo)
  })

  const clearRangeCount = jobs.filter((j) =>
    isWithinLocalDayRange(j.started_at, clearFrom, clearTo)
  ).length

  async function handleClear(mode: 'all' | 'range') {
    setIsClearing(true)
    try {
      const body: Record<string, string> = {}
      if (mode === 'range') {
        // The server (purgeJobs) string-compares `started_at >= from AND
        // started_at <= to` against UTC ISO timestamps, so send full ISO
        // local-day boundaries: a raw `YYYY-MM-DD` "to" would exclude the
        // entire selected end day (and both ends would drift by the UTC
        // offset), diverging from the count previewed on the button.
        if (clearFrom) body.from = new Date(localDayStartMs(clearFrom)).toISOString()
        if (clearTo) body.to = new Date(localDayEndMs(clearTo)).toISOString()
      }
      const res = await fetch(`${getApiBase()}/jobs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json() as { deleted: number }
        toast.success(t('recent.toast.cleared', { count: data.deleted }))
        setShowClearModal(false)
        setClearFrom('')
        setClearTo('')
        onJobsCleared?.()
      } else {
        toast.error(t('recent.toast.clearFailed'))
      }
    } catch {
      toast.error(t('recent.toast.networkError'))
    } finally {
      setIsClearing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 bg-muted/30 rounded-md animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-card/50 p-8 text-center space-y-2">
        <ClipboardList className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <p className="text-sm font-medium text-muted-foreground">{t('recent.emptyTitle')}</p>
        <p className="text-xs text-muted-foreground/60">
          {t('recent.emptyDescription')}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-2">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              statusFilter === null
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            {t('recent.filterAll', { count: jobs.length })}
          </button>
          {ALL_STATUSES.map((s) => {
            const count = jobs.filter((j) => j.status === s).length
            if (count === 0) return null
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {t('recent.filterStatus', { status: t(`statusName.${s}`), count })}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-6 rounded border border-border bg-input px-1.5 text-[10px] text-foreground"
            title={t('recent.fromDate')}
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-6 rounded border border-border bg-input px-1.5 text-[10px] text-foreground"
            title={t('recent.toDate')}
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => { setDateFrom(''); setDateTo('') }}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('recent.clear')}
            </button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`h-6 w-6 p-0 transition-colors ${compareMode ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={toggleCompareMode}
              >
                <GitCompareArrows className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{compareMode ? t('recent.exitCompareMode') : t('recent.compareTwoJobs')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => setShowClearModal(true)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('recent.clearJobs')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Compare mode banner */}
      {compareMode && (
        <div className="flex items-center justify-between rounded-md bg-accent/40 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>
            {compareSelection.length === 0 && t('recent.selectTwoToCompare')}
            {compareSelection.length === 1 && t('recent.selectOneMore')}
            {compareSelection.length === 2 && t('recent.readyToCompare')}
          </span>
          {compareSelection.length === 2 && (
            <button
              type="button"
              className="text-[10px] font-medium text-foreground hover:underline"
              onClick={() => setCompareJobIds(compareSelection as [string, string])}
            >
              {t('recent.compareAction')}
            </button>
          )}
        </div>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span className="w-14">{t('recent.colStatus')}</span>
        <span className="flex-1 min-w-0">{t('recent.colCommand')}</span>
        <div className="flex items-center gap-3 shrink-0">
          <span className="w-14 text-right">{t('recent.colDuration')}</span>
          <span className="w-12 text-right">{t('recent.colTokens')}</span>
          <span className="w-12 text-right">{t('recent.colCost')}</span>
          <span className="w-20 text-right">{t('recent.colStarted')}</span>
        </div>
      </div>

      {/* Job rows */}
      <div className="space-y-0.5">
        {filteredJobs.slice(0, displayLimit).map((job) => {
          const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
          const cost = formatCost(job.total_cost_usd)
          const duration = formatWallDuration(job.started_at, job.finished_at)
          const tokens = formatTokens(
            ((job.tokens_in ?? 0) +
              (job.tokens_out ?? 0) +
              (job.tokens_cache_read ?? 0) +
              (job.tokens_cache_create ?? 0)) || null,
          )

          const isProposal = job.id.startsWith('proposal:')
          const proposalId = isProposal ? job.id.replace('proposal:', '') : null

          const isSelected = compareSelection.includes(job.id)
          const isDisabled = compareMode && !isProposal && compareSelection.length === 2 && !isSelected
          const activateRow = () => {
            if (compareMode && !isProposal) {
              toggleCompareSelect(job.id)
              return
            }
            if (isProposal && proposalId) {
              onProposalClick?.(proposalId)
            } else {
              navigate(`/jobs/${job.id}`)
            }
          }

          return (
            <div
              key={job.id}
              role="button"
              tabIndex={0}
              className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer group ${
                isSelected
                  ? 'bg-accent/70 ring-1 ring-border'
                  : isDisabled
                  ? 'opacity-40 cursor-not-allowed'
                  : 'hover:bg-accent/50'
              }`}
              onClick={activateRow}
              onKeyDown={(e) => {
                // Nested controls (for example proposal delete) own their keys.
                if (e.target !== e.currentTarget) return
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                activateRow()
              }}
            >
              {/* Status badge */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant={statusInfo.variant}>{t(statusInfo.labelKey)}</Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{t(statusInfo.tooltipKey)}</TooltipContent>
              </Tooltip>

              {/* Priority badge (only for non-normal) */}
              {job.priority && job.priority !== 'normal' && (
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border ${PRIORITY_STYLES[job.priority].className}`}>
                  {t(PRIORITY_STYLES[job.priority].labelKey)}
                </span>
              )}

              {/* Profile badge */}
              {job.profile_name && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium border border-accent-primary/40 bg-accent-primary/10 text-accent-primary/90">
                      {job.profile_name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('recent.profileTooltip', { name: job.profile_name })}</TooltipContent>
                </Tooltip>
              )}

              {/* Command */}
              <div className="flex items-center gap-1 flex-1 min-w-0">
                {job.pipeline_id && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link2 className="w-3 h-3 text-accent-primary/60 shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('recent.pipelinePart')}
                      {job.depends_on_job_id && ` ${t('recent.pipelineDependsOn')}`}
                      {job.skip_reason && ` — ${job.skip_reason}`}
                    </TooltipContent>
                  </Tooltip>
                )}
                <code className="text-xs text-foreground/80 truncate">
                  {formatCommandForProvider(job.command, activeProvider)}
                </code>
              </div>

              {/* Meta */}
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground shrink-0">
                <span className="w-14 text-right">{duration ?? '—'}</span>
                <span className="w-12 text-right">{tokens ? `${tokens}` : '—'}</span>
                <span className="w-12 text-right">{cost ?? '—'}</span>
                <span className="w-20 text-right">{formatRelTime(job.started_at)}</span>
                {isProposal && proposalId && (
                  <button
                    type="button"
                    className="w-4 h-4 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteProposalId(proposalId) }}
                    title={t('recent.deleteProposal')}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Load more */}
      {filteredJobs.length > displayLimit && (
        <div className="pt-1 text-center">
          <button
            type="button"
            onClick={() => setDisplayLimit((prev) => prev + PAGE_SIZE)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded hover:bg-accent/50"
          >
            {t('recent.loadMore', { count: filteredJobs.length - displayLimit })}
          </button>
        </div>
      )}

      {/* Clear jobs modal */}
      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={guardBackdrop(() => setShowClearModal(false))}>
          <div
            ref={panelRef}
            className="w-80 rounded-xl border border-border/30 bg-popover p-4 shadow-lg space-y-4"
            onClick={(e) => e.stopPropagation()}
            style={panelStyle}
          >
            <div
              {...headerHandleProps}
              className={isFloating ? 'cursor-grab active:cursor-grabbing' : undefined}
            >
              <h3 className="text-sm font-semibold">{t('recent.clearModal.title')}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('recent.clearModal.jobsInHistory', { count: jobs.length })}
              </p>
            </div>

            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              disabled={isClearing}
              onClick={() => handleClear('all')}
            >
              {t('recent.clearModal.clearAll', { count: jobs.length })}
            </Button>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('recent.clearModal.orByRange')}</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={clearFrom}
                  onChange={(e) => setClearFrom(e.target.value)}
                  className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
                  placeholder={t('recent.clearModal.fromPlaceholder')}
                />
                <input
                  type="date"
                  value={clearTo}
                  onChange={(e) => setClearTo(e.target.value)}
                  className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
                  placeholder={t('recent.clearModal.toPlaceholder')}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isClearing || (!clearFrom && !clearTo)}
                onClick={() => handleClear('range')}
              >
                {(clearFrom || clearTo) ? t('recent.clearModal.clearInRange', { count: clearRangeCount }) : t('recent.clearModal.clearRange')}
              </Button>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShowClearModal(false)}
            >
              {t('common:actions.cancel')}
            </Button>
          </div>
          <ResizeGrips handles={resizeHandles} />
        </div>
      )}

      {/* Delete proposal confirmation */}
      <Dialog open={confirmDeleteProposalId !== null} onOpenChange={(o) => !o && setConfirmDeleteProposalId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('recent.deleteProposalConfirm.title')}</DialogTitle>
            <DialogDescription>
              {t('recent.deleteProposalConfirm.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteProposalId(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmDeleteProposalId) onProposalDelete?.(confirmDeleteProposalId)
                setConfirmDeleteProposalId(null)
              }}
            >
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Job comparison modal */}
      {compareJobIds && (
        <JobComparisonModal
          jobIds={compareJobIds}
          onClose={() => {
            setCompareJobIds(null)
            setCompareSelection([])
            setCompareMode(false)
          }}
        />
      )}
    </div>
  )
}
