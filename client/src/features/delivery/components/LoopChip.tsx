/**
 * Which loop produced a delivery: a compact chip with the loop's display name
 * (and an icon for built-ins) on the mission card and the rail strip. Built-in
 * names are localized; a custom loop shows its own name; an unknown/absent
 * loop reads "Loop".
 */
import { useTranslation } from 'react-i18next'
import { GitMerge, Hammer, Repeat, Wand2, Zap, type LucideIcon } from 'lucide-react'

type BuiltInLoop = 'implement' | 'sddQuick' | 'freestyle' | 'flowSpec'

const BUILT_IN_LOOPS: Record<string, { key: BuiltInLoop; Icon: LucideIcon }> = {
  'factory:implement': { key: 'implement', Icon: Hammer },
  'factory:sdd-quick-openspec': { key: 'sddQuick', Icon: Zap },
  // Legacy persisted id; resolves to Quick SDD.
  'factory:revision': { key: 'sddQuick', Icon: Zap },
  'factory:freestyle': { key: 'freestyle', Icon: Wand2 },
  'factory:flow-spec': { key: 'flowSpec', Icon: GitMerge },
}

export const FLOW_SPEC_LOOP_ID = 'factory:flow-spec'

/** The built-in loop key for an id (null for custom/unknown loops). */
export function builtInLoopKey(loopId: string | null | undefined): BuiltInLoop | null {
  return loopId ? BUILT_IN_LOOPS[loopId]?.key ?? null : null
}

/** Display name of a delivery's loop: localized built-in, the custom name, else "Loop". */
export function useLoopLabel(loopId: string | null | undefined, loopName: string | null | undefined): { label: string; Icon: LucideIcon; builtIn: boolean } {
  const { t } = useTranslation('common')
  const builtIn = loopId ? BUILT_IN_LOOPS[loopId] : undefined
  if (builtIn) return { label: t(`loopChip.${builtIn.key}`), Icon: builtIn.Icon, builtIn: true }
  const name = loopName?.trim()
  return { label: name || t('loopChip.unknown'), Icon: Repeat, builtIn: false }
}

export function LoopChip({ loopId, loopName, className = '' }: { loopId?: string | null; loopName?: string | null; className?: string }) {
  const { t } = useTranslation('common')
  const { label, Icon } = useLoopLabel(loopId, loopName)
  return (
    <span
      data-testid="loop-chip"
      data-loop-id={loopId ?? ''}
      title={t('loopChip.title', { name: label })}
      aria-label={t('loopChip.title', { name: label })}
      className={`inline-flex min-w-0 max-w-[180px] items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption text-foreground/70 ${className}`}
    >
      <Icon className="h-3 w-3 shrink-0 text-accent-primary/70" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
