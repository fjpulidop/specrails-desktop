import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { LAYER_CLASS } from '../../../lib/layers'
import { useDesktop } from '../../../hooks/useDesktop'
import { useAssembleProgress } from '../../jobs/hooks/useAssembleProgress'
import { useAnchorRect } from '../hooks/useAnchorRect'
import { useSampleStatus } from '../hooks/useSampleStatus'
import { removeSampleProject, SampleApiError } from '../lib/sample-api'
import { clearGuideState, readGuideState, writeGuideState, type SampleGuideState } from '../lib/sample-guide-state'
import { GUIDE_STEPS, type GuideStep } from '../lib/sample-model'
import { RecordedRunDialog } from './RecordedRunDialog'
import { RemoveSampleDialog } from './RemoveSampleDialog'
import { RunFirstSpec } from './RunFirstSpec'

/** What each step points at on the Board. The review step shares the rail: the decision strip appears there. */
const ANCHORS: Record<GuideStep, string> = {
  spec: '[data-tour="specs-list"]',
  rail: '[data-tour="rail-1"]',
  review: '[data-tour="rail-1"]',
}

interface SampleGuideProps {
  /** Opens the app's Add project dialog ("Now add your own project"). */
  onAddProject: () => void
}

/**
 * The 3-step guide for the sample project: spec, rail, review. A calm, non-modal
 * card at the corner of the Board that points at the real elements, hosts the
 * single "Run the first spec" action and ends with "Now add your own project".
 * Dismissing it (or finishing) collapses it to a pill that keeps "Show guide"
 * and "Remove sample" one click away. Progress is stored per viewer.
 */
