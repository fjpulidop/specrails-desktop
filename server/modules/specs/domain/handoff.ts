/**
 * Hand-off export: pure model and renderers.
 *
 * The runtime adapter gathers facts (spec, deliveries, diff stats, ledger rows)
 * and hands them over as a `HandoffModel`. This file owns the rules that make
 * the document honest:
 *  - cost shows provider-reported ("billed") and pricing-table ("estimated")
 *    amounts separately and never adds them; a provider on a plan shows turns,
 *    not dollars; a run with no reported cost is counted, not priced at zero;
 *  - every string is passed through the injected redactor before rendering, and
 *    the finished document once more (the redactor is idempotent);
 *  - the HTML bundle is self-contained (inline style, no scripts, no remote
 *    resources) and escapes every interpolated value.
 */
import type { HandoffLabels } from './handoff-labels'

export interface HandoffSpec {
  id: number
  title: string
  status: string
  priority: string | null
  labels: string[]
  summary: string | null
  description: string
  nonGoals: string | null
  jiraKey: string | null
}

export interface HandoffDecision {
  kind: 'change-request' | 'review-feedback' | 'clarification' | 'constraint' | 'verdict'
  at: string
  title: string
  body: string | null
  status: string | null
}

export interface HandoffFile { path: string; status: string; additions: number | null; deletions: number | null }

export interface HandoffDelivery {
  id: string
  loop: string
  decision: string
  branch: string | null
  base: string
  prNumber: number | null
  prUrl: string | null
  createdAt: string
  mergedAt: string | null
  diff: { available: false } | { available: true; files: number; additions: number; deletions: number; top: HandoffFile[] }
  review: { verdict: 'approved' | 'changes_requested' | 'failed' | 'recorded'; findings: number } | null
}

export interface HandoffCostRow {
  provider: string | null
  costUsd: number | null
  estimated: boolean
  turns: number | null
}

export interface HandoffProviderCost {
  provider: string
  runs: number
  /** `turns` for a plan-billed provider: no dollar figure is carried at all. */
  mode: 'dollars' | 'turns'
  billedUsd: number | null
  estimatedUsd: number | null
  unpricedRuns: number
  turns: number | null
}

export interface HandoffFollowUps {
  openAddenda: Array<{ title: string; kind: string; status: string }>
  unresolvedFindings: Array<{ text: string; location: string | null; deliveryId: string }>
}

export interface HandoffModel {
  generatedAt: string
  spec: HandoffSpec
  decisions: HandoffDecision[]
  deliveries: HandoffDelivery[]
  cost: HandoffProviderCost[]
  followUps: HandoffFollowUps
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export function summarizeCost(rows: readonly HandoffCostRow[], planProviders: ReadonlySet<string>): HandoffProviderCost[] {
  const by = new Map<string, HandoffProviderCost>()
  for (const row of rows) {
    const provider = row.provider ?? 'unknown'
    let entry = by.get(provider)
    if (!entry) {
      entry = { provider, runs: 0, mode: planProviders.has(provider) ? 'turns' : 'dollars', billedUsd: null, estimatedUsd: null, unpricedRuns: 0, turns: null }
      by.set(provider, entry)
    }
    entry.runs += 1
    if (row.turns !== null) entry.turns = (entry.turns ?? 0) + row.turns
    if (entry.mode === 'turns') continue
    if (row.costUsd === null) { entry.unpricedRuns += 1; continue }
    if (row.estimated) entry.estimatedUsd = (entry.estimatedUsd ?? 0) + row.costUsd
    else entry.billedUsd = (entry.billedUsd ?? 0) + row.costUsd
  }
  return [...by.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1))
}

// ─── Redaction ───────────────────────────────────────────────────────────────

export type Redactor = (text: string) => string

