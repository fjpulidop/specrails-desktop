import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleSlash, Eye, FileCode2, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'
import { Button } from '../../../components/ui/button'
import { Switch as UiSwitch } from '../../../components/ui/switch'

// ─── Anchoring in existing projects (feedback-2026-10 phase 3 / task 4.4) ────
// Each surface gates on the active Core's capability: without it the toggle is
// shown disabled with an "update Core" note, and nothing is forwarded to Core.

export interface Phase3Capabilities {
  architectClarifications: boolean
  specTrace: boolean
  baselineOnTouch: boolean
  rulesInventory: boolean
}

const NO_CAPABILITIES: Phase3Capabilities = { architectClarifications: false, specTrace: false, baselineOnTouch: false, rulesInventory: false }

function usePhase3Capabilities(projectId: string | null): Phase3Capabilities | null {
  const [capabilities, setCapabilities] = useState<Phase3Capabilities | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setCapabilities(null)
    fetch(`${getApiBase()}/core/phase3-capabilities`)
      .then((res) => (res.ok ? res.json() : NO_CAPABILITIES))
      .then((data: Phase3Capabilities) => { if (!cancelled) setCapabilities({ ...NO_CAPABILITIES, ...data }) })
      .catch(() => { if (!cancelled) setCapabilities(NO_CAPABILITIES) })
    return () => { cancelled = true }
  }, [projectId])
  return capabilities
}

function Switch({ checked, disabled, label, onChange, testId }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void; testId: string }) {
  return <UiSwitch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} data-testid={testId} />
}

type AnchoringKey = 'jiraPostClarifications' | 'baselineOnTouch'

