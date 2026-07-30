import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Check, Globe, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { API_ORIGIN } from '../../lib/origin'

/** Mirror of the server-side registry types (server/external-mcp.ts). */
interface ExternalMcpTransport {
  command: string
  args: string[]
  env: Record<string, string>
}

interface ExternalMcpServerEntry {
  source: 'discovered' | 'custom'
  sourceProvider?: string
  name: string
  providers: Record<string, boolean>
  transport?: ExternalMcpTransport
}

interface ExternalMcpSettings {
  version: 1
  servers: Record<string, ExternalMcpServerEntry>
}

interface DiscoveredServer {
  id: string
  name: string
}

interface ExternalMcpDiscovery {
  claude: DiscoveredServer[]
  gemini: DiscoveredServer[]
  kimi: DiscoveredServer[]
  codexNative: string[]
  orphanIds: string[]
}

interface ExternalMcpPayload {
  discovered: ExternalMcpDiscovery
  settings: ExternalMcpSettings
}

/** Activation-matrix columns — the four registered providers. */
const PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const
const DISCOVERY_PROVIDERS = ['claude', 'gemini', 'kimi'] as const
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

interface Row {
  id: string
  name: string
  source: 'discovered' | 'custom'
  sourceProvider?: string
  providers: Record<string, boolean>
  orphan: boolean
  stored: boolean
}

/** Shared look for the provider toggle pills (matrix rows + the custom form). */
function providerPillClass(active: boolean): string {
  return `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all duration-150 disabled:opacity-50 ${
    active
      ? 'border-accent-primary/50 bg-accent-primary/15 text-accent-primary shadow-[0_0_8px_-2px] shadow-accent-primary/30'
      : 'border-border/60 bg-transparent text-muted-foreground/70 hover:border-border hover:text-foreground hover:bg-muted/30'
  }`
}

/**
 * Settings ▸ MCP ▸ "External MCP servers" — the app-level registry of the
 * user's OWN MCP servers for the MISSION agent, with a per-provider activation
 * matrix. Discovered rows come from the provider native configs (read-only);
 * ticking a provider is the consent act and PATCHes the full registry.
 * Codex-native servers are listed display-only (codex loads them natively).
 */
