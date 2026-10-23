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
//   - ConversationDock: a component the run strip mounts for what the
//     extension needs mounted there that is NOT a run (Flow: its state
//     announcements, said through the strip's ONE polite live region via
//     `announce`). Runs go through useLiveRuns.
//   - useLiveRuns: the extension's live runs for a conversation (Flow: the
//     open Flow, its hand-off and the launch in flight). Missions renders
//     them in the ONE run strip above the composer, next to its own runs.
//   - useConversationMarks: marks for the mission list rows (Flow: "In Flow").
//   - useRunAttention: which conversations have an extension run waiting for
//     the person (the mission list's attention dot), derived from the
//     extension's own app-wide state so it is live without the mission open.
//     When provided, the run strip no longer reports the extension's runs.
//   - describeRun: the person's words for a run's current step and for the
//     step it failed at, when the extension owns the run's loop (Flow → Spec).
//   - RunCardActions: extra actions on a run/PR card whose outcome the
//     extension owns (Flow: "Back to Flow" and "Relaunch" when Flow → Spec
//     stopped with requested changes). Returns null when it has nothing.
//   - useTurnMark: the mark (icon, color, words) on agent turns written in
//     the extension's mode; missions never hard-codes the mode's icon.
//   - RunFailureOutcome: the whole explanation of a run that failed outright
//     when the extension owns its outcome (Flow → Spec: what failed in plain
//     words, what happens next, its actions and the technical details). It
//     replaces the generic failure block; without it the card stays generic.
//
// The value must be STABLE for the app's lifetime (useConversationMode is
// called as a hook). Without a provider every slot is inert and missions
// behave exactly as before.

import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
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

/** A mode marker an extension shows on missions surfaces: icon + text, never color alone. */
export interface MissionModeBadge {
  /** Short visible text ("Flow", "In Flow"). */
  label: string
  /** What the mode means (tooltip / accessible description). */
  description?: string
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  /** The mode's own color (a CSS color, e.g. `var(--color-accent-flow)`); defaults to the info accent. */
  accent?: string
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
  /** The composer works in the extension's mode: a chip next to the tier chip,
   * a thin accent line on top and the mode's own placeholder. */
  composer?: { badge: MissionModeBadge; placeholder?: string } | null
  /** A label next to the mission title in its header ("In Flow"). */
  headerBadge?: MissionModeBadge | null
}

export interface MissionConversationSlotProps {
  conversationId: string
  projectId: string | null
  inline: boolean
}

