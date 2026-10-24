import { ExternalLink } from 'lucide-react'
import { isLoopWindowRoute, openLoopWindow } from '../lib/loop-windows'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LoopMigrationPanel } from '../components/LoopMigrationPanel'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '../../../components/ui/page-header'
import { Workflow, Plus, Pencil, Trash2, Copy, Upload, Download, Sparkles, Eye, Play, FileDown, FileUp, RotateCcw, MoreHorizontal } from 'lucide-react'
import { buildExportEnvelope, parseImportFile, exportFilename } from '../lib/loop-export'
import { filterTemplates, categoryCounts } from '../lib/loop-template-filter'
import { TemplatePreviewModal } from '../components/TemplatePreviewModal'
import { LoopRunModal } from '../components/LoopRunModal'
import { LegacyConversionModal } from '../components/LegacyConversionModal'
import { loopNeedsTicket } from '../lib/loop-ticket-need'
import { useDesktop, projectProviders } from '../../../hooks/useDesktop'
import { cn } from '../../../lib/utils'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { Button } from '../../../components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import {
  loopsApi,
  LoopPublishError,
  type LoopDefinition,
  type LoopTemplateSummary,
} from '../lib/loops-api'

const STATUS_BADGE: Record<LoopDefinition['status'], string> = {
  draft: 'bg-accent-secondary/15 text-accent-secondary ring-accent-secondary/40',
  published: 'bg-accent-success/15 text-accent-success ring-accent-success/40',
}