/** Redact every string of the model. Returns the clean model and how many strings changed. */
export function redactModel(model: HandoffModel, redact: Redactor): { model: HandoffModel; redactions: number } {
  let redactions = 0
  const walk = <T>(value: T): T => {
    if (typeof value === 'string') {
      const next = redact(value)
      if (next !== value) redactions += 1
      return next as T
    }
    if (Array.isArray(value)) return value.map(walk) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)])) as T
    }
    return value
  }
  return { model: walk(model), redactions }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function usd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`
}

function day(iso: string): string {
  return iso.slice(0, 10)
}

function verdictLabel(l: HandoffLabels, verdict: 'approved' | 'changes_requested' | 'failed' | 'recorded'): string {
  return verdict === 'approved' ? l.verdictApproved : verdict === 'changes_requested' ? l.verdictChangesRequested : verdict === 'failed' ? l.verdictFailed : l.verdictRecorded
}

function decisionLabel(l: HandoffLabels, kind: HandoffDecision['kind']): string {
  switch (kind) {
    case 'change-request': return l.decisionAddendum
    case 'clarification': return l.decisionClarification
    case 'constraint': return l.decisionConstraint
    case 'review-feedback': return l.decisionReview
    default: return l.decisionVerdict
  }
}

function costLines(l: HandoffLabels, cost: readonly HandoffProviderCost[]): string[] {
  const lines: string[] = []
  for (const c of cost) {
    if (c.mode === 'turns') {
      lines.push(`${c.provider}: ${c.turns ?? 0} ${l.turns} · ${c.runs} ${l.runs} (${l.planNote})`)
      continue
    }
    const parts: string[] = []
    if (c.billedUsd !== null) parts.push(`${l.billed}: ${usd(c.billedUsd)}`)
    if (c.estimatedUsd !== null) parts.push(`${l.estimated}: ~${usd(c.estimatedUsd)}`)
    if (c.unpricedRuns > 0) parts.push(`${c.unpricedRuns} ${l.unpricedNote}`)
    if (c.turns !== null) parts.push(`${c.turns} ${l.turns}`)
    lines.push(`${c.provider} (${c.runs} ${l.runs}): ${parts.join(' · ') || '—'}`)
  }
  return lines
}

function diffLine(l: HandoffLabels, d: HandoffDelivery): string {
  if (!d.diff.available) return l.diffUnavailable
  return `${d.diff.files} ${l.files} · +${d.diff.additions} / −${d.diff.deletions}`
}

function deliveryHead(l: HandoffLabels, d: HandoffDelivery): string {
  const bits = [d.loop || d.id]
  if (d.prNumber) bits.push(`${l.pr} #${d.prNumber}`)
  if (d.branch) bits.push(`${l.branch} \`${d.branch}\``)
  return bits.join(' · ')
}

