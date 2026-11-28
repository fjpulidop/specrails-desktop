// ─── An external MCP client's change in the history ───────────────────────────
// A server-authored `mcp-action` row (server/mcp/v2/core/mission-journal.ts)
// records what an external MCP client (Claude Code, Codex…) changed while it
// drove Specrails: which tool and action, on what, and how it ended. One event
// line in its chronological slot, like Intent's boundaries; a launched run or a
// PR card shows next to it as it would for the mission's own agent.

import { useTranslation } from 'react-i18next'
import { Plug } from 'lucide-react'
import { AgentRunEventLine } from './AgentRunEventLine'

export interface McpActionRow {
  kind: 'mcp-action'
  client: string
  tool: string
  action: string
  ok: boolean
  target: string | null
  summary: string | null
  error: { code: string; message: string } | null
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null

/** Parse a system row; null when it is not an MCP action. */
export function parseMcpActionRow(content: string): McpActionRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'mcp-action' || !text(o.tool) || !text(o.action)) return null
  const error = o.error && typeof o.error === 'object' ? o.error as Record<string, unknown> : null
  return {
    kind: 'mcp-action',
    client: text(o.client) ?? 'MCP',
    tool: o.tool as string,
    action: o.action as string,
    ok: o.ok !== false,
    target: text(o.target),
    summary: text(o.summary),
    error: error ? { code: text(error.code) ?? 'error', message: text(error.message) ?? '' } : null,
  }
}

/** `specrails_runs` + `launch` → `runs.launch`: the call as the person would recognize it. */
export function mcpCallName(row: Pick<McpActionRow, 'tool' | 'action'>): string {
  return `${row.tool.replace(/^specrails_/, '')}.${row.action}`
}

export function AgentMcpActionLine({ row }: { row: McpActionRow }) {
  const { t } = useTranslation('agent')
  const call = mcpCallName(row)
  const detail = row.ok ? row.summary ?? row.target : row.error?.message || row.error?.code
  return (
    <div title={[row.summary, row.target, row.error?.message].filter(Boolean).join('\n') || undefined}>
      <AgentRunEventLine
        icon={Plug}
        tone={row.ok ? 'neutral' : 'failed'}
        testId="agent-mcp-action"
        attributes={{ 'data-tool': row.tool, 'data-action': row.action, 'data-ok': String(row.ok) }}
        detail={detail ?? undefined}
      >
        {t(row.ok ? 'mcp.action' : 'mcp.actionFailed', { client: row.client, call })}
      </AgentRunEventLine>
    </div>
  )
}
