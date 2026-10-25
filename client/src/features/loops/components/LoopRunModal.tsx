import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { HelpHint } from '../../../components/HelpHint'
import { LaunchForecast } from '../../../components/LaunchForecast'
import { useLaunchBudgetGuard } from '../../../hooks/useLaunchBudgetGuard'
import {
  defaultReasoningEffortForProvider,
  providerLabel,
  providerSupportsCustomModelAliases,
  reasoningEffortsForProvider,
} from '../../providers/lib/provider-capabilities'
import { modelsForProvider, defaultModelForProvider } from '../lib/loop-run-models'
import { isSafeCustomModelAlias } from '../../providers/lib/model-alias'
import { RepositoryScopeSelector } from '../../projects/components/RepositoryScopeSelector'
import type { ProjectRepository } from '../../projects/lib/project-repositories'
import { CustomModelAliasInput } from '../../providers/components/CustomModelAliasInput'

export interface RunModalProject {
  repositories?: ProjectRepository[]
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
  onExecute: (args: { projectId: string; provider?: string; model?: string; effort?: string; repositoryIds?: string[]; runCapUsd?: number }) => void
}) {
  const { t } = useTranslation('loops')
  const open = loop !== null
  const [projectId, setProjectId] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [repositoryIds, setRepositoryIds] = useState<string[] | undefined>()
  // Per-launch override of the per-run soft cap ("pause and ask at $X"); empty = the project/app default.
  const [runCap, setRunCap] = useState('')

  const selected = projects.find((p) => p.id === (projectId || projects[0]?.id))
  const providerList = useMemo(() => selected?.providers ?? (selected?.provider ? [selected.provider] : []), [selected])
  const effectiveProvider = provider || providerList[0] || ''
  const modelOptions = useMemo(() => modelsForProvider(effectiveProvider), [effectiveProvider])
  const customModelAliases = providerSupportsCustomModelAliases(effectiveProvider)
  const effectiveModel = model && (
    modelOptions.some((option) => option.value === model)
    || (customModelAliases && isSafeCustomModelAlias(model))
  )
    ? model
    : defaultModelForProvider(effectiveProvider)
  const effortOptions = reasoningEffortsForProvider(effectiveProvider, effectiveModel)
  const effectiveEffort = effortOptions.includes(effort as never)
    ? effort
    : defaultReasoningEffortForProvider(effectiveProvider, effectiveModel) ?? ''
  const showEffort = effortOptions.length > 0

  // Executing while today's budget is already used up asks first (the run would pause).
  const launchGuard = useLaunchBudgetGuard(selected?.id && loop?.id && effectiveProvider ? { projectId: selected.id, loopId: loop.id, provider: effectiveProvider } : null)

  const execute = () => {
    const pid = projectId || projects[0]?.id
    if (!pid) return
    const cap = parseFloat(runCap)
    onExecute({
      projectId: pid,
      ...(runCap.trim() !== '' && Number.isFinite(cap) && cap > 0 ? { runCapUsd: cap } : {}),
      ...(repositoryIds ? { repositoryIds } : {}),
      provider: providerList.length > 1 ? effectiveProvider : undefined,
      model: modelOptions.length > 0 ? effectiveModel : undefined,
      effort: showEffort ? effectiveEffort : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent size="form" showCloseButton={false}>
        {loop && (
          <>
            <DialogHeader>
              <DialogTitle>{t('run.title', { name: loop.name })}</DialogTitle>
              <DialogDescription>{t('run.subtitle')}</DialogDescription>
              <HelpHint topic="loopBuilder" variant="link" className="mt-1" />
            </DialogHeader>

            <DialogBody className="space-y-2">
            <label className="block text-label text-muted-foreground">{t('run.project')}</label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('run.noProjects')}</p>
            ) : (
              <select
                aria-label={t('run.project')}
                data-testid="run-project-select"
                value={projectId || projects[0]?.id}
                onChange={(e) => { setProjectId(e.target.value); setProvider(''); setModel(''); setEffort(''); setRepositoryIds(undefined) }}
                className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            <RepositoryScopeSelector repositories={selected?.repositories ?? []} value={repositoryIds} onChange={setRepositoryIds} />

            {providerList.length > 1 && (
              <>
                <label className="block text-label text-muted-foreground">{t('run.provider')}</label>
                <select
                  aria-label={t('run.provider')}
                  value={effectiveProvider}
                  onChange={(e) => { setProvider(e.target.value); setModel(''); setEffort('') }}
                  className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
                >
                  {providerList.map((p) => (
                    <option key={p} value={p}>{providerLabel(p)}</option>
                  ))}
                </select>
              </>
            )}

            {modelOptions.length > 0 && (
              <>
                <label className="block text-label text-muted-foreground">{t('run.model')}</label>
                {customModelAliases ? (
                  <CustomModelAliasInput
                    value={effectiveModel}
                    options={modelOptions}
                    ariaLabel={t('run.model')}
                    testId="run-model-select"
                    className="w-full px-2 py-1 text-xs"
                    onCommit={(nextModel) => {
                      setModel(nextModel)
                      setEffort(defaultReasoningEffortForProvider(effectiveProvider, nextModel) ?? '')
                    }}
                  />
                ) : (
                  <select
                    aria-label={t('run.model')}
                    data-testid="run-model-select"
                    value={effectiveModel}
                    onChange={(e) => {
                      const nextModel = e.target.value
                      setModel(nextModel)
                      setEffort(defaultReasoningEffortForProvider(effectiveProvider, nextModel) ?? '')
                    }}
                    className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
                  >
                    {modelOptions.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                )}
              </>
            )}

            {showEffort && (
              <>
                <label className="block text-label text-muted-foreground">{t('run.effort')}</label>
                <select
                  aria-label={t('run.effort')}
                  value={effectiveEffort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
                >
                  {effortOptions.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </>
            )}
            <label className="block text-label text-muted-foreground">{t('run.runCap')}</label>
            <input
              type="number" min="0" step="0.01" inputMode="decimal"
              aria-label={t('run.runCap')}
              data-testid="run-cap-input"
              value={runCap}
              onChange={(e) => setRunCap(e.target.value)}
              placeholder={t('run.runCapPlaceholder')}
              className="num w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40"
            />
            <p className="text-micro text-muted-foreground">{t('run.runCapHint')}</p>
            <LaunchForecast projectId={selected?.id} loopId={loop.id} provider={effectiveProvider || null} className="pt-1" />
            </DialogBody>

            {launchGuard.dialog}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>{t('common:actions.cancel')}</Button>
              <Button onClick={() => launchGuard.guard(execute)} disabled={projects.length === 0}>
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
