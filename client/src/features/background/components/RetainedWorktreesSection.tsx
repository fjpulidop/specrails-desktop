import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { RunStatePill } from '../../../components/ui/run-state/run-state-pill'
import { SegmentedControl } from '../../../components/ui/segmented-control'
import { cn } from '../../../lib/utils'
import { formatBytes } from '../lib/format-bytes'
import { useRetainedWorktrees } from '../hooks/useRetainedWorktrees'
import {
  IDLE_FILTERS, SIZE_FILTERS_MB, groupByProject, knownBytes, matchesFilters, retainedKey, retainedRunState,
  type RetainedFilters, type RetainedLabelFilter,
} from '../lib/retained-worktrees-model'
import type { RetainedRemovalResult, RetainedSize, RetainedWorktree } from '../lib/retained-worktrees-api'

type T = (key: string, params?: Record<string, unknown>) => string

function SizeText({ size, t }: { size: RetainedSize | undefined; t: T }) {
  if (!size || size.status === 'scanning') return <span className="text-muted-foreground">{t('retained.sizeScanning')}</span>
  if (size.status === 'failed') return <span className="text-muted-foreground">{t('retained.sizeUnknown')}</span>
  return <span className="num text-foreground">{formatBytes(size.bytes)}</span>
}

function subject(item: RetainedWorktree, t: T): string {
  const spec = item.ticketId !== null ? `#${item.ticketId}${item.ticketTitle ? ` ${item.ticketTitle}` : ''}` : ''
  if (item.kind === 'intent') return t('retained.intentSubject', { spec })
  return t('retained.railSubject', { rail: (item.railIndex ?? 0) + 1, spec })
}

function facts(item: RetainedWorktree, t: T): string[] {
  const out: string[] = []
  if (item.idleDays !== null) out.push(t('retained.idle', { count: item.idleDays }))
  if (item.pr) {
    out.push(item.pr.number !== null
      ? t('retained.pr', { number: item.pr.number, decision: t(`retained.decision.${item.pr.decision}`, { defaultValue: item.pr.decision }) })
      : t('retained.delivery', { decision: t(`retained.decision.${item.pr.decision}`, { defaultValue: item.pr.decision }) }))
  }
  const changes = (item.trackedChanges ?? 0) + (item.untrackedFiles ?? 0)
  if (changes > 0) out.push(t('retained.changes', { count: changes }))
  if ((item.unpushedCommits ?? 0) > 0) out.push(t('retained.unpushed', { count: item.unpushedCommits }))
  if ((item.ignoredAtRiskCount ?? 0) > 0) out.push(t('retained.atRisk', { count: item.ignoredAtRiskCount }))
  return out
}

function Row({ item, size, selected, onToggle, t }: {
  item: RetainedWorktree
  size: RetainedSize | undefined
  selected: boolean
  onToggle: (checked: boolean) => void
  t: T
}) {
  const { evaluation } = item
  const reasons = evaluation.reasons.map(reason => t(`retained.reason.${reason}`))
  const blocked = evaluation.removeBlocker ? t(`retained.reason.${evaluation.removeBlocker}`) : null
  const name = subject(item, t)
  return <li data-testid="retained-worktree" data-label={evaluation.label} className="flex items-start gap-2 py-2">
    <input
      type="checkbox"
      className="mt-1 h-3.5 w-3.5 shrink-0"
      checked={selected}
      disabled={!evaluation.removable || !item.head}
      onChange={event => onToggle(event.target.checked)}
      aria-label={t('retained.select', { name })}
      title={blocked ? t('retained.cannotRemove', { reason: blocked }) : undefined}
    />
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatePill state={retainedRunState(item)} label={t(`retained.label.${evaluation.label}`)} />
        <span className="min-w-0 truncate text-label text-foreground" title={name}>{name}</span>
      </div>
      {item.branch && <div className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">
        <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate font-mono" title={item.worktreePath}>{item.branch}</span>
      </div>}
      {facts(item, t).length > 0 && <p className="text-caption text-muted-foreground">{facts(item, t).join(' · ')}</p>}
      {reasons.length > 0 && <p className="text-caption text-foreground">{reasons.join(' · ')}</p>}
      {item.ignoredAtRisk.length > 0 && <p className="truncate font-mono text-caption text-muted-foreground" title={item.ignoredAtRisk.join('\n')}>
        {item.ignoredAtRisk.join(', ')}
      </p>}
    </div>
    <div className="w-20 shrink-0 text-right text-caption"><SizeText size={size} t={t} /></div>
  </li>
}

