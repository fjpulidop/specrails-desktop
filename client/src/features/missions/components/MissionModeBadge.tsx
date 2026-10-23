// ─── An extension's mode marker (Flow: "Flow" / "In Flow") ────────────────────
// Recognition over recall: wherever the person looks — the composer, the
// mission header, the mission list — the mode is named with an icon AND text,
// in the mode's accent but never by color alone, and without tinting the
// screen. Missions renders it; the extension only names it.

import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '../../../lib/utils'
import type { MissionModeBadge as Badge } from '../context/MissionExtensionsContext'

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
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-1.5 rounded-md border border-accent-info/35 font-medium text-foreground/80',
        variant === 'composer' ? 'h-8 px-2 text-xs' : 'h-5 px-1.5 text-[11px]',
      )}
    >
      {Icon && <Icon className={cn('shrink-0 text-accent-info', variant === 'composer' ? 'h-3.5 w-3.5' : 'h-3 w-3')} aria-hidden />}
      <span>{badge.label}</span>
      {badge.description && <span className="sr-only">: {badge.description}</span>}
    </motion.span>
  )
}

/** A mission list row's mark: the icon, with the text for assistive technology and the tooltip. */
export function MissionModeRowMark({ badge }: { badge: Badge }) {
  const Icon = badge.icon
  return (
    <span className="inline-flex shrink-0 items-center text-accent-info" title={badge.description ?? badge.label} data-testid="mission-mode-row-mark">
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : <span aria-hidden className="text-[10px] font-medium">{badge.label}</span>}
      <span className="sr-only">{badge.label}</span>
    </span>
  )
}

/** The "waiting for your decision" mark of a mission list row: a dot with its words. */
export function MissionAttentionMark() {
  const { t } = useTranslation('agent')
  return (
    <span className="inline-flex shrink-0 items-center" title={t('runStrip.attention')} data-testid="mission-attention-mark">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary ring-2 ring-accent-primary/20" />
      <span className="sr-only">{t('runStrip.attention')}</span>
    </span>
  )
}
