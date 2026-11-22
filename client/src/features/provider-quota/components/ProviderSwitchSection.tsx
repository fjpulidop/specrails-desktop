/**
 * "Continue with another provider": the Provider · Model · Reasoning effort a
 * Core run's roles on the limited provider continue with, what that does to
 * the run, "Remember for this project" and the button. One section for both
 * ways a usage limit stops a Core run: paused at the limit (the pause card
 * resumes it in place) and settled on it (the failure card continues it as the
 * next attempt). The server names the targets (never the limited provider, one
 * sharing its quota or one refusing too) and checks the choice again.
 */
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, ChevronDown, Play } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { modelsForProvider } from '../../loops/lib/loop-run-models'
import { defaultReasoningEffortForProvider, reasoningEffortsForProvider } from '../../providers/lib/provider-capabilities'
import { providerLabel } from '../lib/labels'
import type { SwitchTarget } from '../lib/limit-pause'

/** What the person chose: the provider, model and effort the moved roles continue with, and whether the project keeps it. */
export interface ProviderSwitchChoice { provider: string; model: string; effort?: string; remember?: boolean }

/** The models offered for a target: its catalog, with the server's starting model first when the catalog lacks it. */
export function switchModels(target: SwitchTarget): Array<{ value: string; label: string }> {
  const catalog = modelsForProvider(target.provider)
  return catalog.some((model) => model.value === target.model) ? catalog : [{ value: target.model, label: target.model }, ...catalog]
}

/** The efforts offered for a model, and the one it starts on (the target's when it applies, else the provider default). */
export function switchEfforts(target: SwitchTarget, model: string): { efforts: readonly string[]; initial: string | null } {
  const efforts = reasoningEffortsForProvider(target.provider, model)
  if (!efforts.length) return { efforts, initial: null }
  return { efforts, initial: target.effort && efforts.includes(target.effort as never) ? target.effort : defaultReasoningEffortForProvider(target.provider, model) ?? efforts[0]! }
}

/** The section's selection, held by whoever also acts on it (the failure card's analysis option continues with it too). */
export interface ProviderSwitchState {
  target: SwitchTarget
  model: string
  effort: string | null
  remember: boolean
  efforts: readonly string[]
  models: Array<{ value: string; label: string }>
  chooseProvider(provider: string): void
  chooseModel(model: string): void
  setEffort(effort: string): void
  setRemember(remember: boolean): void
  choice: ProviderSwitchChoice
}

export function useProviderSwitchChoice(targets: readonly SwitchTarget[]): ProviderSwitchState | null {
  const first = targets[0] ?? null
  const [provider, setProvider] = useState(first?.provider ?? '')
  const target = targets.find((item) => item.provider === provider) ?? first
  const [model, setModel] = useState(first?.model ?? '')
  const [effort, setEffort] = useState<string | null>(first ? switchEfforts(first, first.model).initial : null)
  const [remember, setRemember] = useState(false)
  const models = useMemo(() => (target ? switchModels(target) : []), [target])
  if (!target) return null
  // The targets can arrive after the first render (or change): until the person picks, the selection is the first target's.
  const picked = target.provider === provider
  const currentModel = picked ? model : target.model
  const { efforts, initial } = switchEfforts(target, currentModel)
  const currentEffort = effort && efforts.includes(effort) ? effort : initial
  return {
    target, model: currentModel, effort: currentEffort, remember, efforts, models,
    chooseProvider: (next) => {
      const chosen = targets.find((item) => item.provider === next)
      if (!chosen) return
      setProvider(next); setModel(chosen.model); setEffort(switchEfforts(chosen, chosen.model).initial)
    },
    chooseModel: (next) => {
      setProvider(target.provider); setModel(next)
      const options = switchEfforts(target, next)
      setEffort(currentEffort && options.efforts.includes(currentEffort) ? currentEffort : options.initial)
    },
    setEffort: (next) => { setProvider(target.provider); setModel(currentModel); setEffort(next) },
    setRemember,
    choice: { provider: target.provider, model: currentModel, ...(currentEffort ? { effort: currentEffort } : {}), ...(remember ? { remember: true } : {}) },
  }
}