export interface MissionConversationDockProps extends MissionConversationSlotProps {
  /** Says something politely through the run strip's ONE live region. */
  announce: (message: string) => void
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

/** How a run looks in the strip (see mission-run-strip.ts). */
export type MissionLiveRunTone = 'launching' | 'running' | 'decision' | 'failed' | 'paused' | 'info'

/**
 * One extension-owned live run in the mission's run strip. Missions owns the
 * chrome (status mark, expand toggle, switcher, panel, announcements); the
 * extension supplies the content.
 */
export interface MissionLiveRun {
  /** Stable within the conversation (keep it across states so the strip morphs in place). */
  key: string
  /** The switcher's name for the run ("Flow"). */
  label: string
  tone: MissionLiveRunTone
  /** A running run with no current activity sets false: its mark stops pulsing. */
  working?: boolean
  /** Plain words, inside the expand toggle. */
  headline: ReactNode
  /** Short non-interactive data after the headline (inside the toggle). */
  meta?: ReactNode
  /** Interactive controls after the toggle (the extension's own buttons). */
  controls?: ReactNode
  // The run's primary action is DECLARED by its panel's content
  // (RunPrimaryButton / useRunPrimary from components/run-primary.tsx).
  /** Expanded content above the strip; null = the strip is not expandable. */
  panel?: ReactNode | null
  /** The panel opens on its own each time this token changes (e.g. the hand-off). */
  autoOpenToken?: string | null
  /**
   * The person closed this run's panel (Esc, a click in the conversation, the
   * toggle, or switching to another run). Flow: closing the hand-off panel
   * counts as "Not yet".
   */
  onPanelClose?: (() => void) | null
  /** Hidden as soon as missions shows this delivery (the launch skeleton yields to its run). */
  yieldsTo?: { prDeliveryId?: string | null; runIds?: readonly string[] } | null
  /** Polite announcement of the run's state (announced when it changes). */
  announcement?: string | null
  /** The run's mode (Flow): while it runs, the strip mark is the mode's icon in the mode's color. */
  mode?: MissionModeBadge | null
  /** Extra attributes for the strip root while this run shows (tests, themes). */
  attributes?: Readonly<Record<`data-${string}`, string>>
}

export interface MissionConversationRef {
  id: string
  pinned_project_id: string | null
}

export interface MissionRunDescriptionInput {
  loopId: string | null
  /** The step the run is at (running) or failed at (failed). */
  stepId: string | null
  /** Delivery / failure codes that can name the failing phase without a step. */
  codes: ReadonlyArray<string | null | undefined>
}

export interface MissionRunDescription {
  /** What the run is doing now, in the person's words ("Deriving the spec"). */
  step: string | null
  /** The headline of a failure at that step ("Couldn’t write the spec from your changes"). */
  failure: string | null
}

export interface MissionExtensions {
  fenceCards?: Readonly<Record<string, ComponentType<MissionFenceCardProps>>>
  useConversationMode?: (conversationId: string | null, projectId: string | null) => MissionConversationMode | null
  ConversationDock?: ComponentType<MissionConversationDockProps>
  RunCardActions?: ComponentType<MissionRunCardActionsProps>
  RunFailureOutcome?: ComponentType<MissionRunFailureOutcomeProps>
  useLiveRuns?: (props: MissionConversationSlotProps) => readonly MissionLiveRun[]
  /** Marks for the mission list rows (Flow: the missions that are in Flow). */
  useConversationMarks?: (conversations: readonly MissionConversationRef[]) => ReadonlyMap<string, MissionModeBadge>
  /**
   * The extension's runs that wait for the person (a `decision` or `failed`
   * tone, the strip's own rule), per conversation id, for EVERY listed
   * conversation (open or not). Feeds the sidebar attention dot; the strip
   * then leaves those runs to it.
   */
  useRunAttention?: (conversations: readonly MissionConversationRef[]) => ReadonlyMap<string, ReadonlySet<string>>
  describeRun?: (t: TFunction, input: MissionRunDescriptionInput) => MissionRunDescription | null
  /** The discreet mark on agent turns written inside the extension's mode (Flow): icon, color, words. */
  useTurnMark?: () => MissionModeBadge | null
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

const NO_MARKS: ReadonlyMap<string, MissionModeBadge> = new Map()
function useNoMarks(): ReadonlyMap<string, MissionModeBadge> {
  return NO_MARKS
}

/** The extension's marks for mission list rows, keyed by conversation id. */
export function useMissionConversationMarks(conversations: readonly MissionConversationRef[]): ReadonlyMap<string, MissionModeBadge> {
  const useMarks = useMissionExtensions().useConversationMarks ?? useNoMarks
  return useMarks(conversations)
}

const NO_ATTENTION: ReadonlyMap<string, ReadonlySet<string>> = new Map()
function useNoRunAttention(): ReadonlyMap<string, ReadonlySet<string>> {
  return NO_ATTENTION
}

/** Extension runs waiting for the person, keyed by conversation id (none without an extension). */
export function useMissionRunAttention(conversations: readonly MissionConversationRef[]): ReadonlyMap<string, ReadonlySet<string>> {
  const useAttention = useMissionExtensions().useRunAttention ?? useNoRunAttention
  return useAttention(conversations)
}

const NO_RUNS: readonly MissionLiveRun[] = Object.freeze([])
function useNoLiveRuns(): readonly MissionLiveRun[] {
  return NO_RUNS
}

/** The extension's live runs of a conversation (none without an extension). */
export function useMissionLiveRuns(props: MissionConversationSlotProps): readonly MissionLiveRun[] {
  const useRuns = useMissionExtensions().useLiveRuns ?? useNoLiveRuns
  return useRuns(props)
}

function useNoTurnMark(): MissionModeBadge | null {
  return null
}

/** The extension's mark for agent turns written in its mode (null without an extension). */
export function useMissionTurnMark(): MissionModeBadge | null {
  const useMark = useMissionExtensions().useTurnMark ?? useNoTurnMark
  return useMark()
}

/** The CSS color of a mode badge (the mode's own accent, else the info accent). */
export function modeAccent(badge: Pick<MissionModeBadge, 'accent'> | null | undefined): string {
  return badge?.accent ?? 'var(--color-accent-info)'
}

/** Registered extension fence tags, stable order. */
export function extensionFenceTags(extensions: MissionExtensions): string[] {
  return Object.keys(extensions.fenceCards ?? {}).sort()
}
