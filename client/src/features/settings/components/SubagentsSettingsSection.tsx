import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Bot, Coins, Gauge, Layers, ShieldCheck, Shuffle, Zap } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { API_ORIGIN } from '../../../lib/origin'
import { useDesktop } from '../../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { useProviderDetection } from '../../providers/hooks/useProviderDetection'
import { providerLabel, reasoningEffortsForProvider, defaultReasoningEffortForProvider } from '../../providers/lib/provider-capabilities'
import { modelsForProvider, defaultModelForProvider } from '../../loops/lib/loop-run-models'

// ─── "Allow sub-agents" ───────────────────────────────────────────────────────
// Off by default. A project's setting applies to its conversational agents
// (missions, explore, refinements), never to Implement pipelines; the app-wide
// setting covers missions without a project. Missions running sub-agents
// apply a change once they finish (they show "Stop agents and apply now").
//
// ─── "Run sub-agents with" (hybrid runtime) ───────────────────────────────────
// null = the mission agent's own provider (native sub-agents). An explicit
// provider keeps native sub-agents (with this model/effort) in missions on that
// provider; missions on another provider get Core-launched sub-agents. The
// server re-checks the choice against the running Core and falls back to
// native with a notice when it cannot be honoured.

export interface SubagentRuntimeSetting {
  provider: string
  model: string
  effort: string | null
}

/** Providers whose agents run in Core sessions (the only ones Core can launch as sub-agents). */
const SESSION_PROVIDERS = ['claude', 'codex'] as const
const SAME = '__same__'

interface SubagentSettingsState {
  enabled: boolean
  runtime: SubagentRuntimeSetting | null
  loaded: boolean
  saving: boolean
  setEnabled: (next: boolean) => void
  setRuntime: (next: SubagentRuntimeSetting | null) => void
}

