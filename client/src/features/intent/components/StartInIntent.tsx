// ─── Start in Intent (an existing spec) ─────────────────────────────────────────
// The board's and the spec detail's door into Intent for a spec that already
// exists, next to (never instead of) "Move to Rail": IntentSession and Implement are
// two equal ways to work on a spec. Every door goes through the SAME entry
// confirmation as a new idea (IntentEntryCard: isolated worktree, repository,
// provider, Start / Cancel); nothing starts on a bare click.
//   - Spec detail header: the card opens in a small dialog above the detail.
//   - Card context menu: the menu closes on any outside press, so it cannot host
//     the dialog; it opens the spec detail and asks it to show the entry at once.
//   - Rail-launch card (missions): the card replaces the action in place.
// Starting needs a mission: the spec's own mission (`origin_conversation_id`)
// when it can take an Intent session, else a new mission pinned to the project.
// Once started, that mission comes to the front (its Intent strip focused) and a
// toast says where the work happens, with "Open the Intent mission" to return.
// A spec already in Intent offers that same jump instead of a greyed Start.
// Other unavailable cases stay visible but disabled, with the reason as tooltip.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowUpRight, Loader2, Waves } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { projectProviders, useDesktop } from '../../../hooks/useDesktop'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { createAgentConversation, patchAgentConversation } from '../../missions/lib/agent-api'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import type { LocalTicket } from '../../../types'
import type { MissionRailLaunchAlternativeProps } from '../../missions/context/MissionExtensionsContext'
import type { SpecExtensions, SpecStartAlternativeProps } from '../../specs/context/SpecExtensionsContext'
import { useConversationFlow, useFlowAvailability, useFlowContext } from '../context/IntentContext'
import { IntentApiError, isOpenFlow, type IntentSession } from '../lib/intent-api'
import { IntentEntryCard, focusFlowBar } from './IntentEntryCard'

export type StartInFlowSpec = Pick<LocalTicket, 'id' | 'title' | 'status' | 'metadata' | 'origin_conversation_id' | 'repositoryIds'> & Partial<Pick<LocalTicket, 'intent'>>

export type StartInFlowBlock = 'noProject' | 'loading' | 'unavailable' | 'inFlow' | 'closed' | 'running' | 'onRail' | 'missionInFlow'

/** Codes that mean "this mission cannot take this Intent": try a new mission instead. */
const RETRY_IN_NEW_MISSION: ReadonlySet<string> = new Set(['flow_already_open', 'conversation_not_pinned', 'conversation_not_found'])

/**
 * Why a spec cannot start in Intent now (null ⇒ it can). Mirrors the server's
 * checks so the action explains itself; the server still decides.
 */
export function startInFlowBlock(spec: Pick<StartInFlowSpec, 'status' | 'metadata'>, input: { projectId: string | null; available: boolean | null; rail: { running: boolean } | null }): StartInFlowBlock | null {
  if (!input.projectId) return 'noProject'
  const flowState = spec.metadata?.flow?.state
  if (flowState === 'active' || flowState === 'paused') return 'inFlow'
  if (spec.status === 'done' || spec.status === 'cancelled') return 'closed'
  if (input.rail?.running) return 'running'
  if (input.rail) return 'onRail'
  if (input.available === null) return 'loading'
  if (!input.available) return 'unavailable'
  return null
}

/** The repository the entry card preselects: the one Git member a spec names (the card only offers Git members). */
export function specSuggestedRepository(spec: { repositoryIds?: readonly string[] | null }): string | null {
  return spec.repositoryIds?.length === 1 ? spec.repositoryIds[0] ?? null : null
}

/** Bring the Intent strip of a just-started session into view once the mission has rendered it. */
export function revealFlowBar(flowId: string, attempts = 8): void {
  if (focusFlowBar(flowId) || attempts <= 0) return
  window.setTimeout(() => revealFlowBar(flowId, attempts - 1), 200)
}

