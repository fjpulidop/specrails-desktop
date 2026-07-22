import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Hammer, Loader2, Rocket, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useDesktop } from '../../hooks/useDesktop'
import { getApiBase } from '../../lib/api'
import { coerceBlueprint, type Blueprint } from '../../lib/blueprint-draft'
import { launchMilestone, milestoneLabel } from '../../lib/milestone-launch'
import {
  useMilestoneSequencer,
  readMilestoneLaunchMode,
  saveMilestoneLaunchMode,
  type MilestoneLaunchMode,
} from '../../context/MilestoneSequencerContext'
import { MilestoneGenerateShell } from './MilestoneGenerateShell'
import { providerSupportsToolPolicy } from '../../lib/provider-capabilities'

// Builder sidebar re-entry (add-project-builder D5/D6): visible only when the
// ACTIVE project's workspace has a blueprint.json (404 hides it). Progress is
// derived LIVE from the ticket board by `M<n>` label — never from the stored
// advisory ticket ids — so manual ticket edits/deletes can't break it.

interface TicketLite {
  id: number
  status: string
  labels: string[]
}

interface MilestoneRow {
  id: string
  title: string
  status: string
  n: number
  done: number
  total: number
}

export function useProjectBlueprint(projectId: string | null, refreshKey = 0): Blueprint | null {
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null)
  useEffect(() => {
    if (!projectId) {
      setBlueprint(null)
      return
    }
    let cancelled = false
    fetch(`/api/projects/${projectId}/blueprint`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { blueprint?: unknown } | null) => {
        if (!cancelled) setBlueprint(data ? coerceBlueprint(data.blueprint) : null)
      })
      .catch(() => {
        if (!cancelled) setBlueprint(null)
      })
    return () => { cancelled = true }
  }, [projectId, refreshKey])
  return blueprint
}

export function deriveMilestoneRows(blueprint: Blueprint, tickets: TicketLite[]): MilestoneRow[] {
  return blueprint.milestones.map((m, index) => {
    const n = index + 1
    const label = milestoneLabel(n)
    const mine = tickets.filter((t) => Array.isArray(t.labels) && t.labels.includes(label))
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      n,
      done: mine.filter((t) => t.status === 'done').length,
      total: mine.length,
    }
  })
}

interface BuilderSidebarEntryProps {
  expanded: boolean
}

