import { useCallback, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Plus, Pencil, Copy, Sparkles, Loader2, FileText, Search, X, Tag, Wand2 } from 'lucide-react'
import { getApiBase } from '../../lib/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { AgentStudio, customRoleDisplayPath } from './AgentStudio'
import { AiRefineOverlay } from './AiRefineOverlay'
import { ShellErrorBoundary } from '../ShellErrorBoundary'
import { AGENT_TEMPLATES, ALL_TEMPLATE_CATEGORIES, type AgentTemplateCategory } from './agentTemplates'
import { useMinimizedChats, usePendingRestore } from '../../context/MinimizedChatsContext'
import { useDesktop } from '../../hooks/useDesktop'
import { defaultModelForProvider } from '../../lib/loop-run-models'
import { providerSupportsAgentAutomation } from '../../lib/provider-capabilities'

interface CatalogAgent {
  id: string
  kind: 'upstream' | 'custom'
  description?: string
  model?: string
}

type StudioMode =
  | { kind: 'closed' }
  | { kind: 'create'; initialBody?: string; initialName?: string }
  | { kind: 'edit'; agentId: string; draftFromRefine?: string }
  | { kind: 'duplicate'; from: string; initialBody: string }

type RefineMode =
  | { kind: 'closed' }
  | { kind: 'open'; projectId: string; agentId: string; baseBody: string; resumeRefineId?: string }

