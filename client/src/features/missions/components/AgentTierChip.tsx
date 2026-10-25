import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { Eye, Pencil, Zap, Flame } from 'lucide-react'
import type { AgentTierLevel } from '../lib/agent-api'

const TIERS: { level: AgentTierLevel; key: string; icon: typeof Eye; tone: string; bar: string }[] = [
  { level: 0, key: 'observe', icon: Eye, tone: 'text-foreground/70', bar: 'bg-accent-info' },
  { level: 1, key: 'edit', icon: Pencil, tone: 'text-accent-info', bar: 'bg-accent-info' },
  { level: 2, key: 'operate', icon: Zap, tone: 'text-accent-warning', bar: 'bg-accent-warning' },
  { level: 3, key: 'autonomous', icon: Flame, tone: 'text-accent-warning', bar: 'bg-accent-warning' },
]

interface Props {
  level: AgentTierLevel
  compact?: boolean
  onCycle: () => void
}

/** Live, Shift+Tab-cyclable cumulative tier chip (design D4). */
export function AgentTierChip({ level, onCycle, compact = false }: Props) {
  const { t } = useTranslation('agent')
  const tier = TIERS[level]
  const Icon = tier.icon
  const reduced = useReducedMotion()
  const ladder = (thin: boolean) => (
    <span className={thin ? 'flex gap-px' : 'ml-1 flex gap-0.5'} aria-hidden data-testid={thin ? 'agent-tier-ladder-compact' : undefined}>
      {TIERS.map((s) => (
        <span
          key={s.level}
          className={`${thin ? 'h-0.5 w-1' : 'h-1 w-2'} rounded-full transition-colors duration-200 ${s.level <= level ? tier.bar : 'bg-border/50'}`}
        />
      ))}
    </span>
  )

  return (
    <button
      type="button"
      onClick={onCycle}
      title={t(`tier.${tier.key}.desc`)}
      aria-label={`${t(`tier.${tier.key}.name`)} — ${t('tier.cycleHint')}`}
      className={`group flex shrink-0 items-center gap-1.5 rounded-full ${compact ? 'h-8 px-1.5 py-1' : 'border border-border/60 bg-surface/70 px-2.5 py-1'} ${compact ? 'text-sm' : 'text-xs'} font-medium ${tier.tone} transition-colors hover:bg-surface`}
      data-agent-interactive
    >
      <motion.span
        key={level}
        initial={reduced ? false : { scale: 0.8 }}
        animate={reduced ? { scale: 1 } : { scale: [1, 1.18, 1] }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className="flex items-center gap-1.5"
      >
        {/* Narrow containers drop the name: a thin 4-step ladder under the
            icon keeps the level readable without text. */}
        <span className={compact ? 'flex flex-col items-center gap-0.5' : 'contents'}>
          <Icon className="h-4 w-4" />
          {compact && <span className="@min-[640px]:hidden">{ladder(true)}</span>}
        </span>
        <span className={compact ? 'hidden @min-[640px]:inline' : undefined}>{t(`tier.${tier.key}.name`)}</span>
      </motion.span>
      {!compact && ladder(false)}
    </button>
  )
}
