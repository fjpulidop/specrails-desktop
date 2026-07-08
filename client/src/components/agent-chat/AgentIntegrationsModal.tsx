import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Puzzle, X } from 'lucide-react'
import type { ReactElement } from 'react'
import PluginsPage from '../../pages/PluginsPage'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../ui/ResizeGrips'
import { TooltipProvider } from '../ui/tooltip'

interface AgentIntegrationsModalProps {
  onClose: () => void
}

export function AgentIntegrationsModal({ onClose }: AgentIntegrationsModalProps): ReactElement {
  const { t } = useTranslation('nav')
  const { t: tCommon } = useTranslation('common')
  const {
    panelRef,
    panelStyle,
    headerHandleProps,
    resizeHandles,
    isFloating,
    guardBackdrop,
  } = useMovableResizableModal({
    minWidth: 320,
    minHeight: 200,
    persistKey: 'specrails-desktop:agent-integrations-modal',
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <TooltipProvider delayDuration={400}>
      <div className="fixed inset-0 z-[65] flex items-stretch justify-center">
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={guardBackdrop(onClose)}
        />

        <div
          ref={panelRef}
          className="relative m-3 flex w-full flex-col overflow-hidden rounded-xl border border-border/30 glass-card animate-in fade-in zoom-in-95 duration-200"
          style={panelStyle}
        >
          <div
            {...headerHandleProps}
            className={`flex items-center justify-between border-b border-border/30 px-4 py-3${isFloating ? ' cursor-grab active:cursor-grabbing' : ''}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Puzzle className="h-4 w-4 flex-shrink-0 text-accent-primary" />
              <h2 className="truncate text-sm font-semibold text-foreground">
                {t('rightSidebar.integrations')}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={tCommon('actions.close')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface/50 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <PluginsPage />
          </div>
        </div>

        <ResizeGrips handles={resizeHandles} />
      </div>
    </TooltipProvider>,
    document.body,
  )
}
