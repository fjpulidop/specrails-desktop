import { Suspense, lazy, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, X, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'

const AnalyticsPage = lazy(() => import('../../pages/AnalyticsPage'))

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

  const beginResize = useCallback((e: React.PointerEvent) => {
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - MIN_PANE
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), MIN_PANE), maxWidth)
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [width])

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden border-l border-border bg-background',
        maximized && 'absolute inset-0 z-30 border-l-0',
      )}
      style={maximized ? undefined : { width, flexShrink: 0 }}
      data-testid="agent-analytics-pane"
    >
      <div className="relative flex items-center">
        {!maximized && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={beginResize}
            className="absolute left-0 top-0 h-full w-1.5 -translate-x-full cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
            title={t('workspace.resizeAnalytics')}
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
        <span className="text-xs font-medium text-foreground/70">{t('workspace.analytics')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={closeAnalyticsPane}
            aria-label={t('workspace.closeAnalytics')}
            title={t('workspace.closeAnalytics')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense
          fallback={
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          }
        >
          <AnalyticsPage />
        </Suspense>
      </div>
    </div>
  )
}
