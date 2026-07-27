import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import {
  BrainCircuit,
  Cpu,
  DraftingCompass,
  Gauge,
  Hammer,
  Info,
  RotateCcw,
  SearchCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { AgentToolbarSelector, type AgentToolbarOption } from '../agent-chat/AgentToolbarSelector'
import { useProviderDetection } from '../../hooks/useProviderDetection'

/** Sentinel option value = "use the provider/built-in default" (Radix Select
 *  forbids empty-string item values). Absent field in the stored config. */
const DEFAULT_SENTINEL = '__default__'

const AGENT_ICONS: Record<string, LucideIcon> = {
  'sr-architect': DraftingCompass,
  'sr-developer': Hammer,
  'sr-reviewer': SearchCheck,
}

interface CatalogEntry {
  id: string
  displayName: string
  models: { value: string; label: string; default?: boolean }[]
  defaultModel: string
  baselineAgents: string[]
  perAgentModels: boolean
  supportsEffort: boolean
  customModelAliases: boolean
  effortsByModel: Record<string, string[]>
}

interface ProviderAgentDefaults {
  custom: boolean
  pipelineModel?: string
  pipelineEffort?: string
  agentModels?: Record<string, string>
}

interface AgentDefaultsSettings {
  version: 1
  providers: Record<string, ProviderAgentDefaults>
}

interface AgentDefaultsResponse {
  settings: AgentDefaultsSettings
  catalog: CatalogEntry[]
}

/** Shape guard — an unexpected payload (proxy error page, older server) must
 *  degrade to the load-failed state, never crash the settings dialog. */
function parseAgentDefaultsResponse(body: unknown): AgentDefaultsResponse | null {
  const candidate = body as AgentDefaultsResponse | null
  if (!candidate || !Array.isArray(candidate.catalog)) return null
  if (typeof candidate.settings !== 'object' || candidate.settings === null) return null
  if (typeof candidate.settings.providers !== 'object' || candidate.settings.providers === null) return null
  return candidate
}

/**
 * Settings ▸ Specrails Agents — app-level per-provider customization of the
 * specrails-core pipeline agents: pipeline model + reasoning effort, and
 * per-agent model overrides where the provider supports execution profiles.
 * Every change persists immediately and applies to the NEXT run — no restart.
 */
export function SpecrailsAgentsSection() {
  const { t } = useTranslation('settings')
  const detection = useProviderDetection()
  const [data, setData] = useState<AgentDefaultsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/agent-defaults')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (cancelled) return
        const parsed = parseAgentDefaultsResponse(body)
        if (parsed) setData(parsed)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function patchProvider(providerId: string, next: ProviderAgentDefaults) {
    if (!data) return
    const prev = data
    // Optimistic apply; revert + toast on failure (sibling-section pattern).
    setData({
      ...prev,
      settings: {
        ...prev.settings,
        providers: { ...prev.settings.providers, [providerId]: next },
      },
    })
    try {
      const res = await fetch('/api/agent-defaults', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: next } }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`)
      }
      const parsed = parseAgentDefaultsResponse(await res.json())
      if (!parsed) throw new Error('unexpected response')
      setData(parsed)
    } catch (err) {
      setData(prev)
      toast.error(t('errors.saveFailed', { message: (err as Error).message }))
    }
  }

  if (failed) {
    return (
      <div className="space-y-2">
        <Heading t={t} />
        <p className="text-xs text-muted-foreground">{t('specrailsAgents.loadFailed')}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="space-y-2">
        <Heading t={t} />
        <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Heading t={t} />
      <p className="text-xs text-muted-foreground">{t('specrailsAgents.description')}</p>
      <div className="space-y-3">
        {data.catalog.map((entry) => (
          <ProviderCard
            key={entry.id}
            entry={entry}
            config={data.settings.providers[entry.id] ?? { custom: false }}
            detected={detection.loading || detection.detected.includes(entry.id)}
            unauthenticated={detection.providers[entry.id]?.authState === 'unauthenticated'}
            version={detection.providers[entry.id]?.version}
            onChange={(next) => void patchProvider(entry.id, next)}
          />
        ))}
      </div>
    </div>
  )
}

function Heading({ t }: { t: (key: string) => string }) {
  return (
    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
      <BrainCircuit className="h-3.5 w-3.5" />
      {t('specrailsAgents.heading')}
    </h3>
  )
}

function ProviderCard({
  entry,
  config,
  detected,
  unauthenticated,
  version,
  onChange,
}: {
  entry: CatalogEntry
  config: ProviderAgentDefaults
  detected: boolean
  unauthenticated: boolean
  version?: string
  onChange: (next: ProviderAgentDefaults) => void
}) {
  const { t } = useTranslation('settings')
  const custom = config.custom === true
  const hasAnyOverride =
    custom || !!config.pipelineModel || !!config.pipelineEffort
    || Object.keys(config.agentModels ?? {}).length > 0

  const effectiveModel = config.pipelineModel ?? entry.defaultModel
  const efforts = entry.effortsByModel[effectiveModel] ?? []
  const defaultModelLabel =
    entry.models.find((m) => m.value === entry.defaultModel)?.label ?? entry.defaultModel

  const modelOptions: AgentToolbarOption[] = useMemo(
    () => [
      { value: DEFAULT_SENTINEL, label: t('specrailsAgents.defaultModel', { model: defaultModelLabel }) },
      ...entry.models.map((m) => ({ value: m.value, label: m.label })),
      // Preserve an off-catalog stored value (custom alias) as a visible option.
      ...(config.pipelineModel && !entry.models.some((m) => m.value === config.pipelineModel)
        ? [{ value: config.pipelineModel, label: config.pipelineModel }]
        : []),
    ],
    [entry.models, config.pipelineModel, defaultModelLabel, t],
  )

  const effortOptions: AgentToolbarOption[] = useMemo(
    () => [
      { value: DEFAULT_SENTINEL, label: t('specrailsAgents.defaultEffort') },
      ...efforts.map((e) => ({ value: e, label: e })),
    ],
    [efforts, t],
  )

  function agentModelOptions(agentId: string): AgentToolbarOption[] {
    const stored = config.agentModels?.[agentId]
    return [
      { value: DEFAULT_SENTINEL, label: t('specrailsAgents.defaultModel', { model: defaultModelLabel }) },
      ...entry.models.map((m) => ({ value: m.value, label: m.label })),
      ...(stored && !entry.models.some((m) => m.value === stored)
        ? [{ value: stored, label: stored }]
        : []),
    ]
  }

  function update(patch: Partial<ProviderAgentDefaults>) {
    onChange({ ...config, custom: true, ...patch })
  }

  function setAgentModel(agentId: string, value: string) {
    const next = { ...(config.agentModels ?? {}) }
    if (value === DEFAULT_SENTINEL) delete next[agentId]
    else next[agentId] = value
    update({ agentModels: next })
  }

  return (
    <div
      data-testid={`agent-defaults-card-${entry.id}`}
      className={cn(
        'rounded-lg border transition-colors',
        custom && detected ? 'border-accent-primary/45' : 'border-border',
        !detected && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Cpu className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden />
        <span className="text-sm font-medium">{entry.displayName}</span>
        {version && (
          <span className="text-[10px] font-mono text-muted-foreground">{version}</span>
        )}
        {!detected && (
          <span className="rounded-full bg-muted/50 px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
            {t('specrailsAgents.notDetected')}
          </span>
        )}
        {detected && unauthenticated && (
          <span className="rounded-full bg-accent-warning/15 px-1.5 py-px text-[10px] leading-4 text-accent-warning">
            {t('specrailsAgents.notSignedIn')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {hasAnyOverride && detected && (
            <button
              type="button"
              title={t('specrailsAgents.reset')}
              aria-label={t('specrailsAgents.reset')}
              data-testid={`agent-defaults-reset-${entry.id}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              onClick={() => onChange({ custom: false })}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <ModeToggle
            custom={custom}
            disabled={!detected}
            providerId={entry.id}
            onToggle={(nextCustom) =>
              nextCustom ? update({}) : onChange({ ...config, custom: false })
            }
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {custom && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-border/60 px-3 py-3">
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('specrailsAgents.pipeline')}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <AgentToolbarSelector
                    label={t('specrailsAgents.model')}
                    value={config.pipelineModel ?? DEFAULT_SENTINEL}
                    options={modelOptions}
                    icon={Sparkles}
                    disabled={!detected}
                    testId={`agent-defaults-model-${entry.id}`}
                    onSelect={(value) =>
                      update({ pipelineModel: value === DEFAULT_SENTINEL ? undefined : value })
                    }
                  />
                  {entry.supportsEffort && efforts.length > 0 && (
                    <AgentToolbarSelector
                      label={t('specrailsAgents.effort')}
                      value={config.pipelineEffort ?? DEFAULT_SENTINEL}
                      options={effortOptions}
                      icon={Gauge}
                      disabled={!detected}
                      testId={`agent-defaults-effort-${entry.id}`}
                      onSelect={(value) =>
                        update({ pipelineEffort: value === DEFAULT_SENTINEL ? undefined : value })
                      }
                    />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">{t('specrailsAgents.pipelineHint')}</p>
              </div>

              {entry.perAgentModels ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('specrailsAgents.agentsTitle')}
                  </p>
                  <div className="space-y-1">
                    {entry.baselineAgents.map((agentId) => {
                      const AgentIcon = AGENT_ICONS[agentId] ?? BrainCircuit
                      return (
                        <div
                          key={agentId}
                          className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                        >
                          <AgentIcon className="h-3.5 w-3.5 shrink-0 text-accent-info" aria-hidden />
                          <span className="text-xs font-medium">
                            {t(`specrailsAgents.agentNames.${agentId}`, { defaultValue: agentId })}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">{agentId}</span>
                          <div className="ml-auto">
                            <AgentToolbarSelector
                              label={t('specrailsAgents.model')}
                              value={config.agentModels?.[agentId] ?? DEFAULT_SENTINEL}
                              options={agentModelOptions(agentId)}
                              icon={Sparkles}
                              disabled={!detected}
                              testId={`agent-defaults-agent-${entry.id}-${agentId}`}
                              onSelect={(value) => setAgentModel(agentId, value)}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('specrailsAgents.agentsHint')}</p>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {entry.id === 'codex'
                    ? t('specrailsAgents.inheritNote')
                    : t('specrailsAgents.noPerAgentNote')}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ModeToggle({
  custom,
  disabled,
  providerId,
  onToggle,
}: {
  custom: boolean
  disabled: boolean
  providerId: string
  onToggle: (custom: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const base =
    'rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed'
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-muted/30 p-0.5">
      <button
        type="button"
        disabled={disabled}
        data-testid={`agent-defaults-mode-default-${providerId}`}
        className={cn(
          base,
          !custom ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onToggle(false)}
      >
        {t('specrailsAgents.modeDefault')}
      </button>
      <button
        type="button"
        disabled={disabled}
        data-testid={`agent-defaults-mode-custom-${providerId}`}
        className={cn(
          base,
          custom
            ? 'bg-accent-primary/15 text-accent-primary shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onToggle(true)}
      >
        {t('specrailsAgents.modeCustom')}
      </button>
    </div>
  )
}
