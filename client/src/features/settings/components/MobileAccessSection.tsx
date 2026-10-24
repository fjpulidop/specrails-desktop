import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Smartphone, ShieldCheck, Trash2, Globe } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { PairWebCompanionModal } from './PairWebCompanionModal'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { SettingsCard } from './SettingsCard'

interface MobileStatus {
  enabled: boolean
  running: boolean
  port: number
  certFingerprint: string | null
  desktopName: string
}

interface MobileDevice {
  id: string
  name: string
  platform: 'ios' | 'android' | 'web'
  createdAt: string
  lastSeenAt: string | null
  revoked: boolean
}

const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)

function shortFp(fp: string | null): string {
  if (!fp || fp.length < 16) return fp ?? '—'
  return `${fp.slice(0, 8)}…${fp.slice(-8)}`
}

/** Desktop-wide "Mobile companion" settings: enable the gateway, pair/revoke devices,
 *  rotate the cert identity. Loopback + auth enforced server-side. */
export function MobileAccessSection() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [devices, setDevices] = useState<MobileDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [webPairOpen, setWebPairOpen] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/mobile/status')
      if (r.ok) setStatus((await r.json()) as MobileStatus)
    } catch { /* ignore */ }
  }, [])

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/mobile/devices')
      if (r.ok) setDevices(((await r.json()) as { devices: MobileDevice[] }).devices)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadDevices()
  }, [loadStatus, loadDevices])

  // Live-refresh the device list when a device pairs (incl. the serverless web
  // companion, which registers a beat after the QR exchange) or is revoked.
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    const id = 'mobile-access-devices'
    registerHandler(id, (msg) => {
      const t = (msg as { type?: string } | null)?.type
      if (t === 'mobile.device_paired' || t === 'mobile.device_revoked') void loadDevices()
    })
    return () => unregisterHandler(id)
  }, [registerHandler, unregisterHandler, loadDevices])

  async function toggleEnabled(): Promise<void> {
    if (!status) return
    setBusy(true)
    try {
      const path = status.enabled ? 'disable' : 'enable'
      const r = await fetch(`/api/mobile/${path}`, { method: 'POST' })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${r.status}`)
      }
      setStatus((await r.json()) as MobileStatus)
    } catch (e) {
      toast.error(
        status.enabled
          ? t('mobile.disableFailed', { message: (e as Error).message })
          : t('mobile.enableFailed', { message: (e as Error).message })
      )
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string): Promise<void> {
    await fetch(`/api/mobile/devices/${id}`, { method: 'DELETE' }).catch(() => {})
    void loadDevices()
  }

  async function resetIdentity(): Promise<void> {
    setBusy(true)
    try {
      const r = await fetch('/api/mobile/cert/rotate', { method: 'POST' })
      if (r.ok) setStatus((await r.json()) as MobileStatus)
      void loadDevices()
      toast.success(t('mobile.identityReset'))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div role="status" aria-busy="true" aria-label={t('common:states.loading')} className="h-20 bg-muted/30 rounded-lg motion-safe:animate-pulse" />

  return (
    <SettingsCard
      title={<span className="flex items-center gap-2"><Smartphone className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {t('mobile.heading')}</span>}
      description={t('mobile.description')}
    >

      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div>
          <div className="text-sm font-medium">{status.enabled ? t('mobile.accessOn') : t('mobile.accessOff')}</div>
          <div className="text-xs text-muted-foreground">
            {status.running ? t('mobile.listeningOnPort', { port: status.port }) : t('mobile.notListening')}
          </div>
        </div>
        <Button variant={status.enabled ? 'outline' : 'default'} disabled={busy} onClick={toggleEnabled}>
          {status.enabled ? t('mobile.turnOff') : t('mobile.turnOn')}
        </Button>
      </div>

      {status.enabled && status.running && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button onClick={() => setWebPairOpen(true)} className="gap-2">
                <Globe className="h-4 w-4" aria-hidden /> {t('mobile.pairWebDevice')}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-accent-success" aria-hidden />
              <span title={status.certFingerprint ?? ''}>{shortFp(status.certFingerprint)}</span>
              <button type="button" className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirmReset(true)} disabled={busy}>{t('mobile.reset')}</button>
            </div>
          </div>

          {isWindows && (
            <p className="text-xs text-accent-warning">
              {t('mobile.windowsFirewall')}
            </p>
          )}

          <div className="space-y-1">
            <div className="text-xs font-semibold text-muted-foreground">{t('mobile.pairedDevices')}</div>
            {devices.filter((d) => !d.revoked).length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('mobile.noDevices')}</div>
            ) : (
              devices.filter((d) => !d.revoked).map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                  <div className="text-sm">
                    {d.name} <span className="text-xs text-muted-foreground">· {d.platform}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={t('mobile.revokeDevice', { name: d.name })}
                    className="rounded-sm p-1 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => revoke(d.id)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <PairWebCompanionModal open={webPairOpen} onClose={() => setWebPairOpen(false)} onPaired={loadDevices} />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('mobile.resetConfirmTitle')}
        description={t('mobile.resetConfirm')}
        confirmLabel={t('mobile.reset')}
        onConfirm={() => {
          setConfirmReset(false)
          void resetIdentity()
        }}
      />
    </SettingsCard>
  )
}
