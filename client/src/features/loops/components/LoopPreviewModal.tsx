import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Brain, Square, Pencil } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { cn } from '../../../lib/utils'
import type { AgentLoopRef } from '../../missions/hooks/useAgentRefActions'
import { NODE_ICON, nodeDetail } from './TemplatePreviewModal'

/**
 * Read-only loop preview opened from an agent-chat loop reference chip: the
 * loop's steps (same visual language as `TemplatePreviewModal`), run limits and
 * status, plus an "Open in builder" jump for every stored loop (built-ins included).
 *
 * Built on ui/dialog (focus trap, Escape, dialog semantics). It must layer
 * ABOVE the floating agent panel (floating-chat, z-60), so it sits on the
 * `entity` layer (z-65) — below the minimized chats dock (see lib/layers).
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
        size="form"
        layer="entity"
        showCloseButton={false}
      >
        <DialogHeader icon={<Brain className="text-accent-highlight" />}>
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="min-w-0 truncate">{loop.name}</DialogTitle>
            <span
              data-chip=""
              className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-caption font-medium',
                loop.builtin
                  ? 'border-accent-info/40 bg-accent-info/10 text-accent-info'
                  : loop.status === 'published'
                    ? 'border-accent-success/40 bg-accent-success/10 text-accent-success'
                    : 'border-border/60 bg-surface/60 text-foreground/70',
              )}
            >
              {loop.builtin
                ? t('preview.builtin')
                : t(`status.${loop.status ?? 'draft'}`, { defaultValue: loop.status ?? '' })}
            </span>
          </div>
          {loop.description ? (
            <DialogDescription>{loop.description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t('preview.steps')}</DialogDescription>
          )}
        </DialogHeader>

        <DialogBody className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {loop.graph.config.timeoutMinutes > 0
              ? t('preview.limits', {
                  iterations: loop.graph.config.maxIterations,
                  timeout: loop.graph.config.timeoutMinutes,
                })
              : t('preview.limitsNoTimeout', {
                  iterations: loop.graph.config.maxIterations,
                })}
          </p>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">
              {t('preview.steps')}
            </span>
            {loop.graph.nodes.map((node, i) => {
              const Icon = NODE_ICON[node.type] ?? Square
              const detail = nodeDetail(node)
              return (
                <div key={node.id} className="rounded border border-border bg-surface/30 p-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className="text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                    <Icon className="h-3.5 w-3.5 text-accent-primary" />
                    {t(`builder.nodes.${node.type}`)}
                  </div>
                  {detail && (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {detail}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </DialogBody>

        <DialogFooter>
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
