/**
 * Hand-off export: builds the model from a spec's history and renders it.
 *
 * Effects stay out: the caller injects the diff reader (git) and the set of
 * plan-billed providers (known to the client's subscription snapshot), so this
 * file is a deterministic function of its inputs and easy to test.
 */
import { redactProse } from '../../audit'
import { readSpecAddenda } from './spec-addenda-core'
import type { Ticket } from './ticket-store'
import type { DeliveryFact, SpecHistory } from './spec-history'
import {
  redactModel,
  renderHandoffHtml,
  renderHandoffMarkdown,
  summarizeCost,
  type HandoffDecision,
  type HandoffDelivery,
  type HandoffFile,
  type HandoffModel,
  type HandoffVariant,
} from '../domain/handoff'
import { utc } from '../domain/timeline'
import { handoffLabels, resolveHandoffLocale } from '../domain/handoff-labels'

export type HandoffFormat = 'md' | 'html' | 'pr'

export interface DeliveryDiffStat {
  files: number
  additions: number
  deletions: number
  top: HandoffFile[]
}

export interface HandoffInputs {
  ticket: Pick<Ticket, 'id' | 'title' | 'description' | 'status' | 'priority' | 'labels' | 'short_summary' | 'nonGoals' | 'jira_key' | 'addenda'>
  history: SpecHistory
  /** Providers billed through a plan: their cost is shown as turns, never dollars. */
  planProviders: ReadonlySet<string>
  /** Diff stats of one delivery, or null when git cannot answer any more. */
  diffFor: (delivery: DeliveryFact) => Promise<DeliveryDiffStat | null>
  now: Date
}

export interface HandoffExport {
  format: HandoffFormat
  filename: string
  contentType: string
  body: string
  /** Strings the redactor changed. */
  redactions: number
  locale: string
}

const OPEN_DELIVERY_DECISIONS = new Set(['merged', 'completed', 'discarded', 'superseded', 'no_changes'])

function verdictOf(d: DeliveryFact): 'approved' | 'changes_requested' | 'failed' | 'recorded' | null {
  const r = d.review
  if (!r) return null
  if (r.approved === true) return 'approved'
  if (r.approved === false) return 'changes_requested'
  if (r.sentinel === 'fail') return 'failed'
  return 'recorded'
}

export async function buildHandoffModel(input: HandoffInputs): Promise<HandoffModel> {
  const { ticket, history } = input
  const addenda = readSpecAddenda(ticket.addenda)

  const decisions: HandoffDecision[] = addenda
    .filter((a) => a.status !== 'dismissed')
    .map((a) => ({ kind: a.kind, at: utc(a.created_at), title: a.title, body: a.body, status: a.status }))
  for (const d of history.deliveries) {
    const verdict = verdictOf(d)
    if (!d.review || !verdict) continue
    decisions.push({ kind: 'verdict', at: d.review.harvestedAt, title: `${verdict}${d.review.findings.length > 0 ? ` (${d.review.findings.length})` : ''}`, body: d.review.summary ?? d.review.sentinelDetail, status: verdict })
  }
  decisions.sort((a, b) => (a.at < b.at ? -1 : 1))

  const deliveries: HandoffDelivery[] = []
  for (const d of history.deliveries) {
    const stat = await input.diffFor(d).catch(() => null)
    const verdict = verdictOf(d)
    deliveries.push({
      id: d.id, loop: d.loopName, decision: d.decision, branch: d.branch, base: d.baseBranch, prNumber: d.prNumber, prUrl: d.prUrl,
      createdAt: d.createdAt, mergedAt: d.mergedAt,
      diff: stat ? { available: true, ...stat } : { available: false },
      review: d.review && verdict ? { verdict, findings: d.review.findings.length } : null,
    })
  }

  const unresolvedFindings = history.deliveries
    .filter((d) => d.review && d.review.findings.length > 0 && !OPEN_DELIVERY_DECISIONS.has(d.decision))
    .flatMap((d) => d.review!.findings.map((f) => ({ text: f.text, location: f.location, deliveryId: d.id })))

  return {
    generatedAt: input.now.toISOString(),
    spec: {
      id: ticket.id, title: ticket.title, status: ticket.status, priority: ticket.priority, labels: ticket.labels ?? [],
      summary: ticket.short_summary, description: ticket.description ?? '',
      nonGoals: ticket.nonGoals && ticket.nonGoals.length > 0 ? ticket.nonGoals.map((g) => `- ${g}`).join('\n') : null,
      jiraKey: ticket.jira_key ?? null,
    },
    decisions,
    deliveries,
    cost: summarizeCost(history.invocations.map((i) => ({ provider: i.provider, costUsd: i.costUsd, estimated: i.estimated, turns: i.turns })), input.planProviders),
    followUps: {
      openAddenda: addenda.filter((a) => a.status === 'open' || a.status === 'in_flight').map((a) => ({ title: a.title, kind: a.kind, status: a.status })),
      unresolvedFindings,
    },
  }
}

/** Redact, localize and render. The finished document is redacted once more (idempotent). */
export function renderHandoff(model: HandoffModel, format: HandoffFormat, localeInput: unknown): HandoffExport {
  const locale = resolveHandoffLocale(localeInput)
  const labels = handoffLabels(locale)
  const { model: clean, redactions } = redactModel(model, redactProse)
  const variant: HandoffVariant = format === 'pr' ? 'pr' : 'full'
  const rendered = format === 'html' ? renderHandoffHtml(clean, labels, locale) : renderHandoffMarkdown(clean, labels, variant)
  const body = redactProse(rendered)
  const slug = `spec-${model.spec.id}-handoff`
  return {
    format,
    filename: format === 'html' ? `${slug}.html` : format === 'pr' ? `spec-${model.spec.id}-pr-description.md` : `${slug}.md`,
    contentType: format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    body,
    redactions,
    locale,
  }
}

export function parseHandoffFormat(raw: unknown): HandoffFormat | null {
  if (raw === undefined || raw === '') return 'md'
  return raw === 'md' || raw === 'html' || raw === 'pr' ? raw : null
}

export function parsePlanProviders(raw: unknown): Set<string> {
  if (typeof raw !== 'string') return new Set()
  return new Set(raw.split(',').map((p) => p.trim()).filter((p) => /^[a-z0-9._-]{1,40}$/i.test(p)))
}
