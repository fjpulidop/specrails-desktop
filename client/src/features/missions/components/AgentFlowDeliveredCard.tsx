// ─── Intent delivered: the closing success card ─────────────────────────────────
// A server-authored system row (`flow-delivered`) posted the moment an Intent
// session is delivered and updated IN PLACE as its settlement advances (spec
// rewrite, Jira create). It tells the whole story in one place: the spec built,
// what it cost, how it reached the project (pull request or local merge), the
// spec rewritten from what was built, the archived OpenSpec change, the Jira
// issue — and the next steps. The run card keeps the delivery controls; this
// closes the Intent's story in the conversation. Quiet success: one colour.

import { useTranslation } from 'react-i18next'
import { CheckCircle2, ExternalLink, FileText, GitMerge, GitPullRequest, MessageCircleQuestion, Package, Ticket } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { formatUsd } from '../../../lib/format-usd'
import { formatElapsed } from '../../../lib/format-duration'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'

type SettlementStatus = 'pending' | 'done' | 'skipped' | 'failed' | null

export interface IntentDeliveredIntegration {
  kind: 'pr' | 'local'
  prUrl: string | null
  prNumber: number | null
  merged: boolean
  baseBranch: string | null
  /** The delivered commit (the Intent's frozen head), never a local merge commit. */
  sha: string | null
}

export interface IntentDeliveredRow {
  kind: 'flow-delivered'
  flowId: string
  deliveryId: string | null
  ticketId: number | null
  specTitle: string | null
  branch: string | null
  integration: IntentDeliveredIntegration | null
  prUrl: string | null
  prNumber: number | null
  changeName: string | null
  changeArchived: boolean
  specRewrite: SettlementStatus
  jiraCreate: SettlementStatus
  jiraKey: string | null
  diff: { files: number; additions: number; deletions: number } | null
  /** Provider-billed only; `unpricedTurns` are not included in `costUsd`. */
  cost: { costUsd: number; turns: number; unpricedTurns: number } | null
  durationMs: number | null
  openQuestionsAnswered: number
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const url = (value: unknown): string | null => { const s = str(value); return s && /^https?:\/\//i.test(s) ? s : null }
const status = (value: unknown): SettlementStatus =>
  value === 'pending' || value === 'done' || value === 'skipped' || value === 'failed' ? value : null

function parseIntegration(value: unknown): IntentDeliveredIntegration | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (o.kind !== 'pr' && o.kind !== 'local') return null
  return { kind: o.kind, prUrl: url(o.prUrl), prNumber: int(o.prNumber), merged: o.merged === true, baseBranch: str(o.baseBranch), sha: str(o.sha) }
}

function parseTotals(value: unknown): IntentDeliveredRow['diff'] {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const files = int(o.files); const additions = int(o.additions); const deletions = int(o.deletions)
  return files === null || additions === null || deletions === null ? null : { files, additions, deletions }
}

function parseCost(value: unknown): IntentDeliveredRow['cost'] {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.costUsd !== 'number' || !Number.isFinite(o.costUsd)) return null
  return { costUsd: o.costUsd, turns: int(o.turns) ?? 0, unpricedTurns: int(o.unpricedTurns) ?? 0 }
}

/** Parse a system row; null when it is not an Intent session closing summary. */
export function parseFlowDeliveredRow(content: string): IntentDeliveredRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'flow-delivered' || !str(o.flowId)) return null
  const prUrl = url(o.prUrl)
  const prNumber = int(o.prNumber)
  // Rows written before the success card carry only the PR fields.
  const integration = parseIntegration(o.integration) ?? (prUrl ? { kind: 'pr' as const, prUrl, prNumber, merged: false, baseBranch: null, sha: null } : null)
  return {
    kind: 'flow-delivered',
    flowId: o.flowId as string,
    deliveryId: str(o.deliveryId),
    ticketId: int(o.ticketId),
    specTitle: str(o.specTitle),
    branch: str(o.branch),
    integration,
    prUrl,
    prNumber,
    changeName: str(o.changeName),
    changeArchived: o.changeArchived === true,
    specRewrite: status(o.specRewrite),
    jiraCreate: status(o.jiraCreate),
    jiraKey: str(o.jiraKey),
    diff: parseTotals(o.diff),
    cost: parseCost(o.cost),
    durationMs: typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) && o.durationMs >= 0 ? o.durationMs : null,
    openQuestionsAnswered: Math.max(0, int(o.openQuestionsAnswered) ?? 0),
  }
}

