// ─── Flow entry confirmation ──────────────────────────────────────────────────
// The ONLY door into Flow: it explains the isolated worktree, previews the
// idea, names the provider and starts the Flow on the user's explicit click.
// When the selected Core cannot run Flow, Start is disabled and the missing
// capabilities are listed in plain words. In a workspace (folder primary) or a
// project with several Git repositories it also shows WHERE the Flow runs:
// the repository the agent triaged, changeable among the Git members.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, Check, FolderGit2, GitBranch, Loader2, Play, ShieldCheck, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { useFlowAvailability, useFlowContext } from '../context/FlowContext'
import { FlowApiError, flowApi, flowRepositoryChoice, type Flow, type FlowRepositoryOption } from '../lib/flow-api'
import { missingCapabilityKeys } from '../lib/flow-offer'
import { flowErrorMessage } from '../lib/flow-failure'
import { InitialCommitButton } from '../../../components/InitialCommitButton'

interface Props {
  idea: string
  title?: string | null
  /** The repository the agent triaged the idea into (preselected when offered). */
  repositoryId?: string | null
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

/** Bring an open Flow's bar into view and focus it (it lives above the composer). */
export function focusFlowBar(flowId: string): boolean {
  const bar = document.querySelector<HTMLElement>(`[data-testid="flow-bar"][data-flow-id="${CSS.escape(flowId)}"]`)
  if (!bar) return false
  bar.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  bar.focus({ preventScroll: true })
  return true
}

export function FlowEntryCard({ idea, title, repositoryId: suggestedRepositoryId = null, projectId, conversationId, provider, blockedByOpenFlow = false, openFlowId = null, onStarted, onCancel }: Props) {
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
      onStarted(await ctx.start(projectId, conversationId, idea, title, targetRepositoryId))
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
      className="my-1 overflow-hidden rounded-xl border border-accent-info/30 bg-card/85 shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-accent-info/[0.07] px-3.5 py-2">
        <Sparkles className="h-3.5 w-3.5 text-accent-info" aria-hidden />
        <span id="flow-entry-title" className="text-[10px] font-semibold uppercase tracking-widest text-accent-info">{t('flow.entry.heading')}</span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="flex items-start gap-2 text-xs leading-5 text-foreground/80">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success" aria-hidden />
          <span>{t('flow.entry.body')}</span>
        </p>
        <blockquote data-testid="flow-entry-idea" className="line-clamp-4 border-l-2 border-accent-info/50 bg-surface/40 px-3 py-2 text-xs italic text-foreground/75">
          {title ? <span className="mb-0.5 block not-italic font-medium text-foreground/90">{title}</span> : null}
          {idea}
        </blockquote>
        <p className="flex items-center gap-1.5 text-[11px] text-foreground/55">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          {provider ? t('flow.entry.provider', { provider: providerLabel(provider) }) : t('flow.entry.providerUnknown')}
        </p>
        {choice?.show && choice.candidates.length > 0 && (
          <div data-testid="flow-entry-repository" className="space-y-1.5">
            <p id="flow-entry-repository-label" className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-foreground/55">
              <FolderGit2 className="h-3 w-3 shrink-0" aria-hidden />
              {t('flow.entry.repository.label')}
            </p>
            <div role="radiogroup" aria-labelledby="flow-entry-repository-label" aria-describedby="flow-entry-repository-hint" className="grid max-h-44 gap-1 overflow-y-auto pr-0.5">
              {choice.candidates.map((candidate) => {
                const checked = candidate.id === selectedRepositoryId
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    data-agent-interactive
                    data-testid={`flow-entry-repository-${candidate.id}`}
                    disabled={busy}
                    onClick={() => setPickedRepositoryId(candidate.id)}
                    className={cn(
                      'group flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50 disabled:opacity-50',
                      checked ? 'border-accent-info/60 bg-accent-info/10' : 'border-border/50 bg-surface/30 hover:border-accent-info/35 hover:bg-surface/60',
                    )}
                  >
                    <span aria-hidden className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border', checked ? 'border-accent-info bg-accent-info text-background' : 'border-foreground/30')}>
                      {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('truncate text-xs font-medium', checked ? 'text-foreground' : 'text-foreground/80')}>{candidate.name}</span>
                        {candidate.id === suggested && (
                          <span className="shrink-0 rounded-full bg-accent-info/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-accent-info">{t('flow.entry.repository.suggested')}</span>
                        )}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-foreground/45" title={candidate.path}>{candidate.path}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <p id="flow-entry-repository-hint" className="text-[11px] text-foreground/50">
              {selectedRepositoryId ? t('flow.entry.repository.hint') : t('flow.entry.repository.choose')}
            </p>
          </div>
        )}
        {blockReason && (
          <div role="note" data-testid="flow-entry-blocked" className="rounded-lg border border-accent-warning/35 bg-accent-warning/10 px-2.5 py-2 text-xs text-accent-warning">
            <p id={blockReasonId} className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />{blockReason}</p>
            {blockedByOpenFlow && openFlowId && (
              <button type="button" data-agent-interactive data-testid="flow-entry-open-flow" onClick={() => focusFlowBar(openFlowId)}
                className="mt-1 inline-flex items-center gap-1 rounded pl-5 text-[11px] font-medium text-foreground/75 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50">
                {t('flow.entry.blocked.goToFlow')}
              </button>
            )}
            {missing.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-foreground/70">
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
          <button type="button" data-agent-interactive onClick={onCancel} disabled={busy} className="rounded-md px-2.5 py-1 text-xs text-foreground/65 transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50">
            {t('flow.entry.cancel')}
          </button>
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-entry-start"
            onClick={() => void startFlow()}
            disabled={busy || loading || !!blockReason || needsRepository}
            aria-describedby={blockReason ? blockReasonId : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md bg-accent-info px-3 py-1 text-xs font-semibold text-background shadow transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            {busy || loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            {busy ? t('flow.entry.starting') : t('flow.entry.start')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}
