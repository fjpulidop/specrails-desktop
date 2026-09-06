import { useTranslation } from 'react-i18next'
import { useDesktop } from '../hooks/useDesktop'
import { projectRepositories } from '../lib/project-repositories'

export function RepositoryScopeSelector({ value, onChange, disabled = false, repositories: suppliedRepositories }: {
  value?: string[]
  onChange: (repositoryIds: string[]) => void
  repositories?: import('../lib/project-repositories').ProjectRepository[]
  disabled?: boolean
}) {
  const { t } = useTranslation('common')
  const { activeProjectId, projects } = useDesktop()
  const repositories = suppliedRepositories ?? projectRepositories(projects.find((project) => project.id === activeProjectId))
  const primary = repositories.find((repository) => repository.isPrimary)
  const selected = value ?? (primary ? [primary.id] : [])
  const hasMissingSelection = selected.some((id) => !repositories.some((repository) => repository.id === id))
  if (repositories.length <= 1 && !hasMissingSelection) return null
  return <fieldset className="space-y-2" disabled={disabled}>
    <legend className="mb-1 text-xs font-medium">{t('repositories.specScope')}</legend>
    <p className="text-xs text-muted-foreground">{t('repositories.scopeHint')}</p>
    <div className="flex flex-wrap gap-2">
      {repositories.map((repository) => <label key={repository.id} title={repository.path} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
        <input type="checkbox" checked={selected.includes(repository.id)}
          disabled={disabled || (repository.kind === 'folder' && !repository.isPrimary && !selected.includes(repository.id)) || (selected.length === 1 && selected[0] === repository.id)}
          onChange={(event) => onChange(event.target.checked ? [...selected, repository.id] : selected.filter((id) => id !== repository.id))} />
        {repository.name}
        {repository.kind === 'folder' && !repository.isPrimary && <span className="text-muted-foreground">{t('repositories.contextOnly')}</span>}
      </label>)}
      {selected.filter((id) => !repositories.some((repository) => repository.id === id)).map((id) => <label key={id} className="flex items-center gap-2 rounded border border-destructive px-2 py-1.5 text-xs">
        <input type="checkbox" checked disabled={disabled || selected.length === 1} onChange={() => onChange(selected.filter((selectedId) => selectedId !== id))} />
        {t('repositories.unavailable')}: {id}
      </label>)}
    </div>
    {hasMissingSelection && <p role="alert" className="text-xs text-destructive">{t('repositories.invalidSelection')}</p>}
  </fieldset>
}
