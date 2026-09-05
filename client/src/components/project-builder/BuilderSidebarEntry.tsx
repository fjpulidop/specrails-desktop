import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Hammer, Loader2, Rocket, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useDesktop } from '../../hooks/useDesktop'
import { useMilestoneProgress } from '../../hooks/useMilestoneProgress'
import { FEATURE_REVIEW_PACKET } from '../../lib/feature-flags'
import {
  cancelChain,
  launchMilestone,
  milestoneLabel,
  readMilestoneAutoAdvance,
  readMilestoneLaunchMode,
  resumeChain,
  saveMilestoneAutoAdvance,
  saveMilestoneLaunchMode,
  setChainAutoAdvance,
  type MilestoneLaunchMode,
} from '../../lib/milestone-launch'
import { isMilestoneLaunchable } from '../../lib/milestone-progress'
import { MilestoneAutoAdvanceToggle, MilestoneCard } from './MilestoneProgressCard'
import { MilestoneGenerateShell } from './MilestoneGenerateShell'
import { providerSupportsToolPolicy } from '../../lib/provider-capabilities'

// Builder sidebar re-entry (add-project-builder D5/D6, premium-milestone-
// progress D5): visible only when the ACTIVE project has a blueprint (the
// `/blueprint` route 404s otherwise). Every milestone renders the SERVER-
// derived live progress model — counts by spec state, the segmented bar, the
// milestone's rails with their decisions, the launch chain — kept live by the
// `blueprint.milestone_progress` broadcast. No board fetch on open.

interface BuilderSidebarEntryProps {
  expanded: boolean
}

