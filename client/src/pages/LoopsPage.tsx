import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Workflow, Plus, Pencil, Trash2, Copy, Upload, Download, Sparkles, Eye, Play, FileDown, FileUp } from 'lucide-react'
import { buildExportEnvelope, parseImportFile, exportFilename } from '../lib/loop-export'
import { filterTemplates, categoryCounts } from '../lib/loop-template-filter'
import { TemplatePreviewModal } from '../components/loops/TemplatePreviewModal'
import { LoopRunModal } from '../components/loops/LoopRunModal'
import { loopNeedsTicket } from '../lib/loop-ticket-need'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Button } from '../components/ui/button'
import {
  loopsApi,
  LoopPublishError,
  type LoopDefinition,
  type LoopTemplateSummary,
  type FactoryLoopSummary,
} from '../lib/loops-api'

const STATUS_BADGE: Record<LoopDefinition['status'], string> = {
  draft: 'bg-accent-secondary/15 text-accent-secondary ring-accent-secondary/40',
  published: 'bg-accent-success/15 text-accent-success ring-accent-success/40',
}

function StatusBadge({ status }: { status: LoopDefinition['status'] }) {
  const { t } = useTranslation('loops')
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ring-1 ring-inset',
        STATUS_BADGE[status]
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

export interface LoopsPageProps {
  /** Mission-mode loops dialog: open the embedded builder in place instead of
   *  navigating to /loops/:id/edit (that route has no home in Agent mode). */
  onOpenBuilder?: (id: string) => void
}

export default function LoopsPage({ onOpenBuilder }: LoopsPageProps = {}) {
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
  const [factoryLoops, setFactoryLoops] = useState<FactoryLoopSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<LoopTemplateSummary | null>(null)
  // Whether the previewed item is a starter template (clone via fromTemplate) or
  // a built-in factory loop (clone via forkFactory). Drives the modal's CTA.
  const [previewMode, setPreviewMode] = useState<'use' | 'fork'>('use')
  const [runLoop, setRunLoop] = useState<LoopDefinition | null>(null)
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
  const { projects, setActiveProjectId } = useDesktop()

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

  const reload = useCallback(async () => {
    try {
      // List + templates are the core gallery; load them first so a failure of
      // the (newer) factory-loops endpoint can never blank the page.
      const [ls, ts] = await Promise.all([loopsApi.list(), loopsApi.templates()])
      setLoops(ls)
      setTemplates(ts)
    } catch {
      toast.error(t('errors.load'))
    } finally {
      setLoading(false)
    }
    // Factory loops are best-effort (older server / endpoint missing → just no
    // Built-in section). Never let this break the rest of the gallery.
    try {
      setFactoryLoops(await loopsApi.factoryLoops())
    } catch {
      setFactoryLoops([])
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

  const handleFork = useCallback(
    async (id: string) => {
      try {
        const loop = await loopsApi.forkFactory(id)
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
    async ({ projectId, provider, model, effort }: { projectId: string; provider?: string; model?: string; effort?: string }) => {
      const loop = runLoop
      if (!loop) return
      setRunLoop(null)
      try {
        const { loopRunId } = await loopsApi.runStandalone(projectId, loop.id, { aiEngine: provider, model, reasoning_effort: effort })
        setActiveProjectId(projectId)
        navigate(`/jobs/${loopRunId}`)
        toast.success(t('run.launched', { name: loop.name }))
      } catch {
        toast.error(t('errors.save'))
      }
    },
    [runLoop, navigate, setActiveProjectId, t]
  )

  // Preview a factory loop by adapting it to the template-preview shape.
  const previewFactory = useCallback((f: FactoryLoopSummary) => {
    setPreviewMode('fork')
    setPreviewTemplate({
      id: f.id,
      name: locName(f.id, f.name),
      description: locDesc(f.id, f.description),
      tags: f.requiredCapability ? [f.requiredCapability] : f.claudeOnly ? ['claude-only'] : [],
      graph: f.graph,
    })
  }, [locName, locDesc])

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

  const drafts = loops.filter((l) => l.status === 'draft')
  const published = loops.filter((l) => l.status === 'published')
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
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <Workflow className="w-5 h-5 text-accent-primary" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
              <p className="text-xs text-muted-foreground mt-0.5">{t('subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={() => downloadLoops(loops.filter((l) => selectedIds.has(l.id)))}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-border text-foreground hover:bg-muted"
              >
                <FileDown className="w-3.5 h-3.5" />
                {t('actions.export')} ({selectedIds.size})
              </button>
            )}
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-border text-foreground hover:bg-muted"
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
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-accent-primary text-white hover:bg-accent-primary/90"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('newLoop')}
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <div className="space-y-8">
            {drafts.length === 0 && published.length === 0 && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium text-foreground">{t('empty.title')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('empty.body')}</p>
              </div>
            )}

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
                    onDelete={() => handleDelete(loop.id)}
                  />
                ))}
              </Section>
            )}

            {factoryLoops.length > 0 && (
              <Section title={t('sections.builtIn')}>
                {factoryLoops.map((f) => (
                  <div
                    key={f.id}
                    className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2"
                    data-testid="factory-loop-card"
                  >
                    <div className="flex items-center gap-2">
                      <Workflow className="w-3.5 h-3.5 text-accent-primary" />
                      <span className="text-sm font-medium text-foreground">{locName(f.id, f.name)}</span>
                      <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                        {t('builtInBadge')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground flex-1">{locDesc(f.id, f.description)}</p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => previewFactory(f)}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground"
                      >
                        <Eye className="w-3 h-3" />
                        {t('actions.preview')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleFork(f.id)}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground"
                      >
                        <Copy className="w-3 h-3" />
                        {t('actions.fork')}
                      </button>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {templates.length > 0 && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('sections.templates')}</h2>
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
                          'inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] border transition-colors',
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
                      className="inline-flex items-center h-6 px-2 rounded-full text-[11px] text-accent-primary hover:underline"
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
                          <Sparkles className="w-3.5 h-3.5 text-accent-highlight flex-shrink-0" />
                          <span className="text-sm font-medium text-foreground truncate">{locName(tmpl.id, tmpl.name)}</span>
                          {tmpl.category && (
                            <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-accent-info/15 text-accent-info flex-shrink-0">
                              {t(`categories.${tmpl.category}`, { defaultValue: tmpl.category })}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground flex-1">{locDesc(tmpl.id, tmpl.description)}</p>
                        <div className="flex flex-wrap items-center gap-1">
                          {loopNeedsTicket(tmpl.graph) ? (
                            <span title={t('gallery.needsSpecHint')} className="px-1.5 py-0.5 rounded text-[10px] bg-accent-secondary/15 text-accent-secondary">
                              {t('gallery.needsSpec')}
                            </span>
                          ) : (
                            <span title={t('gallery.standaloneHint')} className="px-1.5 py-0.5 rounded text-[10px] bg-accent-success/15 text-accent-success">
                              {t('gallery.standalone')}
                            </span>
                          )}
                          {tmpl.tags.map((tag) => (
                            <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">{tag}</span>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => { setPreviewMode('use'); setPreviewTemplate({ ...tmpl, name: locName(tmpl.id, tmpl.name), description: locDesc(tmpl.id, tmpl.description) }) }}
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
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => { if (!o) setConfirmDeleteId(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-destructive" />
              {loops.find((l) => l.id === confirmDeleteId)?.name ?? t('actions.delete')}
            </DialogTitle>
            <DialogDescription>{t('confirmDelete')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void doDelete()}>
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Read-only preview before cloning. Built-in factory loops fork (forkFactory);
          starter templates clone (fromTemplate) — routed by previewMode. */}
      <TemplatePreviewModal
        template={previewTemplate}
        mode={previewMode}
        onClose={() => setPreviewTemplate(null)}
        onUse={(id) => {
          setPreviewTemplate(null)
          void (previewMode === 'fork' ? handleFork(id) : handleUseTemplate(id))
        }}
      />

      {/* Standalone Run for a ticket-less loop (pick a project + provider/effort). */}
      <LoopRunModal
        loop={runLoop ? { id: runLoop.id, name: runLoop.name } : null}
        projects={projects.map((p) => ({ id: p.id, name: p.name, providers: projectProviders(p) }))}
        onClose={() => setRunLoop(null)}
        onExecute={handleRunExecute}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
    </section>
  )
}

function LoopCard({
  loop,
  selected,
  onToggleSelect,
  onEdit,
  onPublish,
  onUnpublish,
  onDuplicate,
  onExport,
  onDelete,
  onRun,
}: {
  loop: LoopDefinition
  selected: boolean
  onToggleSelect: () => void
  onEdit: () => void
  onPublish?: () => void
  onUnpublish?: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete: () => void
  /** Present only for ticket-less published loops → standalone Run. */
  onRun?: () => void
}) {
  const { t } = useTranslation('loops')
  const nodeCount = loop.graph?.nodes?.length ?? 0
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2" data-testid="loop-card">
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
        <StatusBadge status={loop.status} />
      </div>
      <p className="text-xs text-muted-foreground">{t('card.nodes', { count: nodeCount })}</p>
      <div className="flex items-center gap-1 flex-wrap">
        {onRun && <CardButton icon={Play} label={t('actions.run')} onClick={onRun} />}
        <CardButton icon={Pencil} label={t('actions.edit')} onClick={onEdit} />
        {onPublish && <CardButton icon={Upload} label={t('actions.publish')} onClick={onPublish} />}
        {onUnpublish && <CardButton icon={Download} label={t('actions.unpublish')} onClick={onUnpublish} />}
        <CardButton icon={Copy} label={t('actions.duplicate')} onClick={onDuplicate} />
        <CardButton icon={FileDown} label={t('actions.export')} onClick={onExport} />
        <CardButton icon={Trash2} label={t('actions.delete')} onClick={onDelete} danger />
      </div>
    </div>
  )
}

function CardButton({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Pencil
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors',
        danger
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}
