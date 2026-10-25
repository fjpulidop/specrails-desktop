// ─── Start in Flow (an existing spec) ─────────────────────────────────────────
// The board's and the spec detail's door into Flow for a spec that already
// exists, next to (never instead of) "Move to Rail": Flow and Implement are
// two equal ways to work on a spec. Starting needs a mission: the spec's own
// mission (`origin_conversation_id`) when it can take a Flow, else a new
// mission pinned to the project. The Flow opens there, in the mission panel.
// Unavailable cases stay visible but disabled, with the reason as tooltip.
// In a project with several Git repositories, a spec that does not target
// exactly one of them first asks WHERE the Flow runs (FlowRepositoryPrompt).

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { FlowApiError, flowApi, flowRepositoryChoice, isOpenFlow, type Flow } from '../lib/flow-api'
import { flowErrorMessage } from '../lib/flow-failure'
import { useFlowRepositoryPrompt, type FlowRepositoryPrompt } from './FlowRepositoryPrompt'

export type StartInFlowSpec = Pick<LocalTicket, 'id' | 'title' | 'status' | 'metadata' | 'origin_conversation_id' | 'repositoryIds'>

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

/**
 * The repository a spec starts its Flow in: `undefined` ⇒ let the server
 * triage (one repository, a spec that targets exactly one Git member, an
 * unknown member list, no prompt mounted); a string ⇒ the person's pick;
 * null ⇒ the person cancelled. Only several Git members ask.
 */
export async function chooseSpecRepository(projectId: string, spec: { id: number; title: string; repositoryIds?: readonly string[] }, prompt: FlowRepositoryPrompt | null, onPrompt?: () => void): Promise<string | null | undefined> {
  if (!prompt) return undefined
  const repositories = await flowApi.repositories(projectId).catch(() => null)
  if (!repositories) return undefined
  const choice = flowRepositoryChoice(repositories)
  if (!choice.show || choice.candidates.length < 2) return undefined
  const named = (spec.repositoryIds ?? []).filter((id) => choice.candidates.some((candidate) => candidate.id === id))
  if ((spec.repositoryIds?.length ?? 0) === 1 && named.length === 1) return undefined
  onPrompt?.()
  return prompt.choose({ spec: { id: spec.id, title: spec.title }, candidates: choice.candidates, specRepositoryId: named[0] ?? null, fallbackId: choice.fallback })
}

/** Start an existing spec in Flow and open its mission. */
export function useStartInFlow(spec: StartInFlowSpec, rail: { running: boolean } | null) {
  const { t } = useTranslation('agent')
  const { activeProjectId } = useDesktop()
  const ctx = useFlowContext()
  const chat = useAgentChat()
  const prompt = useFlowRepositoryPrompt()
  const availability = useFlowAvailability(activeProjectId)
  const [busy, setBusy] = useState(false)
  // Re-entrancy guard (the repository dialog may be open while `busy` is false).
  const startingRef = useRef(false)
  useEffect(() => { if (activeProjectId) ctx?.loadAvailability(activeProjectId) }, [ctx, activeProjectId])
  const block = !ctx ? 'unavailable' : startInFlowBlock(spec, { projectId: activeProjectId, available: availability ? availability.available : null, rail })

  /** `onPrompt`: called as the repository dialog opens (the board's menu closes then). */
  const start = useCallback(async (options?: { onPrompt?: () => void }): Promise<Flow | null> => {
    if (!ctx || !activeProjectId || startingRef.current || block) return null
    startingRef.current = true
    const projectId = activeProjectId
    try {
      const repositoryId = await chooseSpecRepository(projectId, spec, prompt, options?.onPrompt)
      if (repositoryId === null) return null
      setBusy(true)
      const inMission = async (conversationId: string) => ctx.start(projectId, conversationId, '', null, repositoryId ?? null, spec.id)
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
      startingRef.current = false
      setBusy(false)
    }
  }, [ctx, activeProjectId, block, spec, prompt, chat, t])

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
          'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-label transition-colors',
          'hover:border-accent-flow/50 hover:bg-accent-flow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:bg-background',
          className,
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Waves className="h-3.5 w-3.5 text-accent-flow" aria-hidden />}
        {busy ? t('flow.startFromSpec.starting') : t('flow.startFromSpec.action')}
      </button>
    {(reason ?? t('flow.startFromSpec.hint')) ? <span className="sr-only"> ({reason ?? t('flow.startFromSpec.hint')})</span> : null}</span>
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
      onClick={() => { void start({ onPrompt: onDone }).finally(onDone) }}
      className="flex w-full items-start gap-2 px-3 py-2 text-left text-foreground/80 transition-colors hover:bg-accent-flow/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      {busy ? <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <Waves className="mt-px h-3.5 w-3.5 shrink-0 text-accent-flow" aria-hidden />}
      <span className="min-w-0">
        <span className="block">{busy ? t('flow.startFromSpec.starting') : t('flow.startFromSpec.action')}</span>
        {reason ? <span className="block text-caption text-muted-foreground">{reason}</span> : null}
      </span>
    </button>
  )
}

/**
 * The rail-launch card's other path for its one existing spec (missions'
 * RailLaunchAlternative slot): start that spec in Flow in THIS mission.
 * Same weight as the card's own launch; the server checks the spec.
 */
export function FlowRailLaunchAlternative({ projectId, conversationId, ticketId, ticketTitle, ticketRepositoryIds, disabled, onChosen }: MissionRailLaunchAlternativeProps) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const prompt = useFlowRepositoryPrompt()
  // Re-entrancy guard (the repository dialog may be open while `busy` is false).
  const startingRef = useRef(false)
  const availability = useFlowAvailability(projectId)
  const { flow } = useConversationFlow(conversationId, projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = !ctx ? 'unavailable' : isOpenFlow(flow) ? 'missionInFlow' : availability && !availability.available ? 'unavailable' : null
  const reason = blocked ? t(`flow.startFromSpec.blocked.${blocked}`) : null
  const start = async () => {
    if (!ctx || busy || startingRef.current || disabled || blocked) return
    startingRef.current = true
    setError(null)
    try {
      // Several Git repositories and a spec that names none (or several): ask where.
      const repositoryId = await chooseSpecRepository(projectId, { id: ticketId, title: ticketTitle ?? '', repositoryIds: ticketRepositoryIds }, prompt)
      if (repositoryId === null) return
      setBusy(true)
      await ctx.start(projectId, conversationId, '', null, repositoryId ?? null, ticketId)
      onChosen()
    } catch (err) {
      setError(flowErrorMessage(t, err).message)
    } finally {
      startingRef.current = false
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
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-label text-foreground/85 transition-colors hover:border-accent-flow/50 hover:bg-accent-flow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50 disabled:cursor-not-allowed disabled:opacity-50"
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
