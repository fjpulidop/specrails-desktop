import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Eye, Pencil, Zap, Flame } from 'lucide-react'
import type { AgentTierLevel } from '../../lib/agent-api'

const TIERS: { level: AgentTierLevel; key: string; icon: typeof Eye; tone: string; bar: string }[] = [
  { level: 0, key: 'observe', icon: Eye, tone: 'text-foreground/70', bar: 'bg-accent-info' },
  { level: 1, key: 'edit', icon: Pencil, tone: 'text-accent-info', bar: 'bg-accent-info' },
  { level: 2, key: 'operate', icon: Zap, tone: 'text-accent-warning', bar: 'bg-accent-warning' },
  { level: 3, key: 'autonomous', icon: Flame, tone: 'text-destructive', bar: 'bg-destructive' },
]

interface Props {
  level: AgentTierLevel
  onCycle: () => void
}

/** Live, Shift+Tab-cyclable cumulative tier chip (design D4). */
export function AgentTierChip({ level, onCycle }: Props) {
  const { t } = useTranslation('agent')
  const tier = TIERS[level]
  const Icon = tier.icon

  return (
    <button
      type="button"
      onClick={onCycle}
      title={t(`tier.${tier.key}.desc`)}
      aria-label={`${t(`tier.${tier.key}.name`)} — ${t('tier.cycleHint')}`}
      className={`group flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/70 px-2.5 py-1 text-xs font-medium ${tier.tone} transition-colors hover:bg-surface`}
      data-agent-interactive
    >
      <motion.span
        key={level}
        initial={{ scale: 0.8 }}
        animate={{ scale: [1, 1.18, 1] }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className="flex items-center gap-1.5"
      >
        <Icon className="h-3.5 w-3.5" />
        {t(`tier.${tier.key}.name`)}
      </motion.span>
      <span className="ml-1 flex gap-0.5" aria-hidden>
        {TIERS.map((s) => (
          <span
            key={s.level}
            className={`h-1 w-2 rounded-full transition-colors duration-200 ${s.level <= level ? tier.bar : 'bg-border/50'}`}
          />
        ))}
      </span>
    </button>
  )
}
