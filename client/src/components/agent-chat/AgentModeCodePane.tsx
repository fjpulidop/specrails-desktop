import { readMissionCode, saveMissionCode } from '../../lib/mission-view-state'
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'

const CodePage = lazy(() => import('../../pages/CodePage'))

// Per-conversation code selection, kept in-session so reopening Files returns to
// the last file (design D15 — context/session state, never the URL).


const MIN_PANE = 420
const DEFAULT_PANE = 560

/**
 * Agent-Mode inline Code pane (Cursor-style split). Renders the embedded,
 * controlled `CodePage` beside the conversation thread with a left drag handle
 * and a maximize toggle. Requires an active project (enforced by the caller).
 */
export function AgentModeCodePane({ projectId, conversationId }: { projectId: string; conversationId: string }) {
  const { t } = useTranslation('agent')
  const { closeCodePane } = useAgentWorkspace()
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_PANE)
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth)
  const [maximized, setMaximized] = useState(false)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)
  // Preserve room for the conversation, relaxing both minimums on narrow
  // surfaces. The user's preferred width survives temporary window shrinkage.
  const maximumWidth = Math.max(0, availableWidth - Math.min(MIN_PANE, availableWidth / 2))
  const minimumWidth = Math.min(MIN_PANE, maximumWidth)
  const width = Math.min(maximumWidth, Math.max(minimumWidth, preferredWidth))
  const clampWidth = useCallback((value: number) => Math.min(maximumWidth, Math.max(minimumWidth, value)), [maximumWidth, minimumWidth])

  // Scope by project AND conversation — the '__home__' fallback conversation key
  // is shared across projects and would bleed a file path between them.
  const selectionKey = `${projectId}:${conversationId}`
  const onSelectedPathChange = useCallback((p: string | null) => {
    saveMissionCode(projectId, conversationId, { path: p })
  }, [projectId, conversationId])

  useLayoutEffect(() => {
    const pane = paneRef.current
    const parent = pane?.parentElement
    if (!pane || !parent) return
    const measure = () => {
      const parentWidth = parent.getBoundingClientRect().width || parent.clientWidth || window.innerWidth
      let occupied = 0
      for (const sibling of parent.children) {
        if (sibling === pane || !(sibling instanceof HTMLElement)) continue
        const style = getComputedStyle(sibling)
        // The growing conversation shares the remaining width; overlays do not
        // participate in the row. Account for other fixed workspace panes.
        if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed' || Number(style.flexGrow) > 0) continue
        occupied += sibling.getBoundingClientRect().width
      }
      setAvailableWidth(Math.max(0, parentWidth - occupied))
    }
    const observer = new ResizeObserver(measure)
    const observeChildren = () => {
      observer.disconnect()
      observer.observe(parent)
      for (const child of parent.children) if (child !== pane) observer.observe(child)
      measure()
    }
    const mutations = new MutationObserver(observeChildren)
    mutations.observe(parent, { childList: true })
    observeChildren()
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', measure) }
  }, [selectionKey])

  useEffect(() => () => { resizeCleanup.current?.() }, [selectionKey, maximized, maximumWidth])

  const beginResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    resizeCleanup.current?.()
    const startX = e.clientX
    const startWidth = width
    const pointerId = e.pointerId
    const target = e.currentTarget
    try { target.setPointerCapture(pointerId) } catch { /* optional in webviews */ }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      // Drag left edge → wider pane as pointer moves left.
      setPreferredWidth(clampWidth(startWidth + startX - ev.clientX))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', finish)
      target.removeEventListener('lostpointercapture', finish)
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
  }, [width, clampWidth])

  return (
    // Maximized = REALLY maximized: cover the whole Agent-Mode surface
    // (absolute over the relative surface root), not just grow in the flex row.
    <div
      ref={paneRef}
      className={`flex h-full min-w-0 flex-col overflow-hidden border-l border-border bg-background${
        maximized ? ' absolute inset-0 z-30 border-l-0' : ' relative'
      }`}
      style={maximized ? undefined : { width, maxWidth: '100%', flexShrink: 0 }}
      data-testid="agent-code-pane"
      // key by project+conversation so the embedded tree/viewer reset on switch
      // and each conversation restores its own last file (design D15)
      key={selectionKey}
    >
      {!maximized && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={beginResize}
            tabIndex={0}
            aria-label={t('workspace.resizeCode')}
            aria-valuemin={Math.round(minimumWidth)}
            aria-valuemax={Math.round(maximumWidth)}
            aria-valuenow={Math.round(width)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowLeft' ? width + 32 : event.key === 'ArrowRight' ? width - 32 : event.key === 'Home' ? minimumWidth : event.key === 'End' ? maximumWidth : null
              if (next === null) return
              event.preventDefault()
              setPreferredWidth(clampWidth(next))
            }}
            className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize select-none touch-none hover:bg-accent-primary/20 focus-visible:bg-accent-primary/30 focus-visible:outline-none"
            title={t('workspace.resizeCode')}
          />
      )}
      <div className="flex items-center gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
        <span className="text-xs font-medium text-foreground/70">{t('workspace.files')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => { resizeCleanup.current?.(); setMaximized((m) => !m) }}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => { resizeCleanup.current?.(); closeCodePane() }}
            aria-label={t('workspace.closeFiles')}
            title={t('workspace.closeFiles')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>}>
          <CodePage
            embedded
            key={selectionKey}
            initialRepositoryId={readMissionCode(projectId, conversationId).repositoryId}
            onRepositoryChange={(id) => saveMissionCode(projectId, conversationId, { repositoryId: id })}
            initialPath={readMissionCode(projectId, conversationId).path}
            onSelectedPathChange={onSelectedPathChange}
          />
        </Suspense>
      </div>
    </div>
  )
}
