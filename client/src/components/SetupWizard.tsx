import { useState, useEffect, useRef, useCallback, useLayoutEffect, memo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Check, ArrowRight, Package, Bot, ChevronLeft, Settings2, Plug, AlertTriangle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import i18n from '../lib/i18n'
import { Button } from './ui/button'
import { type CheckpointState } from './CheckpointTracker'
import { AgentSelector, ALL_AGENTS, CORE_AGENTS, DEFAULT_SELECTED } from './AgentSelector'
import { ModelSelector, PRESET_DEFAULTS, type ModelPreset, type ModelOverrides } from './ModelSelector'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { cn } from '../lib/utils'
import { type DesktopProject, projectProviders } from '../hooks/useDesktop'
import { providerLabel, type ProviderId } from '../lib/provider-capabilities'
import { usePrerequisites, type SetupPrerequisitesStatus } from '../hooks/usePrerequisites'
import { PrerequisitesPanel } from './PrerequisitesPanel'
import { FEATURE_JIRA, FEATURE_MCP, FEATURE_AGENT_CHAT } from '../lib/feature-flags'
import { JiraConnectWizard } from './jira/JiraConnectWizard'

// ─── Wizard step types ────────────────────────────────────────────────────────
//
// Multi-provider: a project may install one or both providers. The wizard
// configures each provider in turn (`agent-selection` with `providerIndex`),
// then installs them sequentially (`installing`), then shows a combined
// per-provider summary (`complete`). Single-provider projects collapse to the
// classic Configure → Install → Done flow (providerIndex always 0).

type WizardStep =
  | { step: 'agent-selection'; providerIndex: number }
  | { step: 'installing'; providerIndex: number }
  | { step: 'complete'; summaries: SetupSummary[] }
  | { step: 'error'; message: string; retryStep: 'installing'; providerIndex: number }

interface SetupSummary {
  agents: number
  specrailsCommands: number
  opsxCommands: number
  legacySrRemoved: number
  tier: 'quick' | 'full'
  provider?: ProviderId
  /**
   * Optional per-provider failure flag. The install flow routes hard failures
   * to the dedicated `error` step, so summaries reaching the Complete step are
   * successful installs by construction. This flag lets the success card render
   * an error variant when a future server path reports a soft per-provider
   * failure without aborting the whole wizard.
   */
  failed?: boolean
}

const EMPTY_SUMMARY: SetupSummary = {
  agents: 0,
  specrailsCommands: 0,
  opsxCommands: 0,
  legacySrRemoved: 0,
  tier: 'quick',
  provider: 'claude',
}

// ─── Install config ───────────────────────────────────────────────────────────

interface InstallConfig {
  selectedAgents: string[]
  modelPreset: ModelPreset
  modelOverrides: ModelOverrides
}

// Prerequisite types and panel are provided by the shared `usePrerequisites` hook
// and `PrerequisitesPanel` component (see imports below).

// Map full model IDs to short names used by specrails-core
function toShortModelName(modelId: string): string {
  if (modelId.includes('fable')) return 'fable'
  if (modelId.includes('opus')) return 'opus'
  if (modelId.includes('haiku')) return 'haiku'
  if (modelId.includes('sonnet')) return 'sonnet'
  return modelId // codex models pass through as-is
}

// Preset → the preset's default model for a given provider (claude/codex/gemini).
function presetToDefaultModel(preset: ModelPreset, provider: string): string {
  const byProvider = PRESET_DEFAULTS[preset]
  return byProvider[provider] ?? byProvider.claude
}

function buildDefaultConfig(): InstallConfig {
  return {
    selectedAgents: [...DEFAULT_SELECTED],
    modelPreset: 'balanced',
    modelOverrides: {},
  }
}

// ─── Initial checkpoint states ────────────────────────────────────────────────

const installCheckpoints = (): CheckpointState[] => [
  { key: 'base_install', name: i18n.t('setup:wizard.checkpoints.baseInstall'), status: 'pending' },
  { key: 'agent_selection', name: i18n.t('setup:wizard.checkpoints.agentSelection'), status: 'pending' },
  { key: 'agent_generation', name: i18n.t('setup:wizard.checkpoints.agentGeneration'), status: 'pending' },
]

// ─── Per-project wizard state cache (survives unmount on tab switch) ─────────

interface WizardSnapshot {
  wizardStep: WizardStep
  checkpoints: CheckpointState[]
  logLines: string[]
  /** Per-provider install configs, keyed by provider id. */
  configs: Record<string, InstallConfig>
}

const wizardCache = new Map<string, WizardSnapshot>()

// ─── Shared log renderer ──────────────────────────────────────────────────────

const PROSE_CLASSES = `prose prose-invert prose-xs max-w-none
  prose-p:my-1 prose-p:leading-relaxed
  prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold
  prose-ul:my-1 prose-ol:my-1 prose-li:my-0
  prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
  prose-pre:my-1 prose-pre:bg-muted/30 prose-pre:rounded-md prose-pre:p-2 prose-pre:text-[10px]
  prose-strong:text-foreground prose-em:text-foreground/70
  prose-table:my-2 prose-table:text-[10px]
  prose-thead:border-border prose-thead:bg-muted/30
  prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:font-semibold
  prose-td:px-2 prose-td:py-1 prose-td:border-border
  text-foreground/80`

const SetupLogLines = memo(function SetupLogLines({ lines }: { lines: string[] }) {
  const content = lines.join('\n')
  return (
    <div className={PROSE_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
})

// ─── Step 1: Agent Selection ──────────────────────────────────────────────────

type AgentSelectionTab = 'agents' | 'models'

function AgentSelectionStep({
  config,
  onChange,
  onInstall,
  onSkip,
  provider,
  ctaLabel,
  lastStep = true,
  prerequisites,
  prerequisitesLoading,
  prerequisitesError,
  onRefreshPrerequisites,
}: {
  config: InstallConfig
  onChange: (config: InstallConfig) => void
  onInstall: () => void
  onSkip: () => void
  provider: ProviderId
  /** Primary CTA label — "Install" on the last provider, "Next: …" otherwise. */
  ctaLabel?: string
  /** True on the last (or only) provider — drives the CTA icon. */
  lastStep?: boolean
  prerequisites: SetupPrerequisitesStatus | null
  prerequisitesLoading: boolean
  prerequisitesError: Error | null
  onRefreshPrerequisites: () => void
}) {
  const { t } = useTranslation('setup')
  const [activeTab, setActiveTab] = useState<AgentSelectionTab>('agents')
  const selectedAgents = ALL_AGENTS.filter((a) => config.selectedAgents.includes(a.id))
  // Treat null/loading as ok (don't block install on a slow fetch); only block on a definitive negative
  // answer where the server reports `ok: false`.
  const prereqsBlock = prerequisites !== null && !prerequisites.ok && !prerequisitesError
  const installDisabled = config.selectedAgents.length === 0 || prereqsBlock

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
            <Bot className="w-5 h-5 text-accent-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">{t('wizard.configureAgents', { provider: providerLabel(provider) })}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('wizard.configureSubtitle')}
            </p>
          </div>
        </div>

        <PrerequisitesPanel
          status={prerequisites}
          isLoading={prerequisitesLoading}
          error={prerequisitesError}
          onRefresh={onRefreshPrerequisites}
        />

        {/* Tabs */}
        <div className="flex border-b border-border/30">
          {(['agents', 'models'] as AgentSelectionTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                activeTab === tab
                  ? 'border-accent-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tab === 'agents' ? (
                <>
                  <Bot className="w-3 h-3" />
                  {t('wizard.tabs.agents')}
                </>
              ) : (
                <>
                  <Settings2 className="w-3 h-3" />
                  {t('wizard.tabs.models')}
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto px-6 pb-4">
        {activeTab === 'agents' ? (
          <AgentSelector
            selected={config.selectedAgents}
            onChange={(selectedAgents) => onChange({ ...config, selectedAgents })}
          />
        ) : (
          <ModelSelector
            agents={selectedAgents}
            provider={provider}
            preset={config.modelPreset}
            overrides={config.modelOverrides}
            onPresetChange={(modelPreset) => onChange({ ...config, modelPreset })}
            onOverrideChange={(agentId, model) => {
              const next = { ...config.modelOverrides }
              if (model) {
                next[agentId] = model
              } else {
                delete next[agentId]
              }
              onChange({ ...config, modelOverrides: next })
            }}
          />
        )}
      </div>

      {/* Footer actions — install CTA centered, skip left-anchored */}
      <div className="flex-shrink-0 border-t border-border/30 px-6 py-4 relative flex items-center">
        <button
          onClick={onSkip}
          className="absolute left-6 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('wizard.skipForNow')}
        </button>
        <div data-testid="install-cta-wrapper" className="mx-auto">
          <Button
            size="sm"
            className="gap-2"
            onClick={onInstall}
            disabled={installDisabled}
          >
            {lastStep ? <Package className="w-3.5 h-3.5" /> : <ArrowRight className="w-3.5 h-3.5" />}
            {ctaLabel ?? t('wizard.install')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 2: Installing ───────────────────────────────────────────────────────

function InstallingStep({
  logLines,
  onBack,
  providerLabelText,
}: {
  logLines: string[]
  onBack: () => void
  providerLabelText?: string
}) {
  const { t } = useTranslation('setup')
  return (
    <div className="flex flex-col h-full max-w-lg mx-auto px-6 py-8 gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-accent-primary animate-pulse" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">
              {providerLabelText ? t('wizard.installingProvider', { provider: providerLabelText }) : t('wizard.installingSpecrails')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('wizard.installingFromTemplates')}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack} className="h-7 gap-1.5 text-xs">
          <ChevronLeft className="w-3.5 h-3.5" />
          {t('common:actions.back')}
        </Button>
      </div>

      <div className="flex-1 rounded-lg border border-border/30 bg-muted/10 overflow-auto p-3 text-[11px] text-muted-foreground space-y-0.5">
        {logLines.length === 0 ? (
          <p className="text-center text-muted-foreground mt-4">{t('wizard.waitingForOutput')}</p>
        ) : (
          <SetupLogLines lines={logLines.slice(-300)} />
        )}
      </div>
    </div>
  )
}

// ─── Step 3: Complete ─────────────────────────────────────────────────────────

function SummaryCard({ summary }: { summary: SetupSummary }) {
  const { t } = useTranslation('setup')
  const failed = summary.failed === true
  return (
    <div
      data-testid="setup-summary-card"
      data-status={failed ? 'failed' : 'installed'}
      className={cn(
        'w-full rounded-lg border p-3 flex items-center gap-2.5',
        failed ? 'border-destructive/40 bg-destructive/5' : 'border-border/50 bg-muted/20'
      )}
    >
      <div
        className={cn(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
          failed ? 'bg-destructive/15' : 'bg-accent-success/15'
        )}
      >
        {failed ? (
          <AlertTriangle className="w-4 h-4 text-destructive" />
        ) : (
          <Check className="w-4 h-4 text-accent-success" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-foreground leading-tight truncate">
          {providerLabel(summary.provider)}
        </div>
        <div className={cn('text-[11px] leading-tight', failed ? 'text-destructive' : 'text-accent-success')}>
          {failed ? t('wizard.complete.installFailed') : t('wizard.complete.installed')}
        </div>
      </div>
    </div>
  )
}

function CompleteStep({
  projectName,
  projectId,
  summaries,
  onGoToProject,
}: {
  projectName: string
  projectId: string
  summaries: SetupSummary[]
  onGoToProject: () => void
}) {
  const { t } = useTranslation('setup')
  const list = summaries.length > 0 ? summaries : [{ ...EMPTY_SUMMARY }]
  // Optional Jira sub-screen, shown only when the user opts in from the Done
  // step. Both a successful connect and "do it later" go straight to the project.
  const [showJira, setShowJira] = useState(false)

  if (showJira && FEATURE_JIRA) {
    return (
      <div className="flex flex-col h-full max-w-lg mx-auto px-6 py-8 gap-4 overflow-auto">
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold">{t('wizard.complete.jira.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('wizard.complete.jira.subtitle')}</p>
        </div>
        <JiraConnectWizard
          apiBase={`/api/projects/${projectId}`}
          onConnected={onGoToProject}
          onSkip={onGoToProject}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto px-6 gap-4 overflow-auto py-5">
      <div className="w-11 h-11 rounded-2xl bg-accent-success/20 flex items-center justify-center shrink-0">
        <Check className="w-6 h-6 text-accent-success" />
      </div>

      <div className="text-center space-y-1.5">
        <h2 className="text-base font-semibold">
          <Trans
            t={t}
            i18nKey="wizard.complete.welcome"
            components={{ spec: <span className="text-accent-primary" />, rails: <span className="text-accent-secondary" /> }}
          />
        </h2>
        <p className="text-[13px] text-muted-foreground max-w-sm">
          <Trans
            t={t}
            i18nKey="wizard.complete.configured"
            values={{ projectName }}
            components={{ strong: <strong className="text-foreground" /> }}
          />
        </p>
      </div>

      {/* Engine summaries: side-by-side when more than one so the screen fits
          without scrolling. */}
      <div className="w-full space-y-2">
        {list.length > 1 && (
          <p className="text-[11px] text-muted-foreground text-center">{t('wizard.complete.installedForEngines', { count: list.length })}</p>
        )}
        <div className={cn('grid gap-3', list.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          {list.map((s, i) => (
            <SummaryCard key={s.provider ?? i} summary={s} />
          ))}
        </div>
      </div>

      {/* Compact, single-line optional Jira CTA (no full card → no overflow). */}
      {FEATURE_JIRA && (
        <button
          type="button"
          onClick={() => setShowJira(true)}
          data-testid="setup-jira-cta"
          className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-1.5 text-xs font-medium text-foreground/80 hover:text-foreground hover:border-border transition-colors"
        >
          <Plug className="w-3.5 h-3.5 text-accent-info" />
          {t('wizard.complete.jira.configure')}
          <span className="font-normal text-muted-foreground">· {t('wizard.complete.jira.optional')}</span>
        </button>
      )}

      {/* Single-line MCP hint — enabled later in Settings ▸ MCP, not a sub-wizard. */}
      {FEATURE_MCP && (
        <div
          data-testid="setup-mcp-hint"
          className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <Bot className="w-3.5 h-3.5 text-accent-info" />
          {t('wizard.complete.mcpHint')}
        </div>
      )}
      {FEATURE_AGENT_CHAT && (
        <div
          data-testid="setup-agent-hint"
          className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <Bot className="w-3.5 h-3.5 text-accent-primary" />
          {t('wizard.complete.agentChatHint')}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>{t('wizard.complete.learnMore')}</span>
        <a
          href="https://specrails.dev/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-primary hover:underline"
        >
          specrails.dev/docs
        </a>
      </div>

      <Button size="sm" className="gap-2" onClick={onGoToProject}>
        {t('wizard.complete.continueToProject')}
        <ArrowRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

// ─── Error step ───────────────────────────────────────────────────────────────

import { RotateCcw } from 'lucide-react'

function ErrorStep({
  message,
  onRetry,
  onSkip,
}: {
  message: string
  onRetry: () => void
  onSkip: () => void
}) {
  const { t } = useTranslation('setup')
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto px-6 gap-6">
      <div className="text-center space-y-2">
        <h2 className="text-base font-semibold text-destructive">{t('wizard.error.title')}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={onSkip}>
          {t('wizard.error.skipSetup')}
        </Button>
        <Button size="sm" className="gap-2" onClick={onRetry}>
          <RotateCcw className="w-3.5 h-3.5" />
          {t('common:actions.retry')}
        </Button>
      </div>
    </div>
  )
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ wizardStep, providers }: { wizardStep: WizardStep; providers: readonly string[] }) {
  const { t } = useTranslation('setup')
  // One "Configure" step per provider (labelled by provider when >1), then a
  // single Install step and a Done step.
  const multi = providers.length > 1
  const configureSteps = multi
    ? providers.map((p) => ({ label: providerLabel(p) }))
    : [{ label: t('wizard.steps.configure') }]
  const steps = [...configureSteps, { label: t('wizard.install') }, { label: t('common:actions.done') }]

  const installIdx = configureSteps.length
  const doneIdx = installIdx + 1
  const currentIndex =
    wizardStep.step === 'agent-selection' ? Math.min(wizardStep.providerIndex, configureSteps.length - 1)
      : wizardStep.step === 'installing' ? installIdx
      : wizardStep.step === 'error' ? installIdx
      : doneIdx

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const isDone = i < currentIndex
        const isCurrent = i === currentIndex
        return (
          <div key={`${s.label}-${i}`} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  'w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold',
                  isDone && 'bg-accent-success text-background',
                  isCurrent && 'bg-accent-primary text-background',
                  !isDone && !isCurrent && 'bg-muted/50 text-muted-foreground'
                )}
              >
                {isDone ? <Check className="w-2.5 h-2.5" /> : i + 1}
              </div>
              <span className={cn(
                'text-[10px] font-medium',
                isCurrent && 'text-foreground',
                !isCurrent && 'text-muted-foreground'
              )}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn('w-6 h-px', isDone ? 'bg-accent-success/50' : 'bg-border/50')} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── SetupWizard ──────────────────────────────────────────────────────────────

interface SetupWizardProps {
  project: DesktopProject
  onComplete: () => void
  onSkip: () => void
}

export function SetupWizard({ project, onComplete: rawOnComplete, onSkip: rawOnSkip }: SetupWizardProps) {
  const { t } = useTranslation('setup')
  const onComplete = useCallback(() => { wizardCache.delete(project.id); rawOnComplete() }, [project.id, rawOnComplete])
  const onSkip = useCallback(() => { wizardCache.delete(project.id); rawOnSkip() }, [project.id, rawOnSkip])

  // Installed providers (one or both). The wizard configures + installs each in
  // sequence; single-provider projects collapse to the classic flow.
  const providers = projectProviders(project)

  const cached = wizardCache.get(project.id)

  const [wizardStep, setWizardStep] = useState<WizardStep>(cached?.wizardStep ?? { step: 'agent-selection', providerIndex: 0 })
  const [configs, setConfigs] = useState<Record<string, InstallConfig>>(() => {
    if (cached?.configs) return cached.configs
    const init: Record<string, InstallConfig> = {}
    for (const p of providers) init[p] = buildDefaultConfig()
    return init
  })
  const [checkpoints, setCheckpoints] = useState<CheckpointState[]>(cached?.checkpoints ?? installCheckpoints())
  const [logLines, setLogLines] = useState<string[]>(cached?.logLines ?? [])
  const {
    status: setupPrerequisites,
    isLoading: isRefreshingPrerequisites,
    error: setupPrerequisitesError,
    recheck: refreshSetupPrerequisites,
  } = usePrerequisites()

  // Config for the provider currently being configured.
  const currentConfigIndex = wizardStep.step === 'agent-selection' ? wizardStep.providerIndex : 0
  const currentProvider = providers[Math.min(currentConfigIndex, providers.length - 1)] ?? 'claude'
  const currentConfig = configs[currentProvider] ?? buildDefaultConfig()
  const setCurrentConfig = useCallback((next: InstallConfig) => {
    setConfigs((prev) => ({ ...prev, [currentProvider]: next }))
  }, [currentProvider])

  // Accumulates per-provider summaries across the sequential install; the index
  // tracks which provider is currently installing. Refs so the WS handler reads
  // the latest without re-subscribing.
  const installSummariesRef = useRef<SetupSummary[]>([])
  const installIndexRef = useRef(0)
  const installProviderRef = useRef<(i: number) => void>(() => {})

  // Persist refs for cache-on-unmount
  const wizardStepRef = useRef(wizardStep)
  const checkpointsRef = useRef(checkpoints)
  const logLinesRef = useRef(logLines)
  const configsRef = useRef(configs)

  wizardStepRef.current = wizardStep
  checkpointsRef.current = checkpoints
  logLinesRef.current = logLines
  configsRef.current = configs

  useEffect(() => {
    return () => {
      wizardCache.set(project.id, {
        wizardStep: wizardStepRef.current,
        checkpoints: checkpointsRef.current,
        logLines: logLinesRef.current,
        configs: configsRef.current,
      })
    }
  }, [project.id])

  // On remount after tab switch: check if the install finished while we were away
  useEffect(() => {
    if (wizardStep.step !== 'installing') return

    async function syncState() {
      try {
        const res = await fetch(`/api/projects/${project.id}/setup/checkpoints`)
        if (!res.ok) return
        const data = await res.json() as {
          checkpoints: CheckpointState[]
          isInstalling: boolean
          isSettingUp: boolean
          logLines?: string[]
          summary?: SetupSummary
        }

        if (data.checkpoints) {
          setCheckpoints((prev) =>
            prev.map((cp) => {
              const serverCp = data.checkpoints!.find((s: CheckpointState) => s.key === cp.key)
              if (!serverCp) return cp
              if (cp.status === 'done' && serverCp.status !== 'done') return cp
              return { ...cp, ...serverCp }
            })
          )
        }

        if (data.logLines && data.logLines.length > 0) {
          setLogLines((prev) => data.logLines!.length > prev.length ? data.logLines! : prev)
        }

        if (wizardStep.step === 'installing' && !data.isInstalling) {
          const hasBaseInstall = data.checkpoints?.some(
            (cp: CheckpointState) => cp.key === 'base_install' && cp.status === 'done'
          )
          if (hasBaseInstall) {
            const synced = installSummariesRef.current.length > 0
              ? installSummariesRef.current
              : [data.summary ?? { ...EMPTY_SUMMARY }]
            setWizardStep({ step: 'complete', summaries: synced })
          }
        }
      } catch {
        // non-fatal
      }
    }
    syncState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // ─── WebSocket handler ──────────────────────────────────────────────────────

  const handleWsMessage = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (typeof msg.type !== 'string') return
    if ((msg.projectId as string) !== project.id) return

    switch (msg.type) {
      case 'setup_log': {
        setLogLines((prev) => [...prev, msg.line as string])
        break
      }

      case 'setup_install_done': {
        const summary = (msg.summary as SetupSummary | undefined) ?? { ...EMPTY_SUMMARY }
        installSummariesRef.current = [...installSummariesRef.current, summary]
        const nextIndex = installIndexRef.current + 1
        if (nextIndex < providers.length) {
          // More providers to install — kick off the next one and stay in the
          // installing step. The step indicator/progress reset for the next CLI.
          installIndexRef.current = nextIndex
          installProviderRef.current(nextIndex)
        } else {
          setWizardStep({ step: 'complete', summaries: [...installSummariesRef.current] })
        }
        break
      }

      case 'setup_checkpoint': {
        const key = msg.checkpoint as string
        const status = msg.status as 'running' | 'done'
        const detail = msg.detail as string | undefined
        const duration_ms = msg.duration_ms as number | undefined
        setCheckpoints((prev) =>
          prev.map((cp) =>
            cp.key === key
              ? { ...cp, status, detail: detail ?? cp.detail, duration_ms: duration_ms ?? cp.duration_ms }
              : cp
          )
        )
        break
      }

      case 'setup_error': {
        const error = msg.error as string
        setWizardStep({ step: 'error', message: error, retryStep: 'installing', providerIndex: installIndexRef.current })
        break
      }
    }
    // providers.length (a stable number, unlike the freshly-derived providers
    // array) keeps the sequential-install completion check correct without
    // re-subscribing the WS handler on every render.
  }, [project.id, providers.length])

  useLayoutEffect(() => {
    registerHandler(`setup-${project.id}`, handleWsMessage)
    return () => unregisterHandler(`setup-${project.id}`)
  }, [handleWsMessage, registerHandler, unregisterHandler, project.id])

  // ─── Actions ────────────────────────────────────────────────────────────────

  // Kick off the install for a single provider (index into `providers`). The WS
  // `setup_install_done` handler advances to the next provider or to Done.
  const installProvider = useCallback((index: number) => {
    const provider = providers[index] ?? 'claude'
    const cfg = configsRef.current[provider] ?? buildDefaultConfig()

    // Ensure core agents are always included
    const selectedWithCore = [...new Set([...CORE_AGENTS, ...cfg.selectedAgents])]
    const excluded = ALL_AGENTS.map((a) => a.id).filter((id) => !selectedWithCore.includes(id))

    // Convert model overrides from full IDs to short names (sonnet/haiku/opus)
    const shortOverrides: Record<string, string> = {}
    for (const [agentId, modelId] of Object.entries(cfg.modelOverrides)) {
      if (modelId) shortOverrides[agentId] = toShortModelName(modelId)
    }

    setCheckpoints(installCheckpoints())
    setLogLines([])
    setWizardStep({ step: 'installing', providerIndex: index })

    // Write install config matching specrails-core's install-config.yaml schema.
    // `tier: 'quick'` is hardcoded — the app only exposes the template-agent
    // install flow now; the legacy AI-enrich flow lives in specrails-core's
    // standalone `npx specrails-core@latest init` for users who want it.
    // install-config is written then `install` is started; the server runs ONE
    // provider's `npx specrails-core init` per call. Multi-provider projects
    // call this once per provider in sequence (driven by setup_install_done).
    void (async () => {
      try {
        await fetch(`/api/projects/${project.id}/setup/install-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            provider,
            tier: 'quick',
            agents: { selected: selectedWithCore, excluded },
            models: {
              preset: cfg.modelPreset,
              defaults: { model: presetToDefaultModel(cfg.modelPreset, provider) },
              overrides: shortOverrides,
            },
            agent_teams: false,
          }),
        })
      } catch (err) {
        console.error('[SetupWizard] install-config write error:', err)
      }
      fetch(`/api/projects/${project.id}/setup/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Tell the server which provider this install is for, so it reads this
        // provider's per-provider install-config (additive — multi-provider
        // installs no longer clobber a single shared config).
        body: JSON.stringify({ provider }),
      }).catch((err) => {
        console.error('[SetupWizard] install start error:', err)
      })
    })()
  }, [project.id, providers])

  installProviderRef.current = installProvider

  // Start the full install sequence from the first provider.
  const startInstallSequence = useCallback(() => {
    if (setupPrerequisites !== null && !setupPrerequisites.ok) {
      setWizardStep({
        step: 'error',
        retryStep: 'installing',
        providerIndex: 0,
        message: [
          t('wizard.error.prereqMissing'),
          t('wizard.error.prereqRetryHint'),
        ].join('\n\n'),
      })
      return
    }
    installSummariesRef.current = []
    installIndexRef.current = 0
    installProvider(0)
  }, [setupPrerequisites, installProvider, t])

  // Configure-step primary action: advance to the next provider, or — on the
  // last (or only) provider — begin the install sequence.
  const handlePrimary = useCallback(() => {
    if (wizardStep.step !== 'agent-selection') return
    const i = wizardStep.providerIndex
    if (i < providers.length - 1) {
      setWizardStep({ step: 'agent-selection', providerIndex: i + 1 })
    } else {
      startInstallSequence()
    }
  }, [wizardStep, providers.length, startInstallSequence])

  function handleRetry() {
    if (wizardStep.step !== 'error') return
    startInstallSequence()
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  const configProviderIndex = wizardStep.step === 'agent-selection' ? wizardStep.providerIndex : 0
  const isLastProvider = configProviderIndex >= providers.length - 1
  const ctaLabel = isLastProvider
    ? t('wizard.install')
    : t('wizard.nextProvider', { provider: providerLabel(providers[configProviderIndex + 1]) })

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Wizard step indicator */}
      <div className="flex-shrink-0 border-b border-border/30 px-4 py-2">
        <StepIndicator wizardStep={wizardStep} providers={providers} />
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-hidden">
        {wizardStep.step === 'agent-selection' && (
          <AgentSelectionStep
            key={currentProvider}
            config={currentConfig}
            onChange={setCurrentConfig}
            onInstall={handlePrimary}
            onSkip={onSkip}
            provider={currentProvider}
            ctaLabel={ctaLabel}
            lastStep={isLastProvider}
            prerequisites={setupPrerequisites}
            prerequisitesLoading={isRefreshingPrerequisites}
            prerequisitesError={setupPrerequisitesError}
            onRefreshPrerequisites={refreshSetupPrerequisites}
          />
        )}

        {wizardStep.step === 'installing' && (
          <InstallingStep
            logLines={logLines}
            providerLabelText={providers.length > 1 ? providerLabel(providers[wizardStep.providerIndex]) : undefined}
            onBack={() => setWizardStep({ step: 'agent-selection', providerIndex: providers.length - 1 })}
          />
        )}

        {wizardStep.step === 'complete' && (
          <CompleteStep
            projectName={project.name}
            projectId={project.id}
            summaries={wizardStep.summaries}
            onGoToProject={onComplete}
          />
        )}

        {wizardStep.step === 'error' && (
          <ErrorStep
            message={wizardStep.message}
            onRetry={handleRetry}
            onSkip={onSkip}
          />
        )}
      </div>
    </div>
  )
}
