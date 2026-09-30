import { useMissionPaneClose, useMissionPaneLayoutId } from '../context/MissionSplitViewsContext'
import { MissionSplitLayout } from './MissionSplitLayout'
import { useMissionWindows } from '../context/MissionWindowsContext'
import { useMissionViewRevision } from '../lib/mission-view-state'
import { Suspense, lazy, useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { motion, MotionConfig } from 'motion/react'
import { useAgentChat } from '../context/AgentChatContext'
import { useAgentWorkspace } from '../context/AgentWorkspaceContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { useActiveTheme } from '../../settings/context/ThemeContext'
import { Starfield } from '../../settings/components/theme-effects/Starfield'
import { AgentConversationView } from './AgentConversationView'
import { AgentComposer } from './AgentComposer'
import { BuilderConversation } from '../../builder/components/project-builder/BuilderConversation'

const AgentModeCodePane = lazy(() =>
  import('./AgentModeCodePane').then((m) => ({ default: m.AgentModeCodePane })),
)
const AgentModeJobsPane = lazy(() =>
  import('./AgentModeJobsPane').then((m) => ({ default: m.AgentModeJobsPane })),
)
const AgentModeAnalyticsPane = lazy(() =>
  import('./AgentModeAnalyticsPane').then((m) => ({ default: m.AgentModeAnalyticsPane })),
)
/**
 * The full-screen Agent-Mode center surface. EMPTY (no active conversation) is a
 * centered "Plan, Build" composer card with a soft accent glow; ACTIVE renders
 * the shared conversation view, optionally split with an inline Code pane. Never
 * calls `ensureActive` on mount, so the EMPTY state is reachable.
 */
function EmptyPaneClose() {
  const closePane = useMissionPaneClose()
  const { t } = useTranslation('agent')
  return closePane ? <button type="button" aria-label={t('split.close')} title={t('split.close')} onClick={closePane} className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button> : null
}

function ConversationLayout({ splitPane, children }: { splitPane: boolean; children: ReactNode }) {
  return splitPane ? <>{children}</> : <MissionSplitLayout>{children}</MissionSplitLayout>
}

export function AgentModeSurface({ splitPane = false }: { splitPane?: boolean } = {}) {
  const composerLayoutId = useMissionPaneLayoutId()
  const { active, refreshConversations, builderMode } = useAgentChat()
 const { codePaneOpen, jobsPaneOpen, analyticsPaneOpen } = useAgentWorkspace()
  const { activeProjectId } = useDesktop()
  const windows = useMissionWindows()
  const revision = useMissionViewRevision(active?.id ?? '__new-mission__')
  const external = !windows.current && windows.transfers.some(item => item.conversationId === active?.id && item.state === 'detached')
  const activeTheme = useActiveTheme()
  const isGalaxy = activeTheme.id === 'galaxy'

  // Populate the sidebar conversation tree without opening the floating panel.
  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  // The inline Code pane can accompany BOTH the EMPTY composer and an ACTIVE
  // thread — it only needs an active project (its own store is per-conversation,
  // falling back to a Home key when no conversation is open yet).
  const showCode = codePaneOpen && !!activeProjectId && !external
  const showJobs = jobsPaneOpen && !!activeProjectId && !external
  const showAnalytics = analyticsPaneOpen && !!activeProjectId && !external

  return (
    <MotionConfig reducedMotion="user">
    <div data-agent-mode-surface className="relative z-0 flex h-full w-full overflow-hidden bg-background">
      {isGalaxy && <Starfield />}
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Radial glow — always mounted so EMPTY⇄ACTIVE crossfades instead of popping. */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0"
          animate={{ opacity: active === null ? 1 : 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          style={{
            background:
              'radial-gradient(60% 55% at 50% 45%, color-mix(in srgb, var(--color-accent-primary) 13%, transparent), transparent 70%)',
          }}
        />
        <ConversationLayout splitPane={splitPane}>
        {builderMode.active ? (
          // ── BUILDER MODE (reskin): a "new mission" in new-project mode — the
          // MISSION format (centered column, docked composer) with the halo on
          // the composer card itself. The workspace sidebar transforms into
          // the blueprint panel (D4).
          <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
            <BuilderConversation variant="inline" />
          </div>
        ) : active === null ? (
          // ── EMPTY: centered composer card. The card carries the shared
          // `layoutId`, so the first send morphs it down into the docked
          // composer of the conversation view (and New Mission morphs it back).
          <div className="relative z-10 flex h-full w-full items-center justify-center px-4">
            <EmptyPaneClose />
            <motion.div
              layoutId={composerLayoutId}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.28,
                ease: [0.34, 1.56, 0.64, 1],
                layout: { type: 'spring', stiffness: 350, damping: 34 },
              }}
              className="w-full max-w-[960px]"
            >
              <AgentComposer autoFocus />
            </motion.div>
          </div>
        ) : (
          // ── ACTIVE: conversation thread ──
          <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
            <AgentConversationView variant="inline" />
          </div>
        )}
        </ConversationLayout>
      </div>

      {showJobs && (
        <Suspense fallback={<div className="w-[480px] border-l border-border" />}>
          <AgentModeJobsPane projectId={activeProjectId!} />
        </Suspense>
      )}

      {showCode && (
        <Suspense fallback={<div className="w-[520px] border-l border-border" />}>
          <AgentModeCodePane key={`${active?.id}:${revision}`} projectId={activeProjectId!} conversationId={active?.id ?? '__home__'} />
        </Suspense>
      )}

      {showAnalytics && (
        <Suspense fallback={<div className="w-[560px] border-l border-border" />}>
          <AgentModeAnalyticsPane />
        </Suspense>
      )}

      {/* Browser capture mounts globally in AgentBrowserCaptureHost (App root)
          so the board-mode floating panel can open it too. */}
    </div>
    </MotionConfig>
  )
}
