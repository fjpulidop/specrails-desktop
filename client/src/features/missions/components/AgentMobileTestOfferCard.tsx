// ─── Test in Mobile Device offer (tapflow) ────────────────────────────────────
// A server-authored system row (`mobile-test-offer`) posted after a delivery of a
// project with an iOS or Android app, while Tapflow is installed. Optional, like
// the PR CI offer: it never starts by itself and adds no attention. Start builds
// the app for the simulator and runs it on a Tapflow device (`factory:mobile-test`);
// a multiplatform project asks iOS, Android or both, recommending one. The row is
// updated in place: started → running on <device> | failed (reason).

import { Suspense, lazy, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2, Smartphone } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { API_ORIGIN } from '../../../lib/origin'
import { openDeviceWindow } from '../lib/device-windows'

const JobDetailModal = lazy(() =>
  import('../../jobs/components/JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

export type MobilePlatform = 'ios' | 'android'
export type MobileTestOfferState = 'offered' | 'started' | 'launched' | 'failed' | 'expired' | 'dismissed'
export interface MobileTestOfferRow {
  kind: 'mobile-test-offer'
  projectId: string
  deliveryId: string
  platforms: MobilePlatform[]
  recommended: MobilePlatform | 'both'
  state: MobileTestOfferState
  runId: string | null
  reason: string | null
  /** Where the app runs; id/sessionId/buildId open the device window (absent on older rows). */
  devices: Array<{ platform: MobilePlatform; name: string; id?: string; sessionId?: string; buildId?: number }>
}

const STATES: readonly MobileTestOfferState[] = ['offered', 'started', 'launched', 'failed', 'expired', 'dismissed']
const isPlatform = (value: unknown): value is MobilePlatform => value === 'ios' || value === 'android'

/** Parse a system row; null when it is not a mobile test offer. */
export function parseMobileTestOfferRow(content: string): MobileTestOfferRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'mobile-test-offer' || typeof o.projectId !== 'string' || typeof o.deliveryId !== 'string' || !STATES.includes(o.state as MobileTestOfferState)) return null
  const platforms = Array.isArray(o.platforms) ? o.platforms.filter(isPlatform) : []
  const devices = Array.isArray(o.devices) ? o.devices.flatMap((d) => {
    const v = d && typeof d === 'object' ? d as Record<string, unknown> : null
    if (!v || !isPlatform(v.platform) || typeof v.name !== 'string') return []
    const openable = typeof v.id === 'string' && typeof v.sessionId === 'string' && typeof v.buildId === 'number'
    return [{ platform: v.platform, name: v.name, ...(openable ? { id: v.id as string, sessionId: v.sessionId as string, buildId: v.buildId as number } : {}) }]
  }) : []
  return {
    kind: 'mobile-test-offer', projectId: o.projectId, deliveryId: o.deliveryId, platforms,
    recommended: isPlatform(o.recommended) || o.recommended === 'both' ? o.recommended as MobilePlatform | 'both' : 'both',
    state: o.state as MobileTestOfferState,
    runId: typeof o.runId === 'string' ? o.runId : null,
    reason: typeof o.reason === 'string' && o.reason.trim() ? o.reason : null,
    devices,
  }
}