export function AgentsCatalogTab() {
  const { t } = useTranslation('agents')
  const [agents, setAgents] = useState<CatalogAgent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [studio, setStudio] = useState<StudioMode>({ kind: 'closed' })
  const [refine, setRefine] = useState<RefineMode>({ kind: 'closed' })
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const [templateCategory, setTemplateCategory] = useState<AgentTemplateCategory | 'all'>('all')
  const [templateTag, setTemplateTag] = useState<string | null>(null)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [genName, setGenName] = useState('')
  const [genDescription, setGenDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const { activeProjectId, projects } = useDesktop()
  const activeProvider = projects.find((project) => project.id === activeProjectId)?.provider ?? 'claude'
  const automationEnabled = providerSupportsAgentAutomation(activeProvider)
  const { minimize } = useMinimizedChats()

  // Snapshot of the live AiEdit shell so we can auto-minimize the current
  // session before launching/restoring another (mutual-exclusion).
  const liveRefineRef = useRef<{ refineId: string | null }>({ refineId: null })
  const refineRef = useRef(refine)
  refineRef.current = refine

  const parkCurrentRefine = useCallback(() => {
    const cur = refineRef.current
    if (cur.kind !== 'open' || !cur.projectId) return
    minimize({
      kind: 'ai-edit',
      projectId: cur.projectId,
      label: t('catalog.aiEditChipLabel', { agentId: cur.agentId }),
      restoreRoute: '/agents',
      params: {
        agentId: cur.agentId,
        baseBody: cur.baseBody,
        resumeRefineId: liveRefineRef.current.refineId ?? cur.resumeRefineId,
      },
    })
  }, [minimize, t])

  // Restore from a chip click → re-open the AI Refine overlay with the
  // previously parked refine session id. If a different refine is currently
  // visible, park it as a chip first instead of dropping it.
  usePendingRestore('ai-edit', activeProjectId, (chat) => {
    if (chat.kind !== 'ai-edit' || !automationEnabled) return
    parkCurrentRefine()
    liveRefineRef.current = { refineId: chat.params.resumeRefineId ?? null }
    setRefine({
      kind: 'open',
      projectId: chat.projectId,
      agentId: chat.params.agentId,
      baseBody: chat.params.baseBody,
      resumeRefineId: chat.params.resumeRefineId,
    })
  })

  const refresh = useCallback(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getApiBase()}/profiles/catalog?provider=${encodeURIComponent(activeProvider)}`)
      .then((r) => {
        if (!r.ok) throw new Error(t('catalog.errors.loadFailed', { status: r.status }))
        return r.json() as Promise<{ agents: CatalogAgent[] }>
      })
      .then((data) => {
        if (cancelled) return
        setAgents(data.agents)
        if (data.agents.length > 0 && !selectedId) setSelectedId(data.agents[0].id)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeProvider, selectedId, t])

  useEffect(() => {
    const cleanup = refresh()
    return cleanup
  }, [refresh])

  const loadBody = useCallback((id: string) => {
    let cancelled = false
    setBodyLoading(true)
    setBody(null)
    fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(id)}?provider=${encodeURIComponent(activeProvider)}`)
      .then((r) => {
        if (!r.ok) throw new Error(t('catalog.errors.bodyLoadFailed', { status: r.status }))
        return r.json() as Promise<{ id: string; body: string }>
      })
      .then((data) => {
        if (!cancelled) setBody(data.body)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setBodyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeProvider, t])

  useEffect(() => {
    if (!selectedId) return
    const cleanup = loadBody(selectedId)
    return cleanup
  }, [selectedId, loadBody])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">{t('catalog.loading')}</p>
      </div>
    )
  }

  // Studio view (create / edit / duplicate)
  if (studio.kind !== 'closed') {
    return (
      <AgentStudio
        agentId={studio.kind === 'edit' ? studio.agentId : undefined}
        initialBody={
          studio.kind === 'duplicate'
            ? studio.initialBody
            : studio.kind === 'create'
              ? studio.initialBody
              : undefined
        }
        initialName={studio.kind === 'create' ? studio.initialName : undefined}
        draftFromRefine={studio.kind === 'edit' ? studio.draftFromRefine : undefined}
        provider={activeProvider}
        defaultModel={defaultModelForProvider(activeProvider)}
        automationEnabled={automationEnabled}
        onClose={() => setStudio({ kind: 'closed' })}
        onSaved={(id) => {
          setSelectedId(id)
          setStudio({ kind: 'closed' })
          refresh()
        }}
        onResumeRefine={(refineId, agentId, baseBody) => {
          setStudio({ kind: 'closed' })
          if (!activeProjectId) return
          parkCurrentRefine()
          liveRefineRef.current = { refineId }
          setRefine({ kind: 'open', projectId: activeProjectId, agentId, baseBody, resumeRefineId: refineId })
        }}
      />
    )
  }

  // AI Refine overlay view
  if (refine.kind === 'open' && automationEnabled) {
    return (
      <ShellErrorBoundary onClose={() => setRefine({ kind: 'closed' })}>
      <AiRefineOverlay
        // Per-session key — switching to a different refine session must
        // remount so useAgentRefine state and the composer don't leak.
        key={`${refine.agentId}:${refine.resumeRefineId ?? 'fresh'}`}
        agentId={refine.agentId}
        baseBody={refine.baseBody}
        resumeRefineId={refine.resumeRefineId}
        onStateChange={(s) => { liveRefineRef.current = s }}
        onClose={() => setRefine({ kind: 'closed' })}
        onMinimize={(refineId) => {
          const projectId = refine.kind === 'open' ? refine.projectId : activeProjectId
          if (!projectId) {
            setRefine({ kind: 'closed' })
            return
          }
          const agentId = refine.kind === 'open' ? refine.agentId : ''
          const baseBody = refine.kind === 'open' ? refine.baseBody : ''
          minimize({
            kind: 'ai-edit',
            projectId,
            label: t('catalog.aiEditChipLabel', { agentId }),
            restoreRoute: '/agents',
            params: {
              agentId,
              baseBody,
              resumeRefineId: refineId ?? undefined,
            },
          })
          setRefine({ kind: 'closed' })
        }}
        onApplied={(id) => {
          setRefine({ kind: 'closed' })
          setSelectedId(id)
          refresh()
        }}
        onOpenInStudio={(refineId, _draftBody) => {
          setRefine({ kind: 'closed' })
          setStudio({ kind: 'edit', agentId: refine.agentId, draftFromRefine: refineId })
        }}
      />
      </ShellErrorBoundary>
    )
  }

  const templateResults = (() => {
    const q = templateSearch.trim().toLowerCase()
    return AGENT_TEMPLATES.filter((t) => {
      if (templateCategory !== 'all' && t.category !== templateCategory) return false
      if (templateTag && !t.tags.includes(templateTag)) return false
      if (q) {
        const hay = (t.label + ' ' + t.blurb + ' ' + t.tags.join(' ') + ' ' + t.category).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  })()

  const categoryCounts = (() => {
    const counts = new Map<AgentTemplateCategory, number>()
    for (const t of AGENT_TEMPLATES) counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
    return counts
  })()

  const closeTemplates = () => {
    setTemplatesOpen(false)
    setTemplateSearch('')
    setTemplateCategory('all')
    setTemplateTag(null)
  }

  const renderTemplatesDialog = () => (
    <Dialog open={templatesOpen} onOpenChange={(o) => { if (!o) closeTemplates() }}>
      <DialogContent className="max-w-4xl p-0 h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileText className="w-4 h-4 text-accent-primary" /> {t('catalog.templates.title')}
              <span className="text-[11px] font-normal text-muted-foreground ml-1">
                {t('catalog.templates.countOf', {
                  shown: templateResults.length,
                  total: AGENT_TEMPLATES.length,
                })}
              </span>
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t('catalog.templates.description')}
            </p>
          </DialogHeader>

          {/* Search */}
          <div className="mt-3 relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={templateSearch}
              onChange={(e) => setTemplateSearch(e.target.value)}
              placeholder={t('catalog.templates.searchPlaceholder')}
              className="w-full h-9 pl-8 pr-8 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
              autoFocus
            />
            {templateSearch && (
              <button
                type="button"
                onClick={() => setTemplateSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Category chips */}
          <div className="flex gap-1.5 overflow-x-auto mt-3 pb-1 scrollbar-thin">
            <CategoryChip
              label={t('catalog.templates.allCategories')}
              count={AGENT_TEMPLATES.length}
              active={templateCategory === 'all'}
              onClick={() => setTemplateCategory('all')}
            />
            {ALL_TEMPLATE_CATEGORIES.map((cat) => (
              <CategoryChip
                key={cat}
                label={cat}
                count={categoryCounts.get(cat) ?? 0}
                active={templateCategory === cat}
                onClick={() => setTemplateCategory(cat)}
              />
            ))}
          </div>

          {/* Active tag filter */}
          {templateTag && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[11px] text-muted-foreground">{t('catalog.templates.tagFilter')}</span>
              <button
                type="button"
                onClick={() => setTemplateTag(null)}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
              >
                <Tag className="w-3 h-3" /> {templateTag}
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Card list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {templateResults.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center">
              <div className="max-w-sm">
                <div className="text-sm text-muted-foreground">{t('catalog.templates.noMatch')}</div>
                <button
                  type="button"
                  onClick={() => {
                    setTemplateSearch('')
                    setTemplateCategory('all')
                    setTemplateTag(null)
                  }}
                  className="text-xs text-accent-primary hover:underline mt-2"
                >
                  {t('catalog.templates.clearFilters')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {templateResults.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => {
                    closeTemplates()
                    setStudio({ kind: 'create', initialBody: tpl.body, initialName: tpl.nameHint })
                  }}
                  className="group text-left p-4 rounded-lg border border-border bg-card/40 hover:border-accent-primary/50 hover:bg-accent/40 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start gap-3 mb-2">
                    <span className="text-2xl leading-none mt-0.5">{tpl.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground group-hover:text-accent-primary truncate">
                        {tpl.label}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{tpl.category}</div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[2lh]">
                    {tpl.blurb}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-3">
                    {tpl.tags.slice(0, 5).map((tag) => (
                      <span
                        key={tag}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          setTemplateTag(tag)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            setTemplateTag(tag)
                          }
                        }}
                        className={
                          'text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground hover:bg-accent-primary/20 hover:text-accent-primary cursor-pointer transition-colors ' +
                          (templateTag === tag ? 'bg-accent-primary/20 text-accent-primary' : '')
                        }
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between">
                    <code className="text-[10px] font-mono text-muted-foreground/70 truncate">
                      {tpl.nameHint}
                    </code>
                    <span className="text-[10px] text-accent-primary opacity-0 group-hover:opacity-100 transition-opacity">
                      {t('catalog.templates.openInStudio')}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t border-border flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {t('catalog.templates.tip')}
          </span>
          <Button variant="ghost" size="sm" onClick={closeTemplates}>
            {t('common:actions.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )

  const renderGenerateDialog = () => automationEnabled ? (
    <Dialog
      open={generateOpen}
      onOpenChange={(o) => {
        if (!o && !generating) {
          setGenerateOpen(false)
          setGenError(null)
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent-primary" /> {t('catalog.generate.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('catalog.generate.agentIdLabel')}
            </label>
            <Input
              value={genName}
              onChange={(e) => setGenName(e.target.value)}
              placeholder="custom-my-agent"
              className="text-sm font-mono"
              disabled={generating}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              <Trans t={t} i18nKey="catalog.generate.agentIdHint" components={{ code: <code /> }} />
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('catalog.generate.descriptionLabel')}
            </label>
            <textarea
              value={genDescription}
              onChange={(e) => setGenDescription(e.target.value)}
              placeholder={t('catalog.generate.descriptionPlaceholder')}
              className="w-full text-sm p-2 rounded border border-border bg-background min-h-[120px] resize-y"
              disabled={generating}
            />
          </div>
          {genError && (
            <div className="px-3 py-2 text-xs rounded border border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive">
              {genError}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            <Trans t={t} i18nKey="catalog.generate.note" components={{ code: <code /> }} />
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setGenerateOpen(false)}
            disabled={generating}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={runGenerate}
            disabled={generating || !genName.trim() || !genDescription.trim()}
          >
            {generating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> {t('catalog.generate.generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 mr-1.5" /> {t('catalog.generate.generateButton')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  const runGenerate = async () => {
    if (!automationEnabled) return
    setGenerating(true)
    setGenError(null)
    try {
      const res = await fetch(`${getApiBase()}/profiles/catalog/generate?provider=${encodeURIComponent(activeProvider)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: genName.trim(), description: genDescription.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('catalog.errors.generateFailed', { status: res.status }))
      }
      const data = (await res.json()) as { draft: string }
      // Close modal, open Studio in create mode with the draft
      setGenerateOpen(false)
      setStudio({ kind: 'create', initialBody: data.draft, initialName: genName.trim() })
      // Don't reset the fields until the Studio closes, in case user wants to retry
    } catch (e) {
      setGenError((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  const duplicate = async (fromId: string) => {
    try {
      const res = await fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(fromId)}?provider=${encodeURIComponent(activeProvider)}`)
      if (!res.ok) throw new Error(t('catalog.errors.agentLoadFailed', { status: res.status }))
      const data = (await res.json()) as { body: string }
      setStudio({ kind: 'duplicate', from: fromId, initialBody: data.body })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (agents.length === 0) {
    return (
      <>
        <div className="flex items-center justify-center h-full">
          <div className="text-center max-w-sm">
            <div className="text-sm font-medium text-foreground">{t('catalog.empty.title')}</div>
            <div className="text-xs text-muted-foreground mt-1 mb-4">
              <Trans
                t={t}
                i18nKey="catalog.empty.body"
                values={{ command: 'npx specrails-core@latest update' }}
                components={{ code: <code className="text-foreground" /> }}
              />
            </div>
            <div className="flex gap-2 justify-center flex-wrap">
              {automationEnabled && (
                <Button size="sm" onClick={() => setGenerateOpen(true)}>
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" /> {t('catalog.actions.generateWithAi')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setTemplatesOpen(true)}>
                <FileText className="w-3.5 h-3.5 mr-1.5" /> {t('catalog.actions.template')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStudio({ kind: 'create' })}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> {t('catalog.actions.blank')}
              </Button>
            </div>
          </div>
        </div>
        {renderTemplatesDialog()}
        {renderGenerateDialog()}
      </>
    )
  }

  const upstream = agents.filter((a) => a.kind === 'upstream')
  const custom = agents.filter((a) => a.kind === 'custom')
  const selected = agents.find((a) => a.id === selectedId)

  return (
    <>
    {renderTemplatesDialog()}
    {renderGenerateDialog()}
    <div className="flex h-full">
      {/* Left: list grouped by kind */}
      <aside className="w-72 flex-shrink-0 border-r border-border flex flex-col">
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1.5">
            {t('catalog.sidebar.title')}
          </div>
          <div className="text-[10px] text-muted-foreground/70 mb-2">
            {t('catalog.sidebar.createLabel')}
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="flex-1 h-7 text-[11px] px-2"
              onClick={() => setTemplatesOpen(true)}
              title={t('catalog.actions.templateTitle')}
            >
              <FileText className="w-3 h-3 mr-1" /> {t('catalog.actions.template')}
            </Button>
            {automationEnabled && (
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 h-7 text-[11px] px-2"
                onClick={() => setGenerateOpen(true)}
                title={t('catalog.actions.generateWithAi')}
              >
                <Sparkles className="w-3 h-3 mr-1" /> {t('catalog.actions.generate')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="flex-1 h-7 text-[11px] px-2"
              onClick={() => setStudio({ kind: 'create' })}
              title={t('catalog.actions.blankTitle')}
            >
              <Plus className="w-3 h-3 mr-1" /> {t('catalog.actions.blank')}
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          <Section
            title={t('catalog.sections.upstream', { count: upstream.length })}
            description={t('catalog.sections.upstreamDescription')}
          >
            {upstream.map((a) => (
              <CatalogRow
                key={a.id}
                agent={a}
                selected={a.id === selectedId}
                onSelect={() => setSelectedId(a.id)}
              />
            ))}
          </Section>
          <Section
            title={t('catalog.sections.custom', { count: custom.length })}
            description={t('catalog.sections.customDescription')}
          >
            {custom.length === 0 ? (
              <div className="text-[11px] text-muted-foreground px-2 py-2 italic">
                {t('catalog.sections.noCustomAgents')}
              </div>
            ) : (
              custom.map((a) => (
                <CatalogRow
                  key={a.id}
                  agent={a}
                  selected={a.id === selectedId}
                  onSelect={() => setSelectedId(a.id)}
                />
              ))
            )}
          </Section>
        </div>
      </aside>

      {/* Right: selected body */}
      <main className="flex-1 min-w-0 overflow-auto">
        {error && (
          <div className="m-4 px-3 py-2 text-xs rounded border border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive">
            {error}
          </div>
        )}
        {selected && (
          <div className="p-6 min-w-0">
            <div className="flex items-start justify-between gap-4 mb-1">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-mono font-semibold">{selected.id}</h2>
                  <KindBadge kind={selected.kind} />
                  {selected.model && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {t('catalog.detail.defaultModel', { model: selected.model })}
                    </span>
                  )}
                </div>
                {selected.description && (
                  <p className="text-xs text-muted-foreground mt-1 break-words">{selected.description}</p>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <Button size="sm" variant="ghost" onClick={() => void duplicate(selected.id)}>
                  <Copy className="w-3.5 h-3.5 mr-1" /> {t('common:actions.duplicate')}
                </Button>
                {selected.kind === 'custom' && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setStudio({ kind: 'edit', agentId: selected.id })}>
                      <Pencil className="w-3.5 h-3.5 mr-1" /> {t('common:actions.edit')}
                    </Button>
                    {automationEnabled && <Button
                      size="sm"
                      onClick={async () => {
                        if (!activeProjectId) return
                        // Load fresh body from disk so the diff is accurate.
                        try {
                          const r = await fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(selected.id)}?provider=${encodeURIComponent(activeProvider)}`)
                          if (!r.ok) throw new Error(`Load failed: ${r.status}`)
                          const data = (await r.json()) as { body: string }
                          // Mutual exclusion — opening a new AiEdit parks any current one.
                          parkCurrentRefine()
                          liveRefineRef.current = { refineId: null }
                          setRefine({ kind: 'open', projectId: activeProjectId, agentId: selected.id, baseBody: data.body })
                        } catch (e) {
                          setError((e as Error).message)
                        }
                      }}
                      title={t('catalog.detail.aiEditTitle')}
                    >
                      <Wand2 className="w-3.5 h-3.5 mr-1" /> {t('catalog.detail.aiEdit')}
                    </Button>}
                  </>
                )}
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/30 mt-4 min-w-0 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                <span className="text-[11px] font-mono text-muted-foreground truncate">
                  {customRoleDisplayPath(activeProvider, selected.id)}
                </span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-2">
                  {selected.kind === 'upstream'
                    ? t('catalog.detail.readOnly')
                    : t('catalog.detail.editableHint')}
                </span>
              </div>
              <pre className="p-4 text-xs font-mono overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">
                {bodyLoading ? t('common:states.loading') : body ?? ''}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
    </>
  )
}

function CategoryChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-shrink-0 inline-flex items-center gap-1 h-7 px-2.5 text-[11px] rounded-full border transition-colors whitespace-nowrap ' +
        (active
          ? 'bg-accent-primary/20 border-accent-primary/50 text-accent-primary'
          : 'bg-transparent border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground')
      }
    >
      {label}
      <span
        className={
          'text-[9px] px-1 rounded ' +
          (active ? 'bg-accent-primary/30' : 'bg-muted/60')
        }
      >
        {count}
      </span>
    </button>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-4">
      <div className="px-2 pb-1">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </div>
        {description && (
          <div className="text-[11px] text-muted-foreground/70 mt-0.5">{description}</div>
        )}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function CatalogRow({
  agent,
  selected,
  onSelect,
}: {
  agent: CatalogAgent
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        'w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left rounded transition-colors ' +
        (selected
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
      }
    >
      <span className="text-sm font-mono truncate">{agent.id}</span>
      <KindBadge kind={agent.kind} />
    </button>
  )
}

function KindBadge({ kind }: { kind: 'upstream' | 'custom' }) {
  const { t } = useTranslation('agents')
  return (
    <span
      className={
        'text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ' +
        (kind === 'custom'
          ? 'bg-purple-500/15 aurora-light:bg-accent-secondary/15 text-purple-400 aurora-light:text-accent-secondary'
          : 'bg-muted text-muted-foreground')
      }
    >
      {kind === 'custom' ? t('catalog.kind.custom') : t('catalog.kind.upstream')}
    </span>
  )
}
