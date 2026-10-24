// ─── Start in Flow (an existing spec) ─────────────────────────────────────────
// The board's and the spec detail's door into Flow for a spec that already
// exists, next to (never instead of) "Move to Rail": Flow and Implement are
// two equal ways to work on a spec. Starting needs a mission: the spec's own
// mission (`origin_conversation_id`) when it can take a Flow, else a new
// mission pinned to the project. The Flow opens there, in the mission panel.
// Unavailable cases stay visible but disabled, with the reason as tooltip.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Waves } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useDesktop } from '../../../hooks/useDesktop'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { createAgentConversation, patchAgentConversation } from '../../missions/lib/agent-api'
import type { LocalTicket } from '../../../types'
import type { MissionRailLaunchAlternativeProps } from '../../missions/context/MissionExtensionsContext'
import type { SpecExtensions, SpecStartAlternativeProps } from '../../specs/context/SpecExtensionsContext'
import { useConversationFlow, useFlowAvailability, useFlowContext } from '../context/FlowContext'
import { FlowApiError, isOpenFlow, type Flow } from '../lib/flow-api'
import { flowErrorMessage } from '../lib/flow-failure'

export type StartInFlowSpec = Pick<LocalTicket, 'id' | 'title' | 'status' | 'metadata' | 'origin_conversation_id'>

export type StartInFlowBlock = 'noProject' | 'loading' | 'unavailable' | 'inFlow' | 'closed' | 'running' | 'onRail' | 'missionInFlow'

/** Codes that mean "this mission cannot take this Flow": try a new mission instead. */
const RETRY_IN_NEW_MISSION: ReadonlySet<string> = new Set(['flow_already_open', 'conversation_not_pinned', 'conversation_not_found'])

/**
 * Why a spec cannot start in Flow now (null ⇒ it can). Mirrors the server's
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

/** Start an existing spec in Flow and open its mission. */
export function useStartInFlow(spec: StartInFlowSpec, rail: { running: boolean } | null) {
  const { t } = useTranslation('agent')
  const { activeProjectId } = useDesktop()
  const ctx = useFlowContext()
  const chat = useAgentChat()
  const availability = useFlowAvailability(activeProjectId)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (activeProjectId) ctx?.loadAvailability(activeProjectId) }, [ctx, activeProjectId])
  const block = !ctx ? 'unavailable' : startInFlowBlock(spec, { projectId: activeProjectId, available: availability ? availability.available : null, rail })

  const start = useCallback(async (): Promise<Flow | null> => {
    if (!ctx || !activeProjectId || busy || block) return null
    setBusy(true)
    const projectId = activeProjectId
    try {
      const inMission = async (conversationId: string) => ctx.start(projectId, conversationId, '', null, null, spec.id)
      let flow: Flow | null = null
      if (spec.origin_conversation_id) {
        try {
          flow = await inMission(spec.origin_conversation_id)
        } catch (error) {
          if (!(error instanceof FlowApiError && RETRY_IN_NEW_MISSION.has(error.code))) throw error
        }
      }
      if (!flow) {
        const created = await createAgentConversation({ pinnedProjectId: projectId })
        await patchAgentConversation(created.id, { title: spec.title }).catch(() => null)
        flow = await inMission(created.id)
      }
      await chat.refreshConversations().catch(() => undefined)
      await chat.selectConversation(flow.conversationId).catch(() => undefined)
      chat.open()
      return flow
    } catch (error) {
      const { message, detail } = flowErrorMessage(t, error)
      toast.error(t('flow.startFromSpec.failed', { id: spec.id }), { description: detail && detail !== message ? `${message} ${detail}` : message })
      if (error instanceof FlowApiError && error.code === 'feature_unavailable') ctx.loadAvailability(projectId, true)
      return null
    } finally {
      setBusy(false)
    }
  }, [ctx, activeProjectId, busy, block, spec.id, spec.title, spec.origin_conversation_id, chat, t])

  const reason = block && block !== 'loading' ? t(`flow.startFromSpec.blocked.${block}`) : null
  return { block, reason, busy, start }
}

interface StartInFlowProps {
  spec: StartInFlowSpec
  /** The rail the spec sits on (null ⇒ none). */
  rail: { running: boolean } | null
}

