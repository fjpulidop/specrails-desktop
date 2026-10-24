import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Brain, Square, Pencil } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { cn } from '../../../lib/utils'
import type { AgentLoopRef } from '../../missions/hooks/useAgentRefActions'
import { NODE_ICON, nodeDetail } from './TemplatePreviewModal'

/**
 * Read-only loop preview opened from an agent-chat loop reference chip: the
 * loop's steps (same visual language as `TemplatePreviewModal`), run limits and
 * status, plus an "Open in builder" jump for every stored loop (built-ins included).
 *
 * Built on ui/dialog (focus trap, Escape, dialog semantics). It must layer
 * ABOVE the floating agent panel (z-[60]/z-[61]), so both the overlay and the
 * content are raised to z-[65] — below the MinimizedChatsDock (z-[70]).
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

  const openInBuilder = () => {
    onClose()
    navigate(`/loops/${encodeURIComponent(loop.id)}/edit`)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-testid="loop-preview-modal"
        overlayClassName="z-[65]"
        className="z-[65] flex max-h-[80vh] max-w-lg flex-col gap-4 overflow-hidden"
      >
        <DialogHeader className="gap-1.5 space-y-0">
          <div className="flex items-center gap-2 pr-6">
            <Brain className="h-4 w-4 shrink-0 text-accent-highlight" aria-hidden />
            <DialogTitle className="min-w-0 truncate text-base">{loop.name}</DialogTitle>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium',
                loop.builtin
                  ? 'border-accent-info/40 bg-accent-info/10 text-accent-info'
                  : loop.status === 'published'
                    ? 'border-accent-success/40 bg-accent-success/10 text-accent-success'
                    : 'border-border/60 bg-surface/60 text-foreground/60',
              )}
            >
              {loop.builtin
                ? t('preview.builtin')
                : t(`status.${loop.status ?? 'draft'}`, { defaultValue: loop.status ?? '' })}
            </span>
          </div>
          {loop.description ? (
            <DialogDescription className="text-sm">{loop.description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t('preview.steps')}</DialogDescription>
          )}
        </DialogHeader>

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
          <span className="block text-xs font-medium text-muted-foreground">
            {t('preview.steps')}
          </span>
          {loop.graph.nodes.map((node, i) => {
            const Icon = NODE_ICON[node.type] ?? Square
            const detail = nodeDetail(node)
            return (
              <div key={node.id} className="rounded border border-border bg-surface/30 p-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
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

        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
          {!loop.locked && (
            <Button data-testid="loop-preview-open-builder" onClick={openInBuilder}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {t('preview.openInBuilder')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
