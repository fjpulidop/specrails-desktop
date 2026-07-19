import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileMinus2, FilePlus2, FileText, Sparkles } from 'lucide-react'
import { getApiBase } from '../../lib/api'
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
  ticket: { id: number; title: string | null; status: string | null } | null
}

interface ConstructionStoryProps {
  relPath: string
  height: number
  onOpenTicket: (ticketId: number) => void
  onFilterJob?: (jobId: string) => void
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
export function ConstructionStory({ relPath, height, onOpenTicket, onFilterJob }: ConstructionStoryProps) {
  const { t } = useTranslation('code')
  const { activeProjectId, projects } = useDesktop()
  const activeProvider = projects.find((project) => project.id === activeProjectId)?.provider
  const aiTransformsAvailable = providerSupportsPureOutput(activeProvider)
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [story, setStory] = useState<StoryEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  // Per-card explain state: 'busy' while generating, 'budget' when the monthly
  // cap was hit (card shows the inline "Generate anyway" override).
  const [explainState, setExplainState] = useState<Record<number, 'busy' | 'budget'>>({})

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])
  const relPathRef = useRef(relPath)
  useEffect(() => { relPathRef.current = relPath }, [relPath])

  const reqIdRef = useRef(0)
  const fetchStory = useCallback(async () => {
    const myReq = ++reqIdRef.current
    try {
      const res = await fetch(`${getApiBase()}/code/file/story?path=${encodeURIComponent(relPath)}`)
      if (myReq !== reqIdRef.current) return
      if (!res.ok) {
        setStory([])
        setFailed(true)
        return
      }
      const json = (await res.json()) as { story?: StoryEntry[] }
      if (myReq !== reqIdRef.current) return
      setStory(Array.isArray(json.story) ? json.story : [])
      setFailed(false)
    } catch {
      if (myReq === reqIdRef.current) {
        setStory([])
        setFailed(true)
      }
    }
    // activeProjectId: getApiBase() is project-scoped — refetch on switch.
  }, [relPath, activeProjectId])

  useEffect(() => {
    setStory(null)
    setExplainState({})
    void fetchStory()
  }, [fetchStory])

  useEffect(() => {
    if (!activeProjectId) return
    const id = `code-story-${activeProjectId}`
    registerHandler(id, (raw) => {
      const msg = raw as { type?: string; projectId?: string; path?: string }
      if (msg.projectId !== activeProjectIdRef.current) return
      if (msg.path !== relPathRef.current) return
      if (msg.type === 'file.story_updated' || msg.type === 'file.provenance_updated') {
        void fetchStory()
      }
    })
    return () => unregisterHandler(id)
  }, [activeProjectId, registerHandler, unregisterHandler, fetchStory])

  const explain = useCallback(async (entry: StoryEntry, overrideBudget: boolean) => {
    if (!aiTransformsAvailable) return
    setExplainState((prev) => ({ ...prev, [entry.provenanceId]: 'busy' }))
    try {
      const res = await fetch(
        `${getApiBase()}/code/file/story/explain?path=${encodeURIComponent(relPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provenanceId: entry.provenanceId, overrideBudget }),
        },
      )
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; skipped?: string }
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
      setExplainState((prev) => {
        const next = { ...prev }
        delete next[entry.provenanceId]
        return next
      })
    } catch {
      toast.error(t('story.explainFailed'))
      setExplainState((prev) => {
        const next = { ...prev }
        delete next[entry.provenanceId]
        return next
      })
    }
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
          <div className="text-[11px] text-muted-foreground py-2" data-testid="story-failed">{t('story.loadFailed')}</div>
        ) : story.length === 0 ? (
          <div className="text-[11px] text-muted-foreground py-2" data-testid="story-empty">{t('story.empty')}</div>
        ) : (
          <ol className="relative ml-1.5 border-l border-border/60 space-y-3 py-1">
            {story.map((entry) => (
              <StoryCard
                key={entry.provenanceId}
                entry={entry}
                state={explainState[entry.provenanceId]}
                canExplain={aiTransformsAvailable}
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
  onOpenTicket,
  onFilterJob,
  onExplain,
}: {
  entry: StoryEntry
  state: 'busy' | 'budget' | undefined
  canExplain: boolean
  onOpenTicket: (ticketId: number) => void
  onFilterJob?: (jobId: string) => void
  onExplain: (overrideBudget: boolean) => void
}) {
  const { t } = useTranslation('code')
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
              <p className="text-sm leading-relaxed text-foreground/90" data-testid="story-contribution">{entry.summary}</p>
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
                  {t('story.explainUnavailable')}
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
