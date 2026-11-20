import type { ReactNode, Ref } from 'react'
import { cn } from '../../lib/utils'

export interface RunQuestionOptionProps {
  label: string
  /** One line under the label: what choosing it means. */
  meaning?: string | null
  /** A literal detail (a command), in monospace. */
  detail?: string | null
  /** Further lines under the meaning (a consequence, a risk). */
  extra?: ReactNode
  recommended?: boolean
  /** The "Recommended" badge text (the caller's namespace). */
  recommendedLabel: string
  /** A badge beside the label besides the recommendation (a risk level). */
  badge?: ReactNode
  disabled?: boolean
  onClick(): void
  buttonRef?: Ref<HTMLButtonElement>
  testId?: string
  optionId?: string
}

/**
 * One choice of a run question, also used for the resolution options of a
 * failed run: the label, what it means, the recommended one marked. The same
 * look wherever the person picks how a run goes on.
 */
export function RunQuestionOption({ label, meaning, detail, extra, recommended = false, recommendedLabel, badge, disabled, onClick, buttonRef, testId = 'run-question-option', optionId }: RunQuestionOptionProps) {
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid={testId}
      data-option-id={optionId}
      data-recommended={recommended || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        recommended ? 'border-accent-primary/50 bg-accent-primary/5 hover:bg-accent-primary/10' : 'border-border/60 bg-background hover:bg-accent',
      )}
    >
      <span className="flex w-full flex-wrap items-center gap-2">
        <span className="text-body font-medium text-foreground">{label}</span>
        {recommended && <span className="rounded-pill border border-accent-primary/40 px-1.5 text-caption text-accent-primary">{recommendedLabel}</span>}
        {badge}
      </span>
      {meaning && <span className="text-caption text-muted-foreground">{meaning}</span>}
      {extra}
      {detail && <code className="mt-1 block w-full whitespace-pre-wrap break-all font-mono text-caption text-muted-foreground">{detail}</code>}
    </button>
  )
}
