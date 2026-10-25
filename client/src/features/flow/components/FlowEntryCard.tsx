// ─── Flow entry confirmation ──────────────────────────────────────────────────
// The ONLY door into Flow: it explains the isolated worktree, previews the
// idea, names the provider and starts the Flow on the user's explicit click.
// When the selected Core cannot run Flow, Start is disabled and the missing
// capabilities are listed in plain words. In a workspace (folder primary) or a
// project with several Git repositories it also shows WHERE the Flow runs:
// the repository the agent triaged, changeable among the Git members.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { AlertTriangle, FileText, GitBranch, Loader2, Play, ShieldCheck, Waves } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { useFlowAvailability, useFlowContext } from '../context/FlowContext'
import { FlowApiError, flowApi, flowRepositoryChoice, type Flow, type FlowRepositoryOption } from '../lib/flow-api'
import { missingCapabilityKeys } from '../lib/flow-offer'
import { flowErrorMessage } from '../lib/flow-failure'
import { FlowRepositoryPicker } from './FlowRepositoryPicker'
import { InitialCommitButton } from '../../../components/InitialCommitButton'
import { HelpHint } from '../../../components/HelpHint'
import { PRIMARY_ACTION_SHAPE } from '../../missions/components/run-primary'
import { prefersReducedMotion } from '../../../lib/a11y-prefs'

interface Props {
  idea: string
  title?: string | null
  /** The repository the agent triaged the idea into (preselected when offered). */
  repositoryId?: string | null
  /** Start from this EXISTING spec (the card shows the spec, not an idea). */
  ticketId?: number | null
  projectId: string | null
  conversationId: string | null
  provider?: string | null
  /** Another Flow is already open in this conversation. */
  blockedByOpenFlow?: boolean
  /** That open Flow (the note offers to jump to its bar). */
  openFlowId?: string | null
  onStarted: (flow: Flow) => void
  onCancel: () => void
}

type RepositoryLoad = { projectId: string; repositories: FlowRepositoryOption[] | null }

/** Bring an open Flow's strip into view and focus its first control (it lives above the composer). */
export function focusFlowBar(flowId: string): boolean {
  const strip = document.querySelector<HTMLElement>(`[data-testid="mission-run-strip"][data-flow-id="${CSS.escape(flowId)}"]`)
  if (!strip) return false
  strip.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  const target = strip.querySelector<HTMLElement>('[data-testid="mission-run-strip-bar"] button:not(:disabled)')
  target?.focus({ preventScroll: true })
  return true
}

