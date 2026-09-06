import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderGit2, FolderOpen, Plus } from 'lucide-react'
import { useDesktop, type DesktopProject } from '../../hooks/useDesktop'
import { projectRepositories, repositoryApiBase, type ProjectRepository } from '../../lib/project-repositories'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

export function ProjectRepositoriesSection() {
  const { activeProjectId, projects, refreshProjects } = useDesktop()
  const project = projects.find((item) => item.id === activeProjectId)
  return project ? <RepositorySettings key={project.id} project={project} refreshProjects={refreshProjects} /> : null
}

function RepositorySettings({ project, refreshProjects }: { project: DesktopProject; refreshProjects?: () => Promise<void> }) {
  const { t } = useTranslation('common')
  const [repositories, setRepositories] = useState(() => projectRepositories(project))
  const [editing, setEditing] = useState<ProjectRepository | null>(null)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setRepositories(projectRepositories(project)) }, [project])
  const base = `${repositoryApiBase(project.id)}/repositories`

  function begin(repository?: ProjectRepository) {
    setError(null)
    setEditing(repository ?? null)
    setAdding(!repository)
    setPath(repository?.path ?? '')
    setName(repository?.name ?? '')
    setBranch(repository?.integrationBranch ?? '')
  }

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', repositoryId?: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(repositoryId ? `${base}/${encodeURIComponent(repositoryId)}` : base, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(method === 'DELETE' ? {} : { body: JSON.stringify({
          ...(!editing || (!editing.isPrimary && path.trim() !== editing.path) ? { path: path.trim() } : {}),
          ...(name.trim() ? { name: name.trim() } : {}), integrationBranch: branch.trim() || null,
        }) }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `HTTP ${response.status}`)
      }
      // Refresh even without a live WebSocket; the mutation was scoped to the
      // captured project, so switching projects cannot redirect it.
      const snapshot = await fetch(base, { cache: 'no-store' })
      if (!snapshot.ok) throw new Error(`HTTP ${snapshot.status}`)
      const data = await snapshot.json() as { repositories: ProjectRepository[] }
      if (mounted.current) {
        setRepositories(data.repositories)
        setAdding(false)
        setEditing(null)
      }
      await refreshProjects?.()
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><FolderGit2 className="h-4 w-4" />{t('repositories.title')}</CardTitle>
      <CardDescription>{t('repositories.sharedBacklog')}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-2">
        {repositories.map((repository) => <div key={repository.id} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{repository.name}</span>
            <span className="text-xs text-muted-foreground">{repository.isPrimary ? t('repositories.primary') : repository.kind === 'folder' ? t('repositories.contextOnly') : 'Git'}</span>
            {repository.available === false && <span className="text-xs text-destructive">{t('repositories.unavailable')}</span>}
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => begin(repository)}>{t('actions.edit')}</Button>
              {!repository.isPrimary && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate('DELETE', repository.id)}>{t('repositories.detach')}</Button>}
            </div>
          </div>
          <p className="break-all text-xs text-muted-foreground">{repository.path}</p>
          {repository.integrationBranch && <p className="mt-1 text-xs text-muted-foreground">{t('repositories.integrationBranch')}: {repository.integrationBranch}</p>}
        </div>)}
      </div>
      <p className="text-xs text-muted-foreground">{t('repositories.detachHint')}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {(adding || editing) ? <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); void mutate(editing ? 'PATCH' : 'POST', editing?.id) }}>
        <label className="block space-y-1 text-xs">{t('repositories.name')}
          <Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block space-y-1 text-xs">{t('repositories.path')}
          <div className="flex gap-2">
            <Input value={path} required disabled={busy || editing?.isPrimary} onChange={(event) => setPath(event.target.value)} />
            {'__TAURI_INTERNALS__' in window && !editing?.isPrimary && <Button type="button" variant="outline" disabled={busy} aria-label={t('repositories.browse')} onClick={async () => {
              try {
                const { open } = await import('@tauri-apps/plugin-dialog')
                const selected = await open({ directory: true, multiple: false })
                if (typeof selected === 'string' && mounted.current) setPath(selected)
              } catch { /* Manual path remains editable. */ }
            }}><FolderOpen className="h-4 w-4" /></Button>}
          </div>
        </label>
        <label className="block space-y-1 text-xs">{t('repositories.integrationBranch')}
          <Input value={branch} disabled={busy} placeholder={t('repositories.branchDefault')} onChange={(event) => setBranch(event.target.value)} />
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !path.trim()}>{busy ? t('actions.saving') : t('actions.save')}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setEditing(null); setError(null) }}>{t('actions.cancel')}</Button>
        </div>
      </form> : <Button variant="outline" size="sm" disabled={busy} onClick={() => begin()}><Plus className="mr-1 h-4 w-4" />{t('repositories.addFolder')}</Button>}
    </CardContent>
  </Card>
}
