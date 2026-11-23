import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, PlugZap, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Skeleton } from '../../../components/ui/skeleton'
import { Switch } from '../../../components/ui/switch'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'
import { cn } from '../../../lib/utils'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { SettingsCard } from './SettingsCard'

// Mirror of `ProviderConnectors` / `ConnectorRow`
// (server/modules/missions/runtime/mission-connectors.ts).
type ConnectorLock = 'specrails-duplicate' | 'disabled-in-provider' | 'external-mcp' | 'unsupported'

export interface ConnectorRow {
  name: string
  kind: 'account-connector' | 'mcp-server'
  enabled: boolean
  lock?: ConnectorLock
  status?: 'connected' | 'needs-auth' | 'failed' | 'unknown'
  transport?: { command?: string; args?: string[]; url?: string; type?: string }
  size?: { tools: number; tokens: number; measuredAt: string }
}

export interface ProviderConnectors {
  provider: string
  detected: boolean
  connectors: ConnectorRow[]
  userServersNeedToolSearch?: boolean
}

export interface MissionConnectorsPayload {
  detectedAt: string
  claudeAccountListStale: boolean
  measuring: boolean
  providers: ProviderConnectors[]
}

const ENDPOINT = `${API_ORIGIN}/api/mission-connectors`

function isPayload(value: unknown): value is MissionConnectorsPayload {
  return !!value && typeof value === 'object' && Array.isArray((value as MissionConnectorsPayload).providers)
}

async function readPayload(response: Response): Promise<MissionConnectorsPayload> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  const data = (await response.json()) as unknown
  if (!isPayload(data)) throw new Error('unexpected response')
  return data
}

/** `23.0k` style token count. */
function compactTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)
}

/**
 * App settings ▸ Specrails Agents ▸ "Connectors in missions": the connectors
 * and MCP servers each provider already has (claude.ai account connectors,
 * `~/.claude.json`, `~/.codex/config.toml`, Gemini, Kimi), grouped by provider,
 * each with a toggle. Everything starts on; a switch applies on the next
 * mission turn. Specrails' own MCP is always excluded when a provider config
 * repeats it.
 */
