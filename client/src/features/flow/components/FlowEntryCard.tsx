// ─── Flow entry confirmation ──────────────────────────────────────────────────
// The ONLY door into Flow: it explains the isolated worktree, previews the
// idea, names the provider and starts the Flow on the user's explicit click.
// When the selected Core cannot run Flow, Start is disabled and the missing
// capabilities are listed in plain words.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, GitBranch, Loader2, Play, ShieldCheck, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { useFlowAvailability, useFlowContext } from '../context/FlowContext'
import { FlowApiError, type Flow } from '../lib/flow-api'
import { missingCapabilityKeys } from '../lib/flow-offer'

interface Props {
  idea: string
  title?: string | null
  projectId: string | null
  conversationId: string | null
  provider?: string | null
  /** Another Flow is already open in this conversation. */
  blockedByOpenFlow?: boolean
  onStarted: (flow: Flow) => void
  onCancel: () => void
}

export function FlowEntryCard({ idea, title, projectId, conversationId, provider, blockedByOpenFlow = false, onStarted, onCancel }: Props) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const ctx = useFlowContext()
  const availability = useFlowAvailability(projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const missing = availability && !availability.available ? missingCapabilityKeys(availability.missing).map((key) => t(key)) : []
  const blockReason = !projectId || !conversationId
    ? t('flow.entry.blocked.noProject')
    : blockedByOpenFlow
      ? t('flow.entry.blocked.open')
      : !availability
        ? null
        : !availability.available
          ? (missing.length ? t('flow.entry.blocked.missing') : t('flow.entry.blocked.unavailable'))
          : null
  const loading = !!projectId && !availability

  const startFlow = async () => {
    if (!ctx || !projectId || !conversationId || busy || blockReason || loading) return
    setBusy(true)
    setError(null)
    try {
      onStarted(await ctx.start(projectId, conversationId, idea, title))
    } catch (err) {
      if (err instanceof FlowApiError && err.code === 'feature_unavailable') ctx.loadAvailability(projectId, true)
      setError(err instanceof FlowApiError ? t(`flow.errors.${err.code}`, { defaultValue: err.detail || err.code }) : t('flow.errors.generic'))
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
        <blockquote data-testid="flow-entry-idea" className="line-clamp-4 rounded-lg border-l-2 border-accent-info/50 bg-surface/40 px-3 py-2 text-xs italic text-foreground/75">
          {title ? <span className="mb-0.5 block not-italic font-medium text-foreground/90">{title}</span> : null}
          {idea}
        </blockquote>
        <p className="flex items-center gap-1.5 text-[11px] text-foreground/55">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          {provider ? t('flow.entry.provider', { provider: providerLabel(provider) }) : t('flow.entry.providerUnknown')}
        </p>
        {blockReason && (
          <div role="note" data-testid="flow-entry-blocked" className="rounded-lg border border-accent-warning/35 bg-accent-warning/10 px-2.5 py-2 text-xs text-accent-warning">
            <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />{blockReason}</p>
            {missing.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-foreground/70">
                {missing.map((label) => <li key={label}>{label}</li>)}
              </ul>
            )}
          </div>
        )}
        {error && <p role="alert" data-testid="flow-entry-error" className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" data-agent-interactive onClick={onCancel} disabled={busy} className="rounded-md px-2.5 py-1 text-xs text-foreground/65 transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50">
            {t('flow.entry.cancel')}
          </button>
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-entry-start"
            onClick={() => void startFlow()}
            disabled={busy || loading || !!blockReason}
            aria-describedby={blockReason ? 'flow-entry-title' : undefined}
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