function ResultSummary({ results, t }: { results: RetainedRemovalResult[]; t: T }) {
  const removed = results.filter(result => result.status === 'removed')
  const kept = results.filter(result => result.status !== 'removed')
  const branches = removed.filter(result => result.branchDeleted).length
  const warnings = results.flatMap(result => result.warnings)
  return <div role="status" data-testid="retained-results" className="space-y-1 rounded-card bg-muted px-3 py-2 text-caption">
    <p className="text-foreground">{t('retained.result', { removed: removed.length, branches, kept: kept.length })}</p>
    {kept.map(result => <p key={`${result.projectId}:${result.id}`} className="text-muted-foreground">
      {t('retained.keptBecause', { reason: result.reason ? t(`retained.reason.${result.reason}`, { defaultValue: result.reason }) : t('retained.reason.notFound') })}
    </p>)}
    {warnings.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{warnings.map((warning, index) => <li key={index} className="break-all">{warning}</li>)}</ul>}
  </div>
}

/**
 * Settings ▸ Storage: run worktrees Specrails kept on disk, across projects,
 * with what removing each would lose. Removal keeps branches unless the person
 * asks, and then only for branches that hold nothing new.
 */
export function RetainedWorktreesSection({ active }: { active: boolean }) {
  const { t } = useTranslation('resources')
  const { snapshot, error, loading, sizes, refresh, remove } = useRetainedWorktrees(active)
  const [filters, setFilters] = useState<RetainedFilters>({ label: 'all', minIdleDays: 0, minSizeMb: 0 })
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<RetainedRemovalResult[] | null>(null)

  const items = useMemo(() => snapshot?.items ?? [], [snapshot])
  const visible = useMemo(() => items.filter(item => matchesFilters(item, sizes.get(retainedKey(item)), filters)), [items, sizes, filters])
  const groups = useMemo(() => groupByProject(visible, (snapshot?.projects ?? []).map(project => project.projectId)), [visible, snapshot])
  const chosen = useMemo(() => items.filter(item => selected.has(retainedKey(item)) && item.evaluation.removable), [items, selected])
  const removableVisible = visible.filter(item => item.evaluation.removable && item.head)
  const chosenBytes = knownBytes(chosen, sizes)
  const branchCount = chosen.filter(item => item.evaluation.branchDeletable).length
  const total = knownBytes(items, sizes)
  const failedProjects = (snapshot?.projects ?? []).filter(project => project.error)

  const toggle = (item: RetainedWorktree, checked: boolean) => setSelected(previous => {
    const next = new Set(previous)
    if (checked) next.add(retainedKey(item)); else next.delete(retainedKey(item))
    return next
  })

  const confirm = async () => {
    setBusy(true)
    try {
      setResults(await remove(chosen, deleteBranches))
      setSelected(new Set())
      setConfirming(false)
    } catch (err) {
      setResults([{ projectId: '', id: '', status: 'kept', reason: 'release', branchDeleted: false, warnings: [err instanceof Error ? err.message : String(err)] }])
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return <div data-testid="retained-worktrees" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl<RetainedLabelFilter>
        label={t('retained.filterLabel')}
        value={filters.label}
        onChange={label => setFilters(current => ({ ...current, label }))}
        options={[
          { value: 'all', label: t('retained.filter.all') },
          { value: 'nothing-to-lose', label: t('retained.label.nothing-to-lose'), testId: 'retained-filter-safe' },
          { value: 'waiting-for-you', label: t('retained.label.waiting-for-you') },
        ]}
      />
      <SegmentedControl<string>
        label={t('retained.filterIdle')}
        value={String(filters.minIdleDays)}
        onChange={value => setFilters(current => ({ ...current, minIdleDays: Number(value) }))}
        options={IDLE_FILTERS.map(days => ({ value: String(days), label: days === 0 ? t('retained.filter.anyAge') : t('retained.filter.idle', { count: days }) }))}
      />
      <SegmentedControl<string>
        label={t('retained.filterSize')}
        value={String(filters.minSizeMb)}
        onChange={value => setFilters(current => ({ ...current, minSizeMb: Number(value) }))}
        options={SIZE_FILTERS_MB.map(mb => ({ value: String(mb), label: mb === 0 ? t('retained.filter.anySize') : t('retained.filter.size', { size: formatBytes(mb * 1024 * 1024) }) }))}
      />
      <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5" onClick={() => void refresh()} disabled={loading} aria-label={t('retained.refresh')}>
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
        {t('retained.refresh')}
      </Button>
    </div>

    {error && <p role="alert" className="text-caption text-destructive">{t('retained.error', { error })}</p>}
    {failedProjects.map(project => <p key={project.projectId} role="alert" className="text-caption text-destructive">
      {t('retained.projectError', { project: project.projectName, error: project.error })}
    </p>)}
    {!snapshot && !error && <p className="text-caption text-muted-foreground">{t('retained.loading')}</p>}
    {snapshot && items.length === 0 && <div className="flex items-center gap-2 rounded-card border border-dashed border-border p-4 text-caption text-muted-foreground">
      <HardDrive className="h-4 w-4 shrink-0" aria-hidden />{t('retained.empty')}
    </div>}
    {snapshot && items.length > 0 && <p className="text-caption text-muted-foreground">
      {t('retained.summary', { count: items.length, size: formatBytes(total.bytes) })}{total.partial ? ` ${t('retained.partial')}` : ''}
    </p>}
    {snapshot && items.length > 0 && visible.length === 0 && <p className="text-caption text-muted-foreground">{t('retained.noMatch')}</p>}

    {groups.map(group => <section key={group.projectId} aria-label={group.projectName} data-testid="retained-project">
      <div className="flex items-center gap-2 border-b border-border pb-1 text-label text-foreground">
        <span className="min-w-0 flex-1 truncate">{group.projectName}</span>
        <span className="num text-caption text-muted-foreground">{formatBytes(knownBytes(group.items, sizes).bytes)}</span>
      </div>
      <ul className="divide-y divide-border">
        {group.items.map(item => <Row key={retainedKey(item)} item={item} size={sizes.get(retainedKey(item))} t={t}
          selected={selected.has(retainedKey(item))} onToggle={checked => toggle(item, checked)} />)}
      </ul>
    </section>)}

    {removableVisible.length > 0 && <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
      <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set(removableVisible.filter(item => item.evaluation.label === 'nothing-to-lose').map(retainedKey)))}>
        {t('retained.selectSafe')}
      </Button>
      <label className="flex items-center gap-2 text-caption text-foreground">
        <input type="checkbox" className="h-3.5 w-3.5" checked={deleteBranches} onChange={event => setDeleteBranches(event.target.checked)} />
        {t('retained.deleteBranches')}
      </label>
      <Button size="sm" variant="destructive" className="ml-auto h-7 gap-1.5" disabled={chosen.length === 0 || busy} onClick={() => setConfirming(true)} data-testid="retained-remove">
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {t('retained.remove', { count: chosen.length })}
      </Button>
    </div>}

    {results && <ResultSummary results={results} t={t} />}

    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      busy={busy}
      title={t('retained.confirmTitle', { count: chosen.length })}
      description={t('retained.confirmDescription', { size: formatBytes(chosenBytes.bytes) })}
      confirmLabel={t('retained.confirm', { count: chosen.length })}
      onConfirm={confirm}
      testId="retained-confirm"
      confirmTestId="retained-confirm-button"
    >
      <ul className="space-y-1 text-caption text-muted-foreground">
        <li>{deleteBranches
          ? t('retained.confirmBranchesDeleted', { count: branchCount, kept: chosen.length - branchCount })
          : t('retained.confirmBranchesKept')}</li>
        <li>{t('retained.confirmRecheck')}</li>
      </ul>
    </ConfirmDialog>
  </div>
}
