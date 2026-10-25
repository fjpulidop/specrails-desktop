// ─── Flow → Spec engine default ───────────────────────────────────────────────
// The hand-off runs on what the person is using in the Flow: the mission
// conversation's CURRENT provider/model/effort. Only when that provider cannot
// run the loop here (not usable on this machine, or not a single engine) does
// the card fall back to the rail default, and it says why.

import { isRolesEngine } from '../../providers/lib/provider-capabilities'

export interface FlowConversationEngine {
  provider: string | null
  model: string | null
  reasoning_effort: string | null
}

export interface FlowHandOffEngine {
  aiEngine: string | null
  model: string | null
  reasoningEffort: string | null
  /** The conversation's provider when it cannot run Flow → Spec (rail default used instead). */
  fallbackFrom: string | null
}

const RAIL_DEFAULT: FlowHandOffEngine = { aiEngine: null, model: null, reasoningEffort: null, fallbackFrom: null }

/**
 * The engine the hand-off card preselects. `detecting`: provider detection has
 * not answered yet — the conversation's provider is kept (the card re-checks it
 * once detection lands).
 */
export function flowHandOffEngine(
  conversation: FlowConversationEngine | null | undefined,
  usable: readonly string[],
  detecting = false,
): FlowHandOffEngine {
  const provider = conversation?.provider ?? null
  if (!provider) return RAIL_DEFAULT
  if (isRolesEngine(provider) || (!detecting && !usable.includes(provider))) return { ...RAIL_DEFAULT, fallbackFrom: provider }
  return { aiEngine: provider, model: conversation?.model ?? null, reasoningEffort: conversation?.reasoning_effort ?? null, fallbackFrom: null }
}
