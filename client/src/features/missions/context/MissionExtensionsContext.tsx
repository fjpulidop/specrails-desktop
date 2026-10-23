// ─── Mission extensions (composition seam) ────────────────────────────────────
// Features that build ON TOP of missions (Flow mode today) must not be imported
// by missions. Instead missions exposes this extension point and the
// application composition root (App.tsx) provides the implementation:
//
//   - fenceCards: renderers for extra fenced protocol blocks in assistant
//     messages (e.g. ```flow-offer). Missions strips the block and renders the
//     registered card in its place; unknown tags stay plain markdown.
//   - useConversationMode: a hook returning the visual/behavioural mode of a
//     conversation (surface data-attributes, the branch the git strip shows or
//     whether it hides, whether a busy send interrupts the running turn).
//   - ConversationDock: a component rendered above the composer (sticky bars
//     and pinned cards owned by the extension).
//   - RunCardActions: extra actions on a run/PR card whose outcome the
//     extension owns (Flow: "Back to Flow" and "Relaunch" when Flow → Spec
//     stopped with requested changes). Returns null when it has nothing.
//   - RunFailureOutcome: the whole explanation of a run that failed outright
//     when the extension owns its outcome (Flow → Spec: what failed in plain
//     words, what happens next, its actions and the technical details). It
//     replaces the generic failure block; without it the card stays generic.
//
// The value must be STABLE for the app's lifetime (useConversationMode is
// called as a hook). Without a provider every slot is inert and missions
// behave exactly as before.

import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { AgentMessageIntent } from '../lib/agent-api'

export interface MissionFenceCardProps {
  /** The fence tag the card was registered for. */
  tag: string
  /** Parsed JSON body of the block (null when the body is not valid JSON). */
  payload: unknown
  /** 0-based order of this tag's blocks inside the message. */
  index: number
  messageId: string | null
  conversationId: string | null
  /** The mission's pinned project (null in Home). */
  projectId: string | null
  /** Persisted card decisions on the message row. */
  intents: readonly AgentMessageIntent[] | null
  /** Newest message of the thread. */
  isLatest: boolean
  /** A turn is in flight in this conversation. */
  isStreaming: boolean
  /** Sends a user reply (the composer's send). */
  onSend?: (text: string) => void
}

export interface MissionConversationMode {
  /** `data-*` attributes applied to the conversation surface (theme hooks). */
  attributes?: Readonly<Record<`data-${string}`, string>>
  /** Replaces the git strip with a read-only branch (e.g. a worktree). */
  gitBranch?: { branch: string; label: string } | null
  /** The extension shows the branch itself (the Flow bar): no git strip at all. */
  hideGitStrip?: boolean
  /** While a turn runs, a send interrupts it instead of queueing. */
  interruptWhileBusy?: boolean
}

export interface MissionConversationSlotProps {
  conversationId: string
  projectId: string | null
  inline: boolean
}

export interface MissionRunCardActionsProps {
  projectId: string
  prDeliveryId: string
  /** The mission the card lives in (the run's origin conversation). */
  conversationId: string | null
  decision: string
  statusCode: string | null
  /** Disables the extension's buttons while the card runs another action. */
  busy: boolean
}

export interface MissionRunFailureOutcomeProps {
  /** The run's project (null on the Flow return card when unknown). */
  projectId: string | null
  prDeliveryId: string
  conversationId: string | null
  /** The failing step and the runtime's own error (its first line), when known. */
  stepId: string | null
  cause: string | null
  /** Technical codes, shown only under "Technical details". */
  statusCode: string | null
  failureCode: string | null
  statusDetail: string | null
  /** The repository of a multi-repository run (null otherwise). */
  repositoryName: string | null
  /** The work already went back to its Flow: a state instead of actions. */
  returned: boolean
  /** `card`: on the run card (with actions); `return`: inside the Flow's return card. */
  surface: 'card' | 'return'
  /** Disables the extension's buttons while the card runs another action. */
  busy: boolean
}

export interface MissionExtensions {
  fenceCards?: Readonly<Record<string, ComponentType<MissionFenceCardProps>>>
  useConversationMode?: (conversationId: string | null, projectId: string | null) => MissionConversationMode | null
  ConversationDock?: ComponentType<MissionConversationSlotProps>
  RunCardActions?: ComponentType<MissionRunCardActionsProps>
  RunFailureOutcome?: ComponentType<MissionRunFailureOutcomeProps>
}

const NONE: MissionExtensions = Object.freeze({})
const MissionExtensionsContext = createContext<MissionExtensions>(NONE)

export function MissionExtensionsProvider({ value, children }: { value: MissionExtensions; children: ReactNode }) {
  return <MissionExtensionsContext.Provider value={value}>{children}</MissionExtensionsContext.Provider>
}

export function useMissionExtensions(): MissionExtensions {
  return useContext(MissionExtensionsContext)
}

function useNoMode(): MissionConversationMode | null {
  return null
}

/** The extension-provided mode of a conversation (null without an extension). */
export function useMissionConversationMode(conversationId: string | null, projectId: string | null): MissionConversationMode | null {
  const useMode = useMissionExtensions().useConversationMode ?? useNoMode
  return useMode(conversationId, projectId)
}

/** Registered extension fence tags, stable order. */
export function extensionFenceTags(extensions: MissionExtensions): string[] {
  return Object.keys(extensions.fenceCards ?? {}).sort()
}
