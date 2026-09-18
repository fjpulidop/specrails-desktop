import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Sparkles, TriangleAlert } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import type { RuntimeLocalProvider, RuntimeProviderStatus, RuntimeProviderTestResult } from '../../../lib/agent-runtime'
import { registerDynamicModelCatalog } from '../../../lib/loop-run-models'
import { ConnectionStatusPill, pillStateFor } from './ConnectionStatusPill'
import { TestConnectionButton } from './TestConnectionButton'

/** Recommended settings for 7–14B local models: compact loop, effort forwarded, a 32k window. */
export const SMALL_MODEL_CONTEXT = 32768
export function isSmallModelPreset(provider: RuntimeLocalProvider): boolean {
  return (provider.agentLoop ?? 'compact') === 'compact' && provider.supportsReasoningEffort === true && (provider.contextWindowTokens ?? 0) >= SMALL_MODEL_CONTEXT
}

interface Props {
  provider: RuntimeLocalProvider
  /** Detection status from the server (or the last test result overlay). */
  status?: RuntimeProviderStatus
  /** True once the row has been persisted — its id then locks behind Rename. */
  persisted: boolean
  onChange: (next: RuntimeLocalProvider) => void
  onStatus: (next: RuntimeProviderStatus | undefined) => void
  onValidity: (valid: boolean) => void
  onRemove: () => void
}

const CUSTOM = '__custom__'
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'
const labelClass = 'space-y-1 text-xs text-muted-foreground'

function rateText(value: number | undefined): string { return value === undefined ? '' : String(value) }
function parseRate(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN
}

/**
 * Editable local (OpenAI-compatible) connection: identity, endpoint, env key,
 * discovered models + default model, optional USD rates, effort switch.
 */