export function FlowEntryCard({ idea, title, repositoryId: suggestedRepositoryId = null, ticketId = null, projectId, conversationId, provider, blockedByOpenFlow = false, openFlowId = null, onStarted, onCancel }: Props) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const ctx = useFlowContext()
  const availability = useFlowAvailability(projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // The project's repositories (null ⇒ unknown: the server triages and explains).
  const [repositoryLoad, setRepositoryLoad] = useState<RepositoryLoad | null>(null)
  const [pickedRepositoryId, setPickedRepositoryId] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    flowApi.repositories(projectId)
      .then((repositories) => { if (!cancelled) setRepositoryLoad({ projectId, repositories }) })
      .catch(() => { if (!cancelled) setRepositoryLoad({ projectId, repositories: null }) })
    return () => { cancelled = true }
  }, [projectId])

  const repositories = repositoryLoad?.projectId === projectId ? repositoryLoad.repositories : undefined
  const choice = repositories ? flowRepositoryChoice(repositories) : null
  const suggested = choice?.candidates.some((candidate) => candidate.id === suggestedRepositoryId) ? suggestedRepositoryId : null
  const selectedRepositoryId = choice?.show
    ? (choice.candidates.some((candidate) => candidate.id === pickedRepositoryId) ? pickedRepositoryId : suggested ?? choice.fallback)
    : null
  // Unknown members (the list could not load): the agent's triage still goes to the server.
  const targetRepositoryId = choice ? selectedRepositoryId : repositories === null ? suggestedRepositoryId : null
  const noGitRepository = !!choice?.show && choice.candidates.length === 0

  const missing = availability && !availability.available ? missingCapabilityKeys(availability.missing).map((key) => t(key)) : []
  const blockReason = !projectId || !conversationId
    ? t('flow.entry.blocked.noProject')
    : blockedByOpenFlow
      ? t('flow.entry.blocked.open')
      : !availability
        ? null
        : !availability.available
          ? (missing.length ? t('flow.entry.blocked.missing') : t('flow.entry.blocked.unavailable'))
          : noGitRepository
            ? t('flow.entry.repository.noGit')
            : null
  const loading = !!projectId && (!availability || repositories === undefined)
  const blockReasonId = `flow-entry-blocked-${conversationId ?? 'none'}`
  const needsRepository = !!choice?.show && !selectedRepositoryId
  const startFlow = async () => {
    if (!ctx || !projectId || !conversationId || busy || blockReason || loading || needsRepository) return
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try {
      onStarted(await ctx.start(projectId, conversationId, idea, title, targetRepositoryId, ticketId))
    } catch (err) {
      if (err instanceof FlowApiError && err.code === 'feature_unavailable') ctx.loadAvailability(projectId, true)
      setErrorCode(err instanceof FlowApiError ? err.code : null)
      setError(flowErrorMessage(t, err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      role="group"
      aria-labelledby="flow-entry-title"
      data-testid="flow-entry-card"
      className="my-1 overflow-hidden rounded-xl border border-accent-flow/30 bg-card/85 shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-accent-flow/[0.07] px-3.5 py-2">
        <Waves className="h-3.5 w-3.5 text-accent-flow" aria-hidden />
        <span id="flow-entry-title" className="text-strong text-foreground">{t('flow.entry.heading')}</span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="flex items-start gap-2 text-xs leading-5 text-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success" aria-hidden />
          <span>{t('flow.entry.body')}</span>
        </p>
        {ticketId ? (
          // An existing spec: the Flow works on it, so the card names the spec, not an idea.
          <div data-testid="flow-entry-spec" className="space-y-1 rounded-lg border border-border/40 bg-surface/40 px-3 py-2 text-xs">
            <p className="flex min-w-0 items-center gap-1.5 text-foreground">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 font-mono text-muted-foreground">{t('flow.entry.existingSpec.label', { id: ticketId })}</span>
              <span className="min-w-0 truncate font-medium" title={title ?? idea}>{title ?? idea}</span>
            </p>
            <p className="leading-5 text-muted-foreground">{t('flow.entry.existingSpec.note')}</p>
          </div>
        ) : (
          <blockquote data-testid="flow-entry-idea" className="line-clamp-4 rounded-lg border border-border/40 bg-surface/40 px-3 py-2 text-xs italic text-foreground">
            {title ? <span className="mb-0.5 block not-italic font-medium text-foreground">{title}</span> : null}
            {idea}
          </blockquote>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          {provider ? t('flow.entry.provider', { provider: providerLabel(provider) }) : t('flow.entry.providerUnknown')}
          <HelpHint topic="flowMode" variant="link" className="ml-auto" />
        </p>
        {choice?.show && choice.candidates.length > 0 && (
          <FlowRepositoryPicker
            idPrefix="flow-entry-repository"
            candidates={choice.candidates}
            selectedId={selectedRepositoryId}
            suggestedId={suggested}
            onSelect={setPickedRepositoryId}
            disabled={busy}
          />
        )}
        {blockReason && (
          <div role="note" data-testid="flow-entry-blocked" className="rounded-lg border border-accent-warning/35 bg-accent-warning/10 px-2.5 py-2 text-xs text-accent-warning">
            <p id={blockReasonId} className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />{blockReason}</p>
            {blockedByOpenFlow && openFlowId && (
              <button type="button" data-agent-interactive data-testid="flow-entry-open-flow" onClick={() => focusFlowBar(openFlowId)}
                className="mt-1 inline-flex items-center gap-1 rounded pl-5 text-label text-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50">
                {t('flow.entry.blocked.goToFlow')}
              </button>
            )}
            {missing.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-muted-foreground">
                {missing.map((label) => <li key={label}>{label}</li>)}
              </ul>
            )}
          </div>
        )}
        {error && <p role="alert" data-testid="flow-entry-error" className="text-xs text-destructive">{error}</p>}
        {errorCode === 'repository_has_no_commits' && projectId && !busy && (
          // The commit is the only missing step: Start retries on its own.
          <InitialCommitButton projectId={projectId} onCreated={() => void startFlow()} />
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" data-agent-interactive onClick={onCancel} disabled={busy} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50">
            {t('flow.entry.cancel')}
          </button>
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-entry-start"
            onClick={() => void startFlow()}
            disabled={busy || loading || !!blockReason || needsRepository}
            aria-describedby={blockReason ? blockReasonId : undefined}
            className={cn(PRIMARY_ACTION_SHAPE, 'bg-accent-flow text-background hover:bg-accent-flow/90 focus-visible:ring-accent-flow/60')}
          >
            {busy || loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            {busy ? t('flow.entry.starting') : t('flow.entry.start')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}
