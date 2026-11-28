// ─── Mission plan pill ─────────────────────────────────────────────────────────
// The agent's plan of work and how far it got, beside Processes and Resources in
// the composer. Source: the latest silent `mission-plan` system row (server
// mission-plan.ts), written from the agent's own todo list (Claude's TodoWrite)
// or Specrails' `specrails_missions(plan)`. Hover or focus opens the steps.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Circle, ListChecks } from 'lucide-react'
import { HoverPopover } from '../../../components/ui/hover-popover'
import { cn } from '../../../lib/utils'

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'
export interface MissionPlanView { title: string | null; steps: Array<{ content: string; status: PlanStepStatus }>; at: string | null }

const STATUSES: readonly PlanStepStatus[] = ['pending', 'in_progress', 'completed']

/** The plan in a system row's content, or null when it is not one. */
export function parseMissionPlanRow(content: string): MissionPlanView | null {
  if (!content.startsWith('{') || !content.includes('"mission-plan"')) return null
  try {
    const row = JSON.parse(content) as { kind?: unknown; title?: unknown; steps?: unknown; at?: unknown }
    if (row.kind !== 'mission-plan' || !Array.isArray(row.steps)) return null
    const steps = row.steps.flatMap((raw) => {
      const step = raw && typeof raw === 'object' ? raw as { content?: unknown; status?: unknown } : null
      return step && typeof step.content === 'string' && step.content.trim()
        ? [{ content: step.content, status: STATUSES.includes(step.status as PlanStepStatus) ? step.status as PlanStepStatus : 'pending' }]
        : []
    })
    return steps.length ? { title: typeof row.title === 'string' && row.title.trim() ? row.title : null, steps, at: typeof row.at === 'string' ? row.at : null } : null
  } catch { return null }
}

/** The mission's current plan: the latest plan row among its messages. */
export function latestPlan(messages: ReadonlyArray<{ role: string; content: string }>): MissionPlanView | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'system') continue
    const plan = parseMissionPlanRow(message.content)
    if (plan) return plan
  }
  return null
}

/** A small progress ring: the share of steps done. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const share = total ? done / total : 0
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - share)}
        className={cn('transition-[stroke-dashoffset] duration-500', share === 1 ? 'stroke-accent-success' : 'stroke-accent-primary')} />
    </svg>
  )
}

function StepIcon({ status }: { status: PlanStepStatus }) {
  if (status === 'completed') {
    return <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-success/15 text-accent-success"><Check className="h-3 w-3" aria-hidden /></span>
  }
  if (status === 'in_progress') {
    return (
      <span className="relative mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent-primary/25 border-t-accent-primary motion-reduce:animate-none" />
      </span>
    )
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground [stroke-dasharray:3_3]" aria-hidden />
}

export function MissionPlanPill({ messages }: { messages: ReadonlyArray<{ role: string; content: string }> }) {
  const { t } = useTranslation('agent')
  const plan = useMemo(() => latestPlan(messages), [messages])
  if (!plan) return null
  const done = plan.steps.filter((step) => step.status === 'completed').length
  const total = plan.steps.length
  const current = plan.steps.find((step) => step.status === 'in_progress')
  return (
    <HoverPopover
      label={t('missionPlan.title')}
      description={t('missionPlan.description')}
      testId="agent-composer-plan-popover"
      width={380}
      trigger={
        <button
          type="button"
          aria-label={t('missionPlan.open', { done, total })}
          data-testid="agent-composer-plan"
          className="relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <ProgressRing done={done} total={total} />
          <span className="hidden @min-[640px]:inline">{t('missionPlan.button')}</span>
          <span className="text-caption font-medium tabular-nums">{done}/{total}</span>
        </button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="mission-plan">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{plan.title ?? t('missionPlan.title')}</p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t('missionPlan.progress', { done, total })}</span>
        </div>
        <div className="flex gap-0.5" aria-hidden>
          {plan.steps.map((step, index) => (
            <span key={index} className={cn('h-1 flex-1 rounded-full transition-colors duration-500',
              step.status === 'completed' ? (done === total ? 'bg-accent-success' : 'bg-accent-primary')
                : step.status === 'in_progress' ? 'bg-accent-primary/40' : 'bg-muted')} />
          ))}
        </div>
        <ol className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
          {plan.steps.map((step, index) => (
            <li key={`${index}:${step.content}`} className="flex items-start gap-2.5 text-sm" data-status={step.status}>
              <StepIcon status={step.status} />
              <span className={cn('min-w-0 leading-5',
                step.status === 'completed' ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                  : step.status === 'in_progress' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {step.content}
                <span className="sr-only"> · {t(`missionPlan.status.${step.status}`)}</span>
              </span>
            </li>
          ))}
        </ol>
        {current && done < total && <p className="text-xs text-muted-foreground">{t('missionPlan.now', { step: current.content })}</p>}
        {done === total && <p className="text-xs text-accent-success">{t('missionPlan.allDone')}</p>}
      </div>
    </HoverPopover>
  )
}