export function ExternalMcpServersCard() {
  const { t } = useTranslation('mcp')
  const [payload, setPayload] = useState<ExternalMcpPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnvPairs, setFormEnvPairs] = useState<{ key: string; value: string }[]>([])
  const [formProviders, setFormProviders] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_ORIGIN}/api/external-mcp`)
      if (!r.ok) return
      const data = (await r.json()) as Partial<ExternalMcpPayload>
      // Shape-guard: an unexpected body keeps the skeleton instead of crashing.
      if (data?.settings?.servers && data?.discovered?.orphanIds) {
        setPayload(data as ExternalMcpPayload)
      }
    } catch {
      /* keep skeleton until a retry succeeds */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback(
    async (servers: Record<string, ExternalMcpServerEntry>) => {
      if (!payload) return
      const prev = payload
      // Optimistic: reflect the new registry immediately, reconcile from the response.
      setPayload({ ...payload, settings: { version: 1, servers } })
      setBusy(true)
      try {
        const r = await fetch(`${API_ORIGIN}/api/external-mcp`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ servers }),
        })
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `HTTP ${r.status}`)
        }
        const data = (await r.json()) as Partial<ExternalMcpPayload>
        if (data?.settings?.servers && data?.discovered?.orphanIds) {
          setPayload(data as ExternalMcpPayload)
        }
        return true
      } catch (e) {
        setPayload(prev)
        const code = (e as Error).message
        toast.error(t([`external.errors.${code}`, 'external.updateFailed'] as unknown as string))
        return false
      } finally {
        setBusy(false)
      }
    },
    [payload, t]
  )

  const rows = useMemo<Row[]>(() => {
    if (!payload) return []
    const { settings, discovered } = payload
    const out: Row[] = []
    const storedIds = new Set(Object.keys(settings.servers))
    for (const [id, entry] of Object.entries(settings.servers)) {
      out.push({
        id,
        name: entry.name,
        source: entry.source,
        sourceProvider: entry.sourceProvider,
        providers: entry.providers,
        orphan: discovered.orphanIds.includes(id),
        stored: true,
      })
    }
    for (const provider of DISCOVERY_PROVIDERS) {
      for (const server of discovered[provider]) {
        if (storedIds.has(server.id)) continue
        out.push({
          id: server.id,
          name: server.name,
          source: 'discovered',
          sourceProvider: provider,
          providers: {},
          orphan: false,
          stored: false,
        })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }, [payload])

  const toggle = useCallback(
    (row: Row, provider: string) => {
      if (!payload) return
      const servers = { ...payload.settings.servers }
      const existing = servers[row.id]
      const nextProviders = { ...(existing?.providers ?? {}) }
      if (nextProviders[provider]) delete nextProviders[provider]
      else nextProviders[provider] = true
      if (row.source === 'discovered' && Object.keys(nextProviders).length === 0) {
        // A fully-unticked discovered selection is just its candidate row again.
        delete servers[row.id]
      } else {
        servers[row.id] = existing
          ? { ...existing, providers: nextProviders }
          : { source: 'discovered', sourceProvider: row.sourceProvider, name: row.name, providers: nextProviders }
      }
      void patch(servers)
    },
    [payload, patch]
  )

  const removeEntry = useCallback(
    (id: string) => {
      if (!payload) return
      const servers = { ...payload.settings.servers }
      delete servers[id]
      void patch(servers)
    },
    [payload, patch]
  )

  // Inline form validation — Save stays disabled until the entry is well-formed.
  const trimmedName = formName.trim()
  const nameInvalid = trimmedName !== '' && (!NAME_PATTERN.test(trimmedName) || trimmedName === 'specrails')
  const nameTaken =
    trimmedName !== '' && !nameInvalid && !!payload?.settings.servers[`c:${trimmedName}`]
  const formValid = trimmedName !== '' && !nameInvalid && !nameTaken && formCommand.trim() !== ''

  const resetForm = useCallback(() => {
    setShowForm(false)
    setFormName('')
    setFormCommand('')
    setFormArgs('')
    setFormEnvPairs([])
    setFormProviders({})
  }, [])

  const addCustom = useCallback(async () => {
    if (!payload || !formValid) return
    const name = trimmedName
    const env: Record<string, string> = {}
    for (const pair of formEnvPairs) {
      const key = pair.key.trim()
      if (key) env[key] = pair.value
    }
    const providers: Record<string, boolean> = {}
    for (const [provider, on] of Object.entries(formProviders)) {
      if (on) providers[provider] = true
    }
    const servers = { ...payload.settings.servers }
    servers[`c:${name}`] = {
      source: 'custom',
      name,
      providers,
      transport: {
        command: formCommand.trim(),
        args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [],
        env,
      },
    }
    const ok = await patch(servers)
    if (ok) resetForm()
  }, [payload, formValid, trimmedName, formCommand, formArgs, formEnvPairs, formProviders, patch, resetForm])

  if (!payload) return <div className="h-16 bg-muted/30 rounded-lg animate-pulse" data-testid="external-mcp-skeleton" />

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="external-mcp-card">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5" /> {t('external.heading')}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          disabled={busy}
          onClick={() => setShowForm((s) => !s)}
          data-testid="external-mcp-add"
        >
          <Plus className="h-3 w-3" /> {t('external.addCustom')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground/80">{t('external.description')}</p>
      <p className="flex items-start gap-1.5 text-[11px] text-accent-warning">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
        {t('external.warning')}
      </p>

      {showForm && (
        <div className="space-y-2.5 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="external-mcp-form">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="ext-mcp-name" className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('external.form.nameLabel')}
              </label>
              <input
                id="ext-mcp-name"
                autoFocus
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('external.form.name')}
                className={`w-full rounded-md border bg-background px-2 py-1 text-xs transition-colors ${
                  nameInvalid || nameTaken ? 'border-destructive/60 focus:outline-destructive' : 'border-border'
                }`}
              />
              {(nameInvalid || nameTaken) && (
                <p className="text-[10px] text-destructive" data-testid="external-mcp-name-hint">
                  {nameInvalid ? t('external.form.nameInvalid') : t('external.form.nameTaken')}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="ext-mcp-command" className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('external.form.commandLabel')}
              </label>
              <input
                id="ext-mcp-command"
                value={formCommand}
                onChange={(e) => setFormCommand(e.target.value)}
                placeholder={t('external.form.command')}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="ext-mcp-args" className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('external.form.argsLabel')}
            </label>
            <input
              id="ext-mcp-args"
              value={formArgs}
              onChange={(e) => setFormArgs(e.target.value)}
              placeholder={t('external.form.args')}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('external.form.envLabel')}
              </span>
              <button
                type="button"
                onClick={() => setFormEnvPairs((p) => [...p, { key: '', value: '' }])}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                data-testid="external-mcp-env-add"
              >
                <Plus className="h-2.5 w-2.5" /> {t('external.form.addVar')}
              </button>
            </div>
            {formEnvPairs.map((pair, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={pair.key}
                  onChange={(e) =>
                    setFormEnvPairs((p) => p.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                  }
                  placeholder={t('external.form.envKey')}
                  aria-label={`${t('external.form.envKey')} ${i + 1}`}
                  className="w-2/5 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
                />
                <span className="text-[10px] text-muted-foreground">=</span>
                <input
                  value={pair.value}
                  onChange={(e) =>
                    setFormEnvPairs((p) => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                  }
                  placeholder={t('external.form.envValue')}
                  aria-label={`${t('external.form.envValue')} ${i + 1}`}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => setFormEnvPairs((p) => p.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                  aria-label={`${t('external.remove')} ${i + 1}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('external.form.enableFor')}
            </span>
            <div className="flex items-center gap-1">
              {PROVIDERS.map((provider) => {
                const active = formProviders[provider] === true
                return (
                  <button
                    key={provider}
                    type="button"
                    role="switch"
                    aria-checked={active}
                    aria-label={`custom · ${provider}`}
                    onClick={() => setFormProviders((p) => ({ ...p, [provider]: !p[provider] }))}
                    className={providerPillClass(active)}
                    data-testid={`external-mcp-form-provider-${provider}`}
                  >
                    {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    {provider}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex justify-end gap-1.5 pt-0.5">
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={resetForm}>
              {t('external.form.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={busy || !formValid}
              onClick={() => void addCustom()}
              data-testid="external-mcp-form-save"
            >
              {t('external.form.save')}
            </Button>
          </div>
        </div>
      )}

      {rows.length === 0 && payload.discovered.codexNative.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">{t('external.empty')}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-2 py-1.5"
              data-testid={`external-mcp-row-${row.id}`}
            >
              <span className="text-xs font-medium text-foreground min-w-0 truncate">{row.name}</span>
              <span className="rounded-full bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground">
                {row.source === 'custom'
                  ? t('external.sourceCustom')
                  : t('external.sourceDiscovered', { provider: row.sourceProvider })}
              </span>
              {row.orphan && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-warning/15 px-1.5 py-px text-[10px] text-accent-warning" data-testid="external-mcp-orphan">
                  <TriangleAlert className="h-2.5 w-2.5" /> {t('external.orphan')}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2">
                <span className="flex items-center gap-1">
                  {PROVIDERS.map((provider) => {
                    const active = row.providers[provider] === true
                    return (
                      <button
                        key={provider}
                        type="button"
                        role="switch"
                        aria-checked={active}
                        aria-label={`${row.name} · ${provider}`}
                        disabled={busy}
                        onClick={() => toggle(row, provider)}
                        className={providerPillClass(active)}
                      >
                        {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                        {provider}
                      </button>
                    )
                  })}
                </span>
                {row.stored && (
                  <button
                    type="button"
                    onClick={() => removeEntry(row.id)}
                    disabled={busy}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('external.remove')}
                    data-testid={`external-mcp-remove-${row.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </span>
            </div>
          ))}

          {payload.discovered.codexNative.map((name) => (
            <div
              key={`codex:${name}`}
              className="flex items-center gap-3 rounded-md border border-border/40 px-2 py-1.5 opacity-70"
              data-testid={`external-mcp-codex-${name}`}
            >
              <span className="text-xs font-medium text-foreground min-w-0 truncate">{name}</span>
              <span className="rounded-full bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground">
                {t('external.codexNative')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