export function SampleGuide({ onAddProject }: SampleGuideProps) {
  const { t } = useTranslation('onboarding')
  const { activeProjectId, refreshProjects } = useDesktop()
  const { status, refresh } = useSampleStatus({ refreshKey: activeProjectId })
  const assemble = useAssembleProgress()
  const sample = status?.sample ?? null
  const active = sample !== null && sample.projectId === activeProjectId
  const [guide, setGuide] = useState<SampleGuideState | null>(null)
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => { setGuide(active && sample ? readGuideState(sample.projectId) : null) }, [active, sample?.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((patch: Partial<SampleGuideState>) => {
    setGuide((current) => {
      if (!current) return current
      const next = { ...current, ...patch }
      writeGuideState(next)
      return next
    })
  }, [])

  const step = guide ? GUIDE_STEPS[guide.step] : 'spec'
  const expanded = !!guide && !guide.done
  const rect = useAnchorRect(ANCHORS[step], expanded)
  const specId = useMemo(() => sample?.specIds[0] ?? null, [sample])

  if (!active || !sample || !guide || !status) return null

  const dismiss = () => update({ done: true })
  const last = guide.step === GUIDE_STEPS.length - 1

  async function confirmRemove(deleteFolder: boolean) {
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeSampleProject(deleteFolder)
      clearGuideState()
      setRemoveOpen(false)
      await refreshProjects()
      toast.success(t(deleteFolder ? 'toast.removedDeleted' : 'toast.removed'))
    } catch (err) {
      setRemoveError(err instanceof SampleApiError ? err.message : t('remove.failed'))
    } finally {
      setRemoving(false)
    }
  }

  const dialogs = (
    <>
      <RecordedRunDialog open={recordingOpen} onOpenChange={setRecordingOpen} />
      <RemoveSampleDialog open={removeOpen} path={sample.path} busy={removing} error={removeError} onOpenChange={setRemoveOpen} onConfirm={(deleteFolder) => { void confirmRemove(deleteFolder) }} />
    </>
  )

  if (!expanded) {
    return (
      <>
        <section
          aria-label={t('pill.label')}
          data-testid="sample-pill"
          className={cn('fixed bottom-[44px] left-[calc(var(--sidebar-width,2.75rem)+1rem)] flex items-center gap-1 rounded-pill border border-border/50 bg-popover px-2 py-1 shadow-2', LAYER_CLASS.floatingChat)}
        >
          <Sparkles className="ml-1 size-3.5 text-accent-primary" aria-hidden />
          <span className="px-1 text-label">{t('pill.label')}</span>
          <Button size="sm" variant="ghost" onClick={() => update({ done: false })} data-testid="sample-show-guide">{t('pill.showGuide')}</Button>
          <Button size="sm" variant="ghost" onClick={onAddProject} data-testid="sample-pill-add">{t('guide.addOwn')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setRemoveError(null); setRemoveOpen(true) }} aria-label={t('guide.remove')} title={t('guide.remove')} data-testid="sample-remove">
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </section>
        {dialogs}
      </>
    )
  }

  return (
    <>
      {rect && (
        <div
          aria-hidden
          data-testid="sample-highlight"
          className={cn('pointer-events-none fixed rounded-panel border-2 border-accent-primary/70 shadow-2 motion-safe:transition-all', LAYER_CLASS.floatingChat)}
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      )}
      <section
        ref={cardRef}
        aria-label={t('guide.label')}
        data-testid="sample-guide"
        data-step={step}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss() } }}
        className={cn('fixed bottom-[44px] left-[calc(var(--sidebar-width,2.75rem)+1rem)] w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-panel border border-border/50 bg-popover p-4 text-popover-foreground shadow-3', LAYER_CLASS.floatingChat)}
      >
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-caption text-muted-foreground" data-testid="sample-step-count">{t('guide.stepCount', { current: guide.step + 1, total: GUIDE_STEPS.length })}</p>
            <h2 className="text-title">{t(`steps.${step}.title`)}</h2>
          </div>
          <Button size="icon" variant="ghost" className="-mr-1.5 -mt-1 size-7 shrink-0" onClick={dismiss} aria-label={t('guide.dismiss')} title={t('guide.dismiss')} data-testid="sample-dismiss">
            <X className="size-3.5" aria-hidden />
          </Button>
        </header>

        <p className="text-body text-muted-foreground">{t(`steps.${step}.body`)}</p>

        {step === 'rail' && (
          <RunFirstSpec
            projectId={sample.projectId}
            specId={specId}
            launch={status.launch}
            launched={guide.launched}
            workspace={assemble.statusFor(sample.projectId)}
            onLaunched={() => update({ launched: true })}
            onRetryWorkspace={() => { void assemble.retry(sample.projectId) }}
            onWatchRecording={() => setRecordingOpen(true)}
            onRecheck={() => refresh({ providers: true })}
          />
        )}

        {last && (
          <div className="space-y-2 border-t border-border/40 pt-3">
            <p className="text-body">{t('guide.ending')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { update({ done: true }); onAddProject() }} data-testid="sample-add-own">{t('guide.addOwn')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRemoveError(null); setRemoveOpen(true) }} className="gap-1.5" data-testid="sample-remove">
                <Trash2 className="size-3.5" aria-hidden />{t('guide.remove')}
              </Button>
            </div>
          </div>
        )}

        <footer className="flex items-center justify-between gap-2">
          <ol className="flex items-center gap-1.5" aria-hidden>
            {GUIDE_STEPS.map((id, index) => (
              <li key={id} className={cn('size-1.5 rounded-pill', index === guide.step ? 'bg-accent-primary' : 'bg-border')} />
            ))}
          </ol>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={guide.step === 0} onClick={() => update({ step: guide.step - 1 })} className="gap-1" data-testid="sample-back">
              <ChevronLeft className="size-3.5" aria-hidden />{t('guide.back')}
            </Button>
            {!last ? (
              <Button size="sm" variant="secondary" onClick={() => update({ step: guide.step + 1 })} className="gap-1" data-testid="sample-next">
                {t('guide.next')}<ChevronRight className="size-3.5" aria-hidden />
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={dismiss} data-testid="sample-done">{t('guide.done')}</Button>
            )}
          </div>
        </footer>
      </section>
      {dialogs}
    </>
  )
}
