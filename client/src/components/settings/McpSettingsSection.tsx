import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Plug, Copy, Check, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { API_ORIGIN } from '../../lib/origin'
import { ExternalMcpServersCard } from './ExternalMcpServersCard'

interface McpStatus {
  enabled: boolean
  running: boolean
  activeSessions: number
  toolCount: number
  tiers: { write: boolean; aiSpawn: boolean; destructive: boolean }
  tokenHint: string
}

interface McpConfig {
  httpUrl: string
  bridgeCommand: string
  hasToken: boolean
}

type TierKey = 'write' | 'aiSpawn' | 'destructive'

/** Tauri-safe clipboard copy (navigator.clipboard with a textarea/execCommand
 *  fallback for webviews that gate the async clipboard API). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to fallback
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/** Build the ready-to-paste MCP client config from the server-reported bridge
 *  command + HTTP URL. Deliberately carries NO token — that is copied
 *  separately so it never lives in a config the user might commit/share. */
function buildClientConfig(cfg: McpConfig): string {
  return JSON.stringify(
    {
      mcpServers: {
        specrails: {
          command: cfg.bridgeCommand,
        },
      },
    },
    null,
    2
  )
}

/**
 * App-level Settings ▸ MCP panel. Self-fetching (no props): loads the MCP admin
 * status + connection config on mount, exposes an enable toggle, the four
 * permission-tier controls (Read always-on, Write / AI-spawn / Destructive
 * toggleable), a copyable client-config block (no token), and copy/regenerate
 * token actions. All network calls go through the loopback-only
 * `/api/mcp-admin/*` control plane behind the master desktop token.
 */
