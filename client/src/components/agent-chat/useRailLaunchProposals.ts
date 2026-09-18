// ─── Undecided rail-launch proposals (mission-rail-cards) ─────────────────────
// Derives, from the conversation's SETTLED assistant messages, every
// ```rail-launch proposal that has not been launched or dismissed yet. The
// pinned dock renders these above the PR cards; the history slot shows a slim
// marker. Purely additive next to `agent-pr-pinning.ts` (untouched).

import { useMemo } from 'react'
import type { AgentMessage } from '../../lib/agent-api'
import { extractRailLaunchProposals, type RailLaunchProposal } from '../../lib/rail-launch-draft'
import { intentFor, useLocalIntents } from '../../lib/rail-launch-intents'
import { FEATURE_MISSION_RAIL_CARDS } from '../../lib/feature-flags'

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
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.content.includes('```rail-launch')) continue
      const { proposals } = extractRailLaunchProposals(m.content, false)
      proposals.forEach((proposal, proposalIndex) => {
        if (intentFor(local, m.id, m.intent, proposalIndex)) return
        pinned.push({ messageId: m.id, proposalIndex, proposal })
        ids.add(m.id)
      })
    }
    return { pinnedMessageIds: ids, pinned }
  }, [messages, local])
}