async function post(projectId: string, action: 'start' | 'dismiss', body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/mobile-test/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({})) as { error?: string; ok?: boolean }
    return res.ok && data.ok !== false ? { ok: true } : { ok: false, error: data.error }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function AgentMobileTestOfferCard({ row }: { row: MobileTestOfferRow }) {
  const { t } = useTranslation('agent')
  const [local, setLocal] = useState<MobileTestOfferState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const inFlight = useRef(false)
  // The server row wins once it moved past what this click set.
  const state = row.state !== 'offered' ? row.state : (local ?? row.state)
  const platformName = (platform: MobilePlatform) => t(`mobileTest.platform.${platform}`)
  const choices: Array<{ id: string; platforms: MobilePlatform[] }> = row.platforms.length > 1
    ? [{ id: 'ios', platforms: ['ios'] }, { id: 'android', platforms: ['android'] }, { id: 'both', platforms: ['ios', 'android'] }]
    : [{ id: row.platforms[0] ?? 'ios', platforms: row.platforms.length ? row.platforms : ['ios'] }]

  const start = async (platforms: MobilePlatform[], id: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(id); setError(null)
    const outcome = await post(row.projectId, 'start', { deliveryId: row.deliveryId, platforms })
    if (outcome.ok) setLocal('started')
    else { setError(outcome.error ?? t('mobileTest.startFailed')); inFlight.current = false }
    setBusy(null)
  }
  const dismiss = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('dismiss')
    const outcome = await post(row.projectId, 'dismiss', { deliveryId: row.deliveryId })
    if (outcome.ok) setLocal('dismissed')
    else inFlight.current = false
    setBusy(null)
  }

  if (state === 'dismissed') return <p data-testid="agent-mobile-test-offer" data-state="dismissed" className="text-xs text-muted-foreground">{t('mobileTest.dismissed')}</p>
  const tone = state === 'launched' ? 'success' : state === 'failed' ? 'warning' : 'info'
  const Icon = state === 'launched' ? CheckCircle2 : state === 'failed' ? AlertTriangle : Smartphone
  const devices = row.devices.map((device) => t('mobileTest.onDevice', { platform: platformName(device.platform), device: device.name })).join(', ')
  return (
    <section data-testid="agent-mobile-test-offer" data-state={state} aria-label={t('mobileTest.title')}
      className="rounded-xl border border-border/60 bg-surface/50 px-3.5 py-3 text-xs">
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'success' ? 'text-accent-success' : tone === 'warning' ? 'text-accent-warning' : 'text-accent-info')} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {state === 'offered' ? t('mobileTest.title')
              : state === 'started' ? t('mobileTest.started')
              : state === 'launched' ? t('mobileTest.launched', { devices })
              : state === 'expired' ? t('mobileTest.expired')
              : t('mobileTest.failed')}
          </p>
          <p className="mt-1 whitespace-pre-line leading-4 text-muted-foreground">
            {state === 'offered' ? (row.platforms.length > 1 ? t('mobileTest.bodyChoose') : t('mobileTest.body', { platform: platformName(row.platforms[0] ?? 'ios') }))
              : state === 'started' ? t('mobileTest.startedBody')
              : state === 'launched' ? t('mobileTest.launchedBody')
              : state === 'expired' ? t('mobileTest.expiredBody')
              : row.reason ?? t('mobileTest.failedBody')}
          </p>
          {error && <p role="alert" className="mt-1.5 flex items-start gap-1.5 leading-4 text-destructive"><AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />{error}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(state === 'offered' ? choices : state === 'failed' ? [choices.find((choice) => choice.id === row.recommended) ?? choices[0]!] : []).map((choice) => {
              const recommended = choice.id === row.recommended || choices.length === 1
              return (
                <button key={choice.id} type="button" data-agent-interactive data-testid={`agent-mobile-test-start-${choice.id}`} disabled={busy !== null}
                  onClick={() => void start(choice.platforms, choice.id)}
                  className={cn('inline-flex min-h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-opacity disabled:opacity-60',
                    recommended ? 'bg-accent-primary text-primary-foreground hover:opacity-90' : 'border border-border/60 text-muted-foreground hover:text-foreground')}>
                  {busy === choice.id && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                  {state === 'failed' ? t('mobileTest.retry') : choices.length === 1 ? t('mobileTest.start') : choice.id === 'both' ? t('mobileTest.both') : platformName(choice.id as MobilePlatform)}
                </button>
              )
            })}
            {state === 'offered' && (
              <button type="button" data-agent-interactive data-testid="agent-mobile-test-dismiss" disabled={busy !== null} onClick={() => void dismiss()}
                className="inline-flex min-h-7 items-center rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60">
                {t('mobileTest.notNow')}
              </button>
            )}
            {state === 'launched' && row.devices.filter((device) => device.id && device.sessionId && device.buildId).map((device) => (
              <button key={device.id} type="button" data-agent-interactive data-testid={`agent-mobile-test-open-device-${device.platform}`} disabled={busy !== null}
                onClick={() => {
                  setBusy(`open-${device.id}`); setError(null)
                  void openDeviceWindow({ deviceId: device.id!, sessionId: device.sessionId!, buildId: device.buildId!, platform: device.platform, name: device.name })
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setBusy(null))
                }}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-md bg-accent-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60">
                {busy === `open-${device.id}` ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Smartphone className="h-3 w-3" aria-hidden />}
                {t('mobileTest.openDevice', { device: device.name })}
              </button>
            ))}
            {row.runId && state !== 'offered' && (
              <button type="button" data-agent-interactive data-testid="agent-mobile-test-open-log" onClick={() => setLogOpen(true)}
                className="inline-flex min-h-7 items-center rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                {t('mobileTest.openLog')}
              </button>
            )}
          </div>
        </div>
      </div>
      {logOpen && row.runId && (
        <Suspense fallback={null}>
          <JobDetailModal jobId={row.runId} projectId={row.projectId} onClose={() => setLogOpen(false)} />
        </Suspense>
      )}
    </section>
  )
}
