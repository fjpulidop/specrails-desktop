import { isPublicProvider } from '../../providers/lib/provider-capabilities'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { ArrowLeft, Brain, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentModel } from '../lib/agent-api'
import { CustomModelAliasInput } from '../../providers/components/CustomModelAliasInput'

interface Props {
  provider: string
  providers: { value: string; label: string }[]
  models: AgentModel[]
  model: string
  efforts: string[]
  effort: string
  defaultEffort: string
  status: 'loading' | 'ready' | 'error'
  customModelAliases: boolean
  onProvider(value: string): void
  onModel(value: string): void
  onEffort(value: string | null): void
}

/** One compact trigger; provider selection stays inside the model menu. */
export function AgentRuntimeSelector(props: Props) {
  const { t } = useTranslation('agent')
  const [view, setView] = useState<'effort' | 'models' | 'providers' | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const modelLabel = props.models.find(model => model.value === props.model)?.label ?? props.model
  const effortLabel = props.efforts.length ? t(`effort.${props.effort}`) : ''
  const close = () => { setView(null); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!view) return
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const height = popup.current?.offsetHeight ?? 0
      if (!rect) return
      setPosition({ left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), top: Math.max(8, rect.top - height - 8) })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [view, props.status, props.models, props.efforts])
  useEffect(() => { if (view === 'effort' && !props.efforts.length) setView('models') }, [view, props.efforts.length])
  useEffect(() => {
    if (!view) return
    popup.current?.querySelector<HTMLElement>('button, input')?.focus()
    const down = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setView(null)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [view])
  const rowClass = 'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none'
  return <>
    <button ref={trigger} type="button" data-testid="agent-runtime-selector" data-agent-interactive
      aria-label={t('runtimeSelector.label')} aria-haspopup="dialog" aria-expanded={!!view} title={[modelLabel, effortLabel].filter(Boolean).join(' ')}
      className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2 py-1 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      onClick={() => setView(value => value ? null : props.efforts.length ? 'effort' : 'models')}>
      <Brain className="hidden h-4 w-4 @max-[640px]:block" aria-hidden />
      <span className="truncate @max-[640px]:hidden">{modelLabel || t(props.status === 'loading' ? 'model.loading' : 'model.label')}</span>
      {effortLabel && <span className="shrink-0 text-muted-foreground @max-[640px]:hidden">{effortLabel}</span>}
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground @max-[640px]:hidden" />
    </button>
    {view && createPortal(<motion.div ref={popup} role="dialog" aria-label={t('runtimeSelector.label')}
      className="fixed z-[100] w-[280px] max-w-[calc(100vw-16px)] rounded-2xl border border-border/60 bg-card p-2 shadow-2xl"
      style={position}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}>
      <motion.div key={view} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}>
      {view === 'effort' ? <div className="p-2">
        <div className="flex items-center justify-between">
          <span className="w-6" />
          <span className="text-sm font-medium text-accent-primary">{effortLabel}</span>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={t('runtimeSelector.resetEffort')}
            onClick={() => props.onEffort(null)}><RotateCcw className="h-4 w-4" /></button>
        </div>
        <button type="button" className="mx-auto mt-1 flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setView('models')}>
          <span className="truncate">{modelLabel}</span><ChevronRight className="h-3 w-3" />
        </button>
        <input type="range" aria-label={t('effort.label')} aria-valuetext={effortLabel} min={0} max={Math.max(0, props.efforts.length - 1)} step={1}
          value={Math.max(0, props.efforts.indexOf(props.effort || props.defaultEffort))} disabled={props.efforts.length < 2}
          className="mt-4 w-full accent-accent-primary" onChange={event => props.onEffort(props.efforts[Number(event.target.value)])} />
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{t(`effort.${props.efforts[0]}`)}</span><span>{t(`effort.${props.efforts[props.efforts.length - 1]}`)}</span></div>
      </div> : <>
        <div className="mb-1 flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <button type="button" aria-label={t('runtimeSelector.back')} className="rounded p-1 hover:bg-muted"
            onClick={() => props.efforts.length && view === 'models' ? setView('effort') : view === 'providers' ? setView('models') : close()}><ArrowLeft className="h-3.5 w-3.5" /></button>
          {t(view === 'providers' ? 'provider.label' : 'model.label')}
        </div>
        <div className="max-h-[min(18rem,50vh)] overflow-auto">
          {view === 'providers' ? props.providers.filter(provider => isPublicProvider(provider.value)).map(provider => <button key={provider.value} type="button" className={rowClass}
            aria-pressed={provider.value === props.provider} onClick={() => { props.onProvider(provider.value); setView('models') }}>
            {provider.label}{provider.value === props.provider && <Check className="h-4 w-4 text-accent-primary" />}
          </button>) : props.status !== 'ready' ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t(props.status === 'loading' ? 'model.loading' : 'model.unavailable')}</p>
          : props.models.map(model => <button key={model.value} type="button" className={rowClass} aria-pressed={model.value === props.model}
            onClick={() => { props.onModel(model.value); props.efforts.length ? setView('effort') : close() }}>
            <span className="truncate">{model.label}</span>{model.value === props.model && <Check className="h-4 w-4 shrink-0 text-accent-primary" />}
          </button>)}
        </div>
        {view === 'models' && <>
          {props.customModelAliases && <CustomModelAliasInput value={props.model} options={props.models} onCommit={props.onModel}
            disabled={props.status !== 'ready'} ariaLabel={t('model.label')} className="my-2 w-full" />}
          <button type="button" className={`${rowClass} mt-1 border-t border-border text-muted-foreground`} onClick={() => setView('providers')}>
            <span>{t('provider.label')}: {props.providers.find(provider => provider.value === props.provider)?.label ?? props.provider}</span><ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>}
      </>}
      </motion.div>
    </motion.div>, document.body)}
  </>
}