export function BuilderSidebarEntry({ expanded }: BuilderSidebarEntryProps) {
  const { t } = useTranslation('builder')
  const { activeProjectId, projects } = useDesktop()
  const [blueprintRefreshKey, setBlueprintRefreshKey] = useState(0)
  const blueprint = useProjectBlueprint(activeProjectId, blueprintRefreshKey)

  const [panelOpen, setPanelOpen] = useState(false)
  const [tickets, setTickets] = useState<TicketLite[]>([])
  const [launching, setLaunching] = useState(false)
  const [launchMode, setLaunchMode] = useState<MilestoneLaunchMode>(() => readMilestoneLaunchMode())
  const { startSequential } = useMilestoneSequencer()
  const [generating, setGenerating] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Fixed-position anchor for the portalled flyout: both host sidebars clip
  // (`overflow-hidden` is load-bearing for their collapse animation), so an
  // in-flow absolute panel is invisible. Portal to <body> + fixed coords.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!panelOpen) {
      setPanelPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const PANEL_WIDTH = 256
      const GAP = 8
      const left = Math.max(GAP, rect.left - PANEL_WIDTH - GAP)
      const top = Math.min(Math.max(GAP, rect.top), Math.max(GAP, window.innerHeight - 160))
      setPanelPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [panelOpen])

  // Live board fetch on open (cheap, avoids a standing subscription here).
  useEffect(() => {
    if (!panelOpen || !activeProjectId) return
    let cancelled = false
    fetch(`${getApiBase()}/tickets`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { tickets?: TicketLite[] } | TicketLite[]) => {
        if (cancelled) return
        setTickets(Array.isArray(data) ? data : data.tickets ?? [])
      })
      .catch(() => { /* keep prior */ })
    return () => { cancelled = true }
  }, [panelOpen, activeProjectId])

  // Close on outside click.
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  const handleLaunchM1 = useCallback(async () => {
    if (!activeProjectId || launching) return
    setLaunching(true)
    try {
      if (launchMode === 'sequential') {
        // Chunk 1 launches now; the sequencer chains the rest as each rail
        // settles (per-chunk progress rides its own toasts).
        const started = await startSequential(activeProjectId, 1)
        if (started) setPanelOpen(false)
        else toast.error(t('done.launchFailed'))
        return
      }
      const result = await launchMilestone(activeProjectId, 1)
      if (result.ok) {
        if (result.skippedCount > 0) {
          toast.warning(t('done.launchPartialToast', { count: result.ticketCount, skipped: result.skippedCount }))
        } else {
          toast.success(t('done.launchToast', { count: result.ticketCount }))
        }
        setPanelOpen(false)
      } else {
        toast.error(t('done.launchFailed'), { description: result.detail ?? result.reason })
      }
    } finally {
      setLaunching(false)
    }
  }, [activeProjectId, launching, launchMode, startSequential, t])

  if (!blueprint || !activeProjectId) return null

  const rows = deriveMilestoneRows(blueprint, tickets)
  const m1Launchable = tickets.some((tk) => tk.status === 'todo' && tk.labels?.includes('M1'))
  const nextPlanned = rows.find((r) => r.status === 'planned' && r.n > 1)
  const project = projects.find((candidate) => candidate.id === activeProjectId)
  const projectProvider = project?.provider ?? project?.providers?.[0] ?? 'claude'
  const milestoneGenerationAvailable = providerSupportsToolPolicy(projectProvider, 'read-only')

  return (
    <div ref={rootRef} className="relative" data-testid="builder-sidebar-entry">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className={cn(
          'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
          expanded ? 'px-2' : 'px-0 justify-center',
          panelOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        )}
        title={!expanded ? t('sidebar.title') : undefined}
        data-testid="builder-sidebar-toggle"
      >
        <Hammer className="w-4 h-4 flex-shrink-0" />
        {expanded && <span className="text-xs truncate">{t('sidebar.title')}</span>}
      </button>

      {panelOpen && panelPos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[72] w-64 rounded-lg border border-border/50 bg-background p-3 shadow-xl"
          style={{ top: panelPos.top, left: panelPos.left }}
          data-testid="builder-sidebar-panel"
        >
          <h4 className="text-xs font-semibold">{t('sidebar.title')}</h4>
          <div className="mt-2 space-y-1.5">
            {rows.map((row) => (
              <div key={row.id || row.n} className="rounded-md border border-border/30 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent-primary/10 px-1.5 py-px text-[9px] font-semibold text-accent-primary">
                    {t('sidebar.milestone', { n: row.n })}
                  </span>
                  <span className="truncate text-[11px] font-medium">{row.title}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                    {t('sidebar.progress', { done: row.done, total: row.total })}
                  </span>
                </div>
                {row.total > 0 && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent-success transition-all"
                      style={{ width: `${Math.round((row.done / row.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {m1Launchable && (
              <>
                {/* Sequential | Parallel — sequential (default) chains each ≤3-spec
                    rail when the previous one settles; parallel launches all at once. */}
                <div
                  className="flex rounded-md border border-border/40 p-0.5 text-[10px]"
                  role="radiogroup"
                  aria-label={t('sequential.modeLabel')}
                  data-testid="milestone-launch-mode"
                >
                  {(['sequential', 'parallel'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={launchMode === m}
                      onClick={() => { setLaunchMode(m); saveMilestoneLaunchMode(m) }}
                      className={cn(
                        'flex-1 rounded px-1.5 py-1 font-medium transition-colors',
                        launchMode === m
                          ? 'bg-accent-primary/15 text-accent-primary'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`sequential.mode.${m}`)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleLaunchM1}
                  disabled={launching}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent-primary/15 px-2 py-1.5 text-[11px] font-medium text-accent-primary transition-colors hover:bg-accent-primary/25 disabled:opacity-50"
                  data-testid="sidebar-launch-m1"
                >
                  {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
                  {t('sidebar.launchM1')}
                </button>
              </>
            )}
            {nextPlanned && (
              <button
                type="button"
                onClick={() => {
                  if (!milestoneGenerationAvailable) return
                  setGenerating(nextPlanned.id)
                  setPanelOpen(false)
                }}
                disabled={!milestoneGenerationAvailable}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-accent-highlight/40 px-2 py-1.5 text-[11px] font-medium text-accent-highlight transition-colors hover:bg-accent-highlight/10"
                title={milestoneGenerationAvailable
                  ? t('sidebar.generateHint')
                  : t('sidebar.generateUnavailable')}
                data-testid="sidebar-generate-next"
              >
                <Sparkles className="h-3 w-3" />
                {t('sidebar.generateNext', { n: nextPlanned.n })}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}

      {generating && (
        <MilestoneGenerateShell
          open
          onClose={() => setGenerating(null)}
          onCommitted={() => setBlueprintRefreshKey((value) => value + 1)}
          projectId={activeProjectId}
          milestoneId={generating}
          blueprint={blueprint}
          provider={projectProvider}
        />
      )}
    </div>
  )
}
