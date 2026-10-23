// ─── Flow dock (missions ConversationDock slot) ───────────────────────────────
// What sits above the composer for a conversation's Flow:
//   active                → FlowBar (animates out on "This is it")
//   paused / needs-review → compact FlowBar variants (Resume Flow, explanation)
//   wrapping up           → FlowHandOffCard (launch on a rail)
//   just handed off       → the hand-off card's launched stub (this session)
// A polite live region announces state changes (active, paused, needs review,
// handed off, back in Flow) for assistive technology.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { MissionConversationSlotProps } from '../../missions/context/MissionExtensionsContext'
import { cn } from '../../../lib/utils'
import { useConversationFlow, useFlowContext } from '../context/FlowContext'
import { isOpenFlow, type Flow } from '../lib/flow-api'
import { FlowBar } from './FlowBar'
import { FlowHandOffCard } from './FlowHandOffCard'

/** The announcement for a Flow state change (null when nothing worth saying changed). */
export function flowStateAnnouncement(previous: Flow['state'] | null, next: Flow['state']): string | null {
  if (previous === next) return null
  if (previous === 'handed_off' && (next === 'active' || next === 'paused')) return 'returned'
  if (previous === null) return null
  if (next === 'active' || next === 'paused' || next === 'needs-review' || next === 'handed_off' || next === 'delivered' || next === 'discarded') return next
  return null
}

/** Polite, visually hidden announcement of the Flow's state changes. */
function FlowStateAnnouncer({ flow }: { flow: Flow | null }) {
  const { t } = useTranslation('agent')
  const previous = useRef<{ id: string; state: Flow['state'] } | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!flow) return
    const before = previous.current && previous.current.id === flow.id ? previous.current.state : null
    previous.current = { id: flow.id, state: flow.state }
    const key = flowStateAnnouncement(before, flow.state)
    if (key) setMessage(t(`flow.announce.${key}`))
  }, [flow, t])
  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="flow-state-announcer">{message}</div>
}

export function FlowDock({ conversationId, projectId, inline }: MissionConversationSlotProps) {
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  return (
    <>
      <FlowStateAnnouncer flow={ctx && projectId ? flow : null} />
      <FlowDockSurface conversationId={conversationId} projectId={projectId} inline={inline} flow={flow} />
    </>
  )
}

function FlowDockSurface({ conversationId, projectId, inline, flow }: MissionConversationSlotProps & { flow: Flow | null }) {
  const ctx = useFlowContext()
  const reduced = useReducedMotion()
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
