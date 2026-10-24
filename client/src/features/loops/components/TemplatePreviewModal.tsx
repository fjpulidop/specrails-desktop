import { useTranslation } from 'react-i18next'
import { Play, Brain, Terminal, GitBranch, Square, Download } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { loopNeedsTicket } from '../lib/loop-ticket-need'
import type { LoopTemplateSummary, LoopNode, LoopNodeType } from '../lib/loops-api'

export const NODE_ICON: Record<LoopNodeType, typeof Play> = {
  core: Brain,
  start: Play,
  'ai-step': Brain,
  shell: Terminal,
  decider: GitBranch,
  condition: GitBranch,
  end: Square,
}

/** The human-readable detail for a node (prompt / command / goal), if any. */
export function nodeDetail(node: LoopNode): string | null {
  if (node.type === 'core') { const params = node.data?.params as Record<string, unknown> | undefined; return params ? String(params.text ?? params.prompt ?? params.goal ?? params.expr ?? params.question ?? params.message ?? params.ref ?? params.body ?? params.outcome ?? JSON.stringify(params, null, 2)) : null }
  if (node.type === 'ai-step') return typeof node.data?.prompt === 'string' ? node.data.prompt : null
  if (node.type === 'shell') return typeof node.data?.command === 'string' ? node.data.command : null
  if (node.type === 'decider') return typeof node.data?.goal === 'string' ? node.data.goal : null
  if (node.type === 'end') return node.data?.outcome === 'failure' ? 'failure' : 'success'
  return null
}

/**
 * Read-only preview of a starter template: its steps (prompts / decider goal),
 * tags, and run limits — so the user can inspect a loop before cloning it.
 * Templates author their node array in logical order, so we render it as-is.
 */
export function TemplatePreviewModal({
  template,
  onClose,
  onUse,
}: {
  template: LoopTemplateSummary | null
  onClose: () => void
  /** Clone the starter template via fromTemplate ("Use template"). */
  onUse: (id: string) => void
}) {
  const { t } = useTranslation('loops')
  const open = template !== null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent size="wide" showCloseButton={false}>
        {template && (
          <>
            <DialogHeader icon={<Brain className="text-accent-highlight" />}>
              <DialogTitle>{template.name}</DialogTitle>
              <DialogDescription>{template.description}</DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {loopNeedsTicket(template.graph) ? (
                <span title={t('gallery.needsSpecHint')} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-[11px] bg-accent-secondary/15 text-accent-secondary">
                  {t('gallery.needsSpec')}
                </span>
              ) : (
                <span title={t('gallery.standaloneHint')} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-[11px] bg-accent-success/15 text-accent-success">
                  {t('gallery.standalone')}
                </span>
              )}
              {template.category && (
                <span data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-[11px] bg-accent-info/15 text-accent-info">
                  {t(`categories.${template.category}`, { defaultValue: template.category })}
                </span>
              )}
              {template.tags.map((tag) => (
                <span key={tag} data-chip="" className="inline-flex h-5 items-center px-1.5 rounded text-[11px] bg-muted text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {template.graph.config.timeoutMinutes > 0
                ? t('preview.limits', {
                    iterations: template.graph.config.maxIterations,
                    timeout: template.graph.config.timeoutMinutes,
                  })
                : t('preview.limitsNoTimeout', {
                    iterations: template.graph.config.maxIterations,
                  })}
            </p>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">
                {t('preview.steps')}
              </span>
              {template.graph.nodes.map((node, i) => {
                const Icon = NODE_ICON[node.type] ?? Square
                const detail = nodeDetail(node)
                return (
                  <div key={node.id} className="rounded border border-border bg-surface/30 p-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                      <Icon className="w-3.5 h-3.5 text-accent-primary" />
                      {t(node.type === 'core' ? `builder.core.pieces.${node.data?.kind}` : `builder.nodes.${node.type}`)}
                    </div>
                    {detail && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground font-mono">
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
                {t('common:actions.cancel')}
              </Button>
              <Button onClick={() => onUse(template.id)}>
                <Download className="w-3.5 h-3.5 mr-1.5" />
                {t('actions.use')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