/** Load and save both settings through one endpoint (project PATCH or app PUT). */
function useSubagentSettings(url: string | null, method: 'PATCH' | 'PUT'): SubagentSettingsState {
  const { t } = useTranslation('settings')
  const [enabled, setEnabledState] = useState(false)
  const [runtime, setRuntimeState] = useState<SubagentRuntimeSetting | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    setLoaded(false)
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { allowSubagents?: boolean; subagentRuntime?: SubagentRuntimeSetting | null } | null) => {
        if (cancelled || !data) return
        setEnabledState(data.allowSubagents === true)
        setRuntimeState(data.subagentRuntime ?? null)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [url])

  async function put(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(url!, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async function setEnabled(next: boolean) {
    setSaving(true)
    setEnabledState(next)
    try {
      await put({ allowSubagents: next })
      toast.success(next ? t('subagents.enabled') : t('subagents.disabled'))
    } catch (err) {
      setEnabledState(!next)
      toast.error(t('subagents.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function setRuntime(next: SubagentRuntimeSetting | null) {
    const previous = runtime
    setSaving(true)
    setRuntimeState(next)
    try {
      await put({ subagentRuntime: next })
      if (!next || next.provider !== previous?.provider) {
        toast.success(next ? t('subagents.runtime.saved', { provider: providerLabel(next.provider) }) : t('subagents.runtime.reset'))
      }
    } catch (err) {
      setRuntimeState(previous)
      toast.error(t('subagents.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return { enabled, runtime, loaded, saving, setEnabled: (next) => void setEnabled(next), setRuntime: (next) => void setRuntime(next) }
}

function SubagentRuntimePicker({ runtime, saving, onChange }: {
  runtime: SubagentRuntimeSetting | null
  saving: boolean
  onChange: (next: SubagentRuntimeSetting | null) => void
}) {
  const { t } = useTranslation('settings')
  const { detected } = useProviderDetection()
  const [confirming, setConfirming] = useState<string | null>(null)
  const providers = SESSION_PROVIDERS.filter((id) => detected.includes(id) || runtime?.provider === id)
  const models = runtime ? modelsForProvider(runtime.provider) : []
  const efforts = runtime ? reasoningEffortsForProvider(runtime.provider, runtime.model) : []

  function choose(provider: string, model = defaultModelForProvider(provider)): SubagentRuntimeSetting {
    return { provider, model, effort: defaultReasoningEffortForProvider(provider, model) ?? null }
  }

  function onProvider(value: string) {
    if (value === SAME) { onChange(null); return }
    if (value === runtime?.provider) return
    // Leaving "same as the mission agent" changes how sub-agents launch: confirm first.
    if (!runtime) { setConfirming(value); return }
    onChange(choose(value))
  }

  function onModel(model: string) {
    if (!runtime) return
    const allowed = reasoningEffortsForProvider(runtime.provider, model) as readonly string[]
    const effort = runtime.effort && allowed.includes(runtime.effort) ? runtime.effort : defaultReasoningEffortForProvider(runtime.provider, model) ?? null
    onChange({ ...runtime, model, effort })
  }

  const confirmLabel = confirming ? providerLabel(confirming) : ''
  return (
    <div className="space-y-3 rounded-lg border border-border/40 p-3" data-testid="subagent-runtime">
      <div className="space-y-0.5">
        <p className="text-xs font-medium">{t('subagents.runtime.label')}</p>
        <p className="text-[10px] text-muted-foreground">
          {runtime ? t('subagents.runtime.chosenHint', { provider: providerLabel(runtime.provider) }) : t('subagents.runtime.sameHint')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={runtime?.provider ?? SAME} onValueChange={onProvider} disabled={saving}>
          <SelectTrigger className="h-8 w-[220px] text-xs" aria-label={t('subagents.runtime.providerLabel')} data-testid="subagent-runtime-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAME} className="text-xs">{t('subagents.runtime.same')}</SelectItem>
            {providers.map((id) => <SelectItem key={id} value={id} className="text-xs">{providerLabel(id)}</SelectItem>)}
          </SelectContent>
        </Select>
        {runtime && (
          <Select value={runtime.model} onValueChange={onModel} disabled={saving || models.length === 0}>
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={t('subagents.runtime.modelLabel')} data-testid="subagent-runtime-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((entry) => <SelectItem key={entry.value} value={entry.value} className="text-xs">{entry.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {runtime && efforts.length > 0 && (
          <Select value={runtime.effort ?? ''} onValueChange={(effort) => onChange({ ...runtime, effort })} disabled={saving}>
            <SelectTrigger className="h-8 w-[130px] text-xs" aria-label={t('subagents.runtime.effortLabel')} data-testid="subagent-runtime-effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {efforts.map((level) => <SelectItem key={level} value={level} className="text-xs">{t(`agent:effort.${level}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      {runtime?.provider === 'claude' && efforts.length > 0 && (
        <p className="text-[10px] text-muted-foreground">{t('subagents.runtime.claudeEffortHint')}</p>
      )}

      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <DialogContent className="max-w-md" data-testid="subagent-runtime-confirm">
          <DialogHeader>
            <DialogTitle>{t('subagents.runtime.confirm.title', { provider: confirmLabel })}</DialogTitle>
            <DialogDescription>{t('subagents.runtime.confirm.body', { provider: confirmLabel })}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2"><Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />{t('subagents.runtime.confirm.cost')}</li>
            <li className="flex gap-2"><Shuffle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden />{t('subagents.runtime.confirm.control')}</li>
            <li className="flex gap-2"><Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('subagents.runtime.confirm.native', { provider: confirmLabel })}</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>{t('subagents.runtime.confirm.cancel')}</Button>
            <Button size="sm" data-testid="subagent-runtime-confirm-accept" onClick={() => { const provider = confirming!; setConfirming(null); onChange(choose(provider)) }}>
              {t('subagents.runtime.confirm.accept', { provider: confirmLabel })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SubagentsCard({ scope, state }: { scope: 'project' | 'global'; state: SubagentSettingsState }) {
  const { t } = useTranslation('settings')
  const { enabled, runtime, loaded, saving } = state
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
            onClick={() => state.setEnabled(!enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-input'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {enabled && <SubagentRuntimePicker runtime={runtime} saving={saving} onChange={state.setRuntime} />}
        <ul className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <li className="flex gap-2"><Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('subagents.explainParallel')}</li>
          <li className="flex gap-2"><Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('subagents.explainCost')}</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t(`subagents.${scope}.explainScope`)}</li>
        </ul>
      </CardContent>
    </Card>
  )
}

/** Project sub-agent settings (project settings route and dialog). */
export function ProjectSubagentsSection() {
  const { activeProjectId } = useDesktop()
  const state = useSubagentSettings(activeProjectId ? `${getApiBase()}/settings` : null, 'PATCH')
  return <SubagentsCard scope="project" state={state} />
}

/** App-wide sub-agent settings for missions without a project (app settings modal). */
export function GlobalSubagentsSection() {
  const state = useSubagentSettings(`${API_ORIGIN}/api/settings`, 'PUT')
  return <SubagentsCard scope="global" state={state} />
}
