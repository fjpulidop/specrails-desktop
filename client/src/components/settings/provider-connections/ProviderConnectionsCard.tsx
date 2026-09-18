import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, Cpu, Plus, Save, Server, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import {
  RUNTIME_CLI_PROVIDERS, isRuntimeProvidersResponse, nextRuntimeProviderId,
  type RuntimeCli, type RuntimeCliProvider, type RuntimeLocalProvider, type RuntimeProvider, type RuntimeProviderStatus,
} from '../../../lib/agent-runtime'
import { isLocalEnginesEnabled } from '../../../lib/feature-flags'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { ConnectionRow } from './ConnectionRow'
import { CliProviderRow } from './CliProviderRow'
import { LocalEngineCard } from './LocalEngineCard'
import { OverflowMenu } from './OverflowMenu'

interface Row { key: number; provider: RuntimeProvider; persisted: boolean }

let nextKey = 1
function rowsFrom(providers: RuntimeProvider[], persisted: boolean): Row[] {
  return providers.map((provider) => ({ key: nextKey++, provider, persisted }))
}

interface Props {
  /** Extra provider-level configuration rendered under the collapsible "Provider defaults" block. */
  children?: ReactNode
}

/**
 * Settings ▸ AI providers. The section header explains the two kinds of
 * provider (CLI tools detected on this machine · local OpenAI-compatible
 * engines) and where they are used; the body groups them — CLI tools as a
 * compact read-only list, local engines as expandable cards — and persists
 * through `PUT /api/runtime-providers`. `children` (provider defaults) sit in
 * a collapsible block below. Legacy plain rows when the client flag is off.
 */
