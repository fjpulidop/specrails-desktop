import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAgentChat } from '../context/AgentChatContext'
import type { AgentTierLevel } from '../lib/agent-api'

export const AUTONOMOUS_TIER: AgentTierLevel = 3
const CONFIRM_TOAST_ID = 'agent-tier-autonomous-confirm'

/**
 * The tier ladder's ⇧⇥ / chip cycle, guarded at the top rung: lowering or
 * raising to Edit/Operate is immediate, but ENTERING Autonomous (delete/kill)
 * never happens by a repeated keystroke alone — it raises a confirm toast whose
 * action performs the change. Cycling again while that confirm is pending
 * skips Autonomous and wraps back to Observe, so the ladder never dead-ends at
 * Operate for someone who only wanted to go round.
 */
export function useGuardedTierCycle(): () => void {
  const { t } = useTranslation('agent')
  const { active, draftTierLevel, cycleTier, setTier } = useAgentChat()
  const pendingRef = useRef(false)
  const level = active?.tier_level ?? draftTierLevel

  return useCallback(() => {
    const next = ((level + 1) % 4) as AgentTierLevel
    if (next !== AUTONOMOUS_TIER) {
      void cycleTier()
      return
    }
    if (pendingRef.current) {
      pendingRef.current = false
      toast.dismiss?.(CONFIRM_TOAST_ID)
      void setTier(0)
      return
    }
    pendingRef.current = true
    const settle = (): void => { pendingRef.current = false }
    const show = toast.warning ?? toast
    show(t('tier.autonomousWarning'), {
      id: CONFIRM_TOAST_ID,
      description: t('tier.skipAutonomousHint'),
      action: {
        label: t('tier.confirmAutonomous'),
        onClick: () => {
          settle()
          void setTier(AUTONOMOUS_TIER)
        },
      },
      onDismiss: settle,
      onAutoClose: settle,
    })
  }, [level, cycleTier, setTier, t])
}