function StatusBadge({ status }: { status: LoopDefinition['status'] }) {
  const { t } = useTranslation('loops')
  return (
    <span
      data-chip=""
      className={cn(
        'inline-flex h-5 items-center px-1.5 rounded text-caption font-medium ring-1 ring-inset',
        STATUS_BADGE[status]
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

export interface LoopsPageProps {
  /** Independent loop window: open its builder in place without routing
   *  the main application. */
  onOpenBuilder?: (id: string) => void
  onWindowOpened?: () => void
}

export default function LoopsPage({ onOpenBuilder, onWindowOpened }: LoopsPageProps = {}) {
  const { t } = useTranslation('loops')
  const navigate = useNavigate()
  // Template / built-in name+description are authored in English on the server;
  // localize them via the `catalog.<id>` i18n entries, falling back to the
  // server string for ids without a translation (e.g. future templates). The
  // `:` in factory ids (`factory:implement`) clashes with i18next's namespace
  // separator, so sanitize it to `_` for the key path.
  const catKey = useCallback((id: string) => id.replace(/:/g, '_'), [])
  const locName = useCallback((id: string, fallback: string) => t(`catalog.${catKey(id)}.name`, { defaultValue: fallback }), [t, catKey])
  const locDesc = useCallback((id: string, fallback: string) => t(`catalog.${catKey(id)}.description`, { defaultValue: fallback }), [t, catKey])
  const [loops, setLoops] = useState<LoopDefinition[]>([])
  const [templates, setTemplates] = useState<LoopTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<LoopTemplateSummary | null>(null)
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null)
  const [runLoop, setRunLoop] = useState<LoopDefinition | null>(null)
  const [conversionLoop, setConversionLoop] = useState<LoopDefinition | null>(null)
  // Multi-select for export. Selection is over user loops only (drafts+published).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Template-gallery discovery filter (search query + selected category chips),
  // restored from localStorage (best-effort; never blocks render).
  const TEMPLATE_FILTER_KEY = 'specrails-desktop:loop-template-filter'
  const restoredFilter = (() => {
    try {
      const raw = localStorage.getItem(TEMPLATE_FILTER_KEY)
      const parsed = raw ? (JSON.parse(raw) as { query?: string; categories?: string[] }) : null
      return { query: typeof parsed?.query === 'string' ? parsed.query : '', categories: Array.isArray(parsed?.categories) ? parsed!.categories : [] }
    } catch {
      return { query: '', categories: [] as string[] }
    }
  })()
  const [templateQuery, setTemplateQuery] = useState(restoredFilter.query)
  const [selectedCategories, setSelectedCategories] = useState<string[]>(restoredFilter.categories)
  useEffect(() => {
    try { localStorage.setItem(TEMPLATE_FILTER_KEY, JSON.stringify({ query: templateQuery, categories: selectedCategories })) } catch { /* best-effort */ }
  }, [templateQuery, selectedCategories])
  const toggleCategory = useCallback((cat: string) => {
    setSelectedCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]))
  }, [])
  const clearTemplateFilter = useCallback(() => { setTemplateQuery(''); setSelectedCategories([]) }, [])
  const importInputRef = useRef<HTMLInputElement>(null)
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Serialize loops to a .json download (no server round-trip needed for export).
  const downloadLoops = useCallback((toExport: LoopDefinition[]) => {
    if (toExport.length === 0) return
    const blob = new Blob([JSON.stringify(buildExportEnvelope(toExport), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportFilename(toExport)
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const downloadLegacyGraph = useCallback(async (loop: LoopDefinition) => {
    try {
      const backup = await loopsApi.legacyGraph(loop.id)
      downloadLoops([{ ...loop, name: t('actions.originalCopyName', { name: loop.name }), graph: backup.graph }])
    } catch { toast.error(t('errors.exportLegacy')) }
  }, [downloadLoops, t])

  const reload = useCallback(async () => {
    try {
      // Built-ins are ordinary loop rows (builtinId set), listed with the library.
      const [ls, ts] = await Promise.all([loopsApi.list(), loopsApi.templates()])
      setLoops(ls)
      setTemplates(ts)
    } catch {
      toast.error(t('errors.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleImportFile = useCallback(async (file: File) => {
    try {
      const items = parseImportFile(await file.text())
      const { imported, skipped } = await loopsApi.importLoops(items)
      await reload()
      if (imported.length) toast.success(t('import.done', { count: imported.length }))
      if (skipped.length) toast.warning(t('import.skipped', { count: skipped.length, names: skipped.join(', ') }))
      if (!imported.length && !skipped.length) toast.warning(t('import.invalid'))
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      toast.error(code === 'invalid-json' || code === 'no-loops' ? t('import.invalid') : t('errors.save'))
    }
  }, [reload, t])

  const openBuilder = useCallback((id: string) => {
    if (onOpenBuilder) onOpenBuilder(id)
    else navigate(`/loops/${id}/edit`)
  }, [onOpenBuilder, navigate])

  const handleNew = useCallback(async () => {
    try {
      const loop = await loopsApi.create({ name: t('newLoopName') })
      openBuilder(loop.id)
    } catch {
      toast.error(t('errors.save'))
    }
  }, [t, openBuilder])

  const handleUseTemplate = useCallback(
    async (templateId: string) => {
      try {
        const loop = await loopsApi.fromTemplate(templateId)
        openBuilder(loop.id)
      } catch {
        toast.error(t('errors.save'))
      }
    },
    [t, openBuilder]
  )

  // Launch a ticket-less loop standalone against a chosen project, then jump to
  // its job log (switching the active project to that target).
  const handleRunExecute = useCallback(
    async ({ projectId, provider, model, effort, repositoryIds }: { projectId: string; provider?: string; model?: string; effort?: string; repositoryIds?: string[] }) => {
      const loop = runLoop
      if (!loop) return
      setRunLoop(null)
      try {
        const { loopRunId } = await loopsApi.runStandalone(projectId, loop.id, { aiEngine: provider, model, reasoning_effort: effort, ...(repositoryIds ? { repositoryIds } : {}) })
        setActiveProjectId(projectId)
        navigate(`/jobs/${loopRunId}`)
        toast.success(t('run.launched', { name: loop.name }))
      } catch {
        toast.error(t('errors.save'))
      }
    },
    [runLoop, navigate, setActiveProjectId, t]
  )

  const handlePublish = useCallback(
    async (id: string) => {
      try {
        await loopsApi.publish(id)
        await reload()
      } catch (err) {
        if (err instanceof LoopPublishError) toast.error(t('errors.publishInvalid'))
        else toast.error(t('errors.save'))
      }
    },
    [t, reload]
  )

  const handleUnpublish = useCallback(
    async (id: string) => {
      try {
        await loopsApi.unpublish(id)
        await reload()
      } catch {
        toast.error(t('errors.save'))
      }
    },
    [t, reload]
  )

  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        await loopsApi.duplicate(id)
        await reload()
      } catch {
        toast.error(t('errors.save'))
      }
    },
    [t, reload]
  )

  // Restore original: discards edits, back to the default for every rail using it.
  const doRestore = useCallback(async () => {
    const id = confirmRestoreId
    if (!id) return
    setConfirmRestoreId(null)
    try {
      await loopsApi.restoreBuiltin(id)
      await reload()
      toast.success(t('builder.builtin.restored'))
    } catch {
      toast.error(t('errors.save'))
    }
  }, [confirmRestoreId, t, reload])

  // Open the in-app confirm modal (replaces the native window.confirm).
  const handleDelete = useCallback((id: string) => setConfirmDeleteId(id), [])

  const doDelete = useCallback(async () => {
    const id = confirmDeleteId
    if (!id) return
    setConfirmDeleteId(null)
    try {
      await loopsApi.remove(id)
      await reload()
    } catch {
      toast.error(t('errors.save'))
    }
  }, [confirmDeleteId, t, reload])

  // Built-ins are listed in their own section and never duplicated below.
  const builtIns = loops.filter((l) => l.builtinId)
  const userLoops = loops.filter((l) => !l.builtinId)
  const drafts = userLoops.filter((l) => l.status === 'draft')
  const published = userLoops.filter((l) => l.status === 'published')
  const templateCounts = categoryCounts(templates)
  // Search also matches the LOCALIZED text shown on the card (name, description,
  // category label), not just the server English, so a query in the user's
  // language finds the right template.
  const searchableTemplates = templates.map((tmpl) => ({
    ...tmpl,
    searchTerms: `${locName(tmpl.id, tmpl.name)} ${locDesc(tmpl.id, tmpl.description)} ${tmpl.category ? t(`categories.${tmpl.category}`, { defaultValue: tmpl.category }) : ''}`,
  }))
  const visibleTemplates = filterTemplates(searchableTemplates, { query: templateQuery, categories: selectedCategories })
  const templateFilterActive = templateQuery.trim() !== '' || selectedCategories.length > 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Header */}
        <PageHeader
          className="mb-6"
          icon={<Workflow />}
          title={t('title')}
          description={t('subtitle')}
          actions={<>
            {!isLoopWindowRoute() && <button type="button" onClick={() => void openLoopWindow(activeProjectId).then(() => onWindowOpened?.()).catch(error => toast.error(t('window.openFailed'), { description: error instanceof Error ? error.message : undefined }))} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs border border-border hover:bg-muted">
              <ExternalLink className="w-3.5 h-3.5" />{t('window.open')}
            </button>}
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={() => downloadLoops(loops.filter((l) => selectedIds.has(l.id)))}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-label border border-border text-foreground hover:bg-muted"
              >
                <FileDown className="w-3.5 h-3.5" />
                {t('actions.export')} ({selectedIds.size})
              </button>
            )}
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-label border border-border text-foreground hover:bg-muted"
            >
              <FileUp className="w-3.5 h-3.5" />
              {t('actions.import')}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleImportFile(file)
                e.target.value = '' // allow re-importing the same file
              }}
            />
            <button
              type="button"
              onClick={handleNew}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-label bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('newLoop')}
            </button>
          </>}
        />

        {loading ? (
          <div role="status" aria-busy="true" aria-label={t('common:states.loading')} className="space-y-3" data-testid="loops-loading">
            <div className="h-3 w-24 rounded bg-muted/40 motion-safe:animate-pulse" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-lg border border-border bg-card motion-safe:animate-pulse" />)}
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {drafts.length === 0 && published.length === 0 && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium text-foreground">{t('empty.title')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('empty.body')}</p>
              </div>
            )}

            {loops.some(loop => !loop.graph.nodes.some(node => node.type === 'core')) && <LoopMigrationPanel onConvert={id => { const loop = loops.find(item => item.id === id); if (loop) setConversionLoop(loop) }} />}

            {published.length > 0 && (
              <Section title={t('sections.published')}>
                {published.map((loop) => (
                  <LoopCard
                    key={loop.id}
                    loop={loop}
                    selected={selectedIds.has(loop.id)}
                    onToggleSelect={() => toggleSelect(loop.id)}
                    onEdit={() => openBuilder(loop.id)}
                    onUnpublish={() => handleUnpublish(loop.id)}
                    onDuplicate={() => handleDuplicate(loop.id)}
                    onExport={() => downloadLoops([loop])}
                    onExportLegacy={loop.hasLegacyGraph ? () => void downloadLegacyGraph(loop) : undefined}
                    onConvert={loop.graph.nodes.some(node => node.type === 'core') ? undefined : () => setConversionLoop(loop)}
                    onDelete={() => handleDelete(loop.id)}
                    onRun={loopNeedsTicket(loop.graph) ? undefined : () => setRunLoop(loop)}
                  />
                ))}
              </Section>
            )}

            {drafts.length > 0 && (
              <Section title={t('sections.drafts')}>
                {drafts.map((loop) => (
                  <LoopCard
                    key={loop.id}
                    loop={loop}
                    selected={selectedIds.has(loop.id)}
                    onToggleSelect={() => toggleSelect(loop.id)}
                    onEdit={() => openBuilder(loop.id)}
                    onPublish={() => handlePublish(loop.id)}
                    onDuplicate={() => handleDuplicate(loop.id)}
                    onExport={() => downloadLoops([loop])}
                    onExportLegacy={loop.hasLegacyGraph ? () => void downloadLegacyGraph(loop) : undefined}
                    onConvert={loop.graph.nodes.some(node => node.type === 'core') ? undefined : () => setConversionLoop(loop)}
                    onDelete={() => handleDelete(loop.id)}
                  />
                ))}
              </Section>
            )}

            {builtIns.length > 0 && (
              <Section title={t('sections.builtIn')}>
                {builtIns.map((loop) => (
                  <LoopCard
                    key={loop.id}
                    loop={{ ...loop, name: loop.builtinModified ? loop.name : locName(loop.id, loop.name) }}
                    builtIn
                    selected={selectedIds.has(loop.id)}
                    onToggleSelect={() => toggleSelect(loop.id)}
                    onEdit={() => openBuilder(loop.id)}
                    onPublish={loop.status === 'draft' ? () => handlePublish(loop.id) : undefined}
                    onDuplicate={() => handleDuplicate(loop.id)}
                    onExport={() => downloadLoops([loop])}
                    onRestore={loop.builtinModified ? () => setConfirmRestoreId(loop.id) : undefined}
                  />
                ))}
              </Section>
            )}

            {templates.length > 0 && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                  <h2 className="text-xs font-semibold text-muted-foreground">{t('sections.templates')}</h2>
                  <input
                    type="search"
                    value={templateQuery}
                    onChange={(e) => setTemplateQuery(e.target.value)}
                    placeholder={t('gallery.search')}
                    aria-label={t('gallery.search')}
                    data-testid="template-search"
                    className="h-7 w-48 max-w-full rounded-md border border-border bg-surface/40 px-2.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                  />
                </div>

                {/* Category chips (multi-select, counts). */}
                <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="category-chips">
                  {templateCounts.map(({ category, count }) => {
                    const active = selectedCategories.includes(category)
                    return (
                      <button
                        key={category}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleCategory(category)}
                        className={cn(
                          'inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs border transition-colors',
                          active
                            ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                            : 'border-border bg-surface/40 text-muted-foreground hover:text-foreground hover:bg-muted'
                        )}
                      >
                        {t(`categories.${category}`, { defaultValue: category })}
                        <span className="opacity-60 tabular-nums">{count}</span>
                      </button>
                    )
                  })}
                  {templateFilterActive && (
                    <button
                      type="button"
                      onClick={clearTemplateFilter}
                      className="inline-flex items-center h-6 px-2 rounded-full text-xs text-accent-primary hover:underline"
                    >
                      {t('gallery.clearFilter')}
                    </button>
                  )}
                </div>

                {visibleTemplates.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center" data-testid="template-empty">
                    <p className="text-xs text-muted-foreground">{t('gallery.noResults')}</p>
                    <button type="button" onClick={clearTemplateFilter} className="mt-2 text-xs text-accent-primary hover:underline">
                      {t('gallery.clearFilter')}
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {visibleTemplates.map((tmpl) => (
                      <div
                        key={tmpl.id}
                        className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2"
                        data-testid="template-card"
                      >
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-sm font-medium text-foreground truncate">{locName(tmpl.id, tmpl.name)}</span>
                          {tmpl.category && (
                            <span data-chip="" className="ml-auto inline-flex h-5 items-center px-1.5 rounded text-caption bg-accent-info/15 text-accent-info flex-shrink-0">
                              {t(`categories.${tmpl.category}`, { defaultValue: tmpl.category })}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground flex-1">{locDesc(tmpl.id, tmpl.description)}</p>
                        <div className="flex flex-wrap items-center gap-1">
                          {loopNeedsTicket(tmpl.graph) ? (
                            <span title={t('gallery.needsSpecHint')} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-caption bg-muted text-muted-foreground">
                              {t('gallery.needsSpec')}
                            </span>
                          ) : (
                            <span title={t('gallery.standaloneHint')} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-caption bg-accent-success/15 text-accent-success">
                              {t('gallery.standalone')}
                            </span>
                          )}
                          {tmpl.tags.map((tag) => (
                            <span key={tag} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-caption bg-muted text-muted-foreground">{tag}</span>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPreviewTemplate({ ...tmpl, name: locName(tmpl.id, tmpl.name), description: locDesc(tmpl.id, tmpl.description) })}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground"
                          >
                            <Eye className="w-3 h-3" />
                            {t('actions.preview')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUseTemplate(tmpl.id)}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground"
                          >
                            <Download className="w-3 h-3" />
                            {t('actions.use')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      {/* In-app delete confirm (replaces the native window.confirm). */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteId(null) }}
        title={t('confirmDeleteTitle', { name: loops.find((l) => l.id === confirmDeleteId)?.name ?? '' })}
        description={t('confirmDelete')}
        confirmLabel={t('confirmDeleteAction')}
        confirmTestId="confirm-delete-loop"
        onConfirm={() => doDelete()}
      />

      {/* Restore-original confirm for an edited built-in. */}
      <ConfirmDialog
        open={confirmRestoreId !== null}
        onOpenChange={(o) => { if (!o) setConfirmRestoreId(null) }}
        title={t('builder.builtin.confirmTitle')}
        description={t('builder.builtin.confirmBody')}
        confirmLabel={t('actions.restoreBuiltin')}
        tone="default"
        confirmTestId="confirm-restore-builtin"
        onConfirm={() => doRestore()}
      />

      {/* Read-only preview of a starter template before cloning it (fromTemplate). */}
      <TemplatePreviewModal
        template={previewTemplate}
        onClose={() => setPreviewTemplate(null)}
        onUse={(id) => {
          setPreviewTemplate(null)
          void handleUseTemplate(id)
        }}
      />

      {/* Standalone Run for a ticket-less loop (pick a project + provider/effort). */}
      {conversionLoop && <LegacyConversionModal key={conversionLoop.id} loop={conversionLoop} projects={projects}
        onClose={() => setConversionLoop(null)} onConverted={converted => {
          setLoops(current => current.map(loop => loop.id === converted.id ? converted : loop))
          setConversionLoop(null); openBuilder(converted.id)
        }} />}
      <LoopRunModal
        loop={runLoop ? { id: runLoop.id, name: runLoop.name } : null}
        projects={projects.map((p) => ({ id: p.id, name: p.name, providers: projectProviders(p), repositories: p.repositories }))}
        onClose={() => setRunLoop(null)}
        onExecute={handleRunExecute}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-muted-foreground mb-2">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
    </section>
  )
}

function LoopCard({
  loop,
  builtIn = false,
  selected,
  onToggleSelect,
  onEdit,
  onPublish,
  onUnpublish,
  onDuplicate,
  onExport,
  onExportLegacy,
  onConvert,
  onDelete,
  onRun,
  onRestore,
}: {
  loop: LoopDefinition
  /** Built-in loop: badge, no Delete/Unpublish/Convert; Restore when edited. */
  builtIn?: boolean
  selected: boolean
  onToggleSelect: () => void
  onEdit: () => void
  onPublish?: () => void
  onUnpublish?: () => void
  onDuplicate: () => void
  onExport: () => void
  onExportLegacy?: () => void
  onConvert?: () => void
  onDelete?: () => void
  /** Present only for ticket-less published loops → standalone Run. */
  onRun?: () => void
  /** Built-ins with edits → reset to the original default. */
  onRestore?: () => void
}) {
  const { t } = useTranslation('loops')
  const nodeCount = loop.graph?.nodes?.length ?? 0
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2" data-testid={builtIn ? 'builtin-loop-card' : 'loop-card'}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={t('actions.select', { name: loop.name })}
            className="accent-accent-primary flex-shrink-0"
          />
          <span className="text-sm font-medium text-foreground truncate">{loop.name}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {builtIn && (
            <span data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-caption bg-muted text-muted-foreground" data-testid="builtin-badge">
              {t('builtInBadge')}
            </span>
          )}
          <StatusBadge status={loop.status} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('card.nodes', { count: nodeCount })}
        {builtIn && loop.builtinModified && <span className="ml-1.5 text-accent-secondary">· {t('card.builtinModified')}</span>}
      </p>
      <div className="flex items-center gap-1">
        {onRun && <CardButton icon={Play} label={t('actions.run')} onClick={onRun} />}
        <CardButton icon={Pencil} label={t('actions.edit')} onClick={onEdit} />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('actions.more')}
            title={t('actions.more')}
            className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <MoreHorizontal className="w-3.5 h-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onPublish && <DropdownMenuItem onSelect={onPublish}><Upload className="w-3.5 h-3.5" aria-hidden />{t('actions.publish')}</DropdownMenuItem>}
            {onUnpublish && <DropdownMenuItem onSelect={onUnpublish}><Download className="w-3.5 h-3.5" aria-hidden />{t('actions.unpublish')}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={onDuplicate}><Copy className="w-3.5 h-3.5" aria-hidden />{t('actions.duplicate')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport}><FileDown className="w-3.5 h-3.5" aria-hidden />{t('actions.export')}</DropdownMenuItem>
            {onExportLegacy && <DropdownMenuItem onSelect={onExportLegacy}><FileDown className="w-3.5 h-3.5" aria-hidden />{t('actions.exportLegacy')}</DropdownMenuItem>}
            {onConvert && <DropdownMenuItem onSelect={onConvert}><Workflow className="w-3.5 h-3.5" aria-hidden />{t('actions.convert')}</DropdownMenuItem>}
            {onRestore && <DropdownMenuItem onSelect={onRestore}><RotateCcw className="w-3.5 h-3.5" aria-hidden />{t('actions.restoreBuiltin')}</DropdownMenuItem>}
            {onDelete && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}><Trash2 className="w-3.5 h-3.5" aria-hidden />{t('actions.delete')}</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

function CardButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Pencil
  label: string
  onClick: () => void
}) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick} className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {label}
    </Button>
  )
}
