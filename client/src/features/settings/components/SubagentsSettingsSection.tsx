import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Bot, Coins, Layers, ShieldCheck } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { API_ORIGIN } from '../../../lib/origin'
import { useDesktop } from '../../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'

// ─── "Allow sub-agents" ───────────────────────────────────────────────────────
// Off by default. A project's setting applies to its conversational agents
// (missions, explore, refinements), never to Implement pipelines; the app-wide
// setting covers missions without a project. Missions running sub-agents
// apply a change once they finish (they show "Stop agents and apply now").

function SubagentsToggleCard({ scope, enabled, loaded, saving, onChange }: {
  scope: 'project' | 'global'
  enabled: boolean
  loaded: boolean
  saving: boolean
  onChange: (enabled: boolean) => void
}) {
  const { t } = useTranslation('settings')
  if (!loaded) return <div className="h-40 animate-pulse rounded-lg bg-muted/30" data-testid="section-skeleton" />
  const label = t(`subagents.${scope}.toggleLabel`)
  return (
    <Card data-testid={`subagents-settings-${scope}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-accent-primary" aria-hidden />
          {t('subagents.title')}
        </CardTitle>
        <CardDescription>{t(`subagents.${scope}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-xs font-medium">{label}</p>
            <p className="text-[10px] text-muted-foreground">{enabled ? t('subagents.stateOn') : t('subagents.stateOff')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={label}
            aria-checked={enabled}
            disabled={saving}
            onClick={() => onChange(!enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-input'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <ul className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <li className="flex gap-2"><Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('subagents.explainParallel')}</li>
          <li className="flex gap-2"><Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('subagents.explainCost')}</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t(`subagents.${scope}.explainScope`)}</li>
        </ul>
      </CardContent>
    </Card>
  )
}

/** Project "Allow sub-agents" (project settings route and dialog). */
export function ProjectSubagentsSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { allowSubagents?: boolean } | null) => { if (!cancelled && data) setEnabled(data.allowSubagents === true) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function save(next: boolean) {
    setSaving(true)
    setEnabled(next)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSubagents: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(next ? t('subagents.enabled') : t('subagents.disabled'))
    } catch (err) {
      setEnabled(!next)
      toast.error(t('subagents.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return <SubagentsToggleCard scope="project" enabled={enabled} loaded={loaded} saving={saving} onChange={(next) => void save(next)} />
}

/** App-wide "Allow sub-agents" for missions without a project (app settings modal). */
export function GlobalSubagentsSection() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_ORIGIN}/api/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { allowSubagents?: boolean } | null) => { if (!cancelled && data) setEnabled(data.allowSubagents === true) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  async function save(next: boolean) {
    setSaving(true)
    setEnabled(next)
    try {
      const res = await fetch(`${API_ORIGIN}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSubagents: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(next ? t('subagents.enabled') : t('subagents.disabled'))
    } catch (err) {
      setEnabled(!next)
      toast.error(t('subagents.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return <SubagentsToggleCard scope="global" enabled={enabled} loaded={loaded} saving={saving} onChange={(next) => void save(next)} />
}
