import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Unplug } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'
import { Skeleton } from '../../../components/ui/skeleton'

// ─── Agent environment mode (inherit | minimal) ───────────────────────────────
// `inherit` (default) forwards the Desktop environment to agents unchanged.
// `minimal` forwards only a fixed allowlist, Specrails' own variables, the
// provider's auth/config names and the project's passthrough names. The status
// endpoint returns variable NAMES only; values never reach the client.

export type AgentEnvMode = 'inherit' | 'minimal'

export interface AgentEnvStatusReport {
  mode: AgentEnvMode
  names: string[]
  passthrough: string[]
  providers: Array<{ id: string; displayName: string; patterns: string[]; names: string[] }>
}

const MODES: ReadonlyArray<{ id: AgentEnvMode; icon: typeof ShieldCheck }> = [
  { id: 'inherit', icon: Unplug },
  { id: 'minimal', icon: ShieldCheck },
]

function NameChips({ names, testId }: { names: string[]; testId: string }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {names.map((name) => (
        <span key={name} data-chip className="inline-flex h-5 items-center rounded border border-border bg-background px-1.5 font-mono text-caption text-muted-foreground">
          {name}
        </span>
      ))}
    </div>
  )
}

export function ProjectAgentEnvModeSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [mode, setMode] = useState<AgentEnvMode>('inherit')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [report, setReport] = useState<AgentEnvStatusReport | null>(null)
  const [statusError, setStatusError] = useState(false)
  // Responses for a project that is no longer active are dropped.
  const activeProjectRef = useRef(activeProjectId)
  activeProjectRef.current = activeProjectId

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    setReport(null)
    setStatusError(false)
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { agentEnvMode?: AgentEnvMode } | null) => {
        if (!cancelled) setMode(data?.agentEnvMode === 'minimal' ? 'minimal' : 'inherit')
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    fetch(`${getApiBase()}/agent-env/status`)
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json() })
      .then((data: AgentEnvStatusReport) => {
        if (!cancelled) setReport(data && Array.isArray(data.names) ? data : null)
      })
      .catch(() => { if (!cancelled) setStatusError(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function choose(next: AgentEnvMode) {
    if (next === mode || saving) return
    const previous = mode
    const projectId = activeProjectRef.current
    setSaving(true)
    setMode(next)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentEnvMode: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      toast.success(t(`agentEnv.saved.${next}`))
    } catch (err) {
      if (projectId === activeProjectRef.current) setMode(previous)
      toast.error(t('agentEnv.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <Skeleton className="h-32 rounded-lg" data-testid="section-skeleton" />

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('agentEnv.title')}</CardTitle>
        <CardDescription>{t('agentEnv.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label={t('agentEnv.title')} className="grid gap-2 sm:grid-cols-2">
          {MODES.map(({ id, icon: Icon }) => {
            const selected = mode === id
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving}
                onClick={() => { void choose(id) }}
                data-testid={`agent-env-mode-${id}`}
                className={`flex gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
                <span className="space-y-0.5">
                  <span className="block text-label">{t(`agentEnv.modes.${id}.label`)}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">{t(`agentEnv.modes.${id}.description`)}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="space-y-2.5 rounded-lg border border-border/40 bg-muted/20 p-3" data-testid="agent-env-names">
          <p className="text-label text-foreground">{t('agentEnv.namesTitle')}</p>
          {statusError ? (
            <p className="text-xs text-muted-foreground">{t('agentEnv.statusUnavailable')}</p>
          ) : report ? (
            <>
              <div className="space-y-1">
                <p className="text-label text-muted-foreground">{t('agentEnv.shared')}</p>
                <NameChips names={report.names} testId="agent-env-shared" />
              </div>
              <div className="space-y-1">
                <p className="text-label text-muted-foreground">{t('agentEnv.passthrough')}</p>
                {report.passthrough.length > 0
                  ? <NameChips names={report.passthrough} testId="agent-env-passthrough" />
                  : <p className="text-xs text-muted-foreground">{t('agentEnv.noPassthrough')}</p>}
              </div>
              {report.providers.map((provider) => (
                <div key={provider.id} className="space-y-1">
                  <p className="text-label text-muted-foreground">
                    {t('agentEnv.provider', { provider: provider.displayName })}
                  </p>
                  {provider.names.length > 0
                    ? <NameChips names={provider.names} testId={`agent-env-provider-${provider.id}`} />
                    : <p className="text-xs text-muted-foreground">{t('agentEnv.noProviderNames', { patterns: provider.patterns.join(', ') || '—' })}</p>}
                </div>
              ))}
            </>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">{t('agentEnv.namesHelp')}</p>
        </div>
      </CardContent>
    </Card>
  )
}
