import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { SafetyArchiveDeleteDialog, SafetyArchiveDetails } from '../../delivery/components/SafetyArchiveNotice'
import {
  formatArchiveBytes, getSafetyArchives, type SafetyArchive, type SafetyArchiveDeletion, type SafetyArchivesSnapshot,
} from '../../delivery/lib/safety-archives-api'

const DAY_MS = 24 * 60 * 60 * 1000

function archiveKey(archive: Pick<SafetyArchive, 'projectId' | 'path'>): string {
  return `${archive.projectId}\n${archive.path}`
}

function Row({ archive, selected, onToggle, onDelete }: {
  archive: SafetyArchive
  selected: boolean
  onToggle: (checked: boolean) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('resources')
  const [open, setOpen] = useState(false)
  const days = Math.max(0, Math.floor((Date.now() - archive.createdAt) / DAY_MS))
  return <li data-testid="safety-archive-row" className="py-2">
    <div className="flex items-start gap-2">
      <input
        type="checkbox" className="mt-1 h-3.5 w-3.5 shrink-0" checked={selected}
        onChange={(event) => onToggle(event.target.checked)}
        aria-label={t('safetyArchives.select', { name: archive.worktreeName })}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-label text-foreground">{t('safetyArchives.rowTitle', { name: archive.worktreeName, count: archive.fileCount })}</p>
        <p className="text-caption text-muted-foreground">
          {[days === 0 ? t('safetyArchives.today') : t('safetyArchives.age', { count: days }), formatArchiveBytes(archive.bytes)].join(' · ')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-0.5 px-1.5" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          {t('safetyArchives.details')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-1.5 text-destructive" onClick={onDelete} data-testid="safety-archive-row-delete">
          <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('safetyArchives.delete')}
        </Button>
      </div>
    </div>
    {open && <div className="mt-1.5 pl-5"><SafetyArchiveDetails archive={archive} /></div>}
  </li>
}

/**
 * Settings ▸ Storage: safety archives across projects — files a run's release
 * kept outside the PR because it could not prove they were Specrails's own.
 * Delete one or several (confirmed; the server re-validates every folder).
 */
export function SafetyArchivesSection({ active }: { active: boolean }) {
  const { t } = useTranslation('resources')
  const [snapshot, setSnapshot] = useState<SafetyArchivesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState<SafetyArchive[] | null>(null)
  const [results, setResults] = useState<SafetyArchiveDeletion[] | null>(null)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    try {
      const next = await getSafetyArchives(current.signal)
      if (current.signal.aborted) return
      setSnapshot(next)
      setError(null)
      setSelected((previous) => new Set([...previous].filter((key) => next.items.some((item) => archiveKey(item) === key))))
    } catch (err) {
      if (!current.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!current.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    return () => { controller.current?.abort() }
  }, [active, refresh])

  const items = useMemo(() => snapshot?.items ?? [], [snapshot])
  const groups = useMemo(() => {
    const byProject = new Map<string, { projectId: string; projectName: string; items: SafetyArchive[] }>()
    for (const item of items) {
      const group = byProject.get(item.projectId) ?? { projectId: item.projectId, projectName: item.projectName ?? item.projectId, items: [] }
      group.items.push(item)
      byProject.set(item.projectId, group)
    }
    return [...byProject.values()]
  }, [items])
  const chosen = items.filter((item) => selected.has(archiveKey(item)))
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)
  const totalFiles = items.reduce((sum, item) => sum + item.fileCount, 0)
  const failedProjects = (snapshot?.projects ?? []).filter((project) => project.error)

  const toggle = (item: SafetyArchive, checked: boolean) => setSelected((previous) => {
    const next = new Set(previous)
    if (checked) next.add(archiveKey(item)); else next.delete(archiveKey(item))
    return next
  })

  return <div data-testid="safety-archives" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {snapshot && items.length > 0 && <p className="text-caption text-muted-foreground">
        {t('safetyArchives.summary', { folders: t('safetyArchives.folderCount', { count: items.length }), files: t('safetyArchives.fileCount', { count: totalFiles }), size: formatArchiveBytes(totalBytes) })}
      </p>}
      <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5" onClick={() => void refresh()} disabled={loading} aria-label={t('safetyArchives.refresh')}>
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
        {t('safetyArchives.refresh')}
      </Button>
    </div>
    {error && <p role="alert" className="text-caption text-destructive">{t('safetyArchives.error', { error })}</p>}
    {failedProjects.map((project) => <p key={project.projectId} role="alert" className="text-caption text-destructive">
      {t('safetyArchives.projectError', { project: project.projectName, error: project.error })}
    </p>)}
    {!snapshot && !error && <p className="text-caption text-muted-foreground">{t('safetyArchives.loading')}</p>}
    {snapshot && items.length === 0 && <div className="flex items-center gap-2 rounded-card border border-dashed border-border p-4 text-caption text-muted-foreground">
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />{t('safetyArchives.empty')}
    </div>}

    {groups.map((group) => <section key={group.projectId} aria-label={group.projectName} data-testid="safety-archive-project">
      <div className="flex items-center gap-2 border-b border-border pb-1 text-label text-foreground">
        <span className="min-w-0 flex-1 truncate">{group.projectName}</span>
        <span className="num text-caption text-muted-foreground">{formatArchiveBytes(group.items.reduce((sum, item) => sum + item.bytes, 0))}</span>
      </div>
      <ul className="divide-y divide-border">
        {group.items.map((item) => <Row
          key={archiveKey(item)} archive={item} selected={selected.has(archiveKey(item))}
          onToggle={(checked) => toggle(item, checked)} onDelete={() => setPending([item])}
        />)}
      </ul>
    </section>)}

    {items.length > 0 && <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
      <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set(items.map(archiveKey)))}>
        {t('safetyArchives.selectAll')}
      </Button>
      <Button size="sm" variant="destructive" className="ml-auto h-7 gap-1.5" disabled={chosen.length === 0} onClick={() => setPending(chosen)} data-testid="safety-archives-delete-selected">
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {t('safetyArchives.deleteSelected', { count: chosen.length })}
      </Button>
    </div>}

    {results && <p role="status" data-testid="safety-archives-result" className="rounded-card bg-muted px-3 py-2 text-caption text-foreground">
      {t('safetyArchives.result', { deleted: results.filter((result) => result.status === 'deleted').length, kept: results.filter((result) => result.status !== 'deleted').length })}
    </p>}

    <SafetyArchiveDeleteDialog
      archives={pending ?? []}
      open={pending !== null}
      onOpenChange={(open) => { if (!open) setPending(null) }}
      onDeleted={(next) => {
        setResults(next)
        setSelected(new Set())
        void refresh()
      }}
    />
  </div>
}