// ─── Context menu → spec detail hand-off ────────────────────────────────────────
// The board's context menu closes on any press outside it, which would unmount a
// dialog it hosted. The menu item therefore opens the spec detail and leaves a
// short-lived request for that spec's header door to open the entry at once.
const PENDING_ENTRY_TTL_MS = 5000
let pendingEntry: { ticketId: number; at: number } | null = null

export function requestStartInFlowEntry(ticketId: number): void {
  pendingEntry = { ticketId, at: Date.now() }
}

function takeStartInFlowEntry(ticketId: number): boolean {
  const pending = pendingEntry
  if (!pending) return false
  if (pending.ticketId !== ticketId) return false
  pendingEntry = null
  return Date.now() - pending.at <= PENDING_ENTRY_TTL_MS
}

/** The spec doors' shared state: why a start is blocked, how to start, how to reach a running Intent. */
export function useStartInFlow(spec: StartInFlowSpec, rail: { running: boolean } | null) {
  const { t } = useTranslation('agent')
  const { activeProjectId, projects } = useDesktop()
  const ctx = useFlowContext()
  const chat = useAgentChat()
  const availability = useFlowAvailability(activeProjectId)
  const [entryOpen, setEntryOpen] = useState(false)
  useEffect(() => { if (activeProjectId) ctx?.loadAvailability(activeProjectId) }, [ctx, activeProjectId])
  const block = !ctx ? 'unavailable' : startInFlowBlock(spec, { projectId: activeProjectId, available: availability ? availability.available : null, rail })
  const project = projects.find((candidate) => candidate.id === activeProjectId) ?? null
  const provider = project ? projectProviders(project)[0] ?? null : null
  // A spec in Intent: the mission holding it (the spec's own mission as a fallback).
  const flowConversationId = block === 'inFlow' ? spec.metadata?.flow?.conversationId ?? spec.origin_conversation_id ?? null : null
  const flowId = block === 'inFlow' ? spec.metadata?.flow?.flowId ?? null : null

  /** Bring a mission to the front and, when known, its Intent strip into view. */
  const openMission = useCallback(async (conversationId: string, intentId?: string | null) => {
    await chat.selectConversation(conversationId).catch(() => undefined)
    chat.open()
    if (intentId) revealFlowBar(intentId)
  }, [chat])

  /**
   * The entry card's Start: the spec's own mission when it can take the Intent,
   * else a new mission titled after the spec. Throws so the card says why.
   */
  const startIn = useCallback(async ({ repositoryId }: { repositoryId: string | null }): Promise<IntentSession> => {
    if (!ctx || !activeProjectId) throw new IntentApiError('feature_unavailable', 0, t('flow.startFromSpec.blocked.noProject'))
    const projectId = activeProjectId
    const inMission = async (conversationId: string) => ctx.start(projectId, conversationId, '', null, repositoryId, spec.id)
    let flow: IntentSession | null = null
    if (spec.origin_conversation_id) {
      try {
        flow = await inMission(spec.origin_conversation_id)
      } catch (error) {
        if (!(error instanceof IntentApiError && RETRY_IN_NEW_MISSION.has(error.code))) throw error
      }
    }
    if (!flow) {
      const created = await createAgentConversation({ pinnedProjectId: projectId })
      await patchAgentConversation(created.id, { title: spec.title }).catch(() => null)
      flow = await inMission(created.id)
    }
    const started = flow
    await chat.refreshConversations().catch(() => undefined)
    void openMission(started.conversationId, started.id)
    toast.success(t('flow.startFromSpec.started', { id: spec.id, branch: started.branch ?? t('flow.strip.label') }), {
      action: { label: t('flow.startFromSpec.openMission'), onClick: () => { void openMission(started.conversationId, started.id) } },
    })
    return started
  }, [ctx, activeProjectId, spec, chat, openMission, t])

  const reason = block && block !== 'loading' ? t(`flow.startFromSpec.blocked.${block}`) : null
  const openEntry = useCallback(() => setEntryOpen(true), [])
  const closeEntry = useCallback(() => setEntryOpen(false), [])
  return { block, reason, provider, projectId: activeProjectId, flowConversationId, flowId, entryOpen, openEntry, closeEntry, startIn, openMission }
}

