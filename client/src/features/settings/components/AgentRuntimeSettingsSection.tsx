import { RuntimeEfficiencyControls, RuntimeRoleEfficiency, type RoleCapability } from './RuntimeEfficiencyControls'
import { useEffect, useRef, useState } from 'react'
import { Layers, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDesktop } from '../../../hooks/useDesktop'
import { LoopRoleFields, loopRoleEffectiveModel, useLoopRoles, type LoopRole } from './LoopRolesSection'
import { PHASE_GROUP_IDS, PHASE_GROUPS, PIPELINE_PHASES, PhaseCard, PhaseGroupHeading, PipelineStepper, type PhaseEngine, type PipelinePhase } from './PipelineStepper'
import { isLocalEngineId, providerLabel } from '../../providers/lib/provider-capabilities'
import { ProviderTabs } from './ProviderTabs'
import { RuntimeGuardrails } from './RuntimeGuardrails'
import { repositoryApiBase, projectRepositories } from '../../projects/lib/project-repositories'
import { defaultModelForProvider, modelsForProvider } from '../../loops/lib/loop-run-models'
import { useProviderDetection } from '../../providers/hooks/useProviderDetection'
import {
  ARCHITECT_LOW_CONFIDENCE_POLICIES, REVIEW_ASPECTS, REVIEW_THRESHOLD_DEFAULTS, RUNTIME_DEFAULTS, RUNTIME_ROLES, formatVerificationCommand, isAgentRuntimeSettingsResponse, isVerificationSuggestionsResponse, parseVerificationCommand,
  type AgentRuntimeConfig, type AgentRuntimeSettingsResponse, type ArchitectLowConfidencePolicy, type ReviewAspect, type RuntimeAgent, type RuntimeAgentRole, type RuntimeProvider, type RuntimeVerificationCommand, type VerificationSuggestion,
} from '../lib/agent-runtime'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'
interface VerificationRow { label?: string; original?: RuntimeVerificationCommand; repositoryId: string; line: string; reason?: string }

/**
 * Scroll ONLY the nearest scrollable ancestor (the settings modal body), never
 * the window: `scrollIntoView` also moved the page and left the modal cut off
 * at the bottom when it was already at the top of the viewport.
 */
function scrollWithinContainer(target: HTMLElement): void {
  let container: HTMLElement | null = target.parentElement
  while (container && container !== document.body) {
    const style = getComputedStyle(container)
    if (/(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight) break
    container = container.parentElement
  }
  if (!container || container === document.body) { target.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); return }
  const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12
  if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior: 'smooth' })
  else container.scrollTop = top
}

export function AgentRuntimeSettingsSection() {
  const { activeProjectId, projects } = useDesktop()
  const cache = useRef(new Map<string, AgentRuntimeSettingsResponse>())
  const project = projects.find((item) => item.id === activeProjectId)
  return activeProjectId ? <RuntimeSettings key={activeProjectId} projectId={activeProjectId} cache={cache.current}
    projectProviderIds={project?.providers?.length ? project.providers : project?.provider ? [project.provider] : []}
    repositories={projectRepositories(project).map(({ id, name }) => ({ id, name }))} /> : null
}

function rowsFrom(commands: RuntimeVerificationCommand[]): VerificationRow[] {
  return commands.map((command) => ({ original: command, label: command.label, repositoryId: command.repositoryId, line: formatVerificationCommand(command) }))
}
function rowsFromSuggestions(suggestions: VerificationSuggestion[]): VerificationRow[] {
  return suggestions.map((suggestion) => ({ repositoryId: suggestion.repositoryId, line: formatVerificationCommand(suggestion), reason: suggestion.reason }))
}
function minutes(ms: number | undefined): string { return ms === undefined ? '' : String(Math.round((ms / 60_000) * 100) / 100) }

