import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Globe, Plus, Trash2, TriangleAlert } from 'lucide-react'
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

/** Parse `KEY=VALUE` lines into an env record (blank lines ignored). */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
  }
  return env
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
  const [formEnv, setFormEnv] = useState('')

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

  const addCustom = useCallback(async () => {
    if (!payload) return
    const name = formName.trim()
    const command = formCommand.trim()
    if (!NAME_PATTERN.test(name) || name === 'specrails') {
      toast.error(t('external.errors.reserved_name'))
      return
    }
    if (!command) {
      toast.error(t('external.errors.invalid_transport'))
      return
    }
    const servers = { ...payload.settings.servers }
    servers[`c:${name}`] = {
      source: 'custom',
      name,
      providers: {},
      transport: {
        command,
        args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [],
        env: parseEnvLines(formEnv),
      },
    }
    const ok = await patch(servers)
    if (ok) {
      setShowForm(false)
      setFormName('')
      setFormCommand('')
      setFormArgs('')
      setFormEnv('')
    }
  }, [payload, formName, formCommand, formArgs, formEnv, patch, t])

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
        <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-2" data-testid="external-mcp-form">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('external.form.name')}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            aria-label={t('external.form.name')}
          />
          <input
            value={formCommand}
            onChange={(e) => setFormCommand(e.target.value)}
            placeholder={t('external.form.command')}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
            aria-label={t('external.form.command')}
          />
          <input
            value={formArgs}
            onChange={(e) => setFormArgs(e.target.value)}
            placeholder={t('external.form.args')}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
            aria-label={t('external.form.args')}
          />
          <textarea
            value={formEnv}
            onChange={(e) => setFormEnv(e.target.value)}
            placeholder={t('external.form.env')}
            rows={2}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
            aria-label={t('external.form.env')}
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setShowForm(false)}>
              {t('external.form.cancel')}
            </Button>
            <Button size="sm" className="h-7 text-[11px]" disabled={busy} onClick={() => void addCustom()} data-testid="external-mcp-form-save">
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
              <span className="ml-auto flex items-center gap-2.5">
                {PROVIDERS.map((provider) => (
                  <label key={provider} className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={row.providers[provider] === true}
                      disabled={busy}
                      onChange={() => toggle(row, provider)}
                      aria-label={`${row.name} · ${provider}`}
                    />
                    {provider}
                  </label>
                ))}
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
