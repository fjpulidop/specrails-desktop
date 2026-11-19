import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'
import { Switch } from '../../../components/ui/switch'
import { Skeleton } from '../../../components/ui/skeleton'
import { notifyError } from '../../../lib/notify-error'

// ─── Environment files in runs (`worktreeEnvFiles`, off by default) ───────────
// Copies the project's gitignored `.env` files from each repository into every
// run worktree. Only the setting crosses the wire; file names and values never do.

export function ProjectEnvFilesSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  // Responses for a project that is no longer active are dropped.
  const activeProjectRef = useRef(activeProjectId)
  activeProjectRef.current = activeProjectId

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { worktreeEnvFiles?: boolean } | null) => { if (!cancelled) setEnabled(data?.worktreeEnvFiles === true) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function save(next: boolean) {
    if (saving) return
    const projectId = activeProjectRef.current
    setSaving(true)
    setEnabled(next)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeEnvFiles: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t(next ? 'envFiles.enabled' : 'envFiles.disabled'))
    } catch (err) {
      if (projectId === activeProjectRef.current) setEnabled(!next)
      notifyError(t('envFiles.saveFailed'), { detail: (err as Error).message, retry: () => void save(next) })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <Skeleton className="h-32 rounded-lg" data-testid="section-skeleton" />

  return (
    <Card data-testid="project-env-files-section">
      <CardHeader>
        <CardTitle>{t('envFiles.title')}</CardTitle>
        <CardDescription>{t('envFiles.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-label">{t('envFiles.label')}</p>
            <p className="text-xs text-muted-foreground" data-testid="env-files-consequence">{t('envFiles.consequence')}</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(next) => void save(next)}
            disabled={saving}
            aria-label={t('envFiles.label')}
            data-testid="env-files-switch"
          />
        </div>
      </CardContent>
    </Card>
  )
}
