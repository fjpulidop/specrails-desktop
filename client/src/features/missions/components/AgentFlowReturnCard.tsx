// ─── Back to Flow: "What the reviewer asked for" ─────────────────────────────
// A server-authored system row posted once when a Flow → Spec delivery goes
// back to its Flow: the reviewer's verdict (issues, score, failing checks) and
// the spec coverage of the change (files no requirement explains). The Flow
// agent starts on it in the automatic turn that follows.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, FileQuestion, Undo2 } from 'lucide-react'
import type { PrDeliveryFlowReview } from '../../../types'
import { AgentFlowReviewBlock } from './AgentFlowReviewBlock'

export interface FlowReturnBriefingRow {
  kind: 'flow-return-briefing'
  flowId: string
  deliveryId: string
  review: PrDeliveryFlowReview | null
  derivation: { change: string | null; files: number; explained: number; unexplainedFiles: string[]; unexplainedOmitted: number } | null
}

const VISIBLE_FILES = 5
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0)

/** Parse a system row; null when it is not a Back to Flow briefing card. */
export function parseFlowReturnBriefingRow(content: string): FlowReturnBriefingRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'flow-return-briefing' || !str(o.flowId) || !str(o.deliveryId)) return null
  const reason = o.reason === 'review' || o.reason === 'check' ? o.reason : null
  const issues = Array.isArray(o.issues) ? o.issues.filter((issue): issue is string => typeof issue === 'string' && !!issue.trim()).slice(0, 50) : []
  const failingChecks = Array.isArray(o.failingChecks) ? o.failingChecks.flatMap((check) => {
    const c = check as Record<string, unknown> | null
    return c && str(c.command) ? [{ command: c.command as string, exitCode: typeof c.exitCode === 'number' ? c.exitCode : null }] : []
  }).slice(0, 10) : []
  const d = o.derivation as Record<string, unknown> | null | undefined
  return {
    kind: 'flow-return-briefing',
    flowId: o.flowId as string,
    deliveryId: o.deliveryId as string,
    review: reason ? { reason, summary: str(o.summary), issues, issuesOmitted: count(o.issuesOmitted), score: typeof o.score === 'number' ? o.score : null, failingChecks } : null,
    derivation: d && typeof d === 'object' && count(d.files) > 0 ? {
      change: str(d.change), files: count(d.files), explained: Math.min(count(d.explained), count(d.files)),
      unexplainedFiles: Array.isArray(d.unexplainedFiles) ? d.unexplainedFiles.filter((file): file is string => typeof file === 'string').slice(0, 50) : [],
      unexplainedOmitted: count(d.unexplainedOmitted),
    } : null,
  }
}

export function AgentFlowReturnCard({ row }: { row: FlowReturnBriefingRow }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(true)
  const [allFiles, setAllFiles] = useState(false)
  const derivation = row.derivation
  const gap = derivation && derivation.explained < derivation.files
  const files = derivation ? (allFiles ? derivation.unexplainedFiles : derivation.unexplainedFiles.slice(0, VISIBLE_FILES)) : []
  const hiddenFiles = derivation ? derivation.unexplainedFiles.length - files.length + derivation.unexplainedOmitted : 0
  return (
    <section
      data-testid="agent-flow-return-card"
      aria-label={t('flowReturn.title')}
      className="rounded-xl border border-accent-info/30 bg-accent-info/[0.05] px-3 py-2 text-xs backdrop-blur-sm"
    >
      <button
        type="button"
        data-agent-interactive
        data-testid="agent-flow-return-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50 rounded"
      >
        <Undo2 className="h-3.5 w-3.5 shrink-0 text-accent-info" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">{t('flowReturn.title')}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div data-testid="agent-flow-return-body">
          {row.review
            ? <AgentFlowReviewBlock review={row.review} hideNext />
            : <p className="mt-1.5 leading-4 text-foreground/65">{t('flowReturn.noFindings')}</p>}
          {derivation && gap && (
            <div className="mt-2 rounded-md border border-border/50 bg-surface/40 px-2.5 py-2 text-[11px]" data-testid="agent-flow-return-coverage">
              <p className="flex items-center gap-1.5 font-medium text-foreground/80">
                <FileQuestion className="h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
                {t('flowReturn.coverage', { explained: derivation.explained, files: derivation.files })}
              </p>
              {files.length > 0 && (
                <>
                  <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-foreground/50">{t('flowReturn.unexplained')}</p>
                  <ul className="mt-0.5 space-y-0.5" data-testid="agent-flow-return-unexplained">
                    {files.map((file) => <li key={file} className="truncate font-mono text-[10px] text-foreground/70" title={file}>{file}</li>)}
                  </ul>
                  {(hiddenFiles > 0 || allFiles) && derivation.unexplainedFiles.length > VISIBLE_FILES && (
                    <button type="button" data-agent-interactive onClick={() => setAllFiles((value) => !value)} className="mt-1 text-[10px] font-medium text-accent-info hover:underline">
                      {allFiles ? t('runCard.review.showLess') : t('runCard.review.showAll', { count: derivation.unexplainedFiles.length })}
                    </button>
                  )}
                  {derivation.unexplainedOmitted > 0 && <p className="mt-0.5 text-[10px] text-foreground/45">{t('flowReturn.moreFiles', { count: derivation.unexplainedOmitted })}</p>}
                </>
              )}
            </div>
          )}
          <p className="mt-1.5 leading-4 text-foreground/55">{t('flowReturn.next')}</p>
        </div>
      )}
    </section>
  )
}
