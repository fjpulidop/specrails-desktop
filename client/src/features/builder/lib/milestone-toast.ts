import { formatElapsed } from './format-duration'

export type MilestoneToastEvent = 'chunk_launched' | 'checkpoint' | 'paused' | 'delivered' | 'completed'

export interface FormatMilestoneToastInput {
  projectName: string | null
  milestoneLabel: string
  event: MilestoneToastEvent
  status: string
  startedAt: string | null
  endedAt: string | null
  now: number
  railProgress?: { current: number; total: number }
  reviewCount?: number
  pauseReason?: string
}

const PREFIX = 'builder:milestoneProgress.toast'

export function formatMilestoneToast(
  input: FormatMilestoneToastInput,
  t: (key: string, params?: Record<string, unknown>) => string,
): { title: string; description: string | null } {
  const { event, railProgress, reviewCount } = input
  const params: Record<string, unknown> = {}
  let detail = ''
  if ((event === 'chunk_launched' || event === 'checkpoint') && railProgress
    && Number.isInteger(railProgress.current) && Number.isInteger(railProgress.total)
    && railProgress.current > 0 && railProgress.total >= railProgress.current) {
    detail = 'WithProgress'
    params.k = railProgress.current
    params.n = railProgress.total
  }
  if (event === 'paused' && input.pauseReason?.trim()) {
    detail = 'WithReason'
    params.reason = input.pauseReason.trim()
  }
  if (event === 'delivered' && typeof reviewCount === 'number' && Number.isInteger(reviewCount) && reviewCount >= 0) {
    detail = 'WithCount'
    params.count = reviewCount
  }
  const body = t(`${PREFIX}.events.${event}${detail}`, params)
  const milestone = t(`${PREFIX}.title`, { milestone: input.milestoneLabel, event: body })
  const project = input.projectName?.trim()
  const title = project ? t(`${PREFIX}.projectTitle`, { project, title: milestone }) : milestone
  const status = t(`${PREFIX}.statuses.${event}`)
  const start = input.startedAt ? Date.parse(input.startedAt) : NaN
  const terminal = event === 'delivered' || event === 'completed'
  const end = terminal ? (input.endedAt ? Date.parse(input.endedAt) : NaN) : input.now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { title, description: status }
  const elapsed = formatElapsed(Math.max(0, end - start))
  const description = event === 'completed'
    ? t(`${PREFIX}.completedIn`, { elapsed })
    : t(`${PREFIX}.statusElapsed`, { status, elapsed })
  return { title, description }
}