function RuntimeSettings({ projectId, cache, repositories, projectProviderIds }: {
  projectId: string
  cache: Map<string, AgentRuntimeSettingsResponse>
  repositories: Array<{ id: string; name: string }>
  /** The project's detected provider ids (primary first) for the loop roles. */
  projectProviderIds: readonly string[]
}) {
  const { t } = useTranslation(['agentRuntime', 'agents'])
  const detection = useProviderDetection()
  const cached = cache.get(projectId)
  const [snapshot, setSnapshot] = useState<AgentRuntimeSettingsResponse | null>(cached ?? null)
  const [config, setConfig] = useState<AgentRuntimeConfig | null>(cached?.config ?? null)
  const [rows, setRows] = useState<VerificationRow[]>(rowsFrom(cached?.config.verification ?? []))
  const [capabilities, setCapabilities] = useState<RoleCapability[]>([])
  const [checkingCapabilities, setCheckingCapabilities] = useState(false)
  const [capabilityError, setCapabilityError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<'none' | 'some' | null>(null)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  /** Reactive mirror of the `dirty` ref: drives the floating save pill. */
  const [unsaved, setUnsaved] = useState(false)
  const [reload, setReload] = useState(0)
  const [activePhase, setActivePhase] = useState<PipelinePhase | null>(null)
  const [openPhases, setOpenPhases] = useState<Record<PipelinePhase, boolean>>(() => Object.fromEntries(PIPELINE_PHASES.map((phase) => [phase, true])) as Record<PipelinePhase, boolean>)
  const phaseRefs = useRef<Partial<Record<PipelinePhase, HTMLFieldSetElement | null>>>({})
  // Loop-side roles for `roles` rail launches. Save on their own (per-change
  // PUT), independent of this form's Save. Provider choices = the project's
  // detected providers, falling back to the runtime connection ids.
  const loopRoles = useLoopRoles(projectId)
  const dirty = useRef(false)
  const mounted = useRef(true)
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/config`
  const capabilityRequest = useRef(0)
  const currentConfig = useRef(config)
  currentConfig.current = config
  // Effort/turn-limit edits must not discard the options for the same model.
  const capabilitySelection = JSON.stringify([projectId, config?.providers, config && RUNTIME_ROLES.map(role => {
    const agent = config.agents[role]
    return [role, agent.provider, agent.model ?? null, agent.escalation?.model || null]
  }), config?.fixer ? ['fixer', config.fixer.provider, config.fixer.model ?? null, config.fixer.escalation?.model || null] : null])
  async function checkCapabilities(signal?: AbortSignal) {
    if (!currentConfig.current) return
    const selected = structuredClone(currentConfig.current)
    for (const agent of [...Object.values(selected.agents), ...(selected.fixer ? [selected.fixer] : [])]) if (agent.escalation && !agent.escalation.model.trim()) delete agent.escalation
    const requestId = ++capabilityRequest.current
    setCheckingCapabilities(true); setCapabilityError(false)
    try {
      const response = await fetch(`${repositoryApiBase(projectId)}/agent-runtime/capabilities`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal })
      const data = await response.json()
      if (!response.ok || data.schemaVersion !== 1 || !Array.isArray(data.roles)) throw new Error('capabilities')
      if (mounted.current && !signal?.aborted && requestId === capabilityRequest.current) setCapabilities(data.roles)
    } catch {
      if (mounted.current && !signal?.aborted && requestId === capabilityRequest.current) { setCapabilities([]); setCapabilityError(true) }
    } finally {
      if (mounted.current && !signal?.aborted && requestId === capabilityRequest.current) setCheckingCapabilities(false)
    }
  }
  useEffect(() => {
    capabilityRequest.current++; setCapabilities([]); setCapabilityError(false)
    const selected = currentConfig.current
    if (!selected || snapshot?.efficiencyAvailable === false) {
      setCheckingCapabilities(false)
      return
    }
    const controller = new AbortController()
    setCheckingCapabilities(true)
    const timer = setTimeout(() => { void checkCapabilities(controller.signal) }, 250)
    return () => { clearTimeout(timer); controller.abort(); capabilityRequest.current++ }
    // The identity excludes effort, so selecting an effort keeps confirmed options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilitySelection, snapshot?.efficiencyAvailable, reload])
  const suggestionsEndpoint = `${repositoryApiBase(projectId)}/agent-runtime/verification-suggestions`

  async function detect(): Promise<VerificationSuggestion[] | null> {
    try {
      const response = await fetch(suggestionsEndpoint, { cache: 'no-store' })
      if (!response.ok) return null
      const data = await response.json() as unknown
      return isVerificationSuggestionsResponse(data) ? data.suggestions : null
    } catch { return null }
  }

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    fetch(endpoint, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(t('loadFailed'))
      const data = await response.json() as AgentRuntimeSettingsResponse
      if (!isAgentRuntimeSettingsResponse(data)) throw new Error(t('loadFailed'))
      if (cancelled) return
      cache.set(projectId, data)
      setSnapshot(data)
      if (!dirty.current) {
        setConfig(data.config)
        setRows(rowsFrom(data.config.verification))
        // A project that never saved runtime settings starts from its own
        // detected checks, so nothing has to be typed to get a verified run.
        if (!data.configured && data.config.verification.length === 0) {
          const suggestions = await detect()
          if (cancelled || dirty.current) return
          if (suggestions?.length) { setRows(rowsFromSuggestions(suggestions)); setDetected('some') }
          else if (suggestions) setDetected('none')
        }
      }
      setError('')
    }).catch(() => { if (!cancelled) setError(t('loadFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, projectId, cache, reload, t])

  function update(next: AgentRuntimeConfig) {
    dirty.current = true
    setSaved(false); setUnsaved(true)
    setConfig(next)
  }
  function updateRows(next: VerificationRow[]) {
    dirty.current = true
    setSaved(false); setUnsaved(true)
    setRows(next)
  }

  /** Tab shape: the human name up front, the id / base URL as muted detail (tooltip + local badge). */
  function providerTab(provider: RuntimeProvider) {
    if (provider.kind === 'cli') return { value: provider.id, label: t(`cliNames.${provider.cli}`), detail: provider.id, name: `${t(`cliNames.${provider.cli}`)} (${provider.id})` }
    const name = provider.label?.trim()
    return { value: provider.id, label: name || provider.id, detail: name ? `${provider.id} · ${provider.baseUrl}` : provider.baseUrl, local: true, name: name ? `${name} (${provider.id}) · ${provider.baseUrl}` : `${provider.id} · ${provider.baseUrl}` }
  }
  /** Models a local engine discovered (detection status, else the loop-run dynamic catalog). */
  function localModels(provider: RuntimeProvider): string[] {
    if (provider.kind !== 'openai-compatible') return []
    const detected = detection.providers[provider.id]?.models
    const list = detected && detected.length ? detected : modelsForProvider(provider.id).map((model) => model.value)
    return provider.defaultModel && !list.includes(provider.defaultModel) ? [provider.defaultModel, ...list] : list
  }

  function readVerification(): RuntimeVerificationCommand[] | null {
    const commands: RuntimeVerificationCommand[] = []
    for (const row of rows) {
      if (!row.line.trim() && !row.repositoryId) continue
      const parsed = parseVerificationCommand(row.line)
      if (!parsed || !row.repositoryId) { setError(t('verification.invalidLine', { line: row.line || '∅' })); return null }
      commands.push({ ...row.original, ...(row.label !== undefined ? { label: row.label.trim() || undefined } : {}), repositoryId: row.repositoryId, ...parsed })
    }
    return commands
  }

  async function detectNow() {
    setDetecting(true); setError('')
    try {
      const suggestions = await detect()
      if (!mounted.current) return
      if (!suggestions) { setError(t('verification.detectFailed')); return }
      const known = new Set(rows.map((row) => `${row.repositoryId}\0${row.line}`))
      const fresh = rowsFromSuggestions(suggestions).filter((row) => !known.has(`${row.repositoryId}\0${row.line}`))
      updateRows([...rows, ...fresh])
      setDetected(suggestions.length ? 'some' : 'none')
    } finally { if (mounted.current) setDetecting(false) }
  }

  async function save() {
    if (!config || busy) return
    setError('')
    setSaved(false)
    const commands = readVerification()
    if (!commands) return
    setBusy(true)
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, verification: commands }) })
      const data = await response.json() as AgentRuntimeSettingsResponse & { error?: string; message?: string }
      if (!response.ok) throw new Error(data.message ?? data.error ?? t('saveFailed'))
      if (!isAgentRuntimeSettingsResponse(data)) throw new Error(t('saveFailed'))
      cache.set(projectId, data)
      if (!mounted.current) return
      dirty.current = false; setUnsaved(false)
      setSnapshot(data); setConfig(data.config); setRows(rowsFrom(data.config.verification)); setSaved(true)
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : t('saveFailed')) }
    finally { if (mounted.current) setBusy(false) }
  }

  const limits = config?.limits ?? {}
  const setLimit = (key: 'maxAttempts' | 'maxTokens' | 'maxCostUsd' | 'timeoutMs', raw: string, scale = 1) => {
    if (!config) return
    const next = { ...config.limits }
    if (raw === '') delete next[key]
    else next[key] = key === 'maxCostUsd' ? Number(raw) : Math.round(Number(raw) * scale)
    update({ ...config, limits: Object.keys(next).length ? next : undefined })
  }

  // Empty review/architect fields omit the key so Core applies its own default.
  const review = config?.review ?? {}
  const setReviewScore = (aspect: ReviewAspect | 'minScore', raw: string) => {
    if (!config) return
    const value = raw === '' ? undefined : Number(raw)
    const aspects = { ...review.aspects }
    if (aspect !== 'minScore') { if (value === undefined) delete aspects[aspect]; else aspects[aspect] = value }
    const next: NonNullable<AgentRuntimeConfig['review']> = {}
    const minScore = aspect === 'minScore' ? value : review.minScore
    if (minScore !== undefined) next.minScore = minScore
    if (Object.keys(aspects).length) next.aspects = aspects
    update({ ...config, review: Object.keys(next).length ? next : undefined })
  }
  const setLowConfidence = (raw: string) => {
    if (!config) return
    update({ ...config, architect: raw ? { onLowConfidence: raw as ArchitectLowConfidencePolicy } : undefined })
  }

  const loopProviders = projectProviderIds.length ? projectProviderIds : (config?.providers ?? []).map((item) => item.id)
  const loopEnabled = !!config?.enabled && snapshot?.runtimeAvailable !== false

  /** Live engine summary per phase, from the CURRENT (possibly unsaved) form state. */
  function phaseEngine(phase: PipelinePhase): PhaseEngine {
    if (!config) return { kind: 'inherit' }
    if (phase === 'verification') return { kind: 'host', command: rows.find((row) => row.line.trim())?.line.trim() ?? null }
    if (phase === 'verifier' || phase === 'decider') {
      const engine = loopRoles.roles?.[phase]
      if (!engine) return { kind: 'inherit' }
      return { kind: 'ai', label: providerLabel(engine.provider), model: loopRoleEffectiveModel(engine), effort: engine.effort ?? null, local: isLocalEngineId(engine.provider) }
    }
    if (phase === 'fixer' && !config.fixer) return { kind: 'inherit-developer' }
    const agent = phase === 'fixer' ? config.fixer! : config.agents[phase]
    const provider = config.providers.find((item) => item.id === agent.provider)
    const label = provider ? providerTab(provider).label : agent.provider
    const local = provider?.kind === 'openai-compatible'
    const model = agent.model ?? (provider?.kind === 'cli' ? defaultModelForProvider(provider.cli) : provider?.defaultModel) ?? null
    return { kind: 'ai', label, model, effort: agent.effort ?? null, local }
  }
  const steps = PIPELINE_PHASES.map((id) => ({ id, engine: phaseEngine(id) }))
  function selectPhase(phase: PipelinePhase) {
    setActivePhase(phase)
    setOpenPhases((prev) => ({ ...prev, [phase]: true }))
    const target = phaseRefs.current[phase]
    if (target) scrollWithinContainer(target)
  }
  function togglePhase(phase: PipelinePhase) {
    setActivePhase(phase)
    setOpenPhases((prev) => ({ ...prev, [phase]: !prev[phase] }))
  }

  /** Provider/model/turns/effort/escalation for a runtime role; the fixer edits `config.fixer` instead of an `agents` entry. */
  function renderRuntimeRole(role: RuntimeAgentRole) {
    if (!config) return null
    const agent = role === 'fixer' ? config.fixer : config.agents[role]
    if (!agent) return null
    const provider = config.providers.find((item) => item.id === agent.provider)
    const setAgent = (next: RuntimeAgent) => update(role === 'fixer' ? { ...config, fixer: next } : { ...config, agents: { ...config.agents, [role]: next } })
    const catalog = provider?.kind === 'cli' ? modelsForProvider(provider.cli) : []
    const fallback = provider?.kind === 'cli' ? defaultModelForProvider(provider.cli) : ''
    const unknownModel = agent.model && !catalog.some((model) => model.value === agent.model) ? agent.model : null
    return <>
      {role !== 'fixer' && <p className="mb-2 text-xs text-muted-foreground">{t(`roleHints.${role}`)}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <fieldset className="space-y-2 sm:col-span-3"><legend className="text-xs">{t('agents.provider')}</legend>
          <ProviderTabs
            name={`runtime-${role}-provider`}
            value={agent.provider}
            ariaLabel={t('agents.provider')}
            tabs={config.providers.map((item) => providerTab(item))}
            onChange={(id) => setAgent({ ...agent, provider: id, model: undefined, effort: undefined, thinking: undefined, escalation: undefined })}
          />
        </fieldset>
        {provider?.kind === 'cli'
          ? <label className="space-y-1 text-xs">{t('agents.model')}<select className={selectClass} value={agent.model ?? ''} onChange={(event) => setAgent({ ...agent, model: event.target.value || undefined })}>
            <option value="">{t('agents.defaultModel', { model: catalog.find((model) => model.value === fallback)?.label ?? fallback })}</option>
            {catalog.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            {unknownModel && <option value={unknownModel}>{unknownModel}</option>}
          </select></label>
          : <label className="space-y-1 text-xs">{t('agents.model')}
            <Input value={agent.model ?? ''} list={provider ? `runtime-${role}-models-${provider.id}` : undefined}
              placeholder={provider?.kind === 'openai-compatible' && provider.defaultModel ? t('agents.defaultModel', { model: provider.defaultModel }) : t('agents.modelPlaceholder')}
              onChange={(event) => setAgent({ ...agent, model: event.target.value || undefined })} />
            {provider && <datalist id={`runtime-${role}-models-${provider.id}`} data-testid={`runtime-${role}-models`}>{localModels(provider).map((model) => <option key={model} value={model} />)}</datalist>}
          </label>}
        <label className="space-y-1 text-xs">{t('agents.maxTurns', { turns: RUNTIME_DEFAULTS.maxTurns })}<Input type="number" min="1" step="1" placeholder={String(RUNTIME_DEFAULTS.maxTurns)} value={agent.maxTurns ?? ''} onChange={(event) => setAgent({ ...agent, maxTurns: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
        {provider?.kind === 'openai-compatible' && <fieldset className="space-y-1 text-xs"><legend className="text-xs">{t('agents.thinking')}</legend>
          <div role="radiogroup" aria-label={t('agents.thinking')} data-testid={`runtime-${role}-thinking`} className="flex w-full max-w-[12rem] rounded-lg border border-border bg-background/60 p-0.5">
            {(['off', 'on'] as const).map((value) => {
              const selected = (agent.thinking ?? 'off') === value
              return <label key={value} className={`relative flex min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1.5 transition-colors ${selected ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60'}`}>
                <input type="radio" name={`runtime-${role}-thinking`} className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0" value={value} checked={selected} onChange={() => { const next = { ...agent }; if (value === 'on') next.thinking = 'on'; else delete next.thinking; setAgent(next) }} />
                <span className="truncate">{t(`agents.thinking_${value}`)}</span>
              </label>
            })}
          </div>
          <span className="block text-[11px] text-muted-foreground">{t('agents.thinkingHint')}</span>
        </fieldset>}
      </div>
      <fieldset disabled={snapshot?.efficiencyAvailable === false}><RuntimeRoleEfficiency role={role} agent={agent} capabilities={capabilities} onChange={setAgent} /></fieldset>
    </>
  }

  /**
   * Fixer card: "Inherit developer" (no `config.fixer`, the default) vs "Own
   * engine" (seeded from the developer's current provider/model, then the same
   * fields as any runtime role).
   */
  function renderFixer() {
    if (!config) return null
    const own = Boolean(config.fixer)
    const setMode = (next: 'inherit' | 'own') => {
      if ((next === 'own') === own) return
      if (next === 'inherit') { const rest = { ...config }; delete rest.fixer; update(rest); return }
      const developer = config.agents.developer
      update({ ...config, fixer: { provider: developer.provider, ...(developer.model ? { model: developer.model } : {}) } })
    }
    const option = (value: 'inherit' | 'own', label: string) => {
      const selected = (value === 'own') === own
      return <label className={`relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${selected ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
        {/* Not sr-only: a hidden radio positioned off its box scrolls the settings dialog to its static position when focused (the blank modal); the input covers its own label instead. */}
        <input type="radio" name="runtime-fixer-mode" className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0" value={value} checked={selected} onChange={() => setMode(value)} />
        {value === 'own' && <Wrench className="h-3 w-3 shrink-0" aria-hidden />}
        <span className="truncate">{label}</span>
      </label>
    }
    return <>
      <p className="mb-2 text-xs text-muted-foreground">{t('fixer.hint')}</p>
      <fieldset className="mb-3 space-y-2"><legend className="text-xs">{t('fixer.title')}</legend>
        <div role="radiogroup" aria-label={t('fixer.title')} data-testid="fixer-mode" className="flex w-full max-w-sm rounded-lg border border-border bg-background/60 p-0.5">
          {option('inherit', t('fixer.inherit'))}
          {option('own', t('fixer.own'))}
        </div>
      </fieldset>
      {own && renderRuntimeRole('fixer')}
    </>
  }

  function renderVerification() {
    return <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('verification.hint')}</p>
        <Button size="sm" variant="secondary" disabled={detecting} onClick={() => void detectNow()}>{detecting ? t('verification.detecting') : t('verification.detect')}</Button>
      </div>
      {detected === 'some' && !rows.some((row) => !row.reason) && <p role="status" className="text-xs text-accent-success">{t('verification.detected')}</p>}
      {detected === 'none' && rows.length === 0 && <p role="status" className="text-xs text-muted-foreground">{t('verification.nothingDetected')}</p>}
      {rows.map((row, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(8rem,1fr)_2fr_auto]">
        <label className="space-y-1 text-xs">{t('verification.repository')}
          {repositories.length
            ? <select className={selectClass} value={row.repositoryId} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, repositoryId: event.target.value } : item))}>
              {!repositories.some((repository) => repository.id === row.repositoryId) && <option value={row.repositoryId}>{row.repositoryId || '—'}</option>}
              {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
            </select>
            : <Input value={row.repositoryId} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, repositoryId: event.target.value } : item))} />}
        </label>
        <div className="space-y-1 text-xs">
          <label className="block space-y-1">{t('verification.command')}<Input className="font-mono" spellCheck={false} placeholder="npm test" value={row.line} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, line: event.target.value, reason: undefined } : item))} /></label>
          <label className="block space-y-1">{t('verification.label')}<Input maxLength={256} value={row.label ?? ''} onChange={event => updateRows(rows.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} /></label>
          {row.reason && <span className="block text-[11px] text-muted-foreground">{t('verification.reason', { reason: row.reason })}</span>}
        </div>
        <div className="flex items-end gap-1">
          <Button size="sm" variant="ghost" aria-label={`${t('verification.moveUp')} ${index + 1}`} disabled={index === 0} onClick={() => { const moved = [...rows]; [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]]; updateRows(moved) }}>↑</Button>
          <Button size="sm" variant="ghost" aria-label={`${t('verification.moveDown')} ${index + 1}`} disabled={index === rows.length - 1} onClick={() => { const moved = [...rows]; [moved[index + 1], moved[index]] = [moved[index], moved[index + 1]]; updateRows(moved) }}>↓</Button>
          <Button size="sm" variant="ghost" onClick={() => updateRows(rows.filter((_, i) => i !== index))}>{t('verification.remove')}</Button></div>
      </div>)}
      <Button size="sm" variant="ghost" onClick={() => updateRows([...rows, { repositoryId: repositories[0]?.id ?? '', line: '' }])}>{t('verification.add')}</Button>
    </>
  }

  function renderLoopRole(role: LoopRole) {
    return <>
      <p className="mb-2 text-xs text-muted-foreground">{t(`loopRoles.${role}Hint`)}</p>
      {!loopEnabled && <p role="status" className="rounded-md border border-accent-warning/40 p-3 text-xs text-accent-warning">{t('loopRoles.disabled')}</p>}
      {loopRoles.failed && <p role="alert" className="text-xs text-destructive">{t('loadFailed')}</p>}
      {loopRoles.roles === null && !loopRoles.failed && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
      {loopRoles.roles && <fieldset disabled={!loopEnabled} className="disabled:opacity-60">
        <LoopRoleFields role={role} engine={loopRoles.roles[role]} providers={loopProviders} enabled={loopEnabled} onChange={(engine) => loopRoles.setRole(role, engine)} />
      </fieldset>}
    </>
  }

  return <Card id="agent-runtime-settings">
    <CardHeader><CardTitle>{t('title')}</CardTitle><CardDescription>{t('description')}</CardDescription></CardHeader>
    <CardContent className="space-y-6">
      {loading && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!config && !loading && <Button variant="secondary" onClick={() => { setLoading(true); setReload((value) => value + 1) }}>{t('retry')}</Button>}
      {config && <fieldset disabled={busy} className="space-y-6 disabled:opacity-70">
        <div className="space-y-2">
          {snapshot?.runtimeAvailable === false && <p className="rounded-md border border-accent-warning/40 p-3 text-xs text-accent-warning">{t('unavailable')}</p>}
        </div>

        <section className="space-y-4" aria-labelledby="agent-runtime-pipeline">
          <div className="space-y-1">
            <h3 id="agent-runtime-pipeline" className="text-sm font-medium">{t('pipeline.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('agents.hint', { turns: RUNTIME_DEFAULTS.maxTurns })}</p>
          </div>
          <div className="flex flex-wrap items-start gap-2 rounded-lg border border-accent-primary/30 bg-accent-primary/5 p-3 text-xs" data-testid="pipeline-explainer">
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-accent-primary/40 bg-accent-primary/10 px-1.5 text-[10px] text-accent-primary whitespace-nowrap" title={t('agents:railSelectors.rolesChipTitle')}>
              <Layers className="h-3 w-3" aria-hidden />{t('agents:railSelectors.rolesChip')}
            </span>
            <p className="min-w-0 flex-1 text-muted-foreground">{t('pipeline.explainer', { roles: t('agents:railSelectors.rolesChip') })}</p>
          </div>
          <PipelineStepper steps={steps} active={activePhase} onSelect={selectPhase} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={checkingCapabilities || snapshot?.efficiencyAvailable === false} onClick={() => void checkCapabilities()}>{t('efficiency.checkCapabilities')}</Button>
            {checkingCapabilities && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
            {capabilityError && <p className="text-xs text-destructive">{t('efficiency.capabilitiesFailed')}</p>}
          </div>
          <div className="space-y-3">
            {PHASE_GROUP_IDS.map((group) => <div key={group} className="space-y-3" data-testid={`phase-cards-${group}`}>
              <PhaseGroupHeading group={group} className={group === 'loop' ? 'border-t border-border/60 pt-3' : ''} />
              {PHASE_GROUPS[group].map((phase) => <PhaseCard
                key={phase}
                ref={(node) => { phaseRefs.current[phase] = node }}
                phase={phase}
                engine={phaseEngine(phase)}
                open={openPhases[phase]}
                active={activePhase === phase}
                onToggle={() => togglePhase(phase)}
              >
                {phase === 'verification' ? renderVerification()
                  : phase === 'fixer' ? renderFixer()
                    : phase === 'verifier' || phase === 'decider' ? renderLoopRole(phase)
                      : renderRuntimeRole(phase)}
              </PhaseCard>)}
            </div>)}
            <RuntimeGuardrails projectId={projectId} guardrails={config.guardrails} onChange={(guardrails) => { const next = { ...config, guardrails }; if (!guardrails) delete next.guardrails; update(next) }} />
          </div>
        </section>

        {snapshot?.efficiencyAvailable === false && <p className="text-xs text-muted-foreground">{t('efficiency.capabilitiesFailed')}</p>}
        <fieldset disabled={snapshot?.efficiencyAvailable === false}><RuntimeEfficiencyControls config={config} onChange={update} /></fieldset>

        <fieldset className="space-y-3"><legend className="text-sm font-medium">{t('limits.title')}</legend>
          <p className="text-xs text-muted-foreground">{t('limits.hint', { attempts: RUNTIME_DEFAULTS.maxAttempts, minutes: RUNTIME_DEFAULTS.timeoutMs / 60_000 })}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">{t('limits.maxAttempts', { attempts: RUNTIME_DEFAULTS.maxAttempts })}<Input type="number" min="1" step="1" placeholder={String(RUNTIME_DEFAULTS.maxAttempts)} value={limits.maxAttempts ?? ''} onChange={(event) => setLimit('maxAttempts', event.target.value)} /></label>
            <label className="space-y-1 text-xs">{t('limits.timeoutMinutes', { minutes: RUNTIME_DEFAULTS.timeoutMs / 60_000 })}<Input type="number" min="1" step="1" placeholder={String(RUNTIME_DEFAULTS.timeoutMs / 60_000)} value={minutes(limits.timeoutMs)} onChange={(event) => setLimit('timeoutMs', event.target.value, 60_000)} /></label>
            <label className="space-y-1 text-xs">{t('limits.maxTokens')}<Input type="number" min="1" step="1" placeholder={t('limits.unlimited')} value={limits.maxTokens ?? ''} onChange={(event) => setLimit('maxTokens', event.target.value)} /></label>
            <label className="space-y-1 text-xs">{t('limits.maxCostUsd')}<Input type="number" min="0.000001" step="any" placeholder={t('limits.unlimited')} value={limits.maxCostUsd ?? ''} onChange={(event) => setLimit('maxCostUsd', event.target.value)} /></label>
          </div>
          <label className="flex items-center gap-3 text-xs"><input type="checkbox" checked={config.approvalBeforeArchive ?? false} onChange={(event) => update({ ...config, approvalBeforeArchive: event.target.checked })} />{t('approvalBeforeArchive')}</label>
        </fieldset>

        <fieldset className="space-y-3"><legend className="text-sm font-medium">{t('review.title')}</legend>
          <p className="text-xs text-muted-foreground">{t('review.hint', { score: REVIEW_THRESHOLD_DEFAULTS.minScore, security: REVIEW_THRESHOLD_DEFAULTS.aspects.security, aspect: REVIEW_THRESHOLD_DEFAULTS.aspects.type_correctness })}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">{t('review.minScore', { score: REVIEW_THRESHOLD_DEFAULTS.minScore })}<Input type="number" min={REVIEW_THRESHOLD_DEFAULTS.minScore} max="100" step="1" placeholder={String(REVIEW_THRESHOLD_DEFAULTS.minScore)} value={review.minScore ?? ''} onChange={(event) => setReviewScore('minScore', event.target.value)} /></label>
            {REVIEW_ASPECTS.map((aspect) => <label key={aspect} className="space-y-1 text-xs">{t(`review.aspects.${aspect}`, { score: REVIEW_THRESHOLD_DEFAULTS.aspects[aspect] })}<Input type="number" min={REVIEW_THRESHOLD_DEFAULTS.aspects[aspect]} max="100" step="1" placeholder={String(REVIEW_THRESHOLD_DEFAULTS.aspects[aspect])} value={review.aspects?.[aspect] ?? ''} onChange={(event) => setReviewScore(aspect, event.target.value)} /></label>)}
          </div>
        </fieldset>

        <fieldset className="space-y-3"><legend className="text-sm font-medium">{t('architect.title')}</legend>
          <p className="text-xs text-muted-foreground">{t('architect.hint')}</p>
          <label className="space-y-1 text-xs sm:w-1/2">{t('architect.onLowConfidence')}
            <select className={selectClass} value={config.architect?.onLowConfidence ?? ''} onChange={(event) => setLowConfidence(event.target.value)}>
              <option value="">{t('agents.defaultModel', { model: t('architect.ask') })}</option>
              {ARCHITECT_LOW_CONFIDENCE_POLICIES.map((policy) => <option key={policy} value={policy}>{t(`architect.${policy}`)}</option>)}
            </select>
          </label>
        </fieldset>


        {/* Floating save pill: sticks to the bottom of the scrolling pane while
            there are unsaved changes, so a long page never needs a scroll to save. */}
        <div className="sticky bottom-3 z-20 flex justify-end pointer-events-none" data-testid="runtime-save-pill" data-unsaved={unsaved}>
          <div className={`pointer-events-auto flex items-center gap-3 rounded-full border px-3 py-1.5 shadow-lg backdrop-blur transition-colors ${unsaved ? 'border-accent-warning/40 bg-card/95' : 'border-border/60 bg-card/80'}`}>
            {unsaved && <span className="inline-flex items-center gap-1.5 text-xs text-accent-warning"><span className="h-1.5 w-1.5 rounded-full bg-accent-warning" aria-hidden />{t('unsavedChanges')}</span>}
            {saved && !unsaved && <p role="status" className="text-xs text-accent-success">{t('saved')}</p>}
            <Button size="sm" className="rounded-full" disabled={busy} onClick={() => void save()}>{busy ? t('saving') : t('save')}</Button>
          </div>
        </div>
      </fieldset>}
    </CardContent>
  </Card>
}
