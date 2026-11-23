/**
 * The EMPTY compose screen's draft (no conversation yet): pinned project,
 * provider, model, sticky tier and effort. The first send materialises a
 * conversation with these. The draft provider follows what the machine can
 * run until the person picks one.
 */
import { useEffect, useRef, useState } from 'react'
import { preferredProvider } from '../../../providers/lib/provider-capabilities'
import type { AgentConversation, AgentTierLevel } from '../../lib/agent-api'
import { readLastTierLevel } from '../../lib/agent-chat-storage'

export function useComposeDraft(active: AgentConversation | null, usableProviders: string[]) {
  // True once the user picks a provider for the CURRENT draft; cleared when a
  // fresh draft starts. Guards the reconciliation below.
  const draftProviderChosenRef = useRef(false)
  // Pinned project chosen on the EMPTY compose screen (no conversation yet). The
  // first send materialises a conversation with this pin.
  const [draftPinnedProjectId, setDraftPinnedProjectId] = useState<string | null>(null)
  const draftPinRef = useRef<string | null>(null)
  draftPinRef.current = draftPinnedProjectId
  // Provider/model/tier chosen on the EMPTY compose screen (no conversation yet).
  // The first send materialises a conversation with these — mirrors the draft pin;
  // without them the EMPTY controls would visibly snap back (patchActive no-ops).
  const [draftProvider, setDraftProvider] = useState('claude')
  const [draftModel, setDraftModel] = useState<string | null>(null)
  // The tier ladder is sticky ACROSS missions: the last explicitly selected
  // level is persisted and seeds every new mission (draft + created rows).
  const [draftTierLevel, setDraftTierLevel] = useState<AgentTierLevel>(() => readLastTierLevel())
  // null = no provider-specific effort override.
  const [draftEffort, setDraftEffort] = useState<string | null>(null)
  const draftConvRef = useRef({ provider: 'claude', model: null as string | null, tierLevel: 0 as AgentTierLevel, effort: null as string | null })
  draftConvRef.current = { provider: draftProvider, model: draftModel, tierLevel: draftTierLevel, effort: draftEffort }

  // Reconcile the DRAFT provider with what the machine can actually run: the
  // pre-fetch `claude` default (or a provider that just went away) hops to the
  // preferred usable id. Only drafts — a stored conversation keeps its provider
  // (its session/model belong to it; the selector still offers a switch).
  //
  // NEVER override an explicit pick. A local engine's usable set comes from a
  // bounded HTTP probe, so one slow answer can drop it from the list for a
  // cycle; when that happened mid-compose this effect snapped the draft back to
  // the machine default and the user saw a provider that "would not click"
  // (the option was there, the selection reverted instantly). A default is a
  // starting point, not a veto.
  useEffect(() => {
    if (active || draftProviderChosenRef.current) return
    if (usableProviders.length === 0 || usableProviders.includes(draftProvider)) return
    setDraftProvider(preferredProvider(usableProviders))
    setDraftModel(null)
    setDraftEffort(null)
  }, [active, usableProviders, draftProvider])

  return {
    draftProviderChosenRef, draftPinnedProjectId, setDraftPinnedProjectId, draftPinRef,
    draftProvider, setDraftProvider, draftModel, setDraftModel, draftTierLevel, setDraftTierLevel,
    draftEffort, setDraftEffort, draftConvRef,
  }
}
