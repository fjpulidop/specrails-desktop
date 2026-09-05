import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowRight, Check, Rocket, Sparkles, Wand2 } from 'lucide-react'
import { format } from 'date-fns'
import { cn } from '../../lib/utils'
import { getDateFnsLocale } from '../../lib/i18n'
import type { BuilderTurnIntent } from '../../hooks/useBuilderSession'

// Builder decision cards (premium-milestone-progress follow-up). The Builder's
// prose keeps asking the user to type "surprise me" and, later, to "approve
// the blueprint". Each ask gets ONE premium card in the thread — the same
// glass shell as AgentSpecDraftCard — in two modes:
//   • offer   — clickable, rendered after the newest settled Builder reply
//               while that decision is open; one click sends the canonical
//               prompt tagged with the intent.
//   • settled — the decision stays FIXED in the thread: the user turn that
//               carried the intent renders as this card (never the raw prompt
//               bubble), across resumes and locale switches, because the
//               intent is persisted on the message row.

interface BuilderDecisionCardProps {
  kind: BuilderTurnIntent
  mode: 'offer' | 'settled'
  onAction?: () => void
  disabled?: boolean
  createdAt?: string
  className?: string
}

const ICON: Record<BuilderTurnIntent, typeof Wand2> = { surprise: Wand2, approve: Rocket }

export function BuilderDecisionCard({ kind, mode, onAction, disabled = false, createdAt, className }: BuilderDecisionCardProps) {
  const { t } = useTranslation('builder')
  const reducedMotion = useReducedMotion()
  const settled = mode === 'settled'
  const Icon = settled ? Check : ICON[kind]
  const time = createdAt ? safeTime(createdAt) : null
  const shell = cn(
    'group relative my-1 w-full max-w-lg overflow-hidden rounded-xl border text-left shadow-lg backdrop-blur',
    settled
      ? 'border-accent-success/25 bg-card/60'
      : 'border-accent-primary/25 bg-card/80 transition-colors hover:border-accent-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-60',
    className,
  )
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent transition-opacity',
          settled
            ? 'from-accent-success/[0.06] to-accent-success/[0.03] opacity-100'
            : 'from-accent-primary/[0.08] to-accent-highlight/[0.08] opacity-70 group-hover:opacity-100',
        )}
      />
      <div
        className={cn(
          'relative flex items-center justify-between gap-2 border-b border-border/40 px-3.5 py-2',
          settled ? 'bg-accent-success/[0.05]' : 'bg-accent-primary/[0.06]',
        )}
      >
        <span
          className={cn(
            'flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest',
            settled ? 'text-accent-success/90' : 'text-accent-primary/90',
          )}
        >
          {settled ? <Check className="h-3 w-3" aria-hidden /> : <Sparkles className="h-3 w-3" aria-hidden />}
          {settled ? t('decisionCard.settledLabel') : t(`decisionCard.${kind}.label`)}
        </span>
        <span className="text-[10px] text-muted-foreground" data-testid="builder-decision-card-meta">
          {settled ? time : t(`decisionCard.${kind}.hint`)}
        </span>
      </div>
      <div className="relative flex items-center gap-3.5 px-3.5 py-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-inner',
            settled
              ? 'bg-accent-success/15 text-accent-success'
              : 'bg-gradient-to-br from-accent-primary/25 to-accent-highlight/25 text-accent-primary',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-snug text-foreground">
            {t(settled ? `decisionCard.${kind}.settledTitle` : `decisionCard.${kind}.title`)}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {t(settled ? `decisionCard.${kind}.settledDescription` : `decisionCard.${kind}.description`)}
          </span>
        </span>
        {!settled && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-primary/15 px-2.5 py-1 text-[11px] font-medium text-accent-primary transition-colors group-hover:bg-accent-primary/25">
            {t(`decisionCard.${kind}.cta`)}
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </span>
        )}
      </div>
    </>
  )

  if (settled) {
    return (
      <div className={shell} data-testid="builder-decision-card" data-kind={kind} data-mode="settled">
        {body}
      </div>
    )
  }
  return (
    <motion.button
      type="button"
      onClick={onAction}
      disabled={disabled}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      whileHover={disabled || reducedMotion ? undefined : { y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.99 }}
      className={shell}
      data-testid="builder-decision-card"
      data-kind={kind}
      data-mode="offer"
      aria-label={t(`decisionCard.${kind}.cta`)}
    >
      {body}
    </motion.button>
  )
}

function safeTime(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    return format(ms, 'p', { locale: getDateFnsLocale() })
  } catch {
    return null
  }
}
