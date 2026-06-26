import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { providerSupportsReasoningEffort } from '../../lib/provider-capabilities'

export interface RunModalProject {
  id: string
  name: string
  providers?: string[]
  provider?: string
}

/**
 * Run a ticket-less loop standalone (rails-as-loops). Collects a target project
 * (required), a provider (default the project's primary; hidden when single), and
 * reasoning effort (when the provider supports it), then Execute. The run lands as
 * a job in the chosen project's history.
 */
export function LoopRunModal({
  loop,
  projects,
  onClose,
  onExecute,
}: {
  loop: { id: string; name: string } | null
  projects: RunModalProject[]
  onClose: () => void
  onExecute: (args: { projectId: string; provider?: string; effort?: string }) => void
}) {
  const { t } = useTranslation('loops')
  const open = loop !== null
  const [projectId, setProjectId] = useState('')
  const [provider, setProvider] = useState('')
  const [effort, setEffort] = useState('medium')

  const selected = projects.find((p) => p.id === (projectId || projects[0]?.id))
  const providerList = useMemo(() => selected?.providers ?? (selected?.provider ? [selected.provider] : []), [selected])
  const effectiveProvider = provider || providerList[0] || ''
  const showEffort = effectiveProvider ? providerSupportsReasoningEffort(effectiveProvider) : false

  const execute = () => {
    const pid = projectId || projects[0]?.id
    if (!pid) return
    onExecute({
      projectId: pid,
      provider: providerList.length > 1 ? effectiveProvider : undefined,
      effort: showEffort ? effort : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm">
        {loop && (
          <>
            <DialogHeader>
              <DialogTitle>{t('run.title', { name: loop.name })}</DialogTitle>
              <DialogDescription>{t('run.subtitle')}</DialogDescription>
            </DialogHeader>

            <label className="block text-[11px] font-medium text-muted-foreground">{t('run.project')}</label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('run.noProjects')}</p>
            ) : (
              <select
                aria-label={t('run.project')}
                data-testid="run-project-select"
                value={projectId || projects[0]?.id}
                onChange={(e) => { setProjectId(e.target.value); setProvider('') }}
                className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            {providerList.length > 1 && (
              <>
                <label className="block text-[11px] font-medium text-muted-foreground">{t('run.provider')}</label>
                <select
                  aria-label={t('run.provider')}
                  value={effectiveProvider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
                >
                  {providerList.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </>
            )}

            {showEffort && (
              <>
                <label className="block text-[11px] font-medium text-muted-foreground">{t('run.effort')}</label>
                <select
                  aria-label={t('run.effort')}
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>{t('common:actions.cancel')}</Button>
              <Button onClick={execute} disabled={projects.length === 0}>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                {t('run.execute')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
