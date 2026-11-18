import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { SIDE_PANE_FIT } from '../lib/mission-side-pane'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useAgentWorkspace } from '../context/AgentWorkspaceContext'

const AnalyticsPage = lazy(() => import('../../analytics/pages/AnalyticsPage'))

const MIN_PANE = 420
const DEFAULT_PANE = 560

/**
 * Agent-Mode inline Analytics pane — the SAME AnalyticsPage the board's right
 * sidebar routes to, embedded beside the conversation with the shared split
 * chrome (left drag handle, maximize-over-surface, close). Purely a renderer:
 * the page owns its data/filters (URL-synced, harmless in Agent Mode).
 */
export function AgentModeAnalyticsPane() {
  const { t } = useTranslation('agent')
  const { closeAnalyticsPane } = useAgentWorkspace()
  const [width, setWidth] = useState(DEFAULT_PANE)
  const [maximized, setMaximized] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.() }, [maximized])

  const beginResize = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    resizeCleanup.current?.()
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - MIN_PANE
    const pointerId = e.pointerId
    const target = e.currentTarget
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const preventSelection = (event: Event) => event.preventDefault()
    document.addEventListener('selectstart', preventSelection)
    try { target.setPointerCapture(pointerId) } catch { /* optional in webviews */ }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      setWidth(Math.min(Math.max(startWidth + startX - ev.clientX, MIN_PANE), maxWidth))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', finish)
      target.removeEventListener('lostpointercapture', finish)
      document.removeEventListener('selectstart', preventSelection)
      document.body.style.userSelect = previousSelect
      document.body.style.cursor = previousCursor
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* already released */ }
      resizeCleanup.current = null
    }
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish() }
    resizeCleanup.current = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', finish)
    target.addEventListener('lostpointercapture', finish)
  }, [width])

  return (
    <div data-area="analytics"
      className={cn(
        'area-surface flex h-full flex-col overflow-hidden border-l border-border bg-background',
        maximized ? 'absolute inset-0 z-30 border-l-0' : cn('relative', SIDE_PANE_FIT),
      )}
      style={maximized ? undefined : { width, flexShrink: 0 }}
      data-testid="agent-analytics-pane"
    >
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
          title={t('workspace.resizeAnalytics')}
        />
      )}
      <div className="area-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-3">
        <span className="text-label text-muted-foreground">{t('workspace.analytics')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={closeAnalyticsPane}
            aria-label={t('workspace.closeAnalytics')}
            title={t('workspace.closeAnalytics')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense
          fallback={
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <RailTrack running className="w-16 shrink-0" />
            </div>
          }
        >
          <AnalyticsPage />
        </Suspense>
      </div>
    </div>
  )
}
