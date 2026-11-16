import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Rocket } from 'lucide-react'
import { getApiBase } from '../../../../lib/api'
import { Button } from '../../../../components/ui/button'
import { SelectionControls, isMilestoneSelectionAvailable, type Settings, type MilestoneGenerationSelection } from './MilestoneGenerationControls'

/** Per-launch execution choice, independent of blueprint generation defaults. */
export function MilestoneLaunchControls({ projectId, busy, onLaunch, testId = 'launch-m1' }: {
  projectId: string
  busy: boolean
  onLaunch: (selection: MilestoneGenerationSelection) => void
  testId?: string
}) {
  const { t } = useTranslation('builder')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [selection, setSelection] = useState<MilestoneGenerationSelection | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setSettings(null)
    setSelection(null)
    setFailed(false)
    fetch(`${getApiBase(projectId)}/blueprint/launch-settings`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('catalog unavailable')
        return response.json() as Promise<Settings>
      })
      .then((data) => {
        if (controller.signal.aborted) return
        setSettings(data)
        setSelection(data.selection)
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [projectId, revision])

  const ready = isMilestoneSelectionAvailable(selection, settings?.providers ?? [])
  return (
    <div className="space-y-2 text-left" data-testid="milestone-launch-controls">
      <p className="text-xs font-medium">{t('execution.configuration')}</p>
      <p className="text-xs text-muted-foreground">{t('execution.hint')}</p>
      {selection && <SelectionControls value={selection} catalog={settings?.providers ?? []}
        onChange={setSelection} disabled={busy} prefix="milestone-launch" />}
      {failed && <p role="alert" className="text-xs text-destructive">{t('execution.failed')}</p>}
      {failed && <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>{t('execution.retry')}</Button>}
      {settings && !ready && <p role="status" className="text-xs text-accent-warning">{t('generation.unavailable')}</p>}
      <Button className="w-full" onClick={() => { if (ready && selection) onLaunch({ ...selection }) }}
        disabled={busy || !ready} data-testid={testId}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
        {t('done.launchM1')}
      </Button>
    </div>
  )
}
