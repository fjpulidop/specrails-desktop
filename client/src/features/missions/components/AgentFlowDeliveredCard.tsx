// ─── Flow delivered: the closing summary ──────────────────────────────────────
// A server-authored system row posted once when a Flow's delivery settled its
// spec and Jira (`flow-delivered`): the PR, the spec rewritten from what was
// built, the archived OpenSpec change and the Jira issue. The run card keeps
// the delivery controls; this closes the Flow's story in the conversation.

import { useTranslation } from 'react-i18next'
import { CheckCircle2, ExternalLink, FileText, GitPullRequest, Package, Ticket } from 'lucide-react'
import { cn } from '../../../lib/utils'

type SettlementStatus = 'pending' | 'done' | 'skipped' | 'failed' | null

export interface FlowDeliveredRow {
  kind: 'flow-delivered'
  flowId: string
  deliveryId: string | null
  prUrl: string | null
  prNumber: number | null
  changeName: string | null
  changeArchived: boolean
  specRewrite: SettlementStatus
  jiraCreate: SettlementStatus
  jiraKey: string | null
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const status = (value: unknown): SettlementStatus =>
  value === 'pending' || value === 'done' || value === 'skipped' || value === 'failed' ? value : null

/** Parse a system row; null when it is not a Flow closing summary. */
export function parseFlowDeliveredRow(content: string): FlowDeliveredRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'flow-delivered' || !str(o.flowId)) return null
  const prUrl = str(o.prUrl)
  return {
    kind: 'flow-delivered',
    flowId: o.flowId as string,
    deliveryId: str(o.deliveryId),
    prUrl: prUrl && /^https?:\/\//i.test(prUrl) ? prUrl : null,
    prNumber: typeof o.prNumber === 'number' && Number.isInteger(o.prNumber) ? o.prNumber : null,
    changeName: str(o.changeName),
    changeArchived: o.changeArchived === true,
    specRewrite: status(o.specRewrite),
    jiraCreate: status(o.jiraCreate),
    jiraKey: str(o.jiraKey),
  }
}

function Line({ icon: Icon, children, tone = 'default', testId }: { icon: typeof CheckCircle2; children: React.ReactNode; tone?: 'default' | 'muted'; testId: string }) {
  return (
    <li className={cn('flex min-w-0 items-start gap-1.5 leading-4', tone === 'muted' ? 'text-muted-foreground' : 'text-muted-foreground')} data-testid={testId}>
      <Icon className="mt-px h-3 w-3 shrink-0 text-accent-success" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  )
}

export function AgentFlowDeliveredCard({ row }: { row: FlowDeliveredRow }) {
  const { t } = useTranslation('agent')
  const spec = row.specRewrite === 'done' ? t('flowDelivered.specRewritten') : t('flowDelivered.specKept')
  const jira = row.jiraKey
    ? t('flowDelivered.jira', { key: row.jiraKey })
    : row.jiraCreate === 'done' ? t('flowDelivered.jiraPending') : null
  return (
    <section
      data-testid="agent-flow-delivered-card"
      aria-label={t('flowDelivered.title')}
      className="rounded-xl border border-accent-success/30 bg-accent-success/[0.05] px-3 py-2 text-xs"
    >
      <p className="flex items-center gap-2 font-medium text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-success" aria-hidden />
        {t('flowDelivered.title')}
      </p>
      <ul className="mt-1.5 space-y-1 text-caption">
        {row.prUrl && (
          <Line icon={GitPullRequest} testId="agent-flow-delivered-pr">
            <a href={row.prUrl} target="_blank" rel="noreferrer" data-agent-interactive
              className="inline-flex items-center gap-1 font-medium text-accent-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50 rounded">
              {row.prNumber !== null ? t('flowDelivered.prNumber', { number: row.prNumber }) : t('flowDelivered.pr')}
              <ExternalLink className="h-2.5 w-2.5 opacity-60" aria-hidden />
            </a>
          </Line>
        )}
        <Line icon={FileText} tone={row.specRewrite === 'done' ? 'default' : 'muted'} testId="agent-flow-delivered-spec">{spec}</Line>
        {row.changeName && (
          <Line icon={Package} testId="agent-flow-delivered-change">
            {t(row.changeArchived ? 'flowDelivered.changeArchived' : 'flowDelivered.change', { change: row.changeName })}
          </Line>
        )}
        {jira && <Line icon={Ticket} testId="agent-flow-delivered-jira">{jira}</Line>}
      </ul>
    </section>
  )
}