/** Real cost words: `—` until a turn is priced; `*` marks unpriced turns (never estimated). */
function costWords(cost: IntentDeliveredRow['cost']): { text: string; partial: number } | null {
  if (!cost) return null
  const priced = cost.turns - cost.unpricedTurns
  if (priced <= 0) return cost.unpricedTurns > 0 ? { text: '—', partial: cost.unpricedTurns } : null
  return { text: `${formatUsd(cost.costUsd)}${cost.unpricedTurns > 0 ? '*' : ''}`, partial: cost.unpricedTurns }
}

type Lamp = 'done' | 'pending' | 'muted'

/** One line of the story: a lamp (dot) and its words; pending lines breathe. */
function Line({ icon: Icon, lamp, children, testId }: { icon: typeof CheckCircle2; lamp: Lamp; children: React.ReactNode; testId: string }) {
  return (
    <li
      data-testid={testId}
      data-lamp={lamp}
      className={cn('flex min-w-0 items-start gap-2 leading-4', lamp === 'done' ? 'text-foreground' : 'text-muted-foreground', lamp === 'pending' && 'motion-safe:animate-pulse')}
    >
      <span className="mt-1 flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
        <span className={cn('block h-1.5 w-1.5 rounded-full', lamp === 'done' ? 'bg-accent-success' : 'border border-muted-foreground/60')} />
      </span>
      <Icon className={cn('mt-px h-3 w-3 shrink-0', lamp === 'done' ? 'text-accent-success' : 'text-muted-foreground')} aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  )
}

const CHIP = 'inline-flex h-7 items-center gap-1.5 rounded-control border border-border/60 px-2.5 text-label text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'
const LINK = 'inline-flex items-center gap-1 font-medium text-accent-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50 rounded'

export interface AgentFlowDeliveredCardProps {
  row: IntentDeliveredRow
  /** The mission's pinned project (the spec opens there); null ⇒ the active project. */
  projectId?: string | null
  /** The conversation the "Start another intent" chip seeds. */
  conversationId?: string | null
}

