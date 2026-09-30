import { useEffect, useRef, useState } from 'react'
import { Coffee } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isTauri } from '../lib/tauri-shell'

interface AwakeStatus { supported: boolean; awake: boolean }
export function KeepAwakeControl() {
  const { t } = useTranslation('nav')
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
  if (!status?.supported) return null
  async function toggle() {
    if (!status || busy) return
    revision.current += 1
    setBusy(true); setFailed(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('desktop_set_awake', { enabled: !status.awake })
      setStatus(await invoke<AwakeStatus>('desktop_system_status'))
    } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <button type="button" aria-label={t('keepAwake.label')} aria-pressed={status.awake} disabled={busy} onClick={() => void toggle()} title={failed ? t('keepAwake.failed') : t(status.awake ? 'keepAwake.active' : 'keepAwake.inactive')} className="flex h-6 items-center gap-1.5 rounded px-2 text-xs hover:bg-muted focus-visible:outline focus-visible:outline-ring disabled:opacity-50">
    <Coffee className="h-3.5 w-3.5" /><span>{t(status.awake ? 'keepAwake.on' : 'keepAwake.off')}</span><span aria-hidden="true" className={status.awake ? 'h-1.5 w-1.5 rounded-full bg-accent-success' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
    {failed && <span role="status" className="sr-only">{t('keepAwake.failed')}</span>}
  </button>
}
