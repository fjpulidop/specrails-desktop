import { useCallback, useId, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileMinus2, FilePlus2, FileText, Sparkles } from 'lucide-react'
import { RecordedDiff } from './RecordedDiff'
import { useCodeRepository, matchesCodeRepository } from './CodeRepositoryContext'
import { providerSupportsPureOutput } from '../../lib/provider-capabilities'
import { useDesktop } from '../../hooks/useDesktop'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'

export interface StoryEntry {
  provenanceId: number
  jobId: string | null
  ticketId: number | null
  kind: 'created' | 'modified' | 'deleted'
  at: number
  addedLines: number | null
  removedLines: number | null
  hasPatch: boolean
  summary: string | null
  summaryModel: string | null
  summaryGeneratedAt: string | null
  summaryLanguage?: 'en' | 'es'
  summaryPromptVersion?: number
  summaryStale?: boolean
  evidence?: { kind: 'diff' | 'excerpt' | 'missing'; truncated: boolean }
  summaryEvidence?: { kind: 'diff' | 'excerpt' | 'missing'; truncated: boolean } | null
  ticket: { id: number; title: string | null; status: string | null } | null
}

interface ConstructionStoryProps {
  relPath: string
  height: number
  onOpenTicket: (ticketId: number) => void
  onFilterJob?: (jobId: string) => void
  onViewDiff?: (jobId: string) => void
}

const STATUS_STYLES: Record<string, string> = {
  done: 'bg-accent-success/15 text-accent-success',
  in_progress: 'bg-accent-info/15 text-accent-info',
  on_review: 'bg-accent-warning/15 text-accent-warning',
  todo: 'bg-muted/60 text-muted-foreground',
  draft: 'bg-accent-secondary/15 text-accent-secondary',
}

function kindIcon(kind: StoryEntry['kind']) {
  return kind === 'created' ? FilePlus2 : kind === 'deleted' ? FileMinus2 : FileText
}

/**
 * The per-file "construction story": a premium vertical timeline of every
 * spec/job intervention that built this file, narrated in plain language for
 * non-developers. Contribution text sources, in order: the AI-generated
 * per-intervention paragraph (budget-gated, on demand via the Explain button),
 * then an honest fallback (kind + spec + date — never an invented claim).
 */
export function ConstructionStory(props: ConstructionStoryProps) {
  const scope = useCodeRepository()
  const { activeProjectId } = useDesktop()
  const key = JSON.stringify([activeProjectId, scope.apiBase, scope.repositoryPath, props.relPath])
  return <ConstructionStoryInner key={key} {...props} />
}

