/**
 * Tapflow plugin (iOS Simulator / Android emulator): status, install in a terminal, on/off switch.
 * Server: `server/modules/tapflow` under `/api/global-plugins/tapflow`, live status over WS
 * `plugin.tapflow_status`. The installer terminal attaches to the app-scope PTY the server opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, Loader2, Smartphone, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Switch } from '../../../components/ui/switch'
import { API_ORIGIN } from '../../../lib/origin'
import { WS_URL } from '../../../lib/ws-url'
import { getDesktopTokenProtocol } from '../../../lib/auth'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'

export type TapflowPhase = 'unsupported' | 'not-installed' | 'installing' | 'installed' | 'starting' | 'running' | 'running-external' | 'failed'

export interface TapflowStatus {
  phase: TapflowPhase
  managed: boolean
  version: string | null
  port: number
  issue: { code: string; detail: string } | null
  requirements: { ios: string; android: string }
  installerSessionId: string | null
}

/** Scope of the server's app-level terminals (`APP_TERMINAL_SCOPE`). */
export const TAPFLOW_TERMINAL_SCOPE = '__app__'

export function tapflowIsOn(phase: TapflowPhase): boolean {
  return phase === 'running' || phase === 'running-external' || phase === 'starting'
}

type Action = 'install' | 'activate' | 'deactivate' | 'uninstall'

export function useTapflow() {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [status, setStatus] = useState<TapflowStatus | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installerSessionId, setInstallerSessionId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/global-plugins/tapflow`)
      if (res.ok) setStatus(((await res.json()) as { status: TapflowStatus }).status)
    } catch { /* the card keeps its last status */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const handler = (raw: unknown) => {
      const msg = raw as { type?: string; status?: TapflowStatus }
      if (msg.type !== 'plugin.tapflow_status' || !msg.status) return
      setStatus(msg.status)
    }
    registerHandler('plugins-page-tapflow', handler)
    return () => unregisterHandler('plugins-page-tapflow')
  }, [registerHandler, unregisterHandler])

  // A reopened window reattaches to an installer that is still running.
  useEffect(() => {
    if (status?.installerSessionId) setInstallerSessionId(status.installerSessionId)
  }, [status?.installerSessionId])

  const run = useCallback(async (action: Action) => {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`${API_ORIGIN}/api/global-plugins/tapflow/${action}`, { method: 'POST' })
      const body = (await res.json()) as { ok?: boolean; status?: TapflowStatus; error?: string; sessionId?: string }
      if (body.status) setStatus(body.status)
      if (body.sessionId) setInstallerSessionId(body.sessionId)
      if (!res.ok || body.ok === false) setError(body.error ?? `HTTP ${res.status}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  return { status, busy, error, installerSessionId, closeInstaller: () => setInstallerSessionId(null), run, refresh }
}

/** An xterm attached to a server PTY by id (the installer runs Tapflow's interactive setup in it). */
export function InstallerTerminal({ sessionId, onExit }: { sessionId: string; onExit?: (code: number | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]).then(([xterm, fit]) => {
      if (disposed || !host.current) return
      const term = new xterm.Terminal({ fontSize: 12, convertEol: false, cursorBlink: true, scrollback: 5000 })
      const fitAddon = new fit.FitAddon()
      term.loadAddon(fitAddon)
      term.open(host.current)
      try { fitAddon.fit() } catch { /* not laid out yet */ }
      const base = WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      const url = `${base}/ws/terminal/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(TAPFLOW_TERMINAL_SCOPE)}`
      const protocol = getDesktopTokenProtocol()
      const ws = protocol ? new WebSocket(url, ['specrails-desktop', protocol]) : new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const frame = JSON.parse(event.data) as { type?: string; code?: number | null }
            if (frame.type === 'exit') onExitRef.current?.(frame.code ?? null)
          } catch { /* not a control frame */ }
          return
        }
        term.write(new Uint8Array(event.data as ArrayBuffer))
      }
      const sendSize = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      ws.onopen = sendSize
      const input = term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'write', data })) })
      const observer = new ResizeObserver(() => { try { fitAddon.fit(); sendSize() } catch { /* hidden */ } })
      observer.observe(host.current)
      term.focus()
      cleanup = () => { observer.disconnect(); input.dispose(); ws.close(); term.dispose() }
    })
    return () => { disposed = true; cleanup() }
  }, [sessionId])
  return <div ref={host} data-testid="tapflow-installer-terminal" className="h-80 w-full overflow-hidden rounded-md border border-border bg-black p-1" />
}

export function TapflowPanel({ tapflow }: { tapflow: ReturnType<typeof useTapflow> }) {
  const { t } = useTranslation('integrations')
  const { status, busy, error, installerSessionId, run } = tapflow
  const [installerDone, setInstallerDone] = useState<number | null | undefined>(undefined)
  if (!status) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('plugins.tapflow.loading')}</div>

  const on = tapflowIsOn(status.phase)
  const external = status.phase === 'running-external'
  const canToggle = status.managed && (status.phase === 'installed' || status.phase === 'running' || status.phase === 'starting') && !busy
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span data-testid="tapflow-phase">{t(`plugins.tapflow.phase.${status.phase}`)}</span>
            {status.version && <span className="text-xs text-muted-foreground">v{status.version}</span>}
          </div>
          {status.phase === 'unsupported'
            ? <p className="text-muted-foreground">{status.issue?.detail}</p>
            : external
              ? <p className="text-muted-foreground">{t('plugins.tapflow.externalHint')}</p>
              : <p className="text-muted-foreground">{t('plugins.tapflow.summary')}</p>}
        </div>
        {status.phase !== 'unsupported' && status.phase !== 'not-installed' && status.phase !== 'installing' && (
          <Switch
            checked={on}
            disabled={!canToggle}
            aria-label={on ? t('plugins.tapflow.deactivate') : t('plugins.tapflow.activate')}
            onCheckedChange={(next) => void run(next ? 'activate' : 'deactivate')}
          />
        )}
      </div>

      {status.phase !== 'unsupported' && (
        <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground" aria-label={t('plugins.tapflow.requirementsLabel')}>
          <li>{t('plugins.tapflow.requirements.ios')}</li>
          <li>{t('plugins.tapflow.requirements.android')}</li>
        </ul>
      )}

      {(status.issue && status.phase !== 'unsupported') || error ? (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-accent-warning/40 bg-accent-warning/10 p-3 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
          <span>{error ?? status.issue?.detail}</span>
        </div>
      ) : null}

      {installerSessionId && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{installerDone === undefined ? t('plugins.tapflow.installerHint') : installerDone === 0 ? t('plugins.tapflow.installerDone') : t('plugins.tapflow.installerFailed', { code: installerDone ?? '—' })}</p>
          <InstallerTerminal sessionId={installerSessionId} onExit={setInstallerDone} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(status.phase === 'not-installed' || (status.phase === 'installed' && status.issue?.code === 'setup-incomplete')) && (
          <Button size="sm" onClick={() => { setInstallerDone(undefined); void run('install') }} disabled={busy !== null}>
            {busy === 'install' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
            {status.phase === 'not-installed' ? t('plugins.tapflow.install') : t('plugins.tapflow.rerunSetup')}
          </Button>
        )}
        {status.managed && status.phase !== 'installing' && (
          <Button size="sm" variant="outline" onClick={() => void run('uninstall')} disabled={busy !== null}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('plugins.tapflow.uninstall')}
          </Button>
        )}
      </div>
    </div>
  )
}
