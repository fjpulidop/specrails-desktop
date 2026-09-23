import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { Loader2, Sparkles, Wrench } from 'lucide-react'
import type { BuilderSnapshotState } from '../../hooks/useBuilderSession'

// Live generation feedback (harden-project-builder-snapshots). While the M1
// batch streams in, the raw JSON is hidden by the tail cut — so for up to a
// minute the user used to stare at a static "Thinking…" chip. This surfaces
// what is actually happening: "Writing the Milestone-1 specs… spec 5" with a
// soft progress bar (specs started ÷ the batch cap, never claiming 100% until
// the block closes), and the repair phase when the app re-asks for a block.

interface BuilderGenerationProgressProps {
  specsStarted: number
  snapshot: BuilderSnapshotState
  /** Batch cap used for the bar (M1 = 10). */
  maxSpecs?: number
}

export function BuilderGenerationProgress({ specsStarted, snapshot, maxSpecs = 10 }: BuilderGenerationProgressProps) {
  const { t } = useTranslation('builder')
  const repairing = snapshot.status === 'repairing'
  const generation = snapshot.status === 'generating' ? snapshot.generation : null
  // Batched generation (premium-milestone-progress D7): the phase descriptor
  // gives a REAL ratio (specs written ÷ total) instead of the streaming guess.
  const generationRatio = generation && generation.total > 0
    ? generation.phase === 'audit'
      ? 0.95
      : Math.min(0.95, Math.max(0.06, Math.max(0, generation.from - 1) / generation.total))
    : null
  const ratio = generationRatio ?? Math.min(0.95, Math.max(0.06, specsStarted / maxSpecs))
  const Icon = repairing ? Wrench : Sparkles
  const label = repairing
    ? t(`snapshot.repairing.${snapshot.kind}`)
    : generation
      ? t(`generation.phase.${generation.phase}`, { from: generation.from, to: generation.to, total: generation.total })
      : t('generation.writing')

  return (
    <div
      className="inline-flex max-w-full flex-col gap-1.5 rounded-xl border border-border/50 bg-surface/60 px-3 py-2 text-xs text-foreground/80"
      data-testid="builder-generation-progress"
      data-phase={repairing ? 'repairing' : generation ? `generation-${generation.phase}` : 'generating'}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent-info" aria-hidden />
        <Icon className="h-3 w-3 shrink-0 text-accent-primary" aria-hidden />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="font-medium"
          >
            {label}
          </motion.span>
        </AnimatePresence>
        {generation && generation.totalTurns > 0 && (
          <span className="rounded-full bg-muted/60 px-2 py-px font-mono text-[10px] text-muted-foreground" data-testid="builder-generation-turn">
            {t('generation.turn', { turn: generation.turn, total: generation.totalTurns })}
          </span>
        )}
        {specsStarted > 0 && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={specsStarted}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.14 }}
              className="rounded-full bg-accent-primary/10 px-2 py-px font-mono text-[10px] text-accent-primary"
              data-testid="builder-generation-count"
            >
              {t('generation.specCount', { n: specsStarted })}
            </motion.span>
          </AnimatePresence>
        )}
      </div>
      <div className="h-1 w-56 max-w-full overflow-hidden rounded-full bg-border/40" aria-hidden>
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-accent-primary/70 to-accent-highlight/80"
          initial={{ width: '6%' }}
          animate={{ width: `${Math.round(ratio * 100)}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  )
}
