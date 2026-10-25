// ─── Undecided rail-launch proposals (mission-rail-cards) ─────────────────────
// Derives, from the conversation's SETTLED assistant messages, every
// ```rail-launch proposal that has not been launched or dismissed yet. The
// pinned dock renders these above the PR cards; the history slot shows a slim
// marker. Purely additive next to `agent-pr-pinning.ts` (untouched).

import { useMemo } from 'react'
import type { AgentMessage } from '../lib/agent-api'
import { extractRailLaunchProposals, type RailLaunchProposal } from '../../rails/lib/rail-launch-draft'
import { intentFor, useLocalIntents } from '../../rails/lib/rail-launch-intents'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../lib/feature-flags'

export interface PinnedRailProposal {
  messageId: string
  proposalIndex: number
  proposal: RailLaunchProposal
}

export interface DerivedRailProposals {
  /** Message ids that carry at least one still-undecided proposal. */
  pinnedMessageIds: ReadonlySet<string>
  /** Message order, newest LAST. */
  pinned: PinnedRailProposal[]
}

const EMPTY: DerivedRailProposals = { pinnedMessageIds: new Set(), pinned: [] }

export function useRailLaunchProposals(messages: readonly AgentMessage[]): DerivedRailProposals {
  const local = useLocalIntents()
  return useMemo(() => {
    if (!FEATURE_MISSION_RAIL_CARDS) return EMPTY
    const pinned: PinnedRailProposal[] = []
    const ids = new Set<string>()
    // Specs launched at or after each message (any door: another proposal, a Flow
    // hand-off). A proposal whose specs all launched later is superseded, not pending.
    const launchedFrom: Set<number>[] = new Array(messages.length)
    let launched = new Set<number>()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      for (const intent of [...(local.get(m.id) ?? []), ...(m.intents ?? [])]) {
        if (intent.status !== 'launched' || (intent.kind ?? 'rail-launch') === 'flow-offer') continue
        const tickets = intent.config?.ticketIds
        if (Array.isArray(tickets)) {
          launched = new Set(launched)
          for (const id of tickets) if (Number.isFinite(Number(id))) launched.add(Number(id))
        }
      }
      launchedFrom[i] = launched
    }
    messages.forEach((m, i) => {
      if (m.role !== 'assistant' || !m.content.includes('```rail-launch')) return
      const { proposals } = extractRailLaunchProposals(m.content, false)
      proposals.forEach((proposal, proposalIndex) => {
        if (intentFor(local, m.id, m.intents, proposalIndex)) return
        if (proposal.ticketIds.length > 0 && proposal.ticketIds.every((id) => launchedFrom[i].has(id))) return
        pinned.push({ messageId: m.id, proposalIndex, proposal })
        ids.add(m.id)
      })
    })
    return { pinnedMessageIds: ids, pinned }
  }, [messages, local])
}
