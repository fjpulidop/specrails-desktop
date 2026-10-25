// ─── Back to Flow: "What the reviewer asked for" / "Why Flow → Spec stopped" ──
// A server-authored system row posted once when a Flow → Spec delivery goes
// back to its Flow: the reviewer's verdict (issues, score, failing checks) and
// the spec coverage of the change (files no requirement explains) — or, when
// the run failed outright, the failure (rendered by the extension that owns
// it). The Flow agent starts on it in the automatic turn that follows.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileQuestion, Undo2 } from 'lucide-react'
import type { PrDeliveryFlowReview } from '../../../types'
import { useMissionExtensions } from '../context/MissionExtensionsContext'
import { AgentFlowReviewBlock } from './AgentFlowReviewBlock'
import { AgentRunEventLine } from './AgentRunEventLine'

export interface FlowReturnBriefingRow {
  kind: 'flow-return-briefing'
  flowId: string
  deliveryId: string
  review: PrDeliveryFlowReview | null
  derivation: { change: string | null; files: number; explained: number; unexplainedFiles: string[]; unexplainedOmitted: number } | null
  /** The run failed outright (no review): the step, the runtime's error and the codes. */
  failure: { stepId: string | null; cause: string | null; statusCode: string | null; failureCode: string | null; statusDetail: string | null } | null
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
  const f = o.failure as Record<string, unknown> | null | undefined
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
    failure: !reason && f && typeof f === 'object' && !Array.isArray(f) ? {
      stepId: str(f.stepId), cause: str(f.cause), statusCode: str(f.statusCode), failureCode: str(f.failureCode), statusDetail: str(f.statusDetail),
    } : null,
  }
}

export function AgentFlowReturnCard({ row, conversationId = null }: { row: FlowReturnBriefingRow; conversationId?: string | null }) {
  const { t } = useTranslation('agent')
  const { RunFailureOutcome } = useMissionExtensions()
  const title = row.failure ? t('flowReturn.titleFailure') : t('flowReturn.title')
  // A history event line ("Back to Flow"): what the reviewer asked for opens on demand.
  const [open, setOpen] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const derivation = row.derivation
  const gap = derivation && derivation.explained < derivation.files
  const files = derivation ? (allFiles ? derivation.unexplainedFiles : derivation.unexplainedFiles.slice(0, VISIBLE_FILES)) : []
  const hiddenFiles = derivation ? derivation.unexplainedFiles.length - files.length + derivation.unexplainedOmitted : 0
  return (
    <section data-testid="agent-flow-return-card" aria-label={title} className="text-xs">
      <AgentRunEventLine
        icon={Undo2}
        tone="flow"
        testId="agent-flow-return-toggle"
        expanded={open}
        onActivate={() => setOpen((value) => !value)}
        detail={title}
      >
        {t('runStrip.event.backToFlow')}
      </AgentRunEventLine>
      {open && (
        <div data-testid="agent-flow-return-body" className="ml-[22px] mt-1 border-l border-border/50 pl-3">
          {row.review
            ? <AgentFlowReviewBlock review={row.review} hideNext />
            : row.failure && RunFailureOutcome
              ? (
                <div className="mt-1.5">
                  <RunFailureOutcome projectId={null} prDeliveryId={row.deliveryId} conversationId={conversationId}
                    stepId={row.failure.stepId} cause={row.failure.cause} statusCode={row.failure.statusCode} failureCode={row.failure.failureCode}
                    statusDetail={row.failure.statusDetail} repositoryName={null} returned surface="return" busy={false} />
                </div>
              )
              : <p className="mt-1.5 leading-4 text-muted-foreground">{t('flowReturn.noFindings')}</p>}
          {derivation && gap && (
            <div className="mt-2 rounded-md border border-border/50 bg-surface/40 px-2.5 py-2 text-caption" data-testid="agent-flow-return-coverage">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <FileQuestion className="h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
                {t('flowReturn.coverage', { explained: derivation.explained, files: derivation.files })}
              </p>
              {files.length > 0 && (
                <>
                  <p className="mt-1 text-label text-muted-foreground">{t('flowReturn.unexplained')}</p>
                  <ul className="mt-0.5 space-y-0.5" data-testid="agent-flow-return-unexplained">
                    {files.map((file) => <li key={file} className="truncate font-mono text-caption text-muted-foreground" title={file}>{file}</li>)}
                  </ul>
                  {(hiddenFiles > 0 || allFiles) && derivation.unexplainedFiles.length > VISIBLE_FILES && (
                    <button type="button" data-agent-interactive onClick={() => setAllFiles((value) => !value)} className="mt-1 text-caption font-medium text-accent-info hover:underline">
                      {allFiles ? t('runCard.review.showLess') : t('runCard.review.showAll', { count: derivation.unexplainedFiles.length })}
                    </button>
                  )}
                  {derivation.unexplainedOmitted > 0 && <p className="mt-0.5 text-caption text-muted-foreground">{t('flowReturn.moreFiles', { count: derivation.unexplainedOmitted })}</p>}
                </>
              )}
            </div>
          )}
          <p className="mt-1.5 leading-4 text-muted-foreground">{t('flowReturn.next')}</p>
        </div>
      )}
    </section>
  )
}
