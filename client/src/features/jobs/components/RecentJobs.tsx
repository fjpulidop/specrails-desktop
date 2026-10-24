import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { getDateFnsLocale } from '../../../lib/i18n'
import { formatDistanceToNow } from 'date-fns'
import { Trash2, ClipboardList, GitCompareArrows, Link2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import { JobComparisonModal } from './JobComparisonModal'
import type { JobSummary, JobStatus, JobPriority } from '../../../types'
import { useDesktop } from '../../../hooks/useDesktop'
import { formatCommandForProvider } from '../../../lib/format-command'
import { CostValue } from '../../analytics/components/CostValue'
import { jobActivityTimestamp, parseJobTimestamp } from '../lib/job-time'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<JobStatus, { variant: BadgeVariant; labelKey: string; tooltipKey: string }> = {
  running: { variant: 'running', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { variant: 'success', labelKey: 'statusLabel.completed', tooltipKey: 'statusTooltip.completed' },
  failed: { variant: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  canceled: { variant: 'canceled', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  queued: { variant: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queuedToRun' },
  zombie_terminated: { variant: 'failed', labelKey: 'statusLabel.zombie', tooltipKey: 'statusTooltip.zombie' },
  skipped: { variant: 'warning', labelKey: 'statusLabel.skipped', tooltipKey: 'statusTooltip.skipped' },
}

const ALL_STATUSES: JobStatus[] = ['running', 'completed', 'failed', 'canceled', 'zombie_terminated', 'queued', 'skipped']

const PRIORITY_STYLES: Record<JobPriority, { className: string; labelKey: string }> = {
  critical: { className: 'bg-destructive/10 text-destructive border-destructive/30', labelKey: 'recent.priority.critical' },
  high: { className: 'bg-accent-warning/10 text-accent-warning border-accent-warning/30', labelKey: 'recent.priority.high' },
  normal: { className: '', labelKey: 'recent.priority.normal' },
  low: { className: 'bg-muted text-muted-foreground border-border', labelKey: 'recent.priority.low' },
}

/** Wall-clock duration from started_at / finished_at timestamps */
function formatWallDuration(startedAt: string | null, finishedAt: string | null | undefined): string | null {
  const started = parseJobTimestamp(startedAt)
  const finished = parseJobTimestamp(finishedAt)
  if (!started || !finished) return null
  const ms = finished.getTime() - started.getTime()
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatRelTime(dateStr: string | null): string {
  const date = parseJobTimestamp(dateStr)
  if (!date) return '—'
  return formatDistanceToNow(date, { addSuffix: true, locale: getDateFnsLocale() })
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
export function isWithinLocalDayRange(startedAt: string | null, from: string, to: string): boolean {
  if (!from && !to) return true
  const parsed = parseJobTimestamp(startedAt)
  if (!parsed) return true // absent/unparsable timestamp — keep the job visible
  const t = parsed.getTime()
  if (from && t < localDayStartMs(from)) return false
  if (to && t > localDayEndMs(to)) return false
  return true
}

/**
 * "/specrails:implement #15" -> "Implement · #15 Title" once the spec title is
 * known. Falls back to the verbatim command, which stays in the row tooltip.
 */
function humaniseCommand(command: string, titles: Record<number, string> | undefined): string | null {
  if (!titles) return null
  const verb = /^\s*[/$](?:specrails:|sr:)?([a-z][\w-]*)/i.exec(command)?.[1]
  const id = /#(\d+)/.exec(command)?.[1]
  const title = id ? titles[Number(id)] : undefined
  if (!verb || !id || !title) return null
  const label = verb.replace(/-/g, ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} · #${id} ${title}`
}

interface RecentJobsProps {
  jobs: JobSummary[]
  /** Spec titles by ticket id, used to read a command as "Implement · #15 Title". */
  ticketTitles?: Record<number, string>
  isLoading?: boolean
  error?: string | null
  onRetry?: () => void
  onJobsCleared?: () => void
  onProposalClick?: (proposalId: string) => void
  onProposalDelete?: (proposalId: string) => void
}

const PAGE_SIZE = 10

export function RecentJobs({ jobs, ticketTitles, isLoading, error, onRetry, onJobsCleared, onProposalClick, onProposalDelete }: RecentJobsProps) {
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
    return isWithinLocalDayRange(jobActivityTimestamp(j), dateFrom, dateTo)
  })

  const clearRangeCount = jobs.filter((j) =>
    isWithinLocalDayRange(jobActivityTimestamp(j), clearFrom, clearTo)
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

  const loadError = error ? (
    <div role="alert" data-testid="jobs-load-error" className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{t('recent.loadFailed')}</span>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetry} disabled={isLoading}>
          {t('common:actions.retry')}
        </Button>
      )}
    </div>
  ) : null

  if (error && jobs.length === 0) {
    return <div className="rounded-lg border border-border/40 bg-card/50 p-4">{loadError}</div>
  }

  if (isLoading && jobs.length === 0) {
    return (
      <div role="status" aria-busy="true" aria-label={t('recent.loading')} className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 bg-muted/30 rounded-md motion-safe:animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-card/50 p-8 text-center space-y-2">
        <ClipboardList className="w-8 h-8 text-muted-foreground mx-auto" aria-hidden />
        <p className="text-sm font-medium text-foreground">{t('recent.emptyTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {t('recent.emptyDescription')}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => navigate('/')}>
          {t('recent.emptyCta')}
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-2">
      {loadError}
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            aria-pressed={statusFilter === null}
            className={`px-2 py-0.5 rounded text-caption font-medium transition-colors ${
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
                aria-pressed={statusFilter === s}
                className={`px-2 py-0.5 rounded text-caption font-medium transition-colors ${
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
            className="h-6 rounded border border-border bg-input px-1.5 text-caption text-foreground"
            title={t('recent.fromDate')}
            aria-label={t('recent.fromDate')}
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-6 rounded border border-border bg-input px-1.5 text-caption text-foreground"
            title={t('recent.toDate')}
            aria-label={t('recent.toDate')}
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => { setDateFrom(''); setDateTo('') }}
              className="text-caption text-muted-foreground hover:text-foreground transition-colors"
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
                aria-label={compareMode ? t('recent.exitCompareMode') : t('recent.compareTwoJobs')}
                aria-pressed={compareMode}
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
                aria-label={t('recent.clearJobs')}
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
        <div className="flex items-center justify-between rounded-md bg-accent/40 px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            {compareSelection.length === 0 && t('recent.selectTwoToCompare')}
            {compareSelection.length === 1 && t('recent.selectOneMore')}
            {compareSelection.length === 2 && t('recent.readyToCompare')}
          </span>
          {compareSelection.length === 2 && (
            <button
              type="button"
              className="text-xs font-medium text-foreground hover:underline"
              onClick={() => setCompareJobIds(compareSelection as [string, string])}
            >
              {t('recent.compareAction')}
            </button>
          )}
        </div>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-3 px-3 py-1 text-caption font-medium text-muted-foreground">
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
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium border ${PRIORITY_STYLES[job.priority].className}`}>
                  {t(PRIORITY_STYLES[job.priority].labelKey)}
                </span>
              )}

              {/* Profile badge */}
              {job.profile_name && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium border border-accent-primary/40 bg-accent-primary/10 text-accent-primary">
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
                {(() => {
                  const friendly = humaniseCommand(job.command, ticketTitles)
                  const raw = formatCommandForProvider(job.command, activeProvider)
                  return friendly
                    ? <span className="text-xs text-foreground/80 truncate" title={raw}>{friendly}</span>
                    : <code className="text-xs text-foreground/80 truncate">{raw}</code>
                })()}
              </div>

              {/* Meta */}
              <div className="flex items-center gap-3 text-caption num text-muted-foreground shrink-0">
                <span className="w-14 text-right whitespace-nowrap" title={t('recent.colDuration')}>{duration ?? '—'}</span>
                <span className="w-12 text-right" title={t('recent.colTokens')}>{tokens ? `${tokens}` : '—'}</span>
                <span className="w-12 text-right" title={t('recent.colCost')}>
                  <CostValue
                    usd={job.total_cost_usd || null}
                    estimated={Boolean(job.total_cost_usd_estimated)}
                  />
                </span>
                <span className="w-20 text-right whitespace-nowrap" title={t('recent.colStarted')}>
                  {job.status === 'queued' ? '—' : formatRelTime(job.started_at)}
                </span>
                {isProposal && proposalId && (
                  <button
                    type="button"
                    className="w-4 h-4 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteProposalId(proposalId) }}
                    title={t('recent.deleteProposal')}
                    aria-label={t('recent.deleteProposal')}
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
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded hover:bg-accent/50"
          >
            {t('recent.loadMore', { count: filteredJobs.length - displayLimit })}
          </button>
        </div>
      )}

      {/* Clear jobs confirmation (range controls ride in the body) */}
      <ConfirmDialog
        open={showClearModal}
        onOpenChange={setShowClearModal}
        title={t('recent.clearModal.title')}
        description={t('recent.clearModal.jobsInHistory', { count: jobs.length })}
        confirmLabel={t('recent.clearModal.clearAll', { count: jobs.length })}
        busy={isClearing}
        onConfirm={() => handleClear('all')}
      >
        <p className="text-xs text-muted-foreground">{t('recent.clearModal.orByRange')}</p>
        <div className="flex gap-2">
          <input
            type="date"
            value={clearFrom}
            onChange={(e) => setClearFrom(e.target.value)}
            className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
            placeholder={t('recent.clearModal.fromPlaceholder')}
            aria-label={t('recent.clearModal.fromPlaceholder')}
          />
          <input
            type="date"
            value={clearTo}
            onChange={(e) => setClearTo(e.target.value)}
            className="flex-1 h-7 rounded-md border border-border bg-input px-2 text-xs text-foreground"
            placeholder={t('recent.clearModal.toPlaceholder')}
            aria-label={t('recent.clearModal.toPlaceholder')}
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
      </ConfirmDialog>

      {/* Delete proposal confirmation */}
      <ConfirmDialog
        open={confirmDeleteProposalId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteProposalId(null) }}
        title={t('recent.deleteProposalConfirm.title')}
        description={t('recent.deleteProposalConfirm.description')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => {
          if (confirmDeleteProposalId) onProposalDelete?.(confirmDeleteProposalId)
          setConfirmDeleteProposalId(null)
        }}
      />

      {/* Job comparison modal */}
      {compareJobIds && (
        <JobComparisonModal
          jobIds={compareJobIds}
          estimatedCost={[
            Boolean(jobs.find((j) => j.id === compareJobIds[0])?.total_cost_usd_estimated),
            Boolean(jobs.find((j) => j.id === compareJobIds[1])?.total_cost_usd_estimated),
          ]}
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