/** Spec detail header button, styled like "Move to Rail" (equal weight). */
export function StartInFlowButton({ spec, rail, className }: StartInFlowProps & { className?: string }) {
  const { t } = useTranslation('agent')
  const { block, reason, busy, start } = useStartInFlow(spec, rail)
  const disabled = busy || !!block
  return (
    <span title={reason ?? t('flow.startFromSpec.hint')} className="inline-flex">
      <button
        type="button"
        data-testid="spec-start-in-flow"
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={reason ? `${t('flow.startFromSpec.action')} — ${reason}` : t('flow.startFromSpec.action')}
        onClick={() => void start()}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors',
          'hover:border-accent-flow/50 hover:bg-accent-flow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:bg-background',
          className,
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Waves className="h-3.5 w-3.5 text-accent-flow" aria-hidden />}
        {busy ? t('flow.startFromSpec.starting') : t('flow.startFromSpec.action')}
      </button>
    </span>
  )
}

/** Spec card context menu item (the menu closes once the Flow starts or is refused). */
export function StartInFlowMenuItem({ spec, rail, onDone }: StartInFlowProps & { onDone: () => void }) {
  const { t } = useTranslation('agent')
  const { block, reason, busy, start } = useStartInFlow(spec, rail)
  const disabled = busy || !!block
  return (
    <button
      role="menuitem"
      type="button"
      data-testid="spec-menu-start-in-flow"
      disabled={disabled}
      aria-disabled={disabled}
      title={reason ?? t('flow.startFromSpec.hint')}
      onClick={() => { void start().finally(onDone) }}
      className="flex w-full items-start gap-2 px-3 py-2 text-left text-foreground/80 transition-colors hover:bg-accent-flow/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      {busy ? <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <Waves className="mt-px h-3.5 w-3.5 shrink-0 text-accent-flow" aria-hidden />}
      <span className="min-w-0">
        <span className="block">{busy ? t('flow.startFromSpec.starting') : t('flow.startFromSpec.action')}</span>
        {reason ? <span className="block text-[11px] text-muted-foreground">{reason}</span> : null}
      </span>
    </button>
  )
}

/**
 * The rail-launch card's other path for its one existing spec (missions'
 * RailLaunchAlternative slot): start that spec in Flow in THIS mission.
 * Same weight as the card's own launch; the server checks the spec.
 */
export function FlowRailLaunchAlternative({ projectId, conversationId, ticketId, disabled, onChosen }: MissionRailLaunchAlternativeProps) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const availability = useFlowAvailability(projectId)
  const { flow } = useConversationFlow(conversationId, projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = !ctx ? 'unavailable' : isOpenFlow(flow) ? 'missionInFlow' : availability && !availability.available ? 'unavailable' : null
  const reason = blocked ? t(`flow.startFromSpec.blocked.${blocked}`) : null
  const start = async () => {
    if (!ctx || busy || disabled || blocked) return
    setBusy(true)
    setError(null)
    try {
      await ctx.start(projectId, conversationId, '', null, null, ticketId)
      onChosen()
    } catch (err) {
      setError(flowErrorMessage(t, err).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        data-agent-interactive
        data-testid="rail-card-start-in-flow"
        disabled={disabled || busy || !!blocked}
        title={reason ?? t('flow.startFromSpec.hint')}
        aria-describedby={error ? `rail-card-flow-error-${ticketId}` : undefined}
        onClick={() => void start()}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground/85 transition-colors hover:border-accent-flow/50 hover:bg-accent-flow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Waves className="h-3.5 w-3.5 text-accent-flow" aria-hidden />}
        {busy ? t('flow.startFromSpec.starting') : t('flow.startFromSpec.action')}
      </button>
      {error && <span id={`rail-card-flow-error-${ticketId}`} role="alert" data-testid="rail-card-flow-error" className="mt-1 max-w-[16rem] text-right text-xs text-destructive">{error}</span>}
    </span>
  )
}

/** The specs seam (SpecExtensions.StartAlternative): Flow's "Start in Flow". */
export function FlowSpecStartAlternative({ spec, rail, variant, onDone, className }: SpecStartAlternativeProps) {
  return variant === 'menu'
    ? <StartInFlowMenuItem spec={spec} rail={rail} onDone={onDone ?? (() => undefined)} />
    : <StartInFlowButton spec={spec} rail={rail} className={className} />
}

export const FLOW_SPEC_EXTENSIONS: SpecExtensions = Object.freeze({ StartAlternative: FlowSpecStartAlternative })
