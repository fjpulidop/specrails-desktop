import { useTranslation } from 'react-i18next'
import { Play, Brain, Terminal, GitBranch, Square, Download, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import type { LoopTemplateSummary, LoopNode, LoopNodeType } from '../../lib/loops-api'

const NODE_ICON: Record<LoopNodeType, typeof Play> = {
  start: Play,
  'ai-step': Brain,
  shell: Terminal,
  decider: GitBranch,
  condition: GitBranch,
  end: Square,
}

/** The human-readable detail for a node (prompt / command / goal), if any. */
function nodeDetail(node: LoopNode): string | null {
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
  mode = 'use',
}: {
  template: LoopTemplateSummary | null
  onClose: () => void
  onUse: (id: string) => void
  // 'use'  → starter template: clone via fromTemplate ("Use template").
  // 'fork' → built-in factory loop: clone via forkFactory ("Fork to edit").
  mode?: 'use' | 'fork'
}) {
  const { t } = useTranslation('loops')
  const open = template !== null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        {template && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-accent-highlight" />
                {template.name}
              </DialogTitle>
              <DialogDescription>{template.description}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>

            <p className="text-[11px] text-muted-foreground">
              {t('preview.limits', {
                iterations: template.graph.config.maxIterations,
                timeout: template.graph.config.timeoutMinutes,
              })}
            </p>

            <div className="max-h-[50vh] overflow-y-auto space-y-1.5 pr-1">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('preview.steps')}
              </span>
              {template.graph.nodes.map((node, i) => {
                const Icon = NODE_ICON[node.type] ?? Square
                const detail = nodeDetail(node)
                return (
                  <div key={node.id} className="rounded border border-border bg-surface/30 p-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="text-[10px] text-muted-foreground tabular-nums">{i + 1}.</span>
                      <Icon className="w-3.5 h-3.5 text-accent-primary" />
                      {t(`builder.nodes.${node.type}`)}
                    </div>
                    {detail && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground font-mono">
                        {detail}
                      </pre>
                    )}
                  </div>
                )
              })}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('common:actions.cancel')}
              </Button>
              <Button onClick={() => onUse(template.id)}>
                {mode === 'fork'
                  ? <Copy className="w-3.5 h-3.5 mr-1.5" />
                  : <Download className="w-3.5 h-3.5 mr-1.5" />}
                {mode === 'fork' ? t('actions.fork') : t('actions.use')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
