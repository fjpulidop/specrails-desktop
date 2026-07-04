import type { ReactNode } from 'react'
import { Ticket, Briefcase, Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { AgentRefTarget } from '../../lib/agent-refs'

interface Props {
  refTarget: AgentRefTarget
  /** Opens the ref against its owning project (the caller binds the scope). */
  onOpen: (ref: AgentRefTarget) => void
  /** Chip text — the consumed ref text (`#3 — Title` / shortened job id). */
  children?: ReactNode
}

/**
 * Inline reference chip for agent-chat messages and the PR-decision card:
 * ticket refs (`accent-primary`, board TicketDetailModal), job/loop-run ids
 * (`accent-info`, mission-mode JobDetailModal) and loop-definition ids
 * (`accent-highlight`, read-only LoopPreviewModal). Semantic tokens only —
 * theme safe; hover lift consistent with the JobTicketHeader chips.
 */
export function AgentRefChip({ refTarget, onOpen, children }: Props) {
  const { t } = useTranslation('agent')
  const label =
    refTarget.kind === 'ticket'
      ? t('refs.openTicket', { id: refTarget.ticketId })
      : refTarget.kind === 'loop'
        ? t('refs.openLoop', { id: refTarget.loopId })
        : t('refs.openJob', { id: refTarget.jobId.slice(0, 8) })
  const Icon =
    refTarget.kind === 'ticket' ? Ticket : refTarget.kind === 'loop' ? Repeat : Briefcase
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid="agent-ref-chip"
      data-ref-kind={refTarget.kind}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(refTarget)
      }}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-1.5 align-baseline font-mono text-[0.82em] leading-[1.45] transition-all',
        'hover:-translate-y-px hover:shadow-sm',
        refTarget.kind === 'ticket'
          ? 'border-accent-primary/35 bg-accent-primary/10 text-accent-primary hover:border-accent-primary/60 hover:bg-accent-primary/15'
          : refTarget.kind === 'loop'
            ? 'border-accent-highlight/35 bg-accent-highlight/10 text-accent-highlight hover:border-accent-highlight/60 hover:bg-accent-highlight/15'
            : 'border-accent-info/35 bg-accent-info/10 text-accent-info hover:border-accent-info/60 hover:bg-accent-info/15',
      )}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70" />
      <span className="max-w-[280px] truncate">{children}</span>
    </button>
  )
}
