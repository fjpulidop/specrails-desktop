import { useLocation, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from './ui/tooltip'
import { ChatPanel } from '../features/chat/components/ChatPanel'
import { useChat, ChatContext } from '../features/chat/hooks/useChat'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { type DesktopProject } from '../hooks/useDesktop'
import { FEATURE_CHAT_ENABLED } from '../lib/feature-flags'
import { formatUsd } from '../lib/format-usd'

interface ProjectLayoutProps {
  project: DesktopProject
}

export function ProjectLayout({ project }: ProjectLayoutProps) {
  const { t } = useTranslation('nav')
  const location = useLocation()
  const outlet = useOutlet()
  const chat = useChat()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [budgetExceeded, setBudgetExceeded] = useState<{ dailySpend: number; budget: number } | null>(null)
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id

  useEffect(() => {
    const id = `cost-alerts-${project.id}`
    registerHandler(id, (raw) => {
      const msg = raw as { type: string; projectId?: string; jobId?: string; cost?: number; threshold?: number; dailySpend?: number; budget?: number; queuePaused?: boolean; desktopDailySpend?: number; desktopBudget?: number }
      if (msg.projectId !== undefined && msg.projectId !== '' && msg.projectId !== projectIdRef.current) return
      if (msg.type === 'cost_alert') {
        toast.warning(t('costAlerts.costAlertTitle'), {
          description: t('costAlerts.costAlertDescription', {
            cost: formatUsd(msg.cost ?? 0),
            threshold: formatUsd(msg.threshold ?? 0),
          }),
        })
      } else if (msg.type === 'daily_budget_exceeded') {
        toast.error(t('costAlerts.dailyBudgetTitle'), {
          description: t('costAlerts.dailyBudgetDescription', {
            spent: formatUsd(msg.dailySpend ?? 0),
            budget: formatUsd(msg.budget ?? 0),
          }),
          duration: Infinity,
        })
        setBudgetExceeded({ dailySpend: msg.dailySpend ?? 0, budget: msg.budget ?? 0 })
      } else if (msg.type === 'desktop_daily_budget_exceeded') {
        toast.error(t('costAlerts.desktopBudgetTitle'), {
          description: t('costAlerts.desktopBudgetDescription', {
            spent: formatUsd(msg.desktopDailySpend ?? 0),
            budget: formatUsd(msg.desktopBudget ?? 0),
          }),
          duration: Infinity,
        })
      }
    })
    return () => unregisterHandler(id)
  }, [project.id, registerHandler, unregisterHandler, t])

  // Terminal panel + StatusBar are hoisted to DesktopApp (single instance,
  // shared by Kanban and Agent Mode) — see App.tsx. ProjectLayout only owns the
  // routed <main> + chat panel now.

  return (
    <TooltipProvider delayDuration={400}>
      <ChatContext.Provider value={chat}>
      <div className="flex flex-col h-full overflow-hidden">
        {budgetExceeded && (
          <div className="flex items-center justify-between px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-xs">
            <span className="text-destructive font-medium">
              {t('costAlerts.bannerMessage', {
                spent: formatUsd(budgetExceeded.dailySpend),
                budget: formatUsd(budgetExceeded.budget),
              })}
            </span>
            <button
              type="button"
              onClick={() => setBudgetExceeded(null)}
              className="text-muted-foreground hover:text-foreground ml-4 shrink-0"
            >
              {t('costAlerts.dismiss')}
            </button>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden min-h-0">
          <div data-testid="project-content" data-project-content className="flex-1 overflow-auto">
            <AnimatePresence initial={false}>
              <motion.div
                key={location.pathname}
                className="h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
              >
                {outlet}
              </motion.div>
            </AnimatePresence>
          </div>
          {FEATURE_CHAT_ENABLED && <ChatPanel chat={chat} project={project} />}
        </div>
      </div>
      </ChatContext.Provider>
    </TooltipProvider>
  )
}
