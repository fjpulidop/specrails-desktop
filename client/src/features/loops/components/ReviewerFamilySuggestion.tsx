import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Shuffle } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useDesktop } from '../../../hooks/useDesktop'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import { useAvailableProviders } from '../../providers/hooks/useAvailableProviders'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { suggestReviewerProvider } from '../lib/reviewer-family-suggestion'
import type { LoopAgentConfig } from '../lib/loops-api'

/**
 * Non-blocking hint: with two or more usable providers and the reviewer on the
 * developer's provider, offer to move the reviewer to another model family.
 * Applying only edits the loop draft (the editor's normal save flow persists it);
 * dismissing is remembered per project.
 */
export function ReviewerFamilySuggestion({ value, onChange }: { value: LoopAgentConfig; onChange(value: LoopAgentConfig): void }) {
  const { t } = useTranslation('agentRuntime')
  const { activeProjectId, projects } = useDesktop()
  const projectProvider = projects?.find(project => project.id === activeProjectId)?.provider ?? 'claude'
  const catalog = useAvailableProviders()
  // null = not loaded yet: never flash the card before the stored dismissal is known.
  const [dismissed, setDismissed] = useState<boolean | null>(activeProjectId ? null : false)
  const currentProject = useRef(activeProjectId)
  currentProject.current = activeProjectId

  useEffect(() => {
    if (!activeProjectId) { setDismissed(false); return }
    let cancelled = false
    setDismissed(null)
    fetch(`${repositoryApiBase(activeProjectId)}/settings`)
      .then(response => response.ok ? response.json() as Promise<{ reviewerFamilySuggestionDismissed?: unknown }> : null)
      .then(data => { if (!cancelled) setDismissed(data?.reviewerFamilySuggestionDismissed === true) })
      .catch(() => { if (!cancelled) setDismissed(false) })
    return () => { cancelled = true }
  }, [activeProjectId])

  const suggested = catalog.loading ? null : suggestReviewerProvider(value.agents, projectProvider, catalog.availableIds)
  if (!suggested || dismissed !== false) return null
  const name = catalog.labels[suggested] ?? providerLabel(suggested)

  function apply() {
    // Models and efforts are provider-specific: carry over only the turn budget, like the provider picker.
    const maxTurns = value.agents.reviewer?.maxTurns
    onChange({ ...value, agents: { ...value.agents, reviewer: { provider: suggested!, ...(maxTurns ? { maxTurns } : {}) } } })
  }

  function dismiss() {
    setDismissed(true)
    const projectId = activeProjectId
    if (!projectId) return
    void fetch(`${repositoryApiBase(projectId)}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewerFamilySuggestionDismissed: true }),
    }).then(response => { if (!response.ok && currentProject.current === projectId) setDismissed(false) })
      .catch(() => { if (currentProject.current === projectId) setDismissed(false) })
  }

  return <div role="note" aria-label={t('reviewerSuggestion.label')} data-testid="reviewer-family-suggestion" className="flex items-start gap-3 rounded-md border border-accent-info/30 bg-accent-info/10 p-3">
    <Shuffle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent-info" />
    <div className="min-w-0 flex-1 space-y-2">
      <p className="text-xs font-medium text-foreground">{t('reviewerSuggestion.title', { provider: name })}</p>
      <p className="text-xs text-muted-foreground">{t('reviewerSuggestion.body')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={apply}>{t('reviewerSuggestion.apply', { provider: name })}</Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>{t('reviewerSuggestion.dismiss')}</Button>
      </div>
    </div>
  </div>
}