export function ProviderConnectionsCard({ children }: Props) {
  const { t } = useTranslation('agentRuntime')
  const legacy = !isLocalEnginesEnabled()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [saved, setSaved] = useState<RuntimeProvider[] | null>(null)
  const [status, setStatus] = useState<Record<string, RuntimeProviderStatus>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalidKeys, setInvalidKeys] = useState<Set<number>>(() => new Set())
  const [defaultsOpen, setDefaultsOpen] = useState(true)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    fetch('/api/runtime-providers').then(async (response) => {
      const data: unknown = await response.json()
      if (!response.ok || !isRuntimeProvidersResponse(data)) throw new Error((data as { message?: string } | null)?.message ?? t('loadFailed'))
      if (cancelled) return
      setRows(rowsFrom(data.providers, true)); setSaved(data.providers); setStatus(data.status ?? {})
    }).catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true; mounted.current = false }
  }, [t])

  const draft = useMemo(() => rows?.map((row) => row.provider) ?? null, [rows])
  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  const invalid = invalidKeys.size > 0

  const changeRow = useCallback((key: number, provider: RuntimeProvider) => {
    setRows((current) => current?.map((row) => row.key === key ? { ...row, provider } : row) ?? current)
  }, [])
  const removeRow = useCallback((key: number) => {
    setRows((current) => current?.filter((row) => row.key !== key) ?? current)
    setInvalidKeys((current) => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next })
  }, [])
  const setValidity = useCallback((key: number, valid: boolean) => {
    setInvalidKeys((current) => {
      if (current.has(key) === !valid) return current
      const next = new Set(current); if (valid) next.delete(key); else next.add(key); return next
    })
  }, [])
  const setRowStatus = useCallback((id: string, next: RuntimeProviderStatus | undefined) => {
    setStatus((current) => { const copy = { ...current }; if (next) copy[id] = next; else delete copy[id]; return copy })
  }, [])

  function addLocal() {
    if (!rows) return
    const id = nextRuntimeProviderId(rows.map((row) => row.provider), 'local')
    const provider: RuntimeProvider = { id, kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }
    setRows([...rows, { key: nextKey++, provider, persisted: false }])
  }
  /** Legacy (flag off): a generic `cli` row; premium: the named CLI, id = its binary name. */
  function addCli(cli?: RuntimeCli) {
    if (!rows) return
    const providers = rows.map((row) => row.provider)
    const provider: RuntimeProvider = cli && !providers.some((p) => p.id === cli)
      ? { id: cli, kind: 'cli', cli }
      : { id: nextRuntimeProviderId(providers, 'cli'), kind: 'cli', cli: cli ?? 'claude' }
    setRows([...rows, { key: nextKey++, provider, persisted: false }])
  }

  async function save() {
    if (!draft) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/runtime-providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: draft }) })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok || !isRuntimeProvidersResponse(data)) throw new Error((data as { message?: string } | null)?.message ?? t('saveFailed'))
      if (!mounted.current) return
      setRows(rowsFrom(data.providers, true)); setSaved(data.providers); setStatus(data.status ?? {}); setInvalidKeys(new Set())
      toast.success(t('saved'))
    } catch (err) {
      const message = (err as Error).message || t('saveFailed')
      if (mounted.current) setError(message)
      toast.error(t('saveFailed'), { description: message })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const cliRows = rows?.filter((row): row is Row & { provider: RuntimeCliProvider } => row.provider.kind === 'cli') ?? []
  const localRows = rows?.filter((row): row is Row & { provider: RuntimeLocalProvider } => row.provider.kind === 'openai-compatible') ?? []
  const missingClis = RUNTIME_CLI_PROVIDERS.filter((cli) => !cliRows.some((row) => row.provider.cli === cli))

  const addLocalButton = (
    <Button size="sm" className="gap-1.5" onClick={addLocal} data-testid="add-local-engine">
      <Plus className="h-3.5 w-3.5" aria-hidden />{t('providers.addLocalHero')}
    </Button>
  )

  return (
    <section className="space-y-6" aria-labelledby="provider-connections-title" data-testid="provider-connections-card">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent-primary/30 bg-accent-primary/10 text-accent-primary shadow-sm">
            <Cpu className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="provider-connections-title" className="text-base font-semibold tracking-tight">{t('providers.globalTitle')}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('providers.globalHint')}</p>
          </div>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!rows && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}

      {rows && legacy && (
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-70">
          {rows.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t('providers.empty')}</p>}
          {rows.map((row) => (
            <ConnectionRow key={row.key} provider={row.provider} onChange={(next) => changeRow(row.key, next)} onRemove={() => removeRow(row.key)} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => addCli()}><Plus className="h-3.5 w-3.5" aria-hidden />{t('providers.addCli')}</Button>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={addLocal}><Plus className="h-3.5 w-3.5" aria-hidden />{t('providers.addLocal')}</Button>
          </div>
        </fieldset>
      )}

      {rows && !legacy && (
        <fieldset disabled={busy} className="space-y-6 disabled:opacity-70">
          {/* CLI tools */}
          <div className="space-y-2" data-testid="cli-group">
            <GroupHeading icon={<TerminalSquare className="h-3.5 w-3.5" aria-hidden />} title={t('providers.cliGroup')} hint={t('providers.cliGroupHint')} count={cliRows.length}
              action={missingClis.length > 0 && (
                <OverflowMenu label={t('providers.addCli')} align="right"
                  trigger={<><Plus className="h-3.5 w-3.5" aria-hidden />{t('providers.addCli')}</>}
                  items={missingClis.map((cli) => ({ id: cli, label: t(`cliNames.${cli}`), icon: <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />, onSelect: () => addCli(cli) }))} />
              )} />
            {cliRows.length === 0
              ? <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t('providers.notDetected')}</p>
              : <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm" aria-label={t('providers.cliGroup')}>
                {cliRows.map((row) => (
                  <CliProviderRow key={row.key} provider={row.provider} status={status[row.provider.id]} onRemove={() => removeRow(row.key)} />
                ))}
              </ul>}
          </div>

          {/* Local engines */}
          <div className="space-y-2" data-testid="local-group">
            <GroupHeading icon={<Server className="h-3.5 w-3.5" aria-hidden />} title={t('providers.localGroup')} hint={t('providers.localGroupHint')} count={localRows.length} action={localRows.length > 0 ? addLocalButton : undefined} />
            {localRows.length === 0
              ? <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/30 px-4 py-8 text-center" data-testid="local-empty">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight"><Server className="h-5 w-5" aria-hidden /></span>
                <p className="max-w-md text-xs text-muted-foreground">{t('providers.emptyLocalPitch')}</p>
                {addLocalButton}
              </div>
              : <div className="space-y-3">
                {localRows.map((row) => (
                  <LocalEngineCard key={row.key} provider={row.provider} status={status[row.provider.id]} persisted={row.persisted} invalid={invalidKeys.has(row.key)}
                    onChange={(next) => changeRow(row.key, next)} onStatus={(next) => setRowStatus(row.provider.id, next)}
                    onValidity={(valid) => setValidity(row.key, valid)} onRemove={() => removeRow(row.key)} />
                ))}
              </div>}
          </div>
        </fieldset>
      )}

      {/* Save bar — sticky at the bottom of the scrolling pane while there is something to save. */}
      {rows && (
        <div className={cn(
          'flex flex-wrap items-center justify-end gap-3 rounded-xl px-3 py-2 transition-all',
          dirty && 'sticky bottom-0 z-20 border border-accent-warning/30 bg-card/95 shadow-lg backdrop-blur',
        )} data-testid="provider-save-bar" data-sticky={dirty}>
          {dirty && <span className="mr-auto inline-flex h-6 items-center gap-1.5 rounded-full border border-accent-warning/30 bg-accent-warning/10 px-2.5 text-[11px] font-medium text-accent-warning" role="status"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-warning" />{t('providers.unsaved')}</span>}
          {invalid && <p className="text-xs text-destructive">{t('providers.fixBeforeSave')}</p>}
          <Button disabled={busy || invalid || !dirty} className="gap-1.5" onClick={() => void save()}><Save className="h-3.5 w-3.5" aria-hidden />{t(busy ? 'saving' : 'save')}</Button>
        </div>
      )}

      {/* Provider defaults */}
      {children && (
        <div className="rounded-xl border border-border/70 bg-card/40" data-testid="provider-defaults">
          <button type="button" aria-expanded={defaultsOpen} aria-controls="provider-defaults-body" onClick={() => setDefaultsOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('providers.defaultsGroup')}</span>
            <ChevronDown className={cn('ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200', defaultsOpen && 'rotate-180')} aria-hidden />
          </button>
          {defaultsOpen && <div id="provider-defaults-body" className="px-4 pb-4 [&>section]:border-t-0 [&>section]:pt-1">{children}</div>}
        </div>
      )}
    </section>
  )
}

function GroupHeading({ icon, title, hint, count, action }: { icon: ReactNode; title: string; hint: string; count: number; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
      <div>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {icon}{title}
          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-px text-[10px] font-medium tabular-nums">{count}</span>
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
      </div>
      {action}
    </div>
  )
}
