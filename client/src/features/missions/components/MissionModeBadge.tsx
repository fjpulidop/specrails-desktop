// ─── An extension's mode marker (Flow: "Flow" / "In Flow") ────────────────────
// Recognition over recall: wherever the person looks — the composer, the
// mission header, the mission list — the mode is named with an icon AND text,
// in the mode's own accent (the badge's `accent`, Flow: --color-accent-flow)
// but never by color alone, and without tinting the screen. Missions renders
// it; the extension only names it.

import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { modeAccent, type MissionModeBadge as Badge } from '../context/MissionExtensionsContext'

export function MissionModeBadge({ badge, variant, testId }: { badge: Badge; variant: 'composer' | 'header'; testId?: string }) {
  const reduced = useReducedMotion()
  const Icon = badge.icon
  return (
    <motion.span
      initial={reduced ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      data-testid={testId ?? `mission-mode-badge-${variant}`}
      title={badge.description}
      style={{ '--mode-accent': modeAccent(badge), borderColor: `color-mix(in oklab, ${modeAccent(badge)} 40%, transparent)` } as CSSProperties}
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-1.5 rounded-md border font-medium text-foreground',
        // A compact pill may stay 11px (strong contrast); text elsewhere is 12px.
        variant === 'composer' ? 'h-8 px-2 text-xs' : 'h-5 px-1.5 text-caption',
      )}
    >
      {Icon && <Icon className={cn('shrink-0 text-[color:var(--mode-accent)]', variant === 'composer' ? 'h-3.5 w-3.5' : 'h-3 w-3')} aria-hidden />}
      <span>{badge.label}</span>
      {badge.description && <span className="sr-only">: {badge.description}</span>}
    </motion.span>
  )
}

/** A mission list row's mark: the icon, with the text for assistive technology and the tooltip. */
export function MissionModeRowMark({ badge }: { badge: Badge }) {
  const Icon = badge.icon
  return (
    <span className="inline-flex shrink-0 items-center" style={{ color: modeAccent(badge) }} title={badge.description ?? badge.label} data-testid="mission-mode-row-mark">
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : <span aria-hidden className="text-caption font-medium">{badge.label}</span>}
      <span className="sr-only">{badge.label}</span>
    </span>
  )
}

/** A mission list row's attention mark with its words — a waiting decision
 *  (a dot: "Waiting for your decision") or a failed run (a warning triangle:
 *  "Needs attention: a run failed"), told apart by shape, never by color alone. */
export function MissionAttentionMark({ kind = 'decision' }: { kind?: 'decision' | 'failed' }) {
  const { t } = useTranslation('agent')
  const words = kind === 'failed' ? t('runStrip.attention.failed') : t('runStrip.decision.generic')
  return (
    <span className="inline-flex shrink-0 items-center leading-none" title={words} data-testid="mission-attention-mark" data-kind={kind}>
      {kind === 'failed'
        ? <AlertTriangle aria-hidden className="h-3 w-3 text-destructive" />
        : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary ring-2 ring-accent-primary/20" />}
      <span className="sr-only">{words}</span>
    </span>
  )
}