interface StartInFlowProps {
  spec: StartInFlowSpec
  /** The rail the spec sits on (null ⇒ none). */
  rail: { running: boolean } | null
}

/** The entry confirmation for an existing spec, above the spec detail (stacked). */
function StartInFlowEntryDialog({ spec, open, onClose, projectId, provider, start }: {
  spec: StartInFlowSpec
  open: boolean
  onClose: () => void
  projectId: string | null
  provider: string | null
  start: (input: { repositoryId: string | null }) => Promise<IntentSession>
}) {
  const { t } = useTranslation('agent')
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent size="form" data-testid="flow-start-entry-dialog">
        <DialogHeader icon={<Waves className="text-accent-intent" />}>
          <DialogTitle>{t('flow.entry.heading')}</DialogTitle>
          <DialogDescription>{t('flow.startFromSpec.hint')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <IntentEntryCard
            headless
            embedded
            idea={spec.title}
            title={spec.title}
            ticketId={spec.id}
            summary={spec.intent?.problem ?? null}
            repositoryId={specSuggestedRepository(spec)}
            projectId={projectId}
            conversationId={null}
            provider={provider}
            start={start}
            onStarted={onClose}
            onCancel={onClose}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

const DOOR_BUTTON = cn(
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-label transition-colors',
  'hover:border-accent-intent/50 hover:bg-accent-intent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-intent/50',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:bg-background',
)

/** Spec detail header button, styled like "Move to Rail" (equal weight). */
export function StartInFlowButton({ spec, rail, className }: StartInFlowProps & { className?: string }) {
  const { t } = useTranslation('agent')
  const { block, reason, provider, projectId, flowConversationId, flowId, entryOpen, openEntry, closeEntry, startIn, openMission } = useStartInFlow(spec, rail)
  // The context menu asked for this spec's entry: open it as soon as the detail shows.
  useEffect(() => { if (takeStartInFlowEntry(spec.id)) openEntry() }, [spec.id, openEntry])
  if (block === 'inFlow') {
    return (
      <button
        type="button"
        data-testid="spec-open-flow-mission"
        disabled={!flowConversationId}
        title={t('flow.startFromSpec.blocked.inFlow')}
        onClick={() => { if (flowConversationId) void openMission(flowConversationId, flowId) }}
        className={cn(DOOR_BUTTON, className)}
      >
        <ArrowUpRight className="h-3.5 w-3.5 text-accent-intent" aria-hidden />
        {t('flow.startFromSpec.openMission')}
      </button>
    )
  }
  const disabled = !!block
  return (
    <>
      <button
        type="button"
        data-testid="spec-start-in-flow"
        disabled={disabled}
        title={reason ?? t('flow.startFromSpec.hint')}
        onClick={openEntry}
        className={cn(DOOR_BUTTON, className)}
      >
        {block === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Waves className="h-3.5 w-3.5 text-accent-intent" aria-hidden />}
        {t('flow.startFromSpec.action')}
        {reason ? <span className="sr-only"> ({reason})</span> : null}
      </button>
      <StartInFlowEntryDialog spec={spec} open={entryOpen} onClose={closeEntry} projectId={projectId} provider={provider} start={startIn} />
    </>
  )
}

/** Spec card context menu item: opens the spec detail with the entry confirmation (the menu closes first). */
export function StartInFlowMenuItem({ spec, rail, onDone }: StartInFlowProps & { onDone: () => void }) {
  const { t } = useTranslation('agent')
  const { block, reason, flowConversationId, flowId, openMission } = useStartInFlow(spec, rail)
  const { openTicketDetail } = useTicketDetailModal()
  const inFlow = block === 'inFlow'
  const disabled = inFlow ? !flowConversationId : !!block
  const label = inFlow ? t('flow.startFromSpec.openMission') : t('flow.startFromSpec.action')
  const Icon = inFlow ? ArrowUpRight : block === 'loading' ? Loader2 : Waves
  return (
    <button
      role="menuitem"
      type="button"
      data-testid="spec-menu-start-in-flow"
      disabled={disabled}
      title={inFlow ? t('flow.startFromSpec.blocked.inFlow') : reason ?? t('flow.startFromSpec.hint')}
      onClick={() => {
        onDone()
        if (inFlow) { if (flowConversationId) void openMission(flowConversationId, flowId); return }
        requestStartInFlowEntry(spec.id)
        openTicketDetail(spec.id)
      }}
      className="flex w-full items-start gap-2 px-3 py-2 text-left text-foreground transition-colors hover:bg-accent-intent/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0 text-accent-intent', block === 'loading' && 'animate-spin')} aria-hidden />
      <span className="min-w-0">
        <span className="block">{label}</span>
        {!inFlow && reason ? <span className="block text-caption text-muted-foreground">{reason}</span> : null}
      </span>
    </button>
  )
}

/**
 * The rail-launch card's other path for its one existing spec (missions'
 * RailLaunchAlternative slot): start that spec in Intent in THIS mission.
 * Same weight as the card's own launch; choosing it shows the entry
 * confirmation in place, and Start begins the Intent here.
 */
export function IntentRailLaunchAlternative({ projectId, conversationId, ticketId, ticketTitle, ticketRepositoryIds, disabled, onChosen }: MissionRailLaunchAlternativeProps) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const { active } = useAgentChat()
  const availability = useFlowAvailability(projectId)
  const { flow } = useConversationFlow(conversationId, projectId)
  const [entry, setEntry] = useState(false)
  const blocked = !ctx ? 'unavailable' : isOpenFlow(flow) ? 'missionInFlow' : availability && !availability.available ? 'unavailable' : null
  const reason = blocked ? t(`flow.startFromSpec.blocked.${blocked}`) : null
  if (entry) {
    return (
      <div className="w-full min-w-[16rem]" data-testid="rail-card-flow-entry">
        <IntentEntryCard
          embedded
          idea={ticketTitle ?? ''}
          title={ticketTitle ?? null}
          ticketId={ticketId}
          repositoryId={specSuggestedRepository({ repositoryIds: ticketRepositoryIds })}
          projectId={projectId}
          conversationId={conversationId}
          provider={active?.id === conversationId ? active?.provider ?? null : null}
          // The same request as before the confirmation existed: the spec is the idea.
          start={({ repositoryId }) => {
            if (!ctx) throw new IntentApiError('feature_unavailable', 0, t('flow.startFromSpec.blocked.unavailable'))
            return ctx.start(projectId, conversationId, '', null, repositoryId, ticketId)
          }}
          onStarted={(started) => {
            setEntry(false)
            toast.success(t('flow.startFromSpec.started', { id: ticketId, branch: started.branch ?? t('flow.strip.label') }))
            revealFlowBar(started.id)
            onChosen()
          }}
          onCancel={() => setEntry(false)}
        />
      </div>
    )
  }
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid="rail-card-start-in-flow"
      disabled={disabled || !!blocked}
      title={reason ?? t('flow.startFromSpec.hint')}
      onClick={() => setEntry(true)}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-label text-foreground transition-colors hover:border-accent-intent/50 hover:bg-accent-intent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-intent/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Waves className="h-3.5 w-3.5 text-accent-intent" aria-hidden />
      {t('flow.startFromSpec.action')}
      {reason ? <span className="sr-only"> ({reason})</span> : null}
    </button>
  )
}

/** The specs seam (SpecExtensions.StartAlternative): Intent's "Start in Intent". */
export function IntentSpecStartAlternative({ spec, rail, variant, onDone, className }: SpecStartAlternativeProps) {
  return variant === 'menu'
    ? <StartInFlowMenuItem spec={spec} rail={rail} onDone={onDone ?? (() => undefined)} />
    : <StartInFlowButton spec={spec} rail={rail} className={className} />
}

export const FLOW_SPEC_EXTENSIONS: SpecExtensions = Object.freeze({ StartAlternative: IntentSpecStartAlternative })