export function MissionConnectorsSection() {
  const { t } = useTranslation('settings')
  const [payload, setPayload] = useState<MissionConnectorsPayload | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'refresh' | 'measure' | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    try {
      setPayload(await readPayload(await fetch(refresh ? `${ENDPOINT}?refresh=1` : ENDPOINT)))
      setLoadFailed(false)
    } catch (error) {
      setLoadFailed(true)
      if (refresh) notifyError(t('missionConnectors.loadFailed'), { detail: (error as Error).message, retry: () => void load(true) })
    }
  }, [t])

  useEffect(() => { void load(false) }, [load])

  async function refresh() {
    setBusy('refresh')
    try { await load(true) } finally { setBusy(null) }
  }

  async function measure() {
    setBusy('measure')
    try {
      setPayload(await readPayload(await fetch(`${ENDPOINT}/measure`, { method: 'POST' })))
    } catch (error) {
      notifyError(t('missionConnectors.measureFailed'), { detail: (error as Error).message, retry: () => void measure() })
    } finally {
      setBusy(null)
    }
  }

  async function toggle(provider: string, row: ConnectorRow, enabled: boolean) {
    const key = `${provider}:${row.name}`
    const previous = payload
    setPending(key)
    // Optimistic: flip the row now, reconcile with the server's view.
    setPayload((current) => current && {
      ...current,
      providers: current.providers.map((entry) => entry.provider !== provider ? entry : {
        ...entry,
        connectors: entry.connectors.map((connector) => connector.name === row.name ? { ...connector, enabled } : connector),
      }),
    })
    try {
      setPayload(await readPayload(await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, name: row.name, enabled }),
      })))
    } catch (error) {
      setPayload(previous)
      notifyError(t('missionConnectors.saveFailed', { name: row.name }), { detail: (error as Error).message, retry: () => void toggle(provider, row, enabled) })
    } finally {
      setPending(null)
    }
  }

  const actions = (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void measure()} disabled={busy !== null || !payload} data-testid="mission-connectors-measure">
        <Gauge className={cn('h-3 w-3', busy === 'measure' && 'motion-safe:animate-pulse')} aria-hidden />
        {busy === 'measure' ? t('missionConnectors.measuring') : t('missionConnectors.measure')}
      </Button>
      <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void refresh()} disabled={busy !== null} data-testid="mission-connectors-refresh">
        <RefreshCw className={cn('h-3 w-3', busy === 'refresh' && 'motion-safe:animate-spin')} aria-hidden />
        {t('missionConnectors.refresh')}
      </Button>
    </div>
  )

  const groups = payload?.providers.filter((entry) => entry.connectors.length > 0) ?? []

  return (
    <SettingsCard
      title={<span className="flex items-center gap-2"><PlugZap className="h-4 w-4 text-accent-primary" aria-hidden />{t('missionConnectors.title')}</span>}
      description={t('missionConnectors.description')}
      action={actions}
      data-testid="mission-connectors"
      data-setting-id="missionConnectors"
    >
      {!payload && !loadFailed && <Skeleton className="h-32 rounded-lg" data-testid="section-skeleton" />}
      {!payload && loadFailed && <p className="text-xs text-muted-foreground">{t('missionConnectors.loadFailed')}</p>}
      {payload && groups.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('missionConnectors.empty')}</p>
        </div>
      )}
      {groups.map((group) => (
        <section key={group.provider} className="space-y-2" aria-labelledby={`mission-connectors-${group.provider}`} data-testid={`mission-connectors-${group.provider}`}>
          <div className="space-y-0.5">
            <h4 id={`mission-connectors-${group.provider}`} className="text-label">{providerLabel(group.provider)}</h4>
            <p className="text-xs text-muted-foreground">{t(`missionConnectors.providerNote.${group.provider}`, { defaultValue: '' })}</p>
            {group.userServersNeedToolSearch && group.connectors.some((row) => row.kind === 'mcp-server' && !row.lock) && (
              <p className="text-xs text-muted-foreground">{t('missionConnectors.waitsForToolSearch')}</p>
            )}
            {group.provider === 'claude' && payload?.claudeAccountListStale && (
              <p className="text-xs text-accent-warning">{t('missionConnectors.claudeListStale')}</p>
            )}
          </div>
          <ul className="divide-y divide-border/40 rounded-lg border border-border/40">
            {group.connectors.map((row) => (
              <ConnectorItem
                key={row.name}
                provider={group.provider}
                row={row}
                waitsForToolSearch={group.provider === 'claude' && row.kind === 'mcp-server' && group.userServersNeedToolSearch === true}
                pending={pending === `${group.provider}:${row.name}`}
                onToggle={(enabled) => void toggle(group.provider, row, enabled)}
              />
            ))}
          </ul>
        </section>
      ))}
      {payload && groups.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('missionConnectors.appliesNextTurn')}</p>
      )}
    </SettingsCard>
  )
}

function ConnectorItem({ provider, row, waitsForToolSearch, pending, onToggle }: {
  provider: string
  row: ConnectorRow
  waitsForToolSearch: boolean
  pending: boolean
  onToggle: (enabled: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const lockable = row.lock === 'specrails-duplicate' || row.lock === 'disabled-in-provider' || row.lock === 'external-mcp' || row.lock === 'unsupported'
  const notes: string[] = []
  if (row.lock) notes.push(t(`missionConnectors.lock.${row.lock}`, { provider: providerLabel(provider) }))
  if (!row.lock && waitsForToolSearch) notes.push(t('missionConnectors.notLoadedYet'))
  if (row.status === 'needs-auth') notes.push(t('missionConnectors.status.needsAuth'))
  if (row.status === 'failed') notes.push(t('missionConnectors.status.failed'))
  const label = t('missionConnectors.toggleLabel', { name: row.name, provider: providerLabel(provider) })
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2" data-testid={`mission-connector-${provider}-${row.name}`}>
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-medium" title={row.transport?.url ?? row.transport?.command ?? row.name}>{row.name}</span>
          <span className="text-xs text-muted-foreground">{t(`missionConnectors.kind.${row.kind}`)}</span>
          {row.size && (
            <span className="text-xs tabular-nums text-muted-foreground">
              <span className="sr-only">{t('missionConnectors.sizeTitle')}: </span>
              {t('missionConnectors.size', { tokens: compactTokens(row.size.tokens), count: row.size.tools })}
            </span>
          )}
        </div>
        {notes.length > 0 && <p className="text-xs text-muted-foreground">{notes.join(' · ')}</p>}
      </div>
      <Switch
        checked={row.enabled}
        onCheckedChange={onToggle}
        disabled={pending || lockable}
        aria-label={label}
      />
    </li>
  )
}
