import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Link2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'

type ClientId = 'claude' | 'codex'
type ClientState = 'connected' | 'outdated' | 'not_connected' | 'conflict'

interface DetectedClient {
  client: ClientId
  installed: boolean
  configPath: string
  state: ClientState
  command: string | null
}

interface ConnectState {
  available: boolean
  clients: DetectedClient[]
}

interface VerifyResult {
  ok: boolean
  toolCount?: number
  approxTokens?: number
  overview?: string
  error?: string
}

interface ConnectAnswer {
  outcome: 'create' | 'update' | 'unchanged' | 'remove' | 'absent' | 'conflict'
  file: string
  backup: string | null
  verify?: VerifyResult
  mcpEnabled?: boolean
  warnings?: string[]
  error?: string
  reason?: string
}

const CLIENT_NAME: Record<ClientId, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Tauri-safe clipboard copy (async API with a textarea fallback). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function tokensLabel(tokens: number | undefined): string {
  if (tokens === undefined) return ''
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/**
 * Settings ▸ MCP ▸ Connect: registers the Specrails server with Claude Code
 * or Codex in one click (the same `/api/mcp-admin/connect` the
 * `specrails-desktop mcp connect` command uses), then shows the verified
 * round trip. Each row also offers the client's own command to copy.
 */
export function McpConnectCard() {
  const { t } = useTranslation('mcp')
  const [state, setState] = useState<ConnectState | null>(null)
  const [busy, setBusy] = useState<ClientId | null>(null)
  const [results, setResults] = useState<Partial<Record<ClientId, ConnectAnswer>>>({})
  const [copied, setCopied] = useState<ClientId | null>(null)
  const [forceFor, setForceFor] = useState<ClientId | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/connect`)
      if (r.ok) setState((await r.json()) as ConnectState)
    } catch { /* keeps the previous state */ }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (client: ClientId, options: { remove?: boolean; force?: boolean } = {}) => {
    setBusy(client)
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, remove: options.remove === true, force: options.force === true }),
      })
      const body = (await r.json().catch(() => ({}))) as ConnectAnswer
      setResults((prev) => ({ ...prev, [client]: body }))
      if (r.status === 409 && body.reason === 'foreign_entry') {
        setForceFor(client)
      } else if (!r.ok) {
        throw new Error(body.error ?? `HTTP ${r.status}`)
      } else if (options.remove) {
        toast.success(t('connect.disconnected', { client: CLIENT_NAME[client] }))
      } else if (body.verify && !body.verify.ok) {
        notifyError(t('connect.verifyFailed', { client: CLIENT_NAME[client] }), { detail: body.verify.error, retry: () => void run(client, options) })
      } else {
        toast.success(t('connect.connected', { client: CLIENT_NAME[client] }))
      }
      await load()
    } catch (e) {
      notifyError(t('connect.failed', { client: CLIENT_NAME[client] }), { detail: (e as Error).message, retry: () => void run(client, options) })
    } finally {
      setBusy(null)
    }
  }, [load, t])

  const copyCommand = useCallback(async (row: DetectedClient) => {
    if (!row.command) return
    if (await copyText(row.command)) {
      setCopied(row.client)
      window.setTimeout(() => setCopied((c) => (c === row.client ? null : c)), 1500)
    } else {
      notifyError(t('config.copyFailed'))
    }
  }, [t])

  if (!state || !Array.isArray(state.clients)) return null

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="mcp-connect">
      <div className="text-xs font-semibold text-foreground">{t('connect.heading')}</div>
      <p className="text-xs text-muted-foreground">{t('connect.description')}</p>
      {!state.available && <p className="text-xs text-destructive">{t('connect.unavailable')}</p>}
      <ul className="divide-y divide-border">
        {state.clients.map((row) => {
          const result = results[row.client]
          const connected = row.state === 'connected' || row.state === 'outdated'
          return (
            <li key={row.client} className="space-y-1.5 py-2 first:pt-0 last:pb-0" data-testid={`mcp-connect-${row.client}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-sm font-medium">{CLIENT_NAME[row.client]}</span>
                  <Badge variant={row.state === 'connected' ? 'success' : row.state === 'outdated' || row.state === 'conflict' ? 'warning' : 'queued'}>
                    {t(`connect.state.${row.state}`)}
                  </Badge>
                  {!row.installed && <span className="text-xs text-muted-foreground">{t('connect.notInstalled')}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                  {row.command && (
                    <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => void copyCommand(row)} data-testid={`mcp-copy-command-${row.client}`}>
                      {copied === row.client ? <Check className="h-3 w-3 text-accent-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                      {copied === row.client ? t('connect.commandCopied') : t('connect.copyCommand')}
                    </Button>
                  )}
                  {connected && (
                    <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={busy !== null} onClick={() => void run(row.client, { remove: true })}>
                      <Unlink className="h-3 w-3" aria-hidden /> {t('connect.disconnect')}
                    </Button>
                  )}
                  {row.state !== 'connected' && (
                    <Button size="sm" className="h-7 gap-1.5" disabled={busy !== null || !state.available} onClick={() => void run(row.client)}>
                      <Link2 className="h-3 w-3" aria-hidden />
                      {busy === row.client ? t('connect.connecting') : row.state === 'outdated' ? t('connect.update') : t('connect.connect', { client: CLIENT_NAME[row.client] })}
                    </Button>
                  )}
                </div>
              </div>
              <div className="truncate font-mono text-caption text-muted-foreground" title={row.configPath}>{row.configPath}</div>
              {result?.verify && (
                <p className={`text-xs ${result.verify.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
                  {result.verify.ok
                    ? t('connect.verified', { tools: result.verify.toolCount ?? 0, tokens: tokensLabel(result.verify.approxTokens) })
                    : t('connect.verifyError', { error: result.verify.error ?? '' })}
                </p>
              )}
              {result && result.mcpEnabled === false && !result.verify && result.outcome !== 'remove' && (
                <p className="text-xs text-muted-foreground">{t('connect.enableToVerify')}</p>
              )}
              {result?.backup && <p className="truncate text-caption text-muted-foreground">{t('connect.backup', { path: result.backup })}</p>}
              {result && (result.outcome === 'create' || result.outcome === 'update') && (
                <p className="text-xs text-muted-foreground">{t(`connect.next.${row.client}`)}</p>
              )}
              {result?.outcome === 'conflict' && result.reason !== 'foreign_entry' && <p className="text-xs text-destructive">{result.error}</p>}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={forceFor !== null}
        onOpenChange={(open) => { if (!open) setForceFor(null) }}
        title={t('connect.replaceTitle')}
        description={forceFor ? t('connect.replaceBody', { client: CLIENT_NAME[forceFor], path: results[forceFor]?.file ?? '' }) : ''}
        confirmLabel={t('connect.replace')}
        onConfirm={() => {
          const client = forceFor
          setForceFor(null)
          if (client) void run(client, { force: true })
        }}
      />
    </div>
  )
}
