import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import type { ProviderId } from '../lib/provider-capabilities'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import type { AgentDef } from './AgentSelector'

// ─── Model definitions ────────────────────────────────────────────────────────

export type ModelPreset = 'balanced' | 'budget' | 'max'

export interface ModelOverrides {
  [agentId: string]: string
}

export const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
]

export const CODEX_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
]

// Per-provider model catalog. Lookup keyed by provider id (not a branch) — a new
// provider adds one entry, with no edit to consumers. Fallback is Claude's list.
const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
}

// Preset → default model per provider (matches specrails-core MODEL_PRESETS).
// Inner maps are keyed by provider id; an unknown provider falls back to Claude.
export const PRESET_DEFAULTS: Record<ModelPreset, Record<string, string>> = {
  balanced: { claude: 'sonnet', codex: 'gpt-5.5' },
  budget: { claude: 'haiku', codex: 'gpt-5.4-mini' },
  max: { claude: 'sonnet', codex: 'gpt-5.5' },
}

// "max" preset: Opus for architect + PM, Sonnet for rest (matches specrails-core)
const MAX_OVERRIDES: Record<string, Record<string, string>> = {
  'sr-architect': { claude: 'opus', codex: 'gpt-5.3-codex' },
  'sr-product-manager': { claude: 'opus', codex: 'gpt-5.3-codex' },
}

export function getDefaultModel(
  agentId: string,
  preset: ModelPreset,
  provider: ProviderId
): string {
  const presetDefaults = PRESET_DEFAULTS[preset]
  if (preset === 'max' && MAX_OVERRIDES[agentId]) {
    return MAX_OVERRIDES[agentId][provider] ?? presetDefaults[provider] ?? presetDefaults.claude
  }
  return presetDefaults[provider] ?? presetDefaults.claude
}

// ─── ModelSelector ────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  agents: AgentDef[]
  provider: ProviderId
  preset: ModelPreset
  overrides: ModelOverrides
  onPresetChange: (preset: ModelPreset) => void
  onOverrideChange: (agentId: string, model: string) => void
}

// Preset labels/descriptions live in the `addspec` i18n namespace under
// `modelSelector.preset.<preset>.{label,description}`.

export function ModelSelector({
  agents,
  provider,
  preset,
  overrides,
  onPresetChange,
  onOverrideChange,
}: ModelSelectorProps) {
  const { t } = useTranslation('addspec')
  const models = PROVIDER_MODELS[provider] ?? CLAUDE_MODELS

  function getEffectiveModel(agentId: string): string {
    return overrides[agentId] ?? getDefaultModel(agentId, preset, provider)
  }

  function isOverridden(agentId: string): boolean {
    return agentId in overrides
  }

  function clearOverride(agentId: string) {
    onOverrideChange(agentId, '')
  }

  return (
    <div className="space-y-4">
      {/* Preset selector */}
      <div>
        <p className="text-xs font-medium mb-2">{t('modelSelector.presetHeading')}</p>
        <div className="grid grid-cols-3 gap-2">
          {(['balanced', 'budget', 'max'] as ModelPreset[]).map((p) => (
            <button
              key={p}
              onClick={() => onPresetChange(p)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                preset === p
                  ? 'border-accent-primary bg-accent-primary/10'
                  : 'border-border/30 hover:border-border/60'
              )}
            >
              <span className={cn(
                'text-xs font-semibold',
                preset === p ? 'text-accent-primary' : 'text-foreground/80'
              )}>
                {t(`modelSelector.preset.${p}.label`)}
              </span>
              <span className="text-[9px] text-muted-foreground text-center leading-tight">
                {t(`modelSelector.preset.${p}.description`)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Per-agent overrides */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium">{t('modelSelector.overridesHeading')}</p>
          <span className="text-[10px] text-muted-foreground">
            {t('modelSelector.overriddenCount', { count: Object.keys(overrides).length })}
          </span>
        </div>

        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {agents.map((agent) => {
            const effectiveModel = getEffectiveModel(agent.id)
            const overridden = isOverridden(agent.id)

            return (
              <div
                key={agent.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/20"
              >
                <div className="flex-1 min-w-0">
                  <span className={cn('text-xs', overridden ? 'text-foreground' : 'text-foreground/70')}>
                    {agent.name}
                  </span>
                  {overridden && (
                    <span className="ml-1 text-[9px] text-accent-warning">{t('modelSelector.customBadge')}</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Select
                    value={effectiveModel}
                    onValueChange={(val) => onOverrideChange(agent.id, val)}
                  >
                    <SelectTrigger className="h-6 w-44 text-[10px] px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {overridden && (
                    <button
                      onClick={() => clearOverride(agent.id)}
                      className="text-[9px] text-muted-foreground hover:text-foreground transition-colors px-1"
                      title={t('modelSelector.resetToDefault')}
                    >
                      ↺
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
