import { useTranslation } from 'react-i18next'
import { useDesktop } from '../../../hooks/useDesktop'
import { projectRepositories } from '../lib/project-repositories'

export function RepositoryScopeSelector({ value, onChange, disabled = false, repositories: suppliedRepositories, workspaceOnly = false, workspaceSelection, onWorkspaceChange, showSingle = false, label, hint }: {
  value?: string[]
  onChange: (repositoryIds: string[]) => void
  repositories?: import('../lib/project-repositories').ProjectRepository[]
  disabled?: boolean
  workspaceOnly?: boolean
  workspaceSelection?: Record<string, string[]>
  onWorkspaceChange?: (selection: Record<string, string[]>) => void
  showSingle?: boolean
  label?: string
  hint?: string
}) {
  const { t } = useTranslation('common')
  const { activeProjectId, projects } = useDesktop()
  const repositories = suppliedRepositories ?? projectRepositories(projects.find((project) => project.id === activeProjectId))
  const primary = repositories.find((repository) => repository.isPrimary)
  const selected = value ?? (primary ? [primary.id] : [])
  const hasMissingSelection = selected.some((id) => !repositories.some((repository) => repository.id === id))
  if (workspaceOnly) {
    const members = repositories.filter(member => selected.includes(member.id) && (member.workspacePaths?.length || member.workspacePath))
    if (!members.length) return null
    return <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium">{t('repositories.launchWorkspaces')}</legend>
      <p className="text-xs text-muted-foreground">{t('repositories.launchWorkspaceHint')}</p>
      {members.map(member => {
        const paths = member.workspacePaths ?? [member.workspacePath!]
        const chosen = workspaceSelection?.[member.id] ?? paths
        return <div key={member.id} className="space-y-1">
          <span className="text-xs font-medium">{member.name}</span>
          {paths.map(path => <label key={path} className="flex items-center gap-2 text-xs" title={path}>
            <input type="checkbox" data-agent-interactive checked={chosen.includes(path)} disabled={disabled || (chosen.length === 1 && chosen[0] === path)} onChange={event => onWorkspaceChange?.({ ...Object.fromEntries(Object.entries(workspaceSelection ?? {}).filter(([id]) => selected.includes(id))), [member.id]: event.target.checked ? [...chosen, path] : chosen.filter(item => item !== path) })} />
            <span className="break-all">{path}</span>
          </label>)}
        </div>
      })}
    </fieldset>
  }
  if (!showSingle && repositories.length <= 1 && !hasMissingSelection) return null
  return <fieldset className="space-y-2" disabled={disabled}>
    <legend className="mb-1 text-xs font-medium">{label ?? t('repositories.specScope')}</legend>
    <p className="text-xs text-muted-foreground">{hint ?? t('repositories.scopeHint')}</p>
    <div className="flex flex-wrap gap-2">
      {repositories.map((repository) => <label key={repository.id} title={repository.workspacePaths?.join('\n') ?? repository.workspacePath ?? repository.path} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
        <input type="checkbox" data-agent-interactive checked={selected.includes(repository.id)}
          aria-label={repository.available === false ? `${t('repositories.unavailable')}: ${repository.name}` : undefined}
          disabled={disabled || ((repository.available === false || (repository.kind === 'folder' && !repository.isPrimary)) && !selected.includes(repository.id)) || (selected.length === 1 && selected[0] === repository.id)}
          onChange={(event) => onChange(event.target.checked ? [...selected, repository.id] : selected.filter((id) => id !== repository.id))} />
        <span>{repository.name}</span>
        {repository.available === false && <span className="text-destructive">{' '}{t('repositories.unavailable')}</span>}
        {repository.workspacePaths?.map(workspace => <span key={workspace} className="text-muted-foreground">{workspace}</span>)}
        {!repository.workspacePaths && repository.workspacePath && <span className="text-muted-foreground">{repository.workspacePath}</span>}
        {repository.kind === 'folder' && !repository.isPrimary && <span className="text-muted-foreground">{t('repositories.contextOnly')}</span>}
      </label>)}
      {selected.filter((id) => !repositories.some((repository) => repository.id === id)).map((id) => <label key={id} className="flex items-center gap-2 rounded border border-destructive px-2 py-1.5 text-xs">
        <input type="checkbox" data-agent-interactive checked disabled={disabled || selected.length === 1} onChange={() => onChange(selected.filter((selectedId) => selectedId !== id))} />
        {t('repositories.unavailable')}: {id}
      </label>)}
    </div>
    {hasMissingSelection && <p role="alert" className="text-xs text-destructive">{t('repositories.invalidSelection')}</p>}
  </fieldset>
}
