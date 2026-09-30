import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import { CustomRuntimeRoles } from '../../settings/components/CustomRuntimeRoles'
import { RuntimeGuardrails } from '../../settings/components/RuntimeGuardrails'
import { RuntimeEfficiencyControls } from '../../settings/components/RuntimeEfficiencyControls'
import { REVIEW_ASPECTS, REVIEW_THRESHOLD_DEFAULTS, type RuntimeAgent, type RuntimeProvider, type AgentRuntimeConfig } from '../../settings/lib/agent-runtime'
import { modelsForProvider } from '../lib/loop-run-models'
import { loopAgentRoles } from '../lib/core-authoring'
import type { LoopGraph, LoopAgentConfig } from '../lib/loops-api'

const field = 'w-full rounded-md border border-input bg-background px-2 py-1 text-xs'
const builtinRoles = ['architect', 'developer', 'reviewer', 'fixer'] as const

/** Controlled draft: saving/publishing belongs to the loop, never to a project. */
export function LoopAgentsEditor({ value, onChange, selectedRole, graph, mode = 'all' }: {
  mode?: 'all' | 'step' | 'workflow'; graph?: LoopGraph; value?: LoopAgentConfig; onChange(value: LoopAgentConfig): void; selectedRole?: string
}) {
  const { t } = useTranslation('agentRuntime')
  const { activeProjectId } = useDesktop()
  const currentProject = useRef(activeProjectId)
  currentProject.current = activeProjectId
  const [providers, setProviders] = useState<RuntimeProvider[]>([])
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [defaults, setDefaults] = useState<LoopAgentConfig>()
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [showUnused, setShowUnused] = useState(false)
  const usedRoles = graph ? loopAgentRoles(graph) : [...builtinRoles, ...Object.keys(value?.roles ?? {})]
  const visibleRoles = mode === 'step' ? [selectedRole ?? ''] : showUnused ? undefined : usedRoles
  const showAgents = mode !== 'workflow'
  const showPolicy = mode !== 'step'
  const title = mode === 'step' ? 'loopAgents.stepTitle' : mode === 'workflow' ? 'loopAgents.policy' : 'loopAgents.title'
  const hasUnused = [...builtinRoles, ...Object.keys(value?.roles ?? {})].some(role => !usedRoles.includes(role))
  useEffect(() => {
    const controller = new AbortController()
    Promise.all(['/api/runtime-providers', '/api/loop-agent-defaults'].map(url => fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('loadFailed'))
      return response.json()
    }))).then(([connections, factory]) => {
      if (controller.signal.aborted) return
      setProviders(connections.providers ?? []); setDefaults(factory.agents)
      setModels(Object.fromEntries(Object.entries(connections.status ?? {}).map(([id, status]) => [id, (status as { models?: string[] }).models ?? []])))
    }).catch(() => { if (!controller.signal.aborted) setError(t('loadFailed')) })
    return () => controller.abort()
  }, [t])

  async function importProject() {
    const projectId = activeProjectId
    setImporting(true); setError('')
    try {
      const base = getApiBase()
      const [response, roleResponse] = await Promise.all([fetch(`${base}/agent-runtime/config`), fetch(`${base}/agent-runtime/loop-roles`)])
      if (!response.ok || !roleResponse.ok) throw new Error(t('loadFailed'))
      const data = await response.json() as { config: AgentRuntimeConfig }
      const legacy = await roleResponse.json() as { roles?: { decider?: RuntimeAgent } }
      const { agents, fixer, roles, rolePrompts, limits, review, architect, approvalBeforeArchive, efficiency, guardrails } = data.config
      // Endpoint is captured before awaiting; the import is an explicit user action.
      if (!projectId || currentProject.current !== projectId) return
      onChange({ schemaVersion: 1, agents, fixer, roles: { ...defaults?.roles, ...Object.fromEntries(Object.entries(roles ?? {}).map(([id, role]) => [id, { ...role, prompt: rolePrompts?.[id] ?? role.prompt }])), ...(legacy.roles?.decider ? { 'loop-decider': { ...defaults!.roles!['loop-decider'], ...legacy.roles.decider } } : {}) }, rolePrompts: Object.fromEntries(Object.entries({ ...defaults?.rolePrompts, ...rolePrompts }).filter(([id]) => builtinRoles.includes(id as typeof builtinRoles[number]))), limits, review, architect, approvalBeforeArchive, efficiency, guardrails })
    } catch { setError(t('loadFailed')) }
    finally { setImporting(false) }
  }

  function engine(role: string) {
    if (!value) return null
    const builtin = builtinRoles.includes(role as typeof builtinRoles[number])
    const agent = role === 'fixer' ? value.fixer ?? value.agents.developer : builtin ? value.agents[role as keyof typeof value.agents] : value.roles?.[role]
    if (!agent) return null
    const update = (next: RuntimeAgent) => onChange(role === 'fixer' ? { ...value, fixer: next } : builtin
      ? { ...value, agents: { ...value.agents, [role]: next } }
      : { ...value, roles: { ...value.roles, [role]: { ...value.roles![role], ...next } } })
    const provider = providers.find(item => item.id === agent.provider)
    const choices = provider?.kind === 'cli' ? modelsForProvider(provider.cli).map(item => item.value) : models[agent.provider] ?? []
    return <div className="space-y-2">
      <label className="block text-xs">{t('agents.provider')}<select className={field} value={agent.provider} onChange={event => update({ provider: event.target.value, maxTurns: agent.maxTurns })}>
        <option value="inherit">{t('loopAgents.inheritProvider')}</option>
        {!provider && agent.provider !== 'inherit' && <option value={agent.provider}>{agent.provider}</option>}
        {providers.map(item => <option key={item.id} value={item.id}>{item.kind === 'openai-compatible' ? item.label ?? item.id : item.id}</option>)}
      </select></label>
      <label className="block text-xs">{t('agents.model')}<Input value={agent.model ?? ''} list={`loop-models-${role}`} onChange={event => update({ ...agent, model: event.target.value || undefined })} /><datalist id={`loop-models-${role}`}>{choices.map(model => <option key={model} value={model} />)}</datalist></label>
      <label className="block text-xs">{t('loopAgents.effort')}<Input value={agent.effort ?? ''} onChange={event => update({ ...agent, effort: event.target.value || undefined })} /></label>
      <label className="block text-xs">{t('agents.maxTurns', { turns: 100 })}<Input type="number" min={1} value={agent.maxTurns ?? ''} onChange={event => update({ ...agent, maxTurns: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label className="block text-xs">{t('agents.thinking')}<select className={field} value={agent.thinking ?? ''} onChange={event => update({ ...agent, thinking: event.target.value ? event.target.value as 'on' | 'off' : undefined })}><option value="">{t('loopAgents.default')}</option><option value="off">{t('agents.thinking_off')}</option><option value="on">{t('agents.thinking_on')}</option></select></label>
      <label className="block text-xs">{t('loopAgents.escalationModel')}<Input value={agent.escalation?.model ?? ''} onChange={event => update({ ...agent, escalation: event.target.value ? { ...agent.escalation, model: event.target.value } : undefined })} /></label>
      {agent.escalation && <label className="block text-xs">{t('loopAgents.escalationEffort')}<Input value={agent.escalation.effort ?? ''} onChange={event => update({ ...agent, escalation: { model: agent.escalation!.model, effort: event.target.value || undefined } })} /></label>}
    </div>
  }
  const full: AgentRuntimeConfig | undefined = value ? { ...value, enabled: true, providers, verification: [] } : undefined
  return <section className="space-y-3 border-b border-border pb-4" aria-label={t(title)}>
    <h3 className="text-sm font-medium">{t(title)}</h3>
    {showAgents && <p className="text-xs text-muted-foreground">{t(mode === 'step' ? 'loopAgents.stepHint' : 'loopAgents.hint')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!value && <><p className="text-xs text-accent-warning">{t('loopAgents.legacy')}</p><Button size="sm" disabled={!defaults} onClick={() => defaults && onChange(structuredClone(defaults))}>{t('loopAgents.enable')}</Button></>}
    {mode !== 'step' && <Button size="sm" variant="secondary" disabled={!activeProjectId || !defaults || importing} onClick={() => void importProject()}>{t('loopAgents.import')}</Button>}
    {value && <>
      {mode === 'all' && hasUnused && <label className="flex gap-2 text-xs"><input type="checkbox" checked={showUnused} onChange={event => setShowUnused(event.target.checked)} />{t('loopAgents.showUnused')}</label>}
      {showAgents && builtinRoles.filter(role => !visibleRoles || visibleRoles.includes(role)).map(role => <details key={role} open={selectedRole === role} className="rounded-md border border-border p-2">
        <summary className="cursor-pointer text-sm font-medium">{role}</summary>
        <div className="mt-3 space-y-3">{engine(role)}
          <label className="block text-xs">{t('customRoles.prompt')}<textarea className={field} rows={10} maxLength={20000} value={value.rolePrompts?.[role] ?? ''} onChange={event => onChange({ ...value, rolePrompts: { ...value.rolePrompts, [role]: event.target.value } })} /></label>
          <Button size="sm" variant="ghost" disabled={!defaults} onClick={() => onChange({ ...value, rolePrompts: { ...value.rolePrompts, [role]: defaults?.rolePrompts?.[role] ?? '' } })}>{t('loopAgents.restoreDefinition')}</Button>
        </div>
      </details>)}
      {mode === 'step' && selectedRole && ![...builtinRoles, 'archive', 'verify'].includes(selectedRole) && !value.roles?.[selectedRole] && <Button size="sm" disabled={!providers.length} onClick={() => onChange({ ...value, roles: { ...value.roles, [selectedRole]: { provider: 'inherit', access: 'read', artifacts: 'none' } } })}>{t('customRoles.add')}</Button>}
      {(showAgents || mode === 'workflow') && <CustomRuntimeRoles manageRoles={mode !== 'step'} visibleRoleIds={mode === 'workflow' ? [] : visibleRoles} roles={value.roles} provider="inherit" supported onChange={roles => { if (Object.keys(roles).some(id => !value.roles?.[id])) setShowUnused(true); onChange({ ...value, roles, rolePrompts: Object.fromEntries(Object.entries(value.rolePrompts ?? {}).filter(([id]) => builtinRoles.includes(id as typeof builtinRoles[number]))) }) }} renderEngine={engine} />}
      <div className="space-y-3">
        {showPolicy && <details className="rounded-md border border-border p-2"><summary className="cursor-pointer text-sm">{t('loopAgents.policy')}</summary><div className="mt-3 space-y-3">
        {(['maxAttempts', 'maxTokens', 'maxCostUsd', 'timeoutMs'] as const).map(key => <label key={key} className="block text-xs">{t(`loopAgents.${key}`)}<Input type="number" min={1} value={value.limits?.[key] ?? ''} onChange={event => onChange({ ...value, limits: { ...value.limits, [key]: event.target.value ? Number(event.target.value) : undefined } })} /></label>)}
        <RuntimeGuardrails catalogUrl="/api/loop-agent-defaults" guardrails={value.guardrails} onChange={guardrails => onChange({ ...value, guardrails })} />
        {full && <RuntimeEfficiencyControls config={full} onChange={next => onChange({ ...value, efficiency: next.efficiency })} />}
      </div></details>}
        {(mode === 'all' || mode === 'step' && selectedRole === 'reviewer') && <><label className="block text-xs">{t('review.minScore', { score: 70 })}<Input type="number" min={70} max={100} value={value.review?.minScore ?? ''} onChange={event => onChange({ ...value, review: { ...value.review, minScore: event.target.value ? Number(event.target.value) : undefined } })} /></label>
        {REVIEW_ASPECTS.map(aspect => <label key={aspect} className="block text-xs">{t(`review.aspects.${aspect}`, { score: REVIEW_THRESHOLD_DEFAULTS.aspects[aspect] })}<Input type="number" min={REVIEW_THRESHOLD_DEFAULTS.aspects[aspect]} max={100} value={value.review?.aspects?.[aspect] ?? ''} onChange={event => onChange({ ...value, review: { ...value.review, aspects: { ...value.review?.aspects, [aspect]: event.target.value ? Number(event.target.value) : undefined } } })} /></label>)}
        </>}
        {(mode === 'all' || mode === 'step' && selectedRole === 'architect') && <label className="block text-xs">{t('architect.onLowConfidence')}<select className={field} value={value.architect?.onLowConfidence ?? 'ask'} onChange={event => onChange({ ...value, architect: { onLowConfidence: event.target.value as 'ask' | 'proceed' } })}><option value="ask">{t('architect.ask')}</option><option value="proceed">{t('architect.proceed')}</option></select></label>}
        {(mode === 'all' || mode === 'step' && selectedRole === 'archive') && <label className="flex gap-2 text-xs"><input type="checkbox" checked={value.approvalBeforeArchive ?? false} onChange={event => onChange({ ...value, approvalBeforeArchive: event.target.checked })} />{t('approvalBeforeArchive')}</label>}
      </div>
    </>}
  </section>
}