function fence(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

// ─── Markdown ────────────────────────────────────────────────────────────────

export type HandoffVariant = 'full' | 'pr'

export function renderHandoffMarkdown(model: HandoffModel, l: HandoffLabels, variant: HandoffVariant): string {
  const { spec } = model
  const out: string[] = []

  if (variant === 'full') {
    out.push(`# ${l.document}: #${spec.id} ${spec.title}`, '')
    const meta = [`${l.status}: ${spec.status}`]
    if (spec.priority) meta.push(`${l.priority}: ${spec.priority}`)
    if (spec.jiraKey) meta.push(spec.jiraKey)
    if (spec.labels.length > 0) meta.push(`${l.labels}: ${spec.labels.join(', ')}`)
    out.push(meta.join(' · '), '')
  }

  out.push(`## ${l.summary}`, '')
  out.push(spec.summary ? fence(spec.summary) : fence(spec.description).split('\n').slice(0, variant === 'pr' ? 6 : 12).join('\n'), '')
  if (variant === 'full') {
    out.push(`## ${l.request}`, '', fence(spec.description) || '—', '')
    if (spec.nonGoals) out.push(`**${l.outOfScope}**`, '', fence(spec.nonGoals), '')
  }

  out.push(`## ${l.changes}`, '')
  if (model.deliveries.length === 0) out.push(l.noChanges, '')
  for (const d of model.deliveries.slice(0, variant === 'pr' ? 3 : 20)) {
    out.push(`- **${deliveryHead(l, d)}** — ${diffLine(l, d)}${d.prUrl ? ` — ${d.prUrl}` : ''}`)
    if (variant === 'full' && d.diff.available) {
      for (const f of d.diff.top) out.push(`  - \`${f.path}\` (${f.status}${f.additions !== null ? `, +${f.additions}/−${f.deletions ?? 0}` : ''})`)
    }
  }
  if (model.deliveries.length > 0) out.push('')

  const decisions = variant === 'pr' ? model.decisions.slice(0, 5) : model.decisions
  out.push(`## ${l.decisions}`, '')
  if (decisions.length === 0) out.push(l.noDecisions, '')
  for (const d of decisions) {
    const head = `- **${decisionLabel(l, d.kind)}** (${day(d.at)}): ${d.title}`
    out.push(head)
    if (variant === 'full' && d.body) for (const line of fence(d.body).split('\n').slice(0, 8)) out.push(`  > ${line}`)
  }
  if (decisions.length > 0) out.push('')

  const review = model.deliveries.find((d) => d.review)?.review ?? null
  out.push(`## ${l.verification}`, '')
  out.push(review ? `${verdictLabel(l, review.verdict)}${review.findings > 0 ? ` · ${review.findings}` : ''}` : l.noReview, '')

  out.push(`## ${l.cost}`, '')
  const costs = costLines(l, model.cost)
  if (costs.length === 0) out.push(l.noCost)
  for (const line of costs) out.push(`- ${line}`)
  out.push('')

  out.push(`## ${l.followUps}`, '')
  const { openAddenda, unresolvedFindings } = model.followUps
  if (openAddenda.length === 0 && unresolvedFindings.length === 0) out.push(l.noFollowUps)
  if (openAddenda.length > 0) {
    out.push(`**${l.openAddenda}**`)
    for (const a of openAddenda) out.push(`- [ ] ${a.title} (${a.kind}, ${a.status})`)
  }
  if (unresolvedFindings.length > 0) {
    out.push(`**${l.unresolvedFindings}**`)
    for (const f of unresolvedFindings.slice(0, variant === 'pr' ? 8 : 40)) out.push(`- [ ] ${f.text}${f.location ? ` (\`${f.location}\`)` : ''}`)
  }
  out.push('', '---', `${l.attribution} · ${l.generated} ${day(model.generatedAt)}`, '')
  return out.join('\n')
}

// ─── HTML ────────────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const HTML_STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1d21;--muted:#5d6068;--line:#dcdde2;--card:#f6f6f8;--ok:#1f7a3d;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#ececef;--muted:#a0a3ab;--line:#2d2f35;--card:#1d1e22;--ok:#58c07a;--warn:#e0a24a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .5rem}h2{font-size:1.05rem;margin:2rem 0 .6rem;padding-top:1rem;border-top:1px solid var(--line)}
.meta{color:var(--muted);font-size:.85rem}pre.spec{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;font:inherit}
ul{padding-left:1.2rem}li{margin:.25rem 0}blockquote{margin:.25rem 0 .5rem;padding-left:.75rem;border-left:3px solid var(--line);color:var(--muted)}
code{background:var(--card);padding:.05rem .3rem;border-radius:4px;font-size:.85em}.ok{color:var(--ok)}.warn{color:var(--warn)}footer{margin-top:3rem;color:var(--muted);font-size:.8rem}
@media print{body{font-size:12px}}
`.replace(/\n/g, '')

export function renderHandoffHtml(model: HandoffModel, l: HandoffLabels, locale: string): string {
  const e = escapeHtml
  const { spec } = model
  const body: string[] = []
  body.push(`<h1>${e(l.document)}: #${spec.id} ${e(spec.title)}</h1>`)
  const meta = [`${e(l.status)}: ${e(spec.status)}`]
  if (spec.priority) meta.push(`${e(l.priority)}: ${e(spec.priority)}`)
  if (spec.jiraKey) meta.push(e(spec.jiraKey))
  if (spec.labels.length > 0) meta.push(`${e(l.labels)}: ${e(spec.labels.join(', '))}`)
  body.push(`<p class="meta">${meta.join(' · ')}</p>`)
  if (spec.summary) body.push(`<h2>${e(l.summary)}</h2><p>${e(spec.summary)}</p>`)
  body.push(`<h2>${e(l.request)}</h2><pre class="spec">${e(fence(spec.description) || '—')}</pre>`)
  if (spec.nonGoals) body.push(`<p><strong>${e(l.outOfScope)}</strong></p><pre class="spec">${e(fence(spec.nonGoals))}</pre>`)

  body.push(`<h2>${e(l.changes)}</h2>`)
  if (model.deliveries.length === 0) body.push(`<p>${e(l.noChanges)}</p>`)
  else {
    body.push('<ul>')
    for (const d of model.deliveries) {
      const link = d.prUrl && /^https?:\/\//i.test(d.prUrl) ? ` — <a href="${e(d.prUrl)}" rel="noopener noreferrer">${e(d.prUrl)}</a>` : ''
      body.push(`<li><strong>${e(deliveryHead(l, d).replace(/`/g, ''))}</strong> — ${e(diffLine(l, d))}${link}`)
      if (d.diff.available && d.diff.top.length > 0) {
        body.push('<ul>')
        for (const f of d.diff.top) body.push(`<li><code>${e(f.path)}</code> (${e(f.status)}${f.additions !== null ? `, +${f.additions}/−${f.deletions ?? 0}` : ''})</li>`)
        body.push('</ul>')
      }
      body.push('</li>')
    }
    body.push('</ul>')
  }

  body.push(`<h2>${e(l.decisions)}</h2>`)
  if (model.decisions.length === 0) body.push(`<p>${e(l.noDecisions)}</p>`)
  else {
    body.push('<ul>')
    for (const d of model.decisions) {
      body.push(`<li><strong>${e(decisionLabel(l, d.kind))}</strong> (${e(day(d.at))}): ${e(d.title)}${d.body ? `<blockquote>${e(fence(d.body).split('\n').slice(0, 8).join('\n')).replace(/\n/g, '<br>')}</blockquote>` : ''}</li>`)
    }
    body.push('</ul>')
  }

  const review = model.deliveries.find((d) => d.review)?.review ?? null
  body.push(`<h2>${e(l.verification)}</h2><p>${review ? `<span class="${review.verdict === 'approved' ? 'ok' : 'warn'}">${e(verdictLabel(l, review.verdict))}</span>${review.findings > 0 ? ` · ${review.findings}` : ''}` : e(l.noReview)}</p>`)

  body.push(`<h2>${e(l.cost)}</h2>`)
  const costs = costLines(l, model.cost)
  if (costs.length === 0) body.push(`<p>${e(l.noCost)}</p>`)
  else body.push(`<ul>${costs.map((line) => `<li>${e(line)}</li>`).join('')}</ul>`)

  body.push(`<h2>${e(l.followUps)}</h2>`)
  const { openAddenda, unresolvedFindings } = model.followUps
  if (openAddenda.length === 0 && unresolvedFindings.length === 0) body.push(`<p>${e(l.noFollowUps)}</p>`)
  if (openAddenda.length > 0) body.push(`<p><strong>${e(l.openAddenda)}</strong></p><ul>${openAddenda.map((a) => `<li>${e(a.title)} (${e(a.kind)}, ${e(a.status)})</li>`).join('')}</ul>`)
  if (unresolvedFindings.length > 0) body.push(`<p><strong>${e(l.unresolvedFindings)}</strong></p><ul>${unresolvedFindings.slice(0, 40).map((f) => `<li>${e(f.text)}${f.location ? ` (<code>${e(f.location)}</code>)` : ''}</li>`).join('')}</ul>`)

  body.push(`<footer>${e(l.attribution)} · ${e(l.generated)} ${e(day(model.generatedAt))}</footer>`)
  return `<!doctype html><html lang="${e(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(l.document)} #${spec.id} ${e(spec.title)}</title><style>${HTML_STYLE}</style></head><body><main>${body.join('')}</main></body></html>`
}