export function AgentFlowDeliveredCard({ row, projectId = null }: AgentFlowDeliveredCardProps) {
  const { t } = useTranslation('agent')
  const { openTicketDetail, openTicketDetailInProject } = useTicketDetailModal()
  const ticketId = row.ticketId
  const openSpec = ticketId !== null
    ? () => (projectId ? openTicketDetailInProject(projectId, ticketId) : openTicketDetail(ticketId))
    : null

  const cost = costWords(row.cost)
  const stats: React.ReactNode[] = []
  if (row.diff && row.diff.files > 0) {
    stats.push(
      <span key="files" data-testid="agent-flow-delivered-files">
        {t('flowDelivered.files', { count: row.diff.files })}{' '}
        <span className="text-accent-success">+{row.diff.additions}</span>{' '}
        <span className="text-destructive">−{row.diff.deletions}</span>
      </span>,
    )
  }
  if (cost) stats.push(<span key="cost" data-testid="agent-flow-delivered-cost">{cost.text}</span>)
  if (row.durationMs !== null && row.durationMs > 0) stats.push(<span key="duration" data-testid="agent-flow-delivered-duration">{formatElapsed(row.durationMs)}</span>)
  if (row.branch) stats.push(<span key="branch" data-testid="agent-flow-delivered-branch" className="font-mono">{row.branch}</span>)

  const integration = row.integration
  const specPending = row.specRewrite === 'pending' || row.specRewrite === null
  const specLamp: Lamp = row.specRewrite === 'done' ? 'done' : specPending ? 'pending' : 'muted'
  const specWords = row.specRewrite === 'done'
    ? (ticketId !== null ? t('flowDelivered.specRewrittenId', { id: ticketId }) : t('flowDelivered.specRewritten'))
    : specPending ? t('flowDelivered.specRewriting') : t('flowDelivered.specKept')
  const jiraPending = row.jiraCreate === 'pending'
  const jira = row.jiraKey
    ? { lamp: 'done' as Lamp, words: t('flowDelivered.jira', { key: row.jiraKey }) }
    : jiraPending || row.jiraCreate === 'done'
      ? { lamp: 'pending' as Lamp, words: t('flowDelivered.jiraPending') }
      : null
  const settling = specPending || jiraPending

  return (
    <section
      data-testid="agent-flow-delivered-card"
      data-settled={settling ? 'false' : 'true'}
      aria-label={t('flowDelivered.title')}
      className="rounded-xl border border-accent-success/30 bg-accent-success/[0.05] px-3.5 py-3 text-xs"
    >
      <header className="flex items-start gap-2.5">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent-success" aria-hidden />
        <div className="min-w-0">
          <p className="text-caption font-medium uppercase tracking-wide text-accent-success">{t('flowDelivered.title')}</p>
          <h3 className="mt-0.5 text-body font-semibold leading-5 text-foreground break-words" data-testid="agent-flow-delivered-spec-title">
            {row.specTitle ?? t('flowDelivered.untitled')}
          </h3>
          <p className="mt-0.5 text-label leading-4 text-muted-foreground">{t('flowDelivered.subtitle')}</p>
        </div>
      </header>

      {stats.length > 0 && (
        <p data-testid="agent-flow-delivered-stats" className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-label leading-4 tabular-nums text-muted-foreground">
          {stats.map((stat, index) => (
            <span key={index} className="inline-flex items-center gap-1.5">
              {index > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
              {stat}
            </span>
          ))}
          {cost && cost.partial > 0 && <span className="sr-only">({t('flow.bar.costPartial', { count: cost.partial })})</span>}
        </p>
      )}
      {cost && cost.partial > 0 && (
        <p data-testid="agent-flow-delivered-cost-partial" className="mt-0.5 text-caption leading-4 text-muted-foreground">* {t('flow.bar.costPartial', { count: cost.partial })}</p>
      )}

      <ul className="mt-2.5 space-y-1.5 text-label">
        {integration && (
          <Line icon={integration.kind === 'pr' ? GitPullRequest : GitMerge} lamp="done" testId="agent-flow-delivered-integration">
            {integration.kind === 'pr' && integration.prUrl ? (
              <>
                {t(integration.merged ? 'flowDelivered.integratedPrMerged' : 'flowDelivered.integratedPr')}{' '}
                <a href={integration.prUrl} target="_blank" rel="noreferrer" data-agent-interactive className={LINK}>
                  {integration.prNumber !== null ? t('flowDelivered.prNumber', { number: integration.prNumber }) : t('flowDelivered.pr')}
                  <ExternalLink className="h-2.5 w-2.5 opacity-60" aria-hidden />
                </a>
              </>
            ) : (
              <>
                {t('flowDelivered.integratedLocally', { branch: integration.baseBranch ?? 'main' })}
                {integration.sha && <span className="font-mono text-muted-foreground"> · {integration.sha.slice(0, 7)}</span>}
              </>
            )}
          </Line>
        )}
        <Line icon={FileText} lamp={specLamp} testId="agent-flow-delivered-spec">
          {openSpec && row.specRewrite === 'done' ? (
            <button type="button" data-agent-interactive onClick={openSpec} className={LINK}>{specWords}</button>
          ) : specWords}
        </Line>
        {row.changeName && (
          <Line icon={Package} lamp="done" testId="agent-flow-delivered-change">
            {t(row.changeArchived ? 'flowDelivered.changeArchived' : 'flowDelivered.change', { change: row.changeName })}
          </Line>
        )}
        {jira && <Line icon={Ticket} lamp={jira.lamp} testId="agent-flow-delivered-jira">{jira.words}</Line>}
        {row.openQuestionsAnswered > 0 && (
          <Line icon={MessageCircleQuestion} lamp="done" testId="agent-flow-delivered-questions">
            {t('flowDelivered.questionsAnswered', { count: row.openQuestionsAnswered })}
          </Line>
        )}
      </ul>

      {(openSpec || integration?.prUrl) && (
        <div data-testid="agent-flow-delivered-next" className="mt-3 flex flex-wrap items-center gap-1.5">
          {openSpec && (
            <button type="button" data-agent-interactive onClick={openSpec} className={CHIP} data-testid="agent-flow-delivered-open-spec">
              <FileText className="h-3 w-3" aria-hidden />{t('flowDelivered.next.openSpec')}
            </button>
          )}
          {integration?.prUrl && (
            <a href={integration.prUrl} target="_blank" rel="noreferrer" data-agent-interactive className={CHIP} data-testid="agent-flow-delivered-view-pr">
              <GitPullRequest className="h-3 w-3" aria-hidden />{t('flowDelivered.next.viewPr')}
              <ExternalLink className="h-2.5 w-2.5 opacity-60" aria-hidden />
            </a>
          )}
        </div>
      )}
    </section>
  )
}
