import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { Bot } from 'lucide-react'
import { getDateFnsLocale } from '../../lib/i18n'
import type { SpendingResponse } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

function fmtUsd(v: number): string {
  if (v < 0.005 && v > 0) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

/**
 * Agent-mission spend for this project — the Agent Chat/Mission Control turns
 * pinned to it (app-level `agent_invocations` ledger). Exploration turns are a
 * real cost driver, so they get their own block beside the pipeline surfaces.
 */
export function AgentMissionsCard({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  const missions = data?.agentMissions
  // Hidden entirely when the server predates the field or there is no spend in
  // the window — no empty-state noise for users who don't use missions.
  if (loading || !missions || missions.summary.turns === 0) return null

  const { summary, topConversations } = missions
  const isEstimated = summary.estimatedCostUsd > 0
  const delta = summary.prevTotalCostUsd > 0
    ? ((summary.totalCostUsd - summary.prevTotalCostUsd) / summary.prevTotalCostUsd) * 100
    : null

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4" data-testid="agent-missions-card">
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-4 w-4 text-accent-highlight" />
        <h3 className="text-sm font-medium">{t('agentMissions.title')}</h3>
        <span className="text-[10px] text-muted-foreground">{t('agentMissions.subtitle')}</span>
      </div>

      <div className="flex items-baseline gap-3">
        <span
          className="text-3xl font-semibold tabular-nums tracking-tight"
          data-estimated={isEstimated ? 'true' : undefined}
          title={isEstimated ? t('agentMissions.estimatedNote') : undefined}
        >
          {isEstimated ? '~' : ''}{fmtUsd(summary.totalCostUsd)}
        </span>
        {delta !== null && (
          <span className={delta > 0 ? 'text-xs text-accent-warning' : 'text-xs text-accent-success'}>
            {delta > 0 ? '+' : ''}{delta.toFixed(0)}% {t('agentMissions.vsPrev')}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('agentMissions.turnsAndTokens', {
          turns: summary.turns,
          tokens: fmtTokens(summary.tokensIn + summary.tokensOut),
        })}
      </p>

      {topConversations.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border/40 pt-2">
          {topConversations.map((c) => (
            <li key={c.conversationId ?? 'unknown'} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-foreground/85">
                {c.title?.trim() || t('agentMissions.untitled')}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {c.turns} · {c.lastAt
                  ? formatDistanceToNow(new Date(c.lastAt), { addSuffix: true, locale: getDateFnsLocale() })
                  : '—'}
              </span>
              <span className="shrink-0 tabular-nums font-medium">
                {c.estimatedCostUsd > 0 ? '~' : ''}{fmtUsd(c.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
