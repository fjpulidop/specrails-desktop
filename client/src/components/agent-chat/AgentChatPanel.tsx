import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Bot, X, Plus, Maximize2, Minimize2 } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../ui/ResizeGrips'
import { AgentConversationView } from './AgentConversationView'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentMissionSelector } from './AgentMissionSelector'

/** The floating, movable+resizable, non-modal agent chat panel (Kanban Mode
 *  quick-access). Window chrome only — the conversation body is the shared
 *  `AgentConversationView`. */
export function AgentChatPanel() {
  const { t } = useTranslation('agent')
  const { minimize, startNewConversation, cycleTier, active, draftPinnedProjectId, setPinnedProject } = useAgentChat()
  const [maximized, setMaximized] = useState(false)

  // Shift+Tab anywhere in the panel chrome cycles the tier ladder. Presses inside
  // the conversation body are handled (and stopPropagation'd) by AgentConversationView,
  // so this only fires for the header/dialog itself — no double-cycle.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
      e.preventDefault()
      void cycleTier()
    }
  }

  const { panelRef, panelStyle, headerHandleProps, resizeHandles } = useMovableResizableModal({
    enabled: true,
    allowMove: true,
    minWidth: 400,
    minHeight: 420,
    anchorFromCurrentRect: true, // bottom-right panel — don't jump to center on first drag
    persistKey: 'specrails-desktop:agent-panel-geom', // reopen where you left it
  })

  const MAXIMIZED_STYLE: CSSProperties = { position: 'fixed', inset: 12, width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none' }

  return (
    <>
      <motion.div
        ref={panelRef}
        initial={{ opacity: 0, scale: 0.85, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.34, 1.56, 0.64, 1] }}
        style={maximized ? MAXIMIZED_STYLE : panelStyle}
        role="dialog"
        aria-label={t('title')}
        onKeyDown={onPanelKeyDown}
        className={`fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl ${
          maximized ? '' : 'bottom-4 right-4 h-[78vh] max-h-[94vh] w-[520px] max-w-[92vw]'
        }`}
      >
        {/* Header (drag band): identity + window controls. */}
        <div
          {...(maximized ? {} : headerHandleProps)}
          onDoubleClick={() => setMaximized((m) => !m)}
          className={`flex shrink-0 items-center gap-2 border-b border-border/50 bg-surface/40 px-3 py-2 ${maximized ? '' : 'cursor-grab'}`}
        >
          <Bot className="h-4 w-4 shrink-0 text-accent-primary" />
          <span className="shrink-0 text-sm font-medium text-foreground/80">{t('title')}</span>
          {/* Project pin lives in the header (Kanban panel): re-pins the ACTIVE
              conversation, or sets the draft pin on the empty compose screen. */}
          <AgentProjectSelector
            pinnedProjectId={active ? active.pinned_project_id : draftPinnedProjectId}
            onSelect={(id) => void setPinnedProject(id)}
          />
          <div className="h-4 w-px shrink-0 bg-border/60" aria-hidden />
          {/* Mission switcher — the project selector's visual twin. Agent Mode
              keeps its ArcSidebar conversation tree instead (no duplication). */}
          <AgentMissionSelector />
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => startNewConversation(null)} title={t('newConversation')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
              <Plus className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setMaximized((m) => !m)} aria-label={maximized ? t('restore') : t('maximize')} title={maximized ? t('restore') : t('maximize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button type="button" onClick={minimize} aria-label={t('minimize')} title={t('minimize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <AgentConversationView variant="floating" />
      </motion.div>

      {/* Resize grips live OUTSIDE the panel (backdrop-blur/transform would trap
          their fixed positioning). */}
      {!maximized && (
        <div className="pointer-events-none fixed inset-0 z-[61] [&>*]:pointer-events-auto">
          <ResizeGrips handles={resizeHandles} />
        </div>
      )}
    </>
  )
}