export function ProviderSwitchSection({ fromProvider, targets, state, busy, onSwitch, variant = 'pause', step = null, testId = 'limit-pause-switch', className, collapsible = false }: {
  fromProvider: string
  targets: readonly SwitchTarget[]
  state: ProviderSwitchState
  busy: boolean
  onSwitch: (choice: ProviderSwitchChoice) => void
  /** `pause`: the paused run resumes in place; `settled`: the stopped run continues as its next attempt. */
  variant?: 'pause' | 'settled'
  /** `settled`: the step the next attempt goes on from, as the person reads it. */
  step?: string | null
  testId?: string
  className?: string
  /** The title is a disclosure and the choice stays folded until the person opens it (a compact pause card). */
  collapsible?: boolean
}) {
  const { t } = useTranslation(['providerQuota', 'agent'])
  const name = providerLabel(state.target.provider), from = providerLabel(fromProvider)
  const keys = variant === 'settled' ? 'settledSwitch' : 'pause.switch'
  const [open, setOpen] = useState(!collapsible)
  const bodyId = useId()
  const title = <><ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{t(`${keys}.title`)}</>
  return (
    <div className={className ?? 'space-y-2 border-t border-accent-warning/30 pt-2'} data-testid={testId}>
      {collapsible ? (
        <button type="button" aria-expanded={open} aria-controls={bodyId} data-testid={`${testId}-toggle`} onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 rounded-control text-strong text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {title}
          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      ) : <p className="flex items-center gap-1.5 text-strong text-foreground">{title}</p>}
      {open && <div id={bodyId} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-caption text-muted-foreground">
          <span>{t('pause.switch.provider')}</span>
          <Select value={state.target.provider} onValueChange={state.chooseProvider} disabled={busy}>
            <SelectTrigger aria-label={t('pause.switch.provider')} data-testid={`${testId}-provider`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {targets.map((item) => <SelectItem key={item.provider} value={item.provider}>{providerLabel(item.provider)}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-caption text-muted-foreground">
          <span>{t('pause.switch.model')}</span>
          <Select value={state.model} onValueChange={state.chooseModel} disabled={busy}>
            <SelectTrigger aria-label={t('pause.switch.model')} data-testid={`${testId}-model`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {state.models.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {state.efforts.length > 0 && state.effort && (
          <label className="space-y-1 text-caption text-muted-foreground">
            <span>{t('pause.switch.effort')}</span>
            <Select value={state.effort} onValueChange={state.setEffort} disabled={busy}>
              <SelectTrigger aria-label={t('pause.switch.effort')} data-testid={`${testId}-effort`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {state.efforts.map((item) => <SelectItem key={item} value={item}>{t(`agent:effort.${item}`, { defaultValue: item })}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
      <p className="text-caption text-muted-foreground" data-testid={`${testId}-consequence`}>
        {variant === 'settled' && step ? t('settledSwitch.consequenceFrom', { provider: name, from, step }) : t(`${keys}.consequence`, { provider: name, from })}{' '}
        {state.remember ? t('pause.switch.settingsUpdated', { provider: name }) : t('pause.switch.settingsKept')}
      </p>
      <label className="flex items-center gap-2 text-caption text-muted-foreground">
        <input type="checkbox" checked={state.remember} disabled={busy} onChange={(event) => state.setRemember(event.target.checked)} data-testid={`${testId}-remember`} />
        <span>{t('pause.switch.remember')}</span>
      </label>
      <Button size="sm" disabled={busy} data-testid={`${testId}-resume`} className="gap-1.5" aria-busy={busy || undefined}
        onClick={() => onSwitch(state.choice)}>
        <Play className="h-3.5 w-3.5" aria-hidden />{t(`${keys}.resume`, { provider: name })}
      </Button>
      </div>}
    </div>
  )
}
