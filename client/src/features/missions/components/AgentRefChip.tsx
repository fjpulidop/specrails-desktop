import type { ReactNode } from 'react'
import { Ticket, Briefcase, Repeat, GitPullRequest } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { AgentRefTarget } from '../lib/agent-refs'

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
/**
 * `#3 — Title` / `a1b2c3d4` → the id in monospace, the human title in the UI sans.
 * Non-string children render unchanged.
 */
export function splitRefText(visible: string, children: ReactNode): ReactNode {
  if (!visible) return children
  const m = /^(#?[\w-]+)(\s+—\s+)(.+)$/.exec(visible)
  if (!m) return <span className="font-mono">{visible}</span>
  return (
    <>
      <span className="font-mono">{m[1]}</span>
      {m[2]}
      {m[3]}
    </>
  )
}

export function AgentRefChip({ refTarget, onOpen, children }: Props) {
  const { t } = useTranslation('agent')
  const label =
    refTarget.kind === 'ticket'
      ? t('refs.openTicket', { id: refTarget.ticketId })
      : refTarget.kind === 'pull-request'
        ? t('refs.openPullRequest', { id: refTarget.prNumber })
      : refTarget.kind === 'loop'
        ? t('refs.openLoop', { id: refTarget.loopId })
        : t('refs.openJob', { id: refTarget.jobId.slice(0, 8) })
  // Accessible name = visible text + the action (WCAG 2.5.3); the tooltip shows
  // the full visible text because the chip truncates long spec titles.
  const visible = typeof children === 'string' || typeof children === 'number' ? String(children) : ''
  const name = visible ? `${visible} — ${label}` : label
  const Icon =
    refTarget.kind === 'ticket'
      ? Ticket
      : refTarget.kind === 'pull-request'
        ? GitPullRequest
        : refTarget.kind === 'loop'
          ? Repeat
          : Briefcase
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
      title={name}
      aria-label={name}
      className={cn(
        // Caption role (the 11 px floor); monospace is reserved for the id span below.
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-1.5 align-baseline text-caption leading-[1.45] transition-all',
        'hover:-translate-y-px hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
        refTarget.kind === 'ticket'
          ? 'border-accent-primary/35 bg-accent-primary/10 text-accent-primary hover:border-accent-primary/60 hover:bg-accent-primary/15'
          : refTarget.kind === 'pull-request'
            ? 'border-accent-success/35 bg-accent-success/10 text-accent-success hover:border-accent-success/60 hover:bg-accent-success/15'
          : refTarget.kind === 'loop'
            ? 'border-accent-highlight/35 bg-accent-highlight/10 text-accent-highlight hover:border-accent-highlight/60 hover:bg-accent-highlight/15'
            : 'border-accent-info/35 bg-accent-info/10 text-accent-info hover:border-accent-info/60 hover:bg-accent-info/15',
      )}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70" />
      <span className="max-w-[280px] truncate">{splitRefText(visible, children)}</span>
    </button>
  )
}