export function LocalConnectionEditor({ provider, status, persisted, onChange, onStatus, onValidity, onRemove }: Props) {
  const { t } = useTranslation('agentRuntime')
  const uid = useId()
  const [renaming, setRenaming] = useState(!persisted)
  const [probing, setProbing] = useState(false)
  const [testError, setTestError] = useState('')
  const [rates, setRates] = useState({ input: rateText(provider.rates?.inputPer1M), output: rateText(provider.rates?.outputPer1M) })
  const [customModel, setCustomModel] = useState(false)

  const models = status?.models ?? []
  const defaultInList = !provider.defaultModel || models.includes(provider.defaultModel)
  const showCustom = customModel || !defaultInList
  const input = parseRate(rates.input), output = parseRate(rates.output)
  const ratesInvalid = Number.isNaN(input) || Number.isNaN(output) || (input === null) !== (output === null)
  useEffect(() => { onValidity(!ratesInvalid) }, [ratesInvalid, onValidity])

  function setRate(key: 'input' | 'output', text: string) {
    const next = { ...rates, [key]: text }
    setRates(next)
    const nextInput = parseRate(next.input), nextOutput = parseRate(next.output)
    if (nextInput === null && nextOutput === null) onChange({ ...provider, rates: undefined })
    else if (nextInput !== null && nextOutput !== null && !Number.isNaN(nextInput) && !Number.isNaN(nextOutput)) onChange({ ...provider, rates: { inputPer1M: nextInput, outputPer1M: nextOutput } })
  }
  function applyTest(result: RuntimeProviderTestResult) {
    setProbing(false); setTestError('')
    onStatus({ reachable: result.reachable, authState: result.authState, models: result.models, latencyMs: result.latencyMs, error: result.error, apiKeyEnvMissing: result.apiKeyEnvMissing })
    if (result.models.length) registerDynamicModelCatalog(provider.id, result.models)
  }

  const pill = pillStateFor(status, probing)
  return (
    <div className="space-y-4" data-testid={`local-connection-${provider.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionStatusPill state={pill} latencyMs={status?.latencyMs} />
        {status?.error && pill !== 'reachable' && <span className="truncate text-[11px] text-destructive/90" title={status.error}>{status.error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <TestConnectionButton baseUrl={provider.baseUrl} apiKeyEnv={provider.apiKeyEnv} onStart={() => { setProbing(true); setTestError('') }} onResult={applyTest} onError={(message) => { setProbing(false); setTestError(message) }} />
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>{t('providers.remove')}</Button>
        </div>
      </div>
      {testError && <p role="alert" className="text-xs text-destructive">{testError}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={labelClass}>
          <div className="flex items-center gap-2">
            <label htmlFor={`${uid}-id`}>{t('providers.id')}</label>
            {persisted && !renaming && <button type="button" className="inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline" onClick={() => setRenaming(true)}><Pencil className="h-3 w-3" aria-hidden />{t('providers.rename')}</button>}
          </div>
          <Input id={`${uid}-id`} value={provider.id} readOnly={!renaming} aria-readonly={!renaming} title={!renaming ? t('providers.idLocked') : undefined} className={cn(!renaming && 'text-muted-foreground')} onChange={(e) => onChange({ ...provider, id: e.target.value })} />
          {renaming && persisted && <p className="text-[11px] text-muted-foreground/80">{t('providers.renameHint')}</p>}
        </div>
        <label className={labelClass} htmlFor={`${uid}-label`}>{t('providers.label')}
          <Input id={`${uid}-label`} value={provider.label ?? ''} placeholder={t('providers.labelPlaceholder')} onChange={(e) => onChange({ ...provider, label: e.target.value || undefined })} />
        </label>
        <label className={labelClass} htmlFor={`${uid}-url`}>{t('providers.baseUrl')}
          <Input id={`${uid}-url`} type="url" value={provider.baseUrl} onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })} />
        </label>
        <label className={labelClass} htmlFor={`${uid}-env`}>{t('providers.apiKeyEnv')}
          <Input id={`${uid}-env`} value={provider.apiKeyEnv ?? ''} onChange={(e) => onChange({ ...provider, apiKeyEnv: e.target.value || undefined })} />
          {status?.apiKeyEnvMissing && provider.apiKeyEnv && (
            <span role="note" className="flex items-center gap-1 text-[11px] text-accent-warning"><TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />{t('providers.apiKeyEnvMissing', { name: provider.apiKeyEnv })}</span>
          )}
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('providers.discoveredModels')}</p>
        {models.length === 0
          ? <p className="text-[11px] text-muted-foreground/70">{t('providers.noModels')}</p>
          : <ul className="flex flex-wrap gap-1.5" aria-label={t('providers.discoveredModels')}>
            {models.map((model) => <li key={model}>
              <button type="button" onClick={() => { setCustomModel(false); onChange({ ...provider, defaultModel: model }) }}
                className={cn('rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors', provider.defaultModel === model ? 'border-accent-primary/50 bg-accent-primary/10 text-foreground' : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground')}
                aria-pressed={provider.defaultModel === model}>{model}</button>
            </li>)}
          </ul>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass} htmlFor={`${uid}-default`}>{t('providers.defaultModel')}
            <select id={`${uid}-default`} className={selectClass} value={showCustom ? CUSTOM : (provider.defaultModel ?? '')} onChange={(e) => {
              if (e.target.value === CUSTOM) { setCustomModel(true); return }
              setCustomModel(false); onChange({ ...provider, defaultModel: e.target.value || undefined })
            }}>
              <option value="">{t('providers.defaultModelNone')}</option>
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
              <option value={CUSTOM}>{t('providers.customModel')}</option>
            </select>
          </label>
          {showCustom && <label className={labelClass} htmlFor={`${uid}-custom`}>{t('providers.customModel')}
            <Input id={`${uid}-custom`} value={provider.defaultModel ?? ''} placeholder={t('providers.defaultModelPlaceholder')} onChange={(e) => onChange({ ...provider, defaultModel: e.target.value || undefined })} />
          </label>}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('providers.rates')} <span className="text-muted-foreground/60">· {t('providers.ratesHint')}</span></p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass} htmlFor={`${uid}-in`}>{t('providers.inputRate')}
            <Input id={`${uid}-in`} type="number" min="0" step="0.01" inputMode="decimal" value={rates.input} onChange={(e) => setRate('input', e.target.value)} aria-invalid={ratesInvalid} />
          </label>
          <label className={labelClass} htmlFor={`${uid}-out`}>{t('providers.outputRate')}
            <Input id={`${uid}-out`} type="number" min="0" step="0.01" inputMode="decimal" value={rates.output} onChange={(e) => setRate('output', e.target.value)} aria-invalid={ratesInvalid} />
          </label>
        </div>
        {ratesInvalid && <p role="alert" className="text-[11px] text-destructive">{t('providers.ratesInvalid')}</p>}
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-xs" htmlFor={`${uid}-effort`}>
        <input id={`${uid}-effort`} type="checkbox" role="switch" aria-checked={Boolean(provider.supportsReasoningEffort)} className="mt-0.5 accent-accent-primary" checked={Boolean(provider.supportsReasoningEffort)} onChange={(e) => onChange({ ...provider, supportsReasoningEffort: e.target.checked || undefined })} />
        <span><span className="text-foreground">{t('providers.reasoningEffort')}</span><span className="block text-[11px] text-muted-foreground">{t('providers.reasoningEffortHint')}</span>{!provider.supportsReasoningEffort && <span className="block text-[11px] text-muted-foreground/70">{t('providers.reasoningEffortRailHint')}</span>}</span>
      </label>

      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t('providers.presetTitle')}</p>
          <Button type="button" variant="secondary" size="sm" disabled={isSmallModelPreset(provider)}
            title={t('providers.presetSmallModelHint')}
            onClick={() => onChange({ ...provider, agentLoop: undefined, supportsReasoningEffort: true, contextWindowTokens: provider.contextWindowTokens ?? SMALL_MODEL_CONTEXT })}>
            <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{isSmallModelPreset(provider) ? t('providers.presetSmallModelApplied') : t('providers.presetSmallModel')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground/70">{t('providers.presetSmallModelHint')}</p>
      </div>

      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
        <p className="text-xs text-muted-foreground">{t('providers.agentLoop')} <span className="text-muted-foreground/60">· {t('providers.agentLoopHint')}</span></p>
        <div role="radiogroup" aria-label={t('providers.agentLoop')} className="grid grid-cols-2 gap-1 rounded-md bg-muted/40 p-1">
          {(['compact', 'free'] as const).map((mode) => {
            const active = (provider.agentLoop ?? 'compact') === mode
            return (
              <button key={mode} type="button" role="radio" aria-checked={active}
                className={cn('rounded px-2 py-1.5 text-xs transition-colors', active ? 'bg-accent-primary/15 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => onChange({ ...provider, agentLoop: mode === 'compact' ? undefined : mode })}>
                <span className="block font-medium">{t(`providers.agentLoop_${mode}`)}</span>
                <span className="block text-[11px] text-muted-foreground">{t(`providers.agentLoop_${mode}Hint`)}</span>
              </button>
            )
          })}
        </div>
        <label className={labelClass} htmlFor={`${uid}-ctx`}>{t('providers.contextWindow')}
          <Input id={`${uid}-ctx`} type="number" min={4096} step={1024} inputMode="numeric" placeholder="32768" value={provider.contextWindowTokens ?? ''}
            aria-invalid={provider.contextWindowTokens !== undefined && provider.contextWindowTokens < 4096}
            onChange={(e) => { const n = Number.parseInt(e.target.value, 10); onChange({ ...provider, contextWindowTokens: Number.isFinite(n) && e.target.value !== '' ? n : undefined }) }} />
          <span className="block text-[11px] text-muted-foreground">{t('providers.contextWindowHint')}</span>
        </label>
        <label className={labelClass} htmlFor={`${uid}-out`}>{t('providers.maxOutput')}
          <Input id={`${uid}-out`} type="number" min={1024} step={1024} inputMode="numeric" placeholder="8192" value={provider.maxOutputTokens ?? ''}
            aria-invalid={provider.maxOutputTokens !== undefined && provider.maxOutputTokens < 1024}
            onChange={(e) => { const n = Number.parseInt(e.target.value, 10); onChange({ ...provider, maxOutputTokens: Number.isFinite(n) && e.target.value !== '' ? n : undefined }) }} />
          <span className="block text-[11px] text-muted-foreground">{t('providers.maxOutputHint')}</span>
        </label>
      </div>
    </div>
  )
}
