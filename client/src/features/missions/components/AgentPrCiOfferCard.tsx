// ─── PR CI loop offer (pr-ci-loop) ────────────────────────────────────────────
// A server-authored system row (`pr-ci-offer`) posted after a mission's PR is
// created: "Watch and fix the PR's CI". It is OPTIONAL and informational — it
// never starts by itself, rings no bell and adds no attention dot. Start runs
// `factory:pr-ci` on the same PR (Core owns the loop); "Not now" is persisted
// for this delivery generation. The row is updated in place as the loop runs
// and settles (started → green | no checks | needs attention).

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldCheck, Workflow } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { postPrCiDismiss, postPrCiLaunch } from '../../delivery/lib/pr-ci'
import { focusPrCard } from './agent-run-failure'

export type PrCiOfferState = 'offered' | 'started' | 'dismissed' | 'green' | 'no-ci' | 'needs-attention'
export interface PrCiOfferRow {
  kind: 'pr-ci-offer'
  projectId: string
  prDeliveryId: string
  prNumber: number | null
  prUrl: string
  /** Multi-repository generations: one PR per repository. */
  prs: Array<{ repository: string; prNumber: number | null; prUrl: string }>
  railIndex: number
  state: PrCiOfferState
  runId: string | null
  runDeliveryId: string | null
  reason: string | null
  pushes: number | null
  rounds: number | null
}

const STATES: readonly PrCiOfferState[] = ['offered', 'started', 'dismissed', 'green', 'no-ci', 'needs-attention']
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)

/** Parse a system row; null when it is not a PR CI offer. */
export function parsePrCiOfferRow(content: string): PrCiOfferRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'pr-ci-offer') return null
  const projectId = str(o.projectId), prDeliveryId = str(o.prDeliveryId), prUrl = str(o.prUrl), railIndex = int(o.railIndex)
  if (!projectId || !prDeliveryId || !prUrl || !/^https?:\/\//i.test(prUrl) || railIndex === null || !STATES.includes(o.state as PrCiOfferState)) return null
  const prs = Array.isArray(o.prs) ? o.prs.flatMap((entry) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    const link = item ? str(item.prUrl) : null
    return item && link && /^https?:\/\//i.test(link) ? [{ repository: str(item.repository) ?? '', prNumber: int(item.prNumber), prUrl: link }] : []
  }).slice(0, 20) : []
  return { kind: 'pr-ci-offer', projectId, prDeliveryId, prNumber: int(o.prNumber), prUrl, prs, railIndex, state: o.state as PrCiOfferState,
    runId: str(o.runId), runDeliveryId: str(o.runDeliveryId), reason: str(o.reason), pushes: int(o.pushes), rounds: int(o.rounds) }
}

