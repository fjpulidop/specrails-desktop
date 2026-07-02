import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'

const CodePage = lazy(() => import('../../pages/CodePage'))

// Per-conversation code selection, kept in-session so reopening Files returns to
// the last file (design D15 — context/session state, never the URL).
const codeSelection = new Map<string, string | null>()

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
  const [width, setWidth] = useState(DEFAULT_PANE)
  const [maximized, setMaximized] = useState(false)
  const paneRef = useRef<HTMLDivElement | null>(null)

  // Scope by project AND conversation — the '__home__' fallback conversation key
  // is shared across projects and would bleed a file path between them.
  const selectionKey = `${projectId}:${conversationId}`
  const onSelectedPathChange = useCallback((p: string | null) => {
    codeSelection.set(selectionKey, p)
  }, [selectionKey])

  const beginResize = useCallback((e: React.PointerEvent) => {
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - MIN_PANE
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    const onMove = (ev: PointerEvent) => {
      // Drag left edge → wider pane as pointer moves left.
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
      ref={paneRef}
      className="flex h-full flex-col overflow-hidden border-l border-border bg-background"
      style={maximized ? { flex: 1 } : { width, flexShrink: 0 }}
      // key by project+conversation so the embedded tree/viewer reset on switch
      // and each conversation restores its own last file (design D15)
      key={selectionKey}
    >
      <div className="relative flex items-center">
        {!maximized && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={beginResize}
            className="absolute left-0 top-0 h-full w-1.5 -translate-x-full cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
            title={t('workspace.resizeCode')}
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
        <span className="text-xs font-medium text-foreground/70">{t('workspace.files')}</span>
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
            onClick={closeCodePane}
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
            initialPath={codeSelection.get(selectionKey) ?? null}
            onSelectedPathChange={onSelectedPathChange}
          />
        </Suspense>
      </div>
    </div>
  )
}
