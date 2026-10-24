import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, Loader2, ScrollText, TerminalSquare } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import type { AgentLiveTool } from '../context/AgentChatContext'
import { toolChipLabel } from './AgentActivityChip'

/**
 * Execution-log modal opened from the agent activity chip: every tool call of
 * the current (or last settled) turn, with bounded input/output previews and
 * job-log-style copy affordances (copy-all + per-entry copy).
 *
 * Modal standard (docs/internals/modal-standard.md): a Radix dialog on the
 * `entity` layer (65) — above the floating agent panel (60/61) it opens from,
 * below the minimized chats dock (75). Radix owns Escape stacking, the focus
 * trap and focus return.
 */
export function AgentActivityLogModal({
  tools,
  streaming,
  onClose,
}: {
  tools: AgentLiveTool[]
  streaming: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('agent')
  const listRef = useRef<HTMLDivElement | null>(null)

  // Follow the live turn: keep the newest entry in view while streaming.
  useEffect(() => {
    if (!streaming) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tools.length, streaming])

  const formatEntry = (entry: AgentLiveTool): string => {
    const time = entry.at ? formatTime(entry.at) : ''
    const lines = [`[${time}] ${entry.tool}`]
    if (entry.input) lines.push(`  input: ${entry.input}`)
    if (entry.output !== undefined) {
      lines.push(`  ${entry.isError ? 'error' : 'output'}: ${entry.output || '∅'}`)
    }
    return lines.join('\n')
  }

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(tools.map(formatEntry).join('\n\n'))
      toast.success(t('activity.copySuccess'))
    } catch {
      toast.error(t('activity.copyFailed'))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="wide" layer="entity" data-testid="agent-activity-log-modal">
        <DialogHeader
          icon={<ScrollText className="text-accent-info" />}
          actions={
            <button
              type="button"
              onClick={() => void copyAll()}
              disabled={tools.length === 0}
              title={t('activity.copyAll')}
              aria-label={t('activity.copyAll')}
              data-testid="agent-activity-copy-all"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          }
        >
          <div className="flex items-center gap-2">
            <DialogTitle>{t('activity.title')}</DialogTitle>
            <span data-chip="" className="inline-flex h-5 items-center rounded-full bg-muted/40 px-1.5 text-caption text-muted-foreground">
              {tools.length}
            </span>
            {streaming && (
              <span className="inline-flex items-center gap-1.5 text-xs text-accent-info">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {t('activity.live')}
              </span>
            )}
          </div>
          <DialogDescription className="sr-only">{t('activity.title')}</DialogDescription>
        </DialogHeader>

        <DialogBody ref={listRef} className="space-y-2">
          {tools.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{t('activity.empty')}</p>
          ) : (
            tools.map((entry) => (
              <ActivityEntry key={entry.id} entry={entry} formatted={formatEntry(entry)} />
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false })
}

function ActivityEntry({ entry, formatted }: { entry: AgentLiveTool; formatted: string }) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)

  const copyEntry = async () => {
    try {
      await navigator.clipboard.writeText(formatted)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('activity.copyFailed'))
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-surface/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-accent-info" aria-hidden />
        <span className="text-label">{toolChipLabel(entry.tool, t)}</span>
        <span className="truncate text-xs font-mono text-muted-foreground">{entry.tool}</span>
        {entry.at && (
          <span className="ml-auto shrink-0 text-xs font-mono text-muted-foreground">{formatTime(entry.at)}</span>
        )}
        <button
          type="button"
          onClick={() => void copyEntry()}
          title={t('activity.copyEntry')}
          aria-label={t('activity.copyEntry')}
          data-testid={`agent-activity-copy-${entry.id}`}
          className={cn(
            'shrink-0 rounded p-1 transition-colors',
            copied ? 'text-accent-success' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            !entry.at && 'ml-auto',
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      {entry.input && (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background-deep/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground/80">
          {entry.input}
        </pre>
      )}
      {entry.output !== undefined && (
        <div className="mt-1.5">
          <p className={cn('mb-0.5 text-xs', entry.isError ? 'text-destructive' : 'text-muted-foreground')}>
            {entry.isError ? t('activity.error') : t('activity.output')}
          </p>
          <pre
            className={cn(
              'max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md px-2 py-1.5 font-mono text-xs leading-relaxed',
              entry.isError ? 'bg-destructive/10 text-destructive' : 'bg-background-deep/60 text-foreground/80',
            )}
          >
            {entry.output || '∅'}
          </pre>
        </div>
      )}
    </div>
  )
}