function ConstructionStoryInner({ relPath, height, onOpenTicket, onFilterJob, onViewDiff }: ConstructionStoryProps) {
  const { t } = useTranslation('code')
  const repositoryScope = useCodeRepository()
  const { apiBase, repositoryId } = repositoryScope
  const { activeProjectId, projects } = useDesktop()
  const activeProvider = projects.find((project) => project.id === activeProjectId)?.provider
  const aiTransformsAvailable = providerSupportsPureOutput(activeProvider)
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const instanceId = useId()
  const [story, setStory] = useState<StoryEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  const readController = useRef<AbortController | null>(null)
  const postControllers = useRef(new Map<number, AbortController>())
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      readController.current?.abort()
      for (const controller of postControllers.current.values()) controller.abort()
      postControllers.current.clear()
    }
  }, [])
  // Per-card explain state: 'busy' while generating, 'budget' when the monthly
  // cap was hit (card shows the inline "Generate anyway" override).
  const [explainState, setExplainState] = useState<Record<number, 'busy' | 'budget'>>({})

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])
  const relPathRef = useRef(relPath)
  useEffect(() => { relPathRef.current = relPath }, [relPath])

  const reqIdRef = useRef(0)
  const fetchStory = useCallback(async () => {
    if (!alive.current) return
    const myReq = ++reqIdRef.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    try {
      const res = await fetch(`${apiBase}/code/file/story?path=${encodeURIComponent(relPath)}`, { signal: controller.signal })
      if (!alive.current || controller.signal.aborted || myReq !== reqIdRef.current) return
      if (!res.ok) {
        setStory([])
        setFailed(true)
        return
      }
      const json = (await res.json()) as { story?: StoryEntry[] }
      if (!alive.current || controller.signal.aborted || myReq !== reqIdRef.current) return
      setStory(Array.isArray(json.story) ? json.story : [])
      setFailed(false)
    } catch {
      if (alive.current && !controller.signal.aborted && myReq === reqIdRef.current) {
        setStory([])
        setFailed(true)
      }
    }
    // activeProjectId: getApiBase() is project-scoped — refetch on switch.
  }, [relPath, activeProjectId, apiBase])

  useEffect(() => {
    setStory(null)
    setExplainState({})
    void fetchStory()
  }, [fetchStory])

  useEffect(() => {
    if (!activeProjectId) return
    const id = `code-story-${activeProjectId}-${repositoryId ?? 'primary'}-${instanceId}`
    registerHandler(id, (raw) => {
      const msg = raw as { type?: string; repositoryId?: string; projectId?: string; path?: string }
      if (msg.projectId !== activeProjectIdRef.current || !matchesCodeRepository(msg.repositoryId, repositoryScope)) return
      if (msg.path !== relPathRef.current) return
      if (msg.type === 'file.story_updated' || msg.type === 'file.provenance_updated') {
        void fetchStory()
      }
    })
    return () => unregisterHandler(id)
  }, [instanceId, apiBase, repositoryId, activeProjectId, registerHandler, unregisterHandler, fetchStory])

  const explain = useCallback(async (entry: StoryEntry, overrideBudget: boolean) => {
    if (!aiTransformsAvailable || !alive.current || !entry.hasPatch || entry.evidence?.kind === 'missing' || postControllers.current.has(entry.provenanceId)) return
    const controller = new AbortController()
    postControllers.current.set(entry.provenanceId, controller)
    setExplainState((prev) => ({ ...prev, [entry.provenanceId]: 'busy' }))
    try {
      const res = await fetch(
        `${apiBase}/code/file/story/explain?path=${encodeURIComponent(relPath)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provenanceId: entry.provenanceId, overrideBudget, ...(entry.summaryStale ? { force: true } : {}) }),
        },
      )
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; skipped?: string }
      if (!alive.current || controller.signal.aborted) return
      if (json.skipped === 'budget') {
        setExplainState((prev) => ({ ...prev, [entry.provenanceId]: 'budget' }))
        return
      }
      if (!res.ok || !json.ok) {
        toast.error(t('story.explainFailed'))
        setExplainState((prev) => {
          const next = { ...prev }
          delete next[entry.provenanceId]
          return next
        })
        return
      }
      await fetchStory()
      if (!alive.current || controller.signal.aborted) return
      setExplainState((prev) => {
        const next = { ...prev }
        delete next[entry.provenanceId]
        return next
      })
    } catch {
      if (!alive.current || controller.signal.aborted) return
      toast.error(t('story.explainFailed'))
      setExplainState((prev) => {
        const next = { ...prev }
        delete next[entry.provenanceId]
        return next
      })
    } finally { postControllers.current.delete(entry.provenanceId) }
  }, [aiTransformsAvailable, fetchStory, relPath, t])

  return (
    <div
      className="shrink-0 border-t border-border bg-card/40 px-4 py-3 overflow-hidden"
      style={{ height }}
      data-testid="construction-story"
    >
      <div className="h-full overflow-auto">
        {story === null ? (
          <div className="text-[11px] text-muted-foreground animate-pulse py-2">{t('story.loading')}</div>
        ) : failed ? (
          <div className="text-[11px] text-muted-foreground py-2" data-testid="story-failed" role="alert">{t('story.loadFailed')} <button className="ml-2 underline" onClick={() => { void fetchStory() }}>{t('reader.retry', { defaultValue: 'Retry' })}</button></div>
        ) : story.length === 0 ? (
          <div className="text-[11px] text-muted-foreground py-2" data-testid="story-empty">{t('story.empty')}</div>
        ) : (
          <ol className="relative ml-1.5 border-l border-border/60 space-y-3 py-1">
            {story.map((entry) => (
              <StoryCard
                key={entry.provenanceId}
                entry={entry}
                state={explainState[entry.provenanceId]}
                canExplain={aiTransformsAvailable && entry.hasPatch && entry.evidence?.kind !== 'missing'}
                path={relPath}
                onViewDiff={onViewDiff}
                onOpenTicket={onOpenTicket}
                onFilterJob={onFilterJob}
                onExplain={(override) => { void explain(entry, override) }}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function StoryCard({
  entry,
  state,
  canExplain,
  path,
  onViewDiff,
  onOpenTicket,
  onFilterJob,
  onExplain,
}: {
  entry: StoryEntry
  state: 'busy' | 'budget' | undefined
  canExplain: boolean
  path: string
  onViewDiff?: (jobId: string) => void
  onOpenTicket: (ticketId: number) => void
  onFilterJob?: (jobId: string) => void
  onExplain: (overrideBudget: boolean) => void
}) {
  const { t } = useTranslation('code')
  const [diffOpen, setDiffOpen] = useState(false)
  const Icon = kindIcon(entry.kind)
  const status = entry.ticket?.status ?? null
  const specLabel = entry.ticket?.title
    ? `#${entry.ticket.id} · ${entry.ticket.title}`
    : entry.ticketId != null
      ? t('story.spec', { ticketId: entry.ticketId })
      : null
  const fallbackKey = entry.ticketId != null ? entry.kind : (`${entry.kind}NoSpec` as const)

  return (
    <li className="relative pl-4" data-testid="story-card">
      {/* timeline dot */}
      <span
        aria-hidden
        className={`absolute -left-[5px] top-2 h-2.5 w-2.5 rounded-full border-2 border-background ${
          entry.kind === 'created' ? 'bg-accent-success' : entry.kind === 'deleted' ? 'bg-destructive' : 'bg-accent-info'
        }`}
      />
      <article className="rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 backdrop-blur-sm transition-colors hover:border-border">
        <header className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {t(`story.kindLabel.${entry.kind}`)}
          </span>
          {specLabel != null && entry.ticketId != null && (
            <button
              type="button"
              onClick={() => onOpenTicket(entry.ticketId!)}
              className="min-w-0 max-w-full truncate rounded bg-accent-primary/15 px-1.5 py-0.5 text-left text-[11px] font-medium text-accent-primary hover:bg-accent-primary/25"
              title={t('story.openSpec', { ticketId: entry.ticketId })}
            >
              {specLabel}
            </button>
          )}
          {specLabel == null && (
            <span className="text-[11px] text-muted-foreground">{t('story.unknownSpec')}</span>
          )}
          {status && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLES[status] ?? 'bg-muted/60 text-muted-foreground'}`}
              data-testid="story-status-pill"
            >
              {status}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            {entry.addedLines != null && entry.addedLines > 0 && (
              <span className="font-mono text-[10px] text-accent-success" title={t('story.linesAdded')}>+{entry.addedLines}</span>
            )}
            {entry.removedLines != null && entry.removedLines > 0 && (
              <span className="font-mono text-[10px] text-destructive" title={t('story.linesRemoved')}>−{entry.removedLines}</span>
            )}
            <time className="text-[10px] text-muted-foreground" dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleString()}
            </time>
          </span>
        </header>
        <div className="mt-1.5">
          {entry.summary ? (
            <>
              {entry.summaryStale && <span className="text-[10px] text-accent-warning">{t('summary.stale')}</span>}
              <p className="text-sm leading-relaxed text-foreground/90" data-testid="story-contribution">{entry.summary}</p>
              {entry.summaryGeneratedAt && <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={entry.summaryGeneratedAt}>{new Date(entry.summaryGeneratedAt).toLocaleString()}</time>}
              {entry.summaryStale && canExplain && (state === 'budget'
                ? <span className="mt-1 inline-flex items-center gap-2 text-[11px] text-accent-warning"><span>{t('story.budgetReached')}</span><button className="rounded border px-2 py-1" onClick={() => onExplain(true)}>{t('story.generateAnyway')}</button></span>
                : <button disabled={state === 'busy'} className="mt-1 rounded border px-2 py-1 text-[11px]" onClick={() => onExplain(false)}>{state === 'busy' ? t('story.explaining') : t('reader.regenerateExplanation', { defaultValue: 'Refresh explanation' })}</button>)}
              {entry.summaryModel && (
                <p className="mt-1 text-[10px] text-muted-foreground/80">{t('story.explainedBy', { model: entry.summaryModel })}</p>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground" data-testid="story-fallback">
                {t(`story.fallback.${fallbackKey}`)}
              </p>
              {!canExplain ? (
                <span
                  className="text-[10px] text-muted-foreground"
                  data-testid="story-explain-unavailable"
                >
                  {!entry.hasPatch || entry.evidence?.kind === 'missing' ? t('reader.noEvidence', { defaultValue: 'No patch evidence was stored for this change.' }) : t('story.explainUnavailable')}
                </span>
              ) : state === 'budget' ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[10px] text-accent-warning">{t('story.budgetReached')}</span>
                  <button
                    type="button"
                    onClick={() => onExplain(true)}
                    className="rounded bg-accent-warning/15 px-1.5 py-0.5 text-[10px] text-accent-warning hover:bg-accent-warning/25"
                  >
                    {t('story.generateAnyway')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onExplain(false)}
                  disabled={state === 'busy'}
                  className="inline-flex items-center gap-1 rounded bg-accent-primary/10 px-1.5 py-0.5 text-[10px] text-accent-primary hover:bg-accent-primary/20 disabled:opacity-60"
                  data-testid="story-explain"
                >
                  <Sparkles className={state === 'busy' ? 'h-3 w-3 animate-pulse' : 'h-3 w-3'} />
                  {state === 'busy' ? t('story.explaining') : t('story.explain')}
                </button>
              )}
            </div>
          )}
        </div>
        {entry.summary && (!entry.hasPatch || entry.evidence?.kind === 'missing') && <p className="mt-2 text-[10px] text-accent-warning">{t('reader.noEvidence', { defaultValue: 'No patch evidence was stored for this change.' })}</p>}
        {(entry.summaryEvidence?.truncated ?? entry.evidence?.truncated) && <p className="mt-2 text-[10px] text-accent-warning">{t('reader.excerptEvidence', { defaultValue: 'This explanation uses incomplete patch evidence.' })}</p>}
        {entry.jobId && <div className="mt-2">
          <button className="rounded border px-2 py-1 text-[11px]" onClick={() => { if (onViewDiff) onViewDiff(entry.jobId!); else setDiffOpen((value) => !value) }}>{t('reader.viewPatch', { defaultValue: 'View recorded change' })}</button>
          {diffOpen && <div className="mt-2"><RecordedDiff path={path} jobId={entry.jobId} /></div>}
        </div>}
        {entry.jobId && onFilterJob && (
          <footer className="mt-1.5">
            <button
              type="button"
              onClick={() => onFilterJob(entry.jobId!)}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
              title={t('history.filterByJob', { jobId: entry.jobId })}
            >
              {entry.jobId.length > 12 ? entry.jobId.slice(0, 12) : entry.jobId}
            </button>
          </footer>
        )}
      </article>
    </li>
  )
}

export default ConstructionStory
