import { Suspense, lazy, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, MotionConfig } from 'motion/react'
import { Bot } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useDesktop } from '../../hooks/useDesktop'
import { useActiveTheme } from '../../context/ThemeContext'
import { Starfield } from '../theme-effects/Starfield'
import { AgentConversationView } from './AgentConversationView'
import { AgentComposer } from './AgentComposer'

const AgentModeCodePane = lazy(() =>
  import('./AgentModeCodePane').then((m) => ({ default: m.AgentModeCodePane })),
)
const AgentModeJobsPane = lazy(() =>
  import('./AgentModeJobsPane').then((m) => ({ default: m.AgentModeJobsPane })),
)
const AgentBrowserCapture = lazy(() =>
  import('./AgentBrowserCapture').then((m) => ({ default: m.AgentBrowserCapture })),
)
/**
 * The full-screen Agent-Mode center surface. EMPTY (no active conversation) is a
 * centered "Plan, Build" composer card with a soft accent glow; ACTIVE renders
 * the shared conversation view, optionally split with an inline Code pane. Never
 * calls `ensureActive` on mount, so the EMPTY state is reachable.
 */
export function AgentModeSurface() {
  const { t } = useTranslation('agent')
  const { active, refreshConversations } = useAgentChat()
 const { codePaneOpen, jobsPaneOpen, browserOpen } = useAgentWorkspace()
  const { activeProjectId } = useDesktop()
  const activeTheme = useActiveTheme()
  const isGalaxy = activeTheme.id === 'galaxy'
  // Code Rain gets a themed empty-state title.
  const emptyTitle = activeTheme.id === 'code-rain' ? t('emptyTitleCodeRain') : t('emptyTitle')

  // Populate the sidebar conversation tree without opening the floating panel.
  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  // The inline Code pane can accompany BOTH the EMPTY composer and an ACTIVE
  // thread — it only needs an active project (its own store is per-conversation,
  // falling back to a Home key when no conversation is open yet).
  const showCode = codePaneOpen && !!activeProjectId
  const showJobs = jobsPaneOpen && !!activeProjectId

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
        {active === null ? (
          // ── EMPTY: centered composer card. The card carries the shared
          // `layoutId`, so the first send morphs it down into the docked
          // composer of the conversation view (and New Mission morphs it back).
          <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
            <motion.div
              layoutId="agent-composer-dock"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.28,
                ease: [0.34, 1.56, 0.64, 1],
                layout: { type: 'spring', stiffness: 350, damping: 34 },
              }}
              className="w-full max-w-[680px] rounded-2xl border border-border/60 bg-card/90 p-4 shadow-2xl backdrop-blur-xl"
            >
              <div className="mb-3 flex items-center gap-2 px-1">
                <Bot className="h-4 w-4 text-accent-primary" />
                <span className="text-sm font-medium text-foreground/80">{emptyTitle}</span>
              </div>
              <AgentComposer autoFocus />
            </motion.div>
          </div>
        ) : (
          // ── ACTIVE: conversation thread ──
          <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
            <AgentConversationView variant="inline" />
          </div>
        )}
      </div>

      {showJobs && (
        <Suspense fallback={<div className="w-[480px] border-l border-border" />}>
          <AgentModeJobsPane projectId={activeProjectId!} />
        </Suspense>
      )}

      {showCode && (
        <Suspense fallback={<div className="w-[520px] border-l border-border" />}>
          <AgentModeCodePane projectId={activeProjectId!} conversationId={active?.id ?? '__home__'} />
        </Suspense>
      )}

      {browserOpen && activeProjectId && (
        <Suspense fallback={null}>
          <AgentBrowserCapture projectId={activeProjectId} conversationId={active?.id ?? null} />
        </Suspense>
      )}
    </div>
    </MotionConfig>
  )
}
