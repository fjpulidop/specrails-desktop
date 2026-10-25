import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, Globe, PencilLine, Plug, TerminalSquare } from 'lucide-react'
import { getApiBase } from '../../../../lib/api'
import type { AgentActionKind, PacketAgentActions } from '../../../../types'

import { notifyError } from '../../../../lib/notify-error'
const KIND_ORDER: AgentActionKind[] = ['read', 'write', 'exec', 'mcp', 'network']

const KIND_ICON: Record<AgentActionKind, typeof FileText> = {
  read: FileText,
  write: PencilLine,
  exec: TerminalSquare,
  mcp: Plug,
  network: Globe,
}

type AuditFormat = 'jsonl' | 'csv'

/**
 * "What the agent did": recorded agent actions of the delivery's runs, counted
 * by kind, with the per-run JSONL/CSV exports. Downloads go through fetch so the
 * desktop auth interceptor attaches its token (a bare <a download> would 401).
 */
export function AgentActionsSummary({ actions }: { actions: PacketAgentActions }) {
  const { t } = useTranslation('packet')
  const [busy, setBusy] = useState<string | null>(null)

  async function download(runId: string, format: AuditFormat) {
    const key = `${runId}:${format}`
    setBusy(key)
    try {
      const res = await fetch(`${getApiBase()}/jobs/${encodeURIComponent(runId)}/audit?format=${format}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `agent-actions-${runId}.${format}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      notifyError(t('agentActions.downloadFailed'), { detail: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3" data-testid="packet-agent-actions">
      <ul className="flex flex-wrap gap-2" aria-label={t('agentActions.countsLabel')}>
        {KIND_ORDER.map((kind) => {
          const Icon = KIND_ICON[kind]
          const count = actions.counts[kind] ?? 0
          return (
            <li
              key={kind}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${count > 0 ? 'border-border bg-background-deep/50 text-foreground' : 'border-border/50 text-muted-foreground'}`}
              data-testid={`packet-agent-actions-${kind}`}
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="tabular-nums font-medium">{count}</span>
              <span>{t(`agentActions.kinds.${kind}`, { count })}</span>
            </li>
          )
        })}
      </ul>
      <p className="text-caption text-muted-foreground">{t('agentActions.caveat')}</p>
      <ul className="space-y-1.5">
        {actions.runIds.map((runId) => (
          <li key={runId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground" title={runId}>{t('agentActions.run', { id: runId.slice(0, 8) })}</span>
            {(['jsonl', 'csv'] as const).map((format) => (
              <button
                key={format}
                type="button"
                onClick={() => void download(runId, format)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-background-deep/60 disabled:opacity-50"
                data-testid={`packet-agent-actions-download-${format}`}
              >
                <Download className="size-3" aria-hidden />
                {t('agentActions.download', { format: format.toUpperCase() })}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}
