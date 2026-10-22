// ─── Flow dock (missions ConversationDock slot) ───────────────────────────────
// What sits above the composer for a conversation's Flow:
//   active                → FlowBar (animates out on "This is it")
//   paused / needs-review → compact FlowBar variants (Resume Flow, explanation)
//   wrapping up           → FlowHandOffCard (launch on a rail)
//   just handed off       → the hand-off card's launched stub (this session)

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { MissionConversationSlotProps } from '../../missions/context/MissionExtensionsContext'
import { cn } from '../../../lib/utils'
import { useConversationFlow, useFlowContext } from '../context/FlowContext'
import { isOpenFlow } from '../lib/flow-api'
import { FlowBar } from './FlowBar'
import { FlowHandOffCard } from './FlowHandOffCard'

export function FlowDock({ conversationId, projectId, inline }: MissionConversationSlotProps) {
  const ctx = useFlowContext()
  const reduced = useReducedMotion()
  const { flow } = useConversationFlow(conversationId, projectId)
  if (!ctx || !flow || !projectId) return null
  const receipt = ctx.handedOff.get(flow.id) ?? null
  const wrappingUp = ctx.wrappingUp.has(flow.id) && isOpenFlow(flow)
  const showBar = !wrappingUp && (isOpenFlow(flow) || flow.state === 'needs-review')
  const showHandOff = wrappingUp || (!!receipt && flow.state === 'handed_off')
  return (
    <AnimatePresence initial={false} mode="wait">
      {showBar && <FlowBar key={`bar:${flow.id}`} projectId={projectId} flow={flow} inline={inline} />}
      {showHandOff && (
        <motion.div
          key={`hand-off:${flow.id}`}
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className={cn('shrink-0 px-3 pb-2', inline && 'mx-auto w-full max-w-[960px] px-4')}
        >
          <FlowHandOffCard projectId={projectId} conversationId={conversationId} flow={flow} receipt={receipt} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
