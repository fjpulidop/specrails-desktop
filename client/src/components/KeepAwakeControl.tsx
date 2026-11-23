import { useCallback, useEffect, useRef, useState } from 'react'
import { Coffee } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isTauri } from '../lib/tauri-shell'
import { Switch } from './ui/switch'

interface AwakeStatus { supported: boolean; awake: boolean }

/**
 * Toggle request from anywhere in the main window (the command palette): the
 * status bar owns the one useKeepAwake instance and answers it, so keep-awake
 * can be switched on even when the app resources popover (which holds the
 * switch) is hidden because nothing runs.
 */
export const KEEP_AWAKE_TOGGLE_EVENT = 'specrails:keep-awake-toggle'
export function requestKeepAwakeToggle(): void {
  window.dispatchEvent(new Event(KEEP_AWAKE_TOGGLE_EVENT))
}

export interface KeepAwake {
  supported: boolean
  awake: boolean
  busy: boolean
  failed: boolean
  toggle: () => Promise<void>
}

/** The desktop host's "keep the computer awake" assertion (desktop app only; unsupported elsewhere). */
export function useKeepAwake(): KeepAwake {
  const revision = useRef(0)
  const [status, setStatus] = useState<AwakeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    async function read() {
      if (document.visibilityState === 'hidden') return
      const requestedRevision = revision.current
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const result = await invoke<AwakeStatus>('desktop_system_status')
        if (active && requestedRevision === revision.current) setStatus(result)
      } catch { if (active && requestedRevision === revision.current) setFailed(true) }
    }
    void read()
    const timer = setInterval(() => void read(), 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const toggle = useCallback(async () => {
    if (!status || busy) return
    revision.current += 1
    setBusy(true); setFailed(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('desktop_set_awake', { enabled: !status.awake })
      setStatus(await invoke<AwakeStatus>('desktop_system_status'))
    } catch { setFailed(true) } finally { setBusy(false) }
  }, [status, busy])
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    const onRequest = () => { void toggleRef.current() }
    window.addEventListener(KEEP_AWAKE_TOGGLE_EVENT, onRequest)
    return () => window.removeEventListener(KEEP_AWAKE_TOGGLE_EVENT, onRequest)
  }, [])
  return { supported: !!status?.supported, awake: !!status?.awake, busy, failed, toggle }
}

/** Status bar: present only while the computer is kept awake; a click allows sleep again. */
export function KeepAwakeIndicator({ keepAwake }: { keepAwake: KeepAwake }) {
  const { t } = useTranslation('nav')
  if (!keepAwake.supported || !keepAwake.awake) return null
  return <button type="button" data-testid="keep-awake-indicator" aria-label={t('keepAwake.turnOff')} title={keepAwake.failed ? t('keepAwake.failed') : t('keepAwake.activeHint')} disabled={keepAwake.busy}
    onClick={() => void keepAwake.toggle()} className="flex h-6 items-center rounded px-1.5 text-accent-success hover:bg-muted focus-visible:outline focus-visible:outline-ring disabled:opacity-50">
    <Coffee className="h-3.5 w-3.5" aria-hidden />
    {keepAwake.failed && <span role="status" className="sr-only">{t('keepAwake.failed')}</span>}
  </button>
}

/** The on/off switch, inside the app resources popover. */
export function KeepAwakeSwitch({ keepAwake }: { keepAwake: KeepAwake }) {
  const { t } = useTranslation('nav')
  if (!keepAwake.supported) return null
  return <label data-testid="keep-awake-switch" className="flex items-start gap-2 border-t border-border/40 pt-2 text-caption">
    <Coffee className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
    <span className="min-w-0 flex-1">
      <span className="block text-foreground">{t('keepAwake.label')}</span>
      <span className="block text-muted-foreground">{keepAwake.failed ? t('keepAwake.failed') : t(keepAwake.awake ? 'keepAwake.active' : 'keepAwake.inactive')}</span>
    </span>
    <Switch checked={keepAwake.awake} disabled={keepAwake.busy} onCheckedChange={() => void keepAwake.toggle()} aria-label={t('keepAwake.label')} />
  </label>
}