/** Two opt-in switches: architect clarifications on Jira, and baseline on touch. */
export function ProjectAnchoringSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const capabilities = usePhase3Capabilities(activeProjectId)
  const [values, setValues] = useState<Record<AnchoringKey, boolean>>({ jiraPostClarifications: false, baselineOnTouch: false })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState<AnchoringKey | null>(null)

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Partial<Record<AnchoringKey, boolean>> | null) => {
        if (cancelled || !data) return
        setValues({ jiraPostClarifications: data.jiraPostClarifications === true, baselineOnTouch: data.baselineOnTouch === true })
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function save(key: AnchoringKey, next: boolean) {
    const previous = values[key]
    setSaving(key)
    setValues((current) => ({ ...current, [key]: next }))
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success(t(`anchoring.${key}.${next ? 'enabled' : 'disabled'}`))
    } catch (err) {
      setValues((current) => ({ ...current, [key]: previous }))
      toast.error(t('anchoring.saveFailed'), { description: (err as Error).message })
    } finally {
      setSaving(null)
    }
  }

  if (!loaded || !capabilities) return <div className="h-32 animate-pulse rounded-lg bg-muted/30" data-testid="section-skeleton" />

  const rows: Array<{ key: AnchoringKey; supported: boolean }> = [
    { key: 'jiraPostClarifications', supported: capabilities.architectClarifications },
    { key: 'baselineOnTouch', supported: capabilities.baselineOnTouch },
  ]
  return (
    <Card data-testid="project-anchoring-section">
      <CardHeader>
        <CardTitle>{t('anchoring.title')}</CardTitle>
        <CardDescription>{t('anchoring.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map(({ key, supported }) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-xs font-medium">{t(`anchoring.${key}.label`)}</p>
              <p className="text-[10px] text-muted-foreground">{t(`anchoring.${key}.description`)}</p>
              {!supported ? <p className="text-[10px] text-accent-warning" data-testid={`anchoring-${key}-unsupported`}>{t('anchoring.coreRequired')}</p> : null}
            </div>
            <Switch
              checked={values[key]}
              disabled={saving !== null || (!supported && !values[key])}
              label={t(`anchoring.${key}.label`)}
              onChange={(next) => void save(key, next)}
              testId={`anchoring-${key}-switch`}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ─── Project rules (task 4.4) ────────────────────────────────────────────────

type RuleStatus = 'enforcedBy' | 'automatable' | 'humanOnly' | 'unclassified'
interface ProjectRule { id: string; index: number; text: string; source: string | null; status: RuleStatus; enforcedBy: string | null; proposedCheck: string | null }
interface RulesClassification { status: string; provider: string | null; model: string | null; reason: string | null; classifiedAt: string | null }
interface RulesInventory { generatedAt: string | null; gates: Array<{ id: string; kind: string; command: string; source?: string | null }>; rules: ProjectRule[]; counts: Partial<Record<RuleStatus, number>>; classification?: RulesClassification | null; dropped: number }
/** How the latest inventory run ended (the automatic run after setup has nobody watching a toast). */
interface RulesLastRun { trigger: 'setup' | 'manual'; ok: boolean; exitCode: number | null; output: string | null; at: string }
type RulesResponse = { supported: boolean; running: boolean; lastRun?: RulesLastRun } & (
  | { state: 'missing' }
  | { state: 'invalid'; file: string; message: string }
  | { state: 'ok'; file: string; modifiedAt: string | null; inventory: RulesInventory })

/** While the server runs an inventory this panel did not start (after setup), re-read at this pace. */
const RULES_RUNNING_POLL_MS = 3000

const STATUS_ORDER: RuleStatus[] = ['automatable', 'humanOnly', 'enforcedBy', 'unclassified']
const STATUS_ICON: Record<RuleStatus, typeof Eye> = { automatable: Sparkles, humanOnly: Eye, enforcedBy: CheckCircle2, unclassified: CircleSlash }
const STATUS_TONE: Record<RuleStatus, string> = { automatable: 'text-accent-primary', humanOnly: 'text-accent-highlight', enforcedBy: 'text-accent-success', unclassified: 'text-muted-foreground' }

export function ProjectRulesSection() {
  const { t, i18n } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [data, setData] = useState<RulesResponse | null>(null)
  const [running, setRunning] = useState(false)
  const [creating, setCreating] = useState<number | null>(null)
  const [created, setCreated] = useState<Record<number, number>>({})

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch(`${getApiBase()}/rules`)
      const body = res.ok ? await res.json() as RulesResponse : null
      if (!signal?.cancelled) setData(body ?? { supported: false, running: false, state: 'missing' })
    } catch {
      if (!signal?.cancelled) setData({ supported: false, running: false, state: 'missing' })
    }
  }, [])

  useEffect(() => {
    if (!activeProjectId) return
    const signal = { cancelled: false }
    setData(null)
    setCreated({})
    void load(signal)
    return () => { signal.cancelled = true }
  }, [activeProjectId, load])

  // The automatic inventory after setup runs on the server: follow it until it ends.
  const serverRunning = Boolean(data?.running) && !running
  useEffect(() => {
    if (!serverRunning) return
    const signal = { cancelled: false }
    const timer = setInterval(() => { void load(signal) }, RULES_RUNNING_POLL_MS)
    return () => { signal.cancelled = true; clearInterval(timer) }
  }, [serverRunning, load])

  async function rerun() {
    setRunning(true)
    try {
      const res = await fetch(`${getApiBase()}/rules/inventory`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { ok?: boolean; output?: string; message?: string }
      if (!res.ok || body.ok === false) throw new Error(body.message || body.output || t('rules.inventoryFailed'))
      toast.success(t('rules.inventoryDone'))
    } catch (err) {
      toast.error(t('rules.inventoryFailed'), { description: (err as Error).message.slice(0, 300) })
    } finally {
      setRunning(false)
      await load()
    }
  }

  async function createSpec(rule: ProjectRule) {
    setCreating(rule.index)
    try {
      const res = await fetch(`${getApiBase()}/rules/specs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id }),
      })
      const body = await res.json().catch(() => ({})) as { ticket?: { id: number }; message?: string; error?: string }
      if (!res.ok || !body.ticket) throw new Error(body.message || body.error || 'Failed')
      setCreated((current) => ({ ...current, [rule.index]: body.ticket!.id }))
      toast.success(t('rules.specCreated', { id: body.ticket.id }))
    } catch (err) {
      toast.error(t('rules.specFailed'), { description: (err as Error).message })
    } finally {
      setCreating(null)
    }
  }

  const grouped = useMemo(() => {
    if (data?.state !== 'ok') return []
    return STATUS_ORDER.map((status) => ({ status, rules: data.inventory.rules.filter((rule) => rule.status === status) })).filter((group) => group.rules.length > 0)
  }, [data])

  if (!data) return <div className="h-32 animate-pulse rounded-lg bg-muted/30" data-testid="section-skeleton" />

  const busy = running || data.running
  const generatedAt = data.state === 'ok' && data.inventory.generatedAt ? new Date(data.inventory.generatedAt) : null
  return (
    <Card data-testid="project-rules-section">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>{t('rules.title')}</CardTitle>
            <CardDescription>{t('rules.description')}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => void rerun()} disabled={!data.supported || busy} data-testid="rules-rerun">
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            {busy ? t('rules.running') : t('rules.rerun')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.supported ? <p className="text-[11px] text-accent-warning" data-testid="rules-unsupported">{t('rules.coreRequired')}</p> : null}
        {data.running && !running ? <p role="status" className="text-xs text-muted-foreground" data-testid="rules-auto-running">{t('rules.autoRunning')}</p> : null}
        {!busy && data.lastRun && !data.lastRun.ok ? (
          <div role="alert" className="space-y-1 rounded-md border border-accent-warning/40 bg-accent-warning/5 p-2.5 text-xs" data-testid="rules-last-run-failed">
            <p className="font-medium text-foreground">{t(data.lastRun.trigger === 'setup' ? 'rules.lastRun.setupFailed' : 'rules.lastRun.manualFailed', { date: new Date(data.lastRun.at).toLocaleString(i18n.language) })}</p>
            {data.lastRun.output ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/75">{data.lastRun.output.split('\n').slice(-6).join('\n')}</pre> : null}
            <p className="text-foreground/75">{t('rules.lastRun.retryHint')}</p>
          </div>
        ) : null}
        {!busy && data.lastRun?.ok && data.lastRun.trigger === 'setup' ? <p className="text-[11px] text-muted-foreground" data-testid="rules-last-run-setup">{t('rules.lastRun.setupDone')}</p> : null}
        {data.state === 'missing' ? <p className="text-xs text-muted-foreground" data-testid="rules-missing">{t('rules.missing')}</p> : null}
        {data.state === 'invalid' ? <p className="text-xs text-accent-warning" data-testid="rules-invalid">{t('rules.invalid', { message: data.message })}</p> : null}
        {data.state === 'ok' ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" data-testid="rules-summary">
              {STATUS_ORDER.map((status) => (
                <span key={status} className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5">
                  {t(`rules.status.${status}`)} · {data.inventory.counts[status] ?? 0}
                </span>
              ))}
              {generatedAt ? <span>{t('rules.generatedAt', { date: generatedAt.toLocaleString(i18n.language) })}</span> : null}
            </div>
            {data.inventory.classification && !['classified', 'cached'].includes(data.inventory.classification.status) ? (
              <p className="text-[11px] text-accent-warning" data-testid="rules-classification">
                {t(`rules.classification.${['offline', 'unavailable', 'failed', 'empty'].includes(data.inventory.classification.status) ? data.inventory.classification.status : 'unknown'}`)}
                {data.inventory.classification.reason ? ` ${data.inventory.classification.reason}` : ''}
              </p>
            ) : null}
            {data.inventory.gates.length > 0 ? (
              <div>
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('rules.gates', { count: data.inventory.gates.length })}</h3>
                <ul className="space-y-1" data-testid="rules-gates">
                  {data.inventory.gates.map((gate) => (
                    <li key={gate.id} className="flex items-center gap-2 text-xs">
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="text-muted-foreground">{gate.kind}</span>
                      <code className="min-w-0 truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]" title={gate.command}>{gate.command}</code>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[10px] text-muted-foreground">{t('rules.gatesHint')}</p>
              </div>
            ) : null}
            {grouped.map(({ status, rules }) => {
              const Icon = STATUS_ICON[status]
              return (
                <div key={status}>
                  <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    <Icon className={`h-3.5 w-3.5 ${STATUS_TONE[status]}`} aria-hidden />
                    {t(`rules.status.${status}`)} · {rules.length}
                  </h3>
                  <ul className="space-y-2" data-testid={`rules-${status}`}>
                    {rules.map((rule) => (
                      <li key={rule.index} className="rounded-md border border-border/40 bg-muted/10 px-3 py-2">
                        <p className="text-xs text-foreground">{rule.text}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                          {rule.source ? <span className="font-mono">{rule.source}</span> : null}
                          {rule.enforcedBy ? <span>{t('rules.enforcedBy', { check: rule.enforcedBy })}</span> : null}
                          {rule.proposedCheck ? <span>{t('rules.proposedCheck', { check: rule.proposedCheck })}</span> : null}
                        </div>
                        {status === 'automatable' ? (
                          <div className="mt-2">
                            {created[rule.index] !== undefined ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-accent-success" data-testid={`rules-created-${rule.index}`}>
                                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {t('rules.specCreated', { id: created[rule.index] })}
                              </span>
                            ) : (
                              <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={!data.supported || creating !== null} onClick={() => void createSpec(rule)} data-testid={`rules-create-${rule.index}`}>
                                {creating === rule.index ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3 w-3" aria-hidden />}
                                {t('rules.createSpec')}
                              </Button>
                            )}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
            {data.inventory.dropped > 0 ? (
              <p className="flex items-center gap-1 text-[10px] text-muted-foreground"><CircleSlash className="h-3 w-3" aria-hidden />{t('rules.dropped', { count: data.inventory.dropped })}</p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
