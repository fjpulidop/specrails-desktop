// ─── "Session renewed · summary" marker ──────────────────────────────────────
// A server-authored `session-summary` row marks where the mission started a
// fresh provider session with a summary ("Start fresh with a summary" in the
// context ring). It renders as ONE compact event line in its chronological
// slot that expands to the summary, so the person sees what the new session
// knows. It is an app record, never a user message.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { RefreshCcw } from 'lucide-react'
import type { SessionSummaryRow } from '../lib/agent-api'
import { AgentRunEventLine } from './AgentRunEventLine'
import { MISSION_MARKDOWN_CLASS } from './AgentMessage'

/** Parse a system row; null when it is not a session summary marker. */
export function parseSessionSummaryRow(content: string): SessionSummaryRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'session-summary' || typeof o.summary !== 'string' || !o.summary.trim()) return null
  return {
    kind: 'session-summary',
    summary: o.summary,
    provider: typeof o.provider === 'string' ? o.provider : '',
    model: typeof o.model === 'string' ? o.model : '',
    includedMessages: typeof o.includedMessages === 'number' ? o.includedMessages : 0,
    totalMessages: typeof o.totalMessages === 'number' ? o.totalMessages : 0,
    at: typeof o.at === 'string' ? o.at : '',
  }
}

export function AgentSessionSummaryCard({ row }: { row: SessionSummaryRow }) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const partial = row.totalMessages > 0 && row.includedMessages < row.totalMessages
  return (
    <section data-testid="agent-session-summary" aria-label={t('sessionRenew.marker')} className="rounded-md border border-border bg-card/40">
      <AgentRunEventLine
        icon={RefreshCcw}
        testId="agent-session-summary-line"
        onActivate={() => setExpanded((value) => !value)}
        expanded={expanded}
        actionLabel={expanded ? t('sessionRenew.hideSummary') : t('sessionRenew.showSummary')}
        attributes={{ 'data-expanded': expanded ? 'true' : 'false' }}
        detail={t('sessionRenew.markerDetail')}
      >
        {t('sessionRenew.marker')}
      </AgentRunEventLine>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2" data-testid="agent-session-summary-body">
          <p className="text-caption text-muted-foreground">
            {partial
              ? t('sessionRenew.basedOnPartial', { included: row.includedMessages, total: row.totalMessages })
              : t('sessionRenew.basedOn')}
            {row.model ? ` · ${row.model}` : ''}
          </p>
          <div className={MISSION_MARKDOWN_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.summary}</ReactMarkdown>
          </div>
        </div>
      )}
    </section>
  )
}
