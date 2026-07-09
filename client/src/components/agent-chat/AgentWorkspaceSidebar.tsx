import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, TerminalSquare, FileCode2, PanelRight, Briefcase } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useResizableSidebar } from '../../hooks/useResizableSidebar'
import { SidebarResizeGrip } from '../SidebarResizeGrip'
import { useSidebarPin } from '../../context/SidebarPinContext'
import { useDesktop } from '../../hooks/useDesktop'
import { useTerminals } from '../../context/TerminalsContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useAgentChat } from '../../context/AgentChatContext'
import { FEATURE_CODE_EXPLORER, FEATURE_TERMINAL_PANEL } from '../../lib/feature-flags'
import { isBrowserCaptureEnabled } from '../../lib/browser-capture'

const RIGHT_PIN_LABEL_KEY: Record<'pinned-open' | 'pinned-collapsed' | 'unpinned', string> = {
  'pinned-open': 'sidebarPin.right.pinnedOpen',
  'pinned-collapsed': 'sidebarPin.right.pinnedCollapsed',
  'unpinned': 'sidebarPin.right.unpinned',
}

/**
 * Agent-Mode right "On workspace" toolbar. Mirrors ProjectRightSidebar chrome
 * (border-l rail, 200ms width transition, h-12 header, bg-muted lit rows) so it
 * reads as the same family. Browser / Terminal / Files are disabled when there
 * is no active project (each tool is project-scoped).
 */
export function AgentWorkspaceSidebar() {
  const { t } = useTranslation('agent')
  const { t: tNav } = useTranslation('nav')
  const { rightMode, cycleRightMode } = useSidebarPin()
  const { activeProjectId } = useDesktop()
  const terminals = useTerminals()
  const workspace = useAgentWorkspace()
  const { active } = useAgentChat()
  const [hovered, setHovered] = useState(false)
  const expanded = rightMode === 'pinned-open' || (rightMode === 'unpinned' && hovered)
  // Imperative drag-resize (208px expanded, 44px collapsed rail). The mouseleave
  // guard keeps `hovered` true during a drag so an unpinned rail can't collapse.
  const resize = useResizableSidebar('right-workspace', {
    side: 'right', defaultWidth: 208, min: 180, max: 460, collapsedWidth: 44, expanded,
  })
  const lit = rightMode !== 'unpinned'
  const pinLabel = tNav(RIGHT_PIN_LABEL_KEY[rightMode])
  const noProject = !activeProjectId
  const tools = [
    // Jobs sits ABOVE Browser: the executions the agent launches are the first
    // thing the user reaches for from Agent Mode.
    {
      key: 'jobs', icon: Briefcase, label: t('workspace.jobs'),
      onClick: () => workspace.toggleJobsPane(),
      disabled: noProject, disabledTitle: t('workspace.requiresProject'),
    },
    ...(isBrowserCaptureEnabled()
      ? [{
          key: 'browser', icon: Globe, label: t('workspace.browser'),
          onClick: () => workspace.openBrowser(),
          // Captures are conversation-keyed (uploaded as agent attachments of the
          // active conversation) — require one besides the project.
          disabled: noProject || !active,
          disabledTitle: noProject ? t('workspace.requiresProject') : t('workspace.requiresConversation'),
        }]
      : []),
    ...(FEATURE_TERMINAL_PANEL
      ? [{
          key: 'terminal', icon: TerminalSquare, label: t('workspace.terminal'),
          onClick: () => activeProjectId && terminals.togglePanel(activeProjectId),
          disabled: noProject, disabledTitle: t('workspace.requiresProject'),
        }]
      : []),
    ...(FEATURE_CODE_EXPLORER
      ? [{
          key: 'files', icon: FileCode2, label: t('workspace.files'),
          onClick: () => workspace.toggleCodePane(),
          disabled: noProject, disabledTitle: t('workspace.requiresProject'),
        }]
      : []),
  ]

  return (
    <div
      ref={resize.panelRef}
      className={cn(
        'relative flex flex-col h-full border-l border-border bg-background flex-shrink-0 overflow-hidden',
        'transition-[width] duration-200 ease-in-out',
      )}
      onMouseEnter={() => { if (rightMode === 'unpinned') setHovered(true) }}
      onMouseLeave={() => { if (rightMode === 'unpinned' && !resize.dragging) setHovered(false) }}
    >
      {expanded && (
        <SidebarResizeGrip
          side="right"
          dragging={resize.dragging}
          width={resize.width}
          min={180}
          max={460}
          label={tNav('sidebarPin.resize', { defaultValue: 'Resize sidebar' })}
          onPointerDown={resize.onGripPointerDown}
          onKeyDown={resize.onGripKeyDown}
        />
      )}
      <div className={cn(
        'flex items-center h-12 border-b border-border flex-shrink-0',
        expanded ? 'px-3 justify-between' : 'justify-center',
      )}>
        {expanded && (
          <span className="font-mono text-sm font-bold whitespace-nowrap overflow-hidden text-accent-secondary">
            {t('workspace.title')}
          </span>
        )}
        <button
          type="button"
          onClick={cycleRightMode}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-md transition-colors',
            lit ? 'text-foreground bg-muted' : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50',
          )}
          aria-label={pinLabel}
          title={tNav('sidebarPin.withShortcut', { label: pinLabel, shortcut: '⌘B' })}
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 py-2 px-1.5 space-y-0.5">
        {tools.map(({ key, icon: Icon, label, onClick, disabled, disabledTitle }) => (
          <button
            key={key}
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
              'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              expanded ? 'px-2' : 'px-0 justify-center',
              disabled
                ? 'text-muted-foreground/40 cursor-not-allowed'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
            title={disabled ? disabledTitle : (!expanded ? label : undefined)}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {expanded && <span className="text-xs truncate">{label}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}
