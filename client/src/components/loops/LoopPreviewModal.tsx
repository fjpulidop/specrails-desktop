import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Brain, Square, Pencil, Lock } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { AgentLoopRef } from '../../hooks/useAgentRefActions'
import { NODE_ICON, nodeDetail } from './TemplatePreviewModal'

/**
 * Read-only loop preview opened from an agent-chat loop reference chip: the
 * loop's steps (same visual language as `TemplatePreviewModal`), run limits and
 * status, plus an "Open in builder" jump for editable (non-factory) loops.
 *
 * Hand-rolled portal modal (NOT ui/dialog): it must layer ABOVE the floating
 * agent panel, and Radix `DialogContent` is pinned at z-50 (< the panel's
 * z-[60]). Same pattern + tier as the board-mode overlays: portal to
 * `document.body` at z-[65] — above the panel (z-[60]/z-[61]), below the
 * MinimizedChatsDock (z-[70]).
 */
export function LoopPreviewModal({
  loop,
  onClose,
}: {
  loop: AgentLoopRef
  onClose: () => void
}) {
  const { t } = useTranslation('loops')
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openInBuilder = () => {
    onClose()
    navigate(`/loops/${encodeURIComponent(loop.id)}/edit`)
  }

  return createPortal(
    <div
      data-testid="loop-preview-modal"
      className="fixed inset-0 z-[65] flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={loop.name}
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col gap-4 overflow-hidden rounded-xl border border-border/30 bg-popover p-6 shadow-xl backdrop-blur-md"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 pr-6">
            <Brain className="h-4 w-4 shrink-0 text-accent-highlight" />
            <span className="min-w-0 truncate text-base font-semibold text-foreground">{loop.name}</span>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide',
                loop.locked
                  ? 'border-accent-info/40 bg-accent-info/10 text-accent-info'
                  : loop.status === 'published'
                    ? 'border-accent-success/40 bg-accent-success/10 text-accent-success'
                    : 'border-border/60 bg-surface/60 text-foreground/60',
              )}
            >
              {loop.locked && <Lock className="h-2.5 w-2.5" />}
              {loop.locked
                ? t('preview.builtin')
                : t(`status.${loop.status ?? 'draft'}`, { defaultValue: loop.status ?? '' })}
            </span>
          </div>
          {loop.description && (
            <p className="text-sm text-muted-foreground">{loop.description}</p>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          {loop.graph.config.timeoutMinutes > 0
            ? t('preview.limits', {
                iterations: loop.graph.config.maxIterations,
                timeout: loop.graph.config.timeoutMinutes,
              })
            : t('preview.limitsNoTimeout', {
                iterations: loop.graph.config.maxIterations,
              })}
        </p>

        <div className="min-h-0 space-y-1.5 overflow-y-auto pr-1">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('preview.steps')}
          </span>
          {loop.graph.nodes.map((node, i) => {
            const Icon = NODE_ICON[node.type] ?? Square
            const detail = nodeDetail(node)
            return (
              <div key={node.id} className="rounded border border-border bg-surface/30 p-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="text-[10px] tabular-nums text-muted-foreground">{i + 1}.</span>
                  <Icon className="h-3.5 w-3.5 text-accent-primary" />
                  {t(`builder.nodes.${node.type}`)}
                </div>
                {detail && (
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                    {detail}
                  </pre>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
          {!loop.locked && (
            <Button data-testid="loop-preview-open-builder" onClick={openInBuilder}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {t('preview.openInBuilder')}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
