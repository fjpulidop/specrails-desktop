import { isTauri } from '../../../lib/tauri-shell'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Globe, TerminalSquare, FileCode2, PanelRight, Briefcase, BarChart3 } from 'lucide-react'
import { BlueprintPanel } from '../../builder/components/project-builder/BlueprintPanel'
import { BlueprintReadiness } from '../../builder/components/project-builder/BlueprintReadiness'
import { cn } from '../../../lib/utils'
import { useResizableSidebar } from '../../../hooks/useResizableSidebar'
import { SidebarResizeGrip } from '../../../components/SidebarResizeGrip'
import { useSidebarHoverIntent } from '../../../hooks/useSidebarHoverIntent'
import { keyboardLabel } from '../../../lib/keyboard-label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { useSidebarPin } from '../../../context/SidebarPinContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { useTerminals } from '../../terminals/context/TerminalsContext'
import { useAgentWorkspace } from '../context/AgentWorkspaceContext'
import { useAgentChat } from '../context/AgentChatContext'
import { FEATURE_CODE_EXPLORER, FEATURE_TERMINAL_PANEL } from '../../../lib/feature-flags'
import { isBrowserCaptureEnabled } from '../../browser/lib/browser-capture'
import { BuilderSidebarEntry } from '../../builder/components/project-builder/BuilderSidebarEntry'

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
export function AgentWorkspaceSidebar({ missionOnly = false }: { missionOnly?: boolean } = {}) {
  const { t } = useTranslation('agent')
  const { t: tNav } = useTranslation('nav')
  const { t: tBuilder } = useTranslation('builder')
  const { rightMode, effectiveRightMode, cycleRightMode } = useSidebarPin()
  const { activeProjectId } = useDesktop()
  const terminals = useTerminals()
  const workspace = useAgentWorkspace()
  const { builderMode } = useAgentChat()
  const unpinned = effectiveRightMode === 'unpinned'
  // Builder mode transforms this rail into the live blueprint panel (reskin
  // D4) — force it expanded AND docked for the duration so the panel is readable.
  const docked = builderMode.active || effectiveRightMode === 'pinned-open'
  const [dragging, setDragging] = useState(false)
  const hover = useSidebarHoverIntent({ enabled: unpinned && !builderMode.active, dragging })
  const expanded = docked || (unpinned && hover.hovered)
  // Imperative drag-resize (208px expanded, 44px collapsed rail). A hover-
  // expanded unpinned rail overlays the content; the wrapper keeps 44px.
  const resize = useResizableSidebar('right-workspace', {
    side: 'right', defaultWidth: 208, min: 180, max: 460, collapsedWidth: 44, expanded, docked,
  })
  useEffect(() => { setDragging(resize.dragging) }, [resize.dragging])
  const overlaying = expanded && !docked
  const lit = rightMode !== 'unpinned'
  const pinLabel = tNav(RIGHT_PIN_LABEL_KEY[rightMode])
  const noProject = !activeProjectId
  const terminalOpen = !!activeProjectId && terminals.getState(activeProjectId).visibility !== 'hidden'
  const tools: Array<{ key: string; icon: typeof Globe; label: string; onClick: () => void; disabled: boolean; disabledTitle: string; active: boolean }> = [
    // Jobs sits ABOVE Browser: the executions the agent launches are the first
    // thing the user reaches for from Agent Mode.
    {
      key: 'jobs', icon: Briefcase, label: t('workspace.jobs'),
      onClick: () => workspace.toggleJobsPane(),
      disabled: noProject, disabledTitle: t('workspace.requiresProject'),
      active: workspace.jobsPaneOpen,
    },
    {
      key: 'analytics', icon: BarChart3, label: t('workspace.analytics'),
      onClick: () => workspace.toggleAnalyticsPane(),
      disabled: noProject, disabledTitle: t('workspace.requiresProject'),
      active: workspace.analyticsPaneOpen,
    },
    ...(isBrowserCaptureEnabled()
      ? [{
          key: 'browser', icon: Globe, label: t('workspace.browser'),
          onClick: () => workspace.openBrowser(),
          // Only the project gates the tool: on the EMPTY compose screen a
          // capture materializes the draft mission (AgentBrowserCapture), so a
          // conversation is no longer a precondition.
          disabled: noProject,
          disabledTitle: t('workspace.requiresProject'),
          active: workspace.browserOpen,
        }]
      : []),
    ...(FEATURE_TERMINAL_PANEL
      ? [{
          key: 'terminal', icon: TerminalSquare, label: t('workspace.terminal'),
          onClick: () => { if (activeProjectId) terminals.togglePanel(activeProjectId) },
          disabled: noProject, disabledTitle: t('workspace.requiresProject'),
          active: terminalOpen,
        }]
      : []),
    ...(FEATURE_CODE_EXPLORER
      ? [{
          key: 'files', icon: FileCode2, label: t('workspace.files'),
          onClick: () => workspace.toggleCodePane(),
          disabled: noProject, disabledTitle: t('workspace.requiresProject'),
          active: workspace.codePaneOpen,
        }]
      : []),
  ]

  return (
    <aside
      ref={resize.wrapperRef}
      aria-label={t('workspace.title')}
      className="relative h-full flex-shrink-0 transition-[width] duration-200 ease-in-out"
      {...hover.handlers}
    >
    <div
      ref={resize.panelRef}
      data-testid="workspace-sidebar-panel"
      data-overlay={overlaying || undefined}
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex flex-col border-l border-border bg-background overflow-hidden',
        'transition-[width,box-shadow] duration-200 ease-in-out',
        overlaying && 'shadow-xl',
      )}
    >
      {expanded && (
        <SidebarResizeGrip
          side="right"
          dragging={resize.dragging}
          width={resize.width}
          min={180}
          max={460}
          label={tNav('sidebarPin.resize')}
          onPointerDown={resize.onGripPointerDown}
          onKeyDown={resize.onGripKeyDown}
        />
      )}
      {!isTauri() && <div className={cn(
        'flex items-center h-12 border-b border-border flex-shrink-0',
        expanded ? 'px-3 justify-between' : 'justify-center',
      )}>
        {expanded && (
          <span className="text-xs font-medium whitespace-nowrap overflow-hidden text-muted-foreground">
            {t('workspace.title')}
          </span>
        )}
        <button
          type="button"
          onClick={cycleRightMode}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-md transition-colors',
            lit ? 'text-foreground bg-muted' : 'text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
          )}
          aria-label={pinLabel}
          aria-pressed={lit}
          title={tNav('sidebarPin.withShortcut', { label: pinLabel, shortcut: keyboardLabel('⌥⌘B') })}
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>}

      {builderMode.active ? (
        // ── Builder transformation: the tool rail becomes the live blueprint
        // panel + the phase CTA while the Builder skin is active. Animated
        // swap; the rail returns untouched on exit.
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key="builder-blueprint"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="flex min-h-0 flex-1 flex-col"
            data-testid="workspace-blueprint-panel"
          >
            <BlueprintPanel blueprint={builderMode.session.blueprint} snapshot={builderMode.session.snapshot} />
            {builderMode.session.phase === 'chat' && (
              <BlueprintReadiness
                readiness={builderMode.session.readiness}
                snapshot={builderMode.session.snapshot}
                busy={builderMode.session.busy}
                primaryLabel={tBuilder('shell.createSpecs')}
                onPrimary={builderMode.session.goToCommit}
                onRepair={() => void builderMode.session.repairSnapshot()}
              />
            )}
          </motion.div>
        </AnimatePresence>
      ) : (
      <TooltipProvider delayDuration={150}>
      <nav aria-label={t('workspace.title')} className="flex-1 py-2 px-1.5 space-y-0.5">
        {!missionOnly && <BuilderSidebarEntry expanded={expanded} />}
        {tools.map(({ key, icon: Icon, label, onClick, disabled, disabledTitle, active }) => {
          const reasonId = `workspace-tool-${key}-disabled-reason`
          const button = (
            <button
              key={key}
              type="button"
              onClick={disabled ? undefined : onClick}
              aria-disabled={disabled || undefined}
              aria-pressed={disabled ? undefined : active}
              aria-label={!expanded ? label : undefined}
              aria-describedby={disabled ? reasonId : undefined}
              className={cn(
                'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
                expanded ? 'px-2' : 'px-0 justify-center',
                disabled
                  ? 'text-muted-foreground cursor-not-allowed'
                  : active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
              title={!disabled && !expanded ? label : undefined}
              data-active={active || undefined}
            >
              <Icon className={cn('w-4 h-4 flex-shrink-0', active && !disabled && 'text-accent-primary')} aria-hidden />
              {expanded && <span className="text-xs truncate">{label}</span>}
              {disabled && <span id={reasonId} className="sr-only">{disabledTitle}</span>}
            </button>
          )
          if (!disabled) return button
          // The reason is visible too: a tooltip on hover AND keyboard focus.
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="left">{disabledTitle}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
      </TooltipProvider>
      )}
    </div>
    </aside>
  )
}
