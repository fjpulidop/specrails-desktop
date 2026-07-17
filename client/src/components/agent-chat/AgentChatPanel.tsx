import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Bot, X, Plus, Maximize2, Minimize2, Rocket } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../ui/ResizeGrips'
import { AgentConversationView } from './AgentConversationView'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentMissionSelector } from './AgentMissionSelector'
import { Button } from '../ui/button'
import { BuilderHalo } from '../project-builder/BuilderHalo'
import { BuilderConversation } from '../project-builder/BuilderConversation'
import { BlueprintPanel } from '../project-builder/BlueprintPanel'

/** The floating, movable+resizable, non-modal agent chat panel (Kanban Mode
 *  quick-access). Window chrome only — the conversation body is the shared
 *  `AgentConversationView`. */
export function AgentChatPanel() {
  const { t } = useTranslation('agent')
  const { t: tBuilder } = useTranslation('builder')
  const { minimize, startNewConversation, cycleTier, active, draftPinnedProjectId, setPinnedProject, builderMode } = useAgentChat()
  const [maximized, setMaximized] = useState(false)
  const builder = builderMode.active

  // Shift+Tab anywhere in the panel chrome cycles the tier ladder. Presses inside
  // the conversation body are handled (and stopPropagation'd) by AgentConversationView,
  // so this only fires for the header/dialog itself — no double-cycle.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (builder) return
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
        aria-label={builder ? tBuilder('mode.title') : t('title')}
        onKeyDown={onPanelKeyDown}
        className={`fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl ${
          maximized ? '' : `bottom-4 right-4 h-[78vh] max-h-[94vh] max-w-[92vw] ${builder ? 'w-[860px]' : 'w-[520px]'}`
        }`}
      >
        {/* Header (drag band): identity + window controls. */}
        <div
          {...(maximized ? {} : headerHandleProps)}
          onDoubleClick={() => setMaximized((m) => !m)}
          className={`flex shrink-0 items-center gap-2 border-b border-border/50 bg-surface/40 px-3 py-2 ${maximized ? '' : 'cursor-grab'}`}
        >
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <BuilderHalo
              active={builder && builderMode.session.messages.length === 0 && builderMode.session.phase === 'chat'}
              inset={-3}
            />
            <Bot className="h-4 w-4 shrink-0 text-accent-primary" />
          </span>
          <span className="shrink-0 text-sm font-medium text-foreground/80">
            {builder ? tBuilder('mode.title') : t('title')}
          </span>
          {/* Builder mode hides (never unmounts) the agent's project/mission
              chrome — the Builder session has no project yet by definition. */}
          {!builder && (
            <>
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
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {!builder && (
              <button type="button" onClick={() => startNewConversation(null)} title={t('newConversation')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
                <Plus className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={() => setMaximized((m) => !m)} aria-label={maximized ? t('restore') : t('maximize')} title={maximized ? t('restore') : t('maximize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button type="button" onClick={minimize} aria-label={t('minimize')} title={t('minimize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {builder ? (
          // Builder skin (reskin D4 board mode): conversation + attached
          // blueprint side pane, both inside the panel so they move/resize
          // together. The agent conversation stays mounted-out, untouched.
          <div className="flex min-h-0 flex-1">
            <BuilderConversation variant="floating" />
            <aside className="flex w-72 shrink-0 flex-col border-l border-border/40 lg:w-80">
              <BlueprintPanel blueprint={builderMode.session.blueprint} />
              {builderMode.session.phase === 'chat' && (
                <div className="border-t border-border/40 p-3">
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={!builderMode.session.canProposeCommit}
                    onClick={builderMode.session.goToCommit}
                    data-testid="builder-create-specs"
                  >
                    <Rocket className="mr-1.5 h-3.5 w-3.5" />
                    {tBuilder('shell.createSpecs')}
                  </Button>
                  {!builderMode.session.canProposeCommit && (
                    <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                      {builderMode.session.specQualityDetail ?? tBuilder('shell.createSpecsHint')}
                    </p>
                  )}
                </div>
              )}
            </aside>
          </div>
        ) : (
          <AgentConversationView variant="floating" />
        )}
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