export function BuilderSidebarEntry({ expanded }: BuilderSidebarEntryProps) {
  const { t } = useTranslation('builder')
  const navigate = useNavigate()
  const { activeProjectId, projects } = useDesktop()
  const { blueprint, progress, hasBlueprint, refresh } = useMilestoneProgress(activeProjectId)

  const [panelOpen, setPanelOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [chainBusy, setChainBusy] = useState(false)
  const [launchMode, setLaunchMode] = useState<MilestoneLaunchMode>(() => readMilestoneLaunchMode())
  // Wave checkpoints (D9): OFF by default — the chain asks before each next rail.
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() => readMilestoneAutoAdvance())
  const [generating, setGenerating] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Fixed-position anchor for the portalled flyout: both host sidebars clip
  // (`overflow-hidden` is load-bearing for their collapse animation), so an
  // in-flow absolute panel is invisible. Portal to <body> + fixed coords.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const PANEL_WIDTH = 320

  useLayoutEffect(() => {
    if (!panelOpen) {
      setPanelPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const GAP = 8
      const left = Math.max(GAP, rect.left - PANEL_WIDTH - GAP)
      const top = Math.min(Math.max(GAP, rect.top), Math.max(GAP, window.innerHeight - 240))
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
      const result = await launchMilestone(activeProjectId, 1, launchMode, { autoAdvance })
      const label = milestoneLabel(1)
      if (result.ok) {
        const totalRails = result.launched.length + result.pending.length
        if (launchMode === 'sequential' && result.pending.length > 0) {
          toast.success(t(autoAdvance ? 'milestoneProgress.toast.launched' : 'milestoneProgress.toast.launchedCheckpoint', { milestone: label, count: result.ticketCount, n: totalRails }))
        } else if (result.skippedCount > 0) {
          toast.warning(t('milestoneProgress.toast.launchedPartial', { milestone: label, count: result.ticketCount, skipped: result.skippedCount }))
        } else {
          toast.success(t('milestoneProgress.toast.launchedAll', { milestone: label, count: result.ticketCount, n: totalRails }))
        }
        setPanelOpen(false)
      } else if (result.reason === 'chain_active') {
        toast.info(t('milestoneProgress.toast.chainActive', { milestone: label }))
      } else {
        toast.error(t('done.launchFailed'), { description: result.detail ?? result.error })
      }
    } finally {
      setLaunching(false)
    }
  }, [activeProjectId, autoAdvance, launching, launchMode, t])

  const handleSetAutoAdvance = useCallback(async (chainId: string, on: boolean) => {
    if (!activeProjectId || chainBusy) return
    setChainBusy(true)
    try {
      const r = await setChainAutoAdvance(activeProjectId, chainId, on)
      if (r.ok) {
        // The chain flag is also the user's preference for the next launch.
        setAutoAdvance(on)
        saveMilestoneAutoAdvance(on)
        toast.success(t(on ? 'milestoneProgress.chain.autoOn' : 'milestoneProgress.chain.autoOff'))
      } else {
        toast.error(t('milestoneProgress.chain.autoFailed'), { description: r.detail ?? r.error })
      }
    } finally {
      setChainBusy(false)
    }
  }, [activeProjectId, chainBusy, t])

  const handleResume = useCallback(async (chainId: string) => {
    if (!activeProjectId || chainBusy) return
    setChainBusy(true)
    try {
      const r = await resumeChain(activeProjectId, chainId)
      if (r.ok) toast.success(t('milestoneProgress.chain.resumed'))
      else toast.error(t('milestoneProgress.chain.resumeFailed'), { description: r.detail ?? r.error })
    } finally {
      setChainBusy(false)
    }
  }, [activeProjectId, chainBusy, t])

  const handleCancel = useCallback(async (chainId: string) => {
    if (!activeProjectId || chainBusy) return
    setChainBusy(true)
    try {
      const r = await cancelChain(activeProjectId, chainId)
      if (r.ok) toast.success(t('milestoneProgress.chain.cancelledToast'))
      else toast.error(r.detail ?? r.error)
    } finally {
      setChainBusy(false)
    }
  }, [activeProjectId, chainBusy, t])

  const openReview = useCallback((deliveryId: string) => {
    setPanelOpen(false)
    navigate(FEATURE_REVIEW_PACKET ? `/review/${deliveryId}` : '/')
  }, [navigate])

  const openRail = useCallback(() => {
    setPanelOpen(false)
    navigate('/')
  }, [navigate])

  if (!activeProjectId || hasBlueprint === false || !blueprint) return null

  const m1 = progress.find((p) => p.n === 1) ?? null
  const m1Launchable = m1 !== null && isMilestoneLaunchable(m1)
  const nextPlanned = progress.find((p) => p.state === 'planned' && p.n > 1) ?? null
  const project = projects.find((candidate) => candidate.id === activeProjectId)
  const projectProvider = project?.provider ?? project?.providers?.[0] ?? 'claude'
  const milestoneGenerationAvailable = providerSupportsToolPolicy(projectProvider, 'read-only')

  const launchControls = m1Launchable ? (
    <>
      {/* Sequential | Parallel — sequential (default) chains each ≤3-spec rail
          on the previous rail's delivered branch; parallel launches all at once. */}
      <div
        className="flex rounded-md border border-border/40 p-0.5 text-[10px]"
        role="radiogroup"
        aria-label={t('sequential.modeLabel')}
        title={launchMode === 'sequential' ? t('milestoneProgress.sequentialHint') : t('milestoneProgress.parallelHint')}
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
      {launchMode === 'sequential' && (
        <MilestoneAutoAdvanceToggle
          checked={autoAdvance}
          onChange={(on) => { setAutoAdvance(on); saveMilestoneAutoAdvance(on) }}
          testId="sidebar-auto-advance"
        />
      )}
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
  ) : null

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
          className="fixed z-[72] w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-border/50 bg-background p-3 shadow-xl"
          style={{ top: panelPos.top, left: panelPos.left }}
          data-testid="builder-sidebar-panel"
        >
          <h4 className="text-xs font-semibold">{t('sidebar.title')}</h4>
          <div className="mt-2 space-y-1.5">
            {progress.map((row) => (
              <MilestoneCard
                key={row.id || row.n}
                progress={row}
                actions={row.n === 1 ? launchControls : undefined}
                chainBusy={chainBusy}
                onReview={openReview}
                onOpenRail={openRail}
                onResume={handleResume}
                onCancel={handleCancel}
                onSetAutoAdvance={handleSetAutoAdvance}
              />
            ))}
          </div>

          {nextPlanned && (
            <div className="mt-3 flex flex-col gap-1.5">
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
            </div>
          )}
        </div>,
        document.body,
      )}

      {generating && (
        <MilestoneGenerateShell
          open
          onClose={() => setGenerating(null)}
          onCommitted={() => { void refresh() }}
          projectId={activeProjectId}
          milestoneId={generating}
          blueprint={blueprint}
          provider={projectProvider}
        />
      )}
    </div>
  )
}