export function AgentPrCiOfferCard({ row, conversationId = null }: { row: PrCiOfferRow; conversationId?: string | null }) {
  const { t } = useTranslation('agent')
  // Synchronous guard: a double click never sends two launches.
  const inFlight = useRef(false)
  const [busy, setBusy] = useState<'start' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<PrCiOfferState | null>(null)
  const state = local && row.state === 'offered' ? local : row.state
  const many = row.prs.length > 1
  const prName = (entry: { repository: string; prNumber: number | null }) => [entry.repository, entry.prNumber !== null ? `#${entry.prNumber}` : ''].filter(Boolean).join(' ')
  const pr = many ? row.prs.map(prName).join(', ') : row.prNumber !== null ? `#${row.prNumber}` : t('prCi.thisPr')
  const links = many ? row.prs.map((entry) => ({ href: entry.prUrl, text: t('prCi.openPr', { pr: prName(entry) }) })) : [{ href: row.prUrl, text: t('prCi.openPr', { pr }) }]
  const k = (key: string) => many ? `${key}Many` : key
  const rail = t('prCard.rail', { index: row.railIndex + 1 })

  const start = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('start'); setError(null)
    const outcome = await postPrCiLaunch(row.projectId, row.railIndex, { prDeliveryId: row.prDeliveryId, originConversationId: conversationId })
    if (outcome.kind === 'started') setLocal('started')
    else { setError(outcome.detail || t('prCi.startFailed')); inFlight.current = false }
    setBusy(null)
  }
  const dismiss = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('dismiss'); setError(null)
    if (await postPrCiDismiss(row.projectId, row.prDeliveryId)) setLocal('dismissed')
    else { setError(t('prCi.dismissFailed')); inFlight.current = false }
    setBusy(null)
  }
  const openRun = () => focusPrCard({ prDeliveryId: row.runDeliveryId ?? row.prDeliveryId, runIds: row.runId ? [row.runId] : [], conversationId })

  if (state === 'dismissed') {
    return <p data-testid="agent-pr-ci-offer" data-state="dismissed" className="text-xs text-muted-foreground">{t(`prCi.${k('dismissed')}`, { pr })}</p>
  }
  const tone = state === 'green' || state === 'no-ci' ? 'success' : state === 'needs-attention' ? 'warning' : 'info'
  const Icon = state === 'green' || state === 'no-ci' ? CheckCircle2 : state === 'needs-attention' ? AlertTriangle : state === 'started' ? Workflow : ShieldCheck
  return (
    <section data-testid="agent-pr-ci-offer" data-state={state} aria-label={t(`prCi.${k('title')}`, { pr })}
      className="rounded-xl border border-border/60 bg-surface/50 px-3.5 py-3 text-xs">
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'success' ? 'text-accent-success' : tone === 'warning' ? 'text-accent-warning' : 'text-accent-info')} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {state === 'offered' ? t(`prCi.${k('title')}`, { pr })
              : state === 'started' ? t(`prCi.${k('started')}`, { pr, rail })
              : state === 'green' ? t(`prCi.${k('green')}`, { pr })
              : state === 'no-ci' ? t(`prCi.${k('noCi')}`, { pr })
              : t(`prCi.${k('needsAttention')}`, { pr })}
          </p>
          <p className="mt-1 leading-4 text-muted-foreground">
            {state === 'offered' ? t('prCi.body')
              : state === 'started' ? t('prCi.startedBody')
              : state === 'needs-attention' ? (row.reason ?? t('prCi.needsAttentionBody'))
              : state === 'green' ? t('prCi.greenBody', { pushes: row.pushes ?? 0, rounds: row.rounds ?? 0, count: row.pushes ?? 0 })
              : t('prCi.noCiBody')}
          </p>
          {state === 'offered' && <p className="mt-1 leading-4 text-muted-foreground">{t('prCi.guarantee')}</p>}
          {error && <p role="alert" data-testid="agent-pr-ci-offer-error" className="mt-1.5 flex items-start gap-1.5 leading-4 text-destructive"><AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />{error}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {state === 'offered' && (
              <>
                <button type="button" data-agent-interactive data-testid="agent-pr-ci-start" disabled={busy !== null} onClick={() => void start()}
                  className="inline-flex min-h-7 items-center gap-1.5 rounded-md bg-accent-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60">
                  {busy === 'start' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                  {t('prCi.start')}
                </button>
                <button type="button" data-agent-interactive data-testid="agent-pr-ci-dismiss" disabled={busy !== null} onClick={() => void dismiss()}
                  className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60">
                  {busy === 'dismiss' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                  {t('prCi.notNow')}
                </button>
              </>
            )}
            {state !== 'offered' && (row.runId || row.runDeliveryId) && (
              <button type="button" data-agent-interactive data-testid="agent-pr-ci-open-run" onClick={openRun}
                className="inline-flex min-h-7 items-center rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                {t('prCi.openRun')}
              </button>
            )}
            {links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer" data-agent-interactive
                className="inline-flex min-h-7 items-center gap-1 px-1 text-xs text-accent-info hover:underline">
                {link.text}<ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