export function McpSettingsSection() {
  const { t } = useTranslation('mcp')
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [config, setConfig] = useState<McpConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'config' | 'token' | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/status`)
      if (r.ok) setStatus((await r.json()) as McpStatus)
    } catch {
      /* ignore — keeps the skeleton until a retry succeeds */
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/config`)
      if (r.ok) setConfig((await r.json()) as McpConfig)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadConfig()
  }, [loadStatus, loadConfig])

  const toggleEnabled = useCallback(async () => {
    if (!status) return
    setBusy(true)
    try {
      const path = status.enabled ? 'disable' : 'enable'
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/${path}`, { method: 'POST' })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${r.status}`)
      }
      // /enable|/disable return the bare status object (no tiers/tokenHint), so
      // re-read the full status to keep the tier + token UI authoritative.
      await loadStatus()
    } catch (e) {
      toast.error(
        status.enabled
          ? t('enable.disableFailed', { message: (e as Error).message })
          : t('enable.enableFailed', { message: (e as Error).message })
      )
    } finally {
      setBusy(false)
    }
  }, [status, loadStatus, t])

  const toggleTier = useCallback(
    async (key: TierKey) => {
      if (!status) return
      setBusy(true)
      const next = !status.tiers[key]
      try {
        const r = await fetch(`${API_ORIGIN}/api/mcp-admin/tiers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: next }),
        })
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `HTTP ${r.status}`)
        }
        const data = (await r.json()) as { tiers: McpStatus['tiers'] }
        setStatus((prev) => (prev ? { ...prev, tiers: data.tiers } : prev))
      } catch (e) {
        toast.error(t('tiers.updateFailed', { message: (e as Error).message }))
      } finally {
        setBusy(false)
      }
    },
    [status, t]
  )

  const copyConfig = useCallback(async () => {
    if (!config) return
    const ok = await copyToClipboard(buildClientConfig(config))
    if (ok) {
      setCopied('config')
      window.setTimeout(() => setCopied((c) => (c === 'config' ? null : c)), 1500)
    } else {
      toast.error(t('config.copyFailed'))
    }
  }, [config, t])

  const copyToken = useCallback(async () => {
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/token`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const { token } = (await r.json()) as { token: string }
      const ok = await copyToClipboard(token)
      if (ok) {
        setCopied('token')
        window.setTimeout(() => setCopied((c) => (c === 'token' ? null : c)), 1500)
      } else {
        toast.error(t('config.copyFailed'))
      }
    } catch {
      toast.error(t('config.copyFailed'))
    }
  }, [t])

  const regenerateToken = useCallback(async () => {
    if (!window.confirm(t('token.regenerateConfirm'))) return
    setBusy(true)
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/regenerate-token`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await loadStatus()
      toast.success(t('token.regenerated'))
    } catch (e) {
      toast.error(t('token.regenerateFailed', { message: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [loadStatus, t])

  if (!status) return <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />

  const tierRows: { key: TierKey; label: string; help: string }[] = [
    { key: 'write', label: t('tiers.write'), help: t('tiers.writeHelp') },
    { key: 'aiSpawn', label: t('tiers.aiSpawn'), help: t('tiers.aiSpawnHelp') },
    { key: 'destructive', label: t('tiers.destructive'), help: t('tiers.destructiveHelp') },
  ]

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <Plug className="h-3.5 w-3.5" /> {t('heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('explainer.what')}</p>
      <p className="text-xs text-muted-foreground/80">{t('explainer.how')}</p>

      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div>
          <div className="text-sm font-medium">
            {status.enabled ? t('enable.on') : t('enable.off')}
          </div>
          <div className="text-xs text-muted-foreground">
            {status.running
              ? t('enable.running', { count: status.toolCount })
              : t('enable.stopped')}
            {status.enabled && status.activeSessions > 0 && (
              <> · {t('enable.activeSessions', { count: status.activeSessions })}</>
            )}
          </div>
        </div>
        <Button
          variant={status.enabled ? 'outline' : 'default'}
          disabled={busy}
          onClick={() => void toggleEnabled()}
        >
          {status.enabled ? t('enable.turnOff') : t('enable.turnOn')}
        </Button>
      </div>

      {status.enabled && (
        <>
          {/* Permission tiers */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="text-xs font-semibold text-foreground">{t('tiers.heading')}</div>
            <p className="text-[11px] text-muted-foreground/80">{t('explainer.grants')}</p>

            {/* Read — always on, disabled */}
            <label className="flex items-start gap-2 opacity-70">
              <input type="checkbox" checked disabled className="mt-0.5" aria-label={t('tiers.read')} />
              <span className="min-w-0">
                <span className="text-xs font-medium">{t('tiers.read')}</span>
                <span className="block text-[10px] text-muted-foreground">{t('tiers.readHelp')}</span>
              </span>
            </label>

            {tierRows.map((row) => (
              <label key={row.key} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={status.tiers[row.key]}
                  disabled={busy}
                  onChange={() => void toggleTier(row.key)}
                  className="mt-0.5"
                  aria-label={row.label}
                />
                <span className="min-w-0">
                  <span className="text-xs font-medium">{row.label}</span>
                  <span className="block text-[10px] text-muted-foreground">{row.help}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Client config (no token) */}
          {config && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-foreground">{t('config.heading')}</div>
                <button
                  type="button"
                  onClick={() => void copyConfig()}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  data-testid="mcp-copy-config"
                >
                  {copied === 'config' ? (
                    <>
                      <Check className="h-3 w-3 text-accent-success" /> {t('config.configCopied')}
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> {t('config.copyConfig')}
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/80">{t('config.description')}</p>
              <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-[10px] leading-relaxed text-foreground">
                {buildClientConfig(config)}
              </pre>
            </div>
          )}

          {/* Access token */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="text-xs font-semibold text-foreground">{t('token.heading')}</div>
            <p className="text-[11px] text-muted-foreground/80">{t('token.description')}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {t('token.hint', { hint: status.tokenHint })}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void copyToken()}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  data-testid="mcp-copy-token"
                >
                  {copied === 'token' ? (
                    <>
                      <Check className="h-3 w-3 text-accent-success" /> {t('token.tokenCopied')}
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> {t('token.copyToken')}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void regenerateToken()}
                  disabled={busy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                  data-testid="mcp-regenerate-token"
                >
                  <RefreshCw className="h-3 w-3" /> {t('token.regenerate')}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* External MCP servers for the MISSION agent — the inverse concern of the
          panel above (app AS consumer, not app AS server), so it renders
          regardless of the embedded server's enabled state. */}
      <ExternalMcpServersCard />
    </div>
  )
}
