import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Smartphone } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { SegmentedControl } from '../../../components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import {
  fetchMobileTestOptions, fetchMobileTestRun, openRunDevice, startMobileTestRun,
  type MobilePlatform, type MobileTestOptions, type MobileTestRunView, type MobileTestTarget,
} from '../lib/mobile-test-run'

type TargetKind = MobileTestTarget['kind']
type PlatformChoice = MobilePlatform | 'both'
const AUTO = '__auto__'
const POLL_MS = 2_000

/** Refusals worded for people; anything else shows the server's own detail. */
const KNOWN_ERRORS = new Set(['branch_not_found', 'no_app', 'delivery_code_gone', 'tapflow_not_installed', 'engine_unsupported'])

/**
 * Loops ▸ Test in Mobile Device ▸ Run on a device: pick the code (the checkout as it is, a delivery on
 * review, or a branch, built in a temporary worktree), the platform and, optionally, the device; then
 * follow the run here until the app is open, with a button to show each device in its own window.
 */
export function RunOnDeviceDialog({ projects, initialProjectId, onClose }: {
  projects: Array<{ id: string; name: string }>
  initialProjectId: string | null
  onClose: () => void
}) {
  const { t } = useTranslation('loops')
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? projects[0]?.id ?? null)
  const [options, setOptions] = useState<MobileTestOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [kind, setKind] = useState<TargetKind>('checkout')
  const [deliveryId, setDeliveryId] = useState<string>('')
  const [branch, setBranch] = useState<string>('')
  const [platform, setPlatform] = useState<PlatformChoice>('ios')
  const [devices, setDevices] = useState<Partial<Record<MobilePlatform, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<{ projectId: string; view: MobileTestRunView } | null>(null)

  // Options of the chosen project (its apps, deliveries, branches, and Tapflow's devices).
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setOptions(null); setLoadError(null); setError(null)
    fetchMobileTestOptions(projectId).then((loaded) => {
      if (cancelled) return
      setOptions(loaded)
      setKind(loaded.checkout.platforms.length ? 'checkout' : loaded.deliveries.length ? 'delivery' : 'branch')
      setDeliveryId(loaded.deliveries[0]?.id ?? '')
      setBranch(loaded.checkout.branch ?? loaded.branches[0] ?? '')
      setPlatform(loaded.checkout.recommended)
      setDevices({})
    }).catch((err: Error) => { if (!cancelled) setLoadError(err.message) })
    return () => { cancelled = true }
  }, [projectId])

  // A started run: follow it until the app is open or it stops (the dialog is open, so it is bounded).
  useEffect(() => {
    if (!run || run.view.state !== 'running') return
    const timer = setInterval(() => {
      fetchMobileTestRun(run.projectId, run.view.runId).then((view) => setRun((current) => current && current.view.runId === view.runId ? { ...current, view } : current)).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [run])

  // Platforms the chosen code builds (a branch is only known once checked out: both are offered).
  const available = useMemo<MobilePlatform[]>(() => {
    if (!options) return []
    if (kind === 'checkout') return options.checkout.platforms
    if (kind === 'delivery') return options.deliveries.find((delivery) => delivery.id === deliveryId)?.platforms ?? []
    return ['ios', 'android']
  }, [options, kind, deliveryId])
  useEffect(() => {
    if (!available.length) return
    if (platform === 'both' ? available.length < 2 : !available.includes(platform)) setPlatform(available.length > 1 && options?.remembered === 'both' ? 'both' : available[0]!)
  }, [available, platform, options])

  const platforms: MobilePlatform[] = platform === 'both' ? ['ios', 'android'] : [platform]
  const tapflowOff = Boolean(options?.ready && options.devices === null)
  const blocker = !options ? null
    : !options.ready ? t('runOnDevice.errors.tapflow_not_installed')
    : !options.hostTasks ? t('runOnDevice.errors.engine_unsupported')
    : tapflowOff ? t('runOnDevice.tapflowOff')
    : null
  const targetReady = kind === 'checkout' ? available.length > 0 : kind === 'delivery' ? Boolean(deliveryId) : Boolean(branch.trim())
  const canStart = Boolean(projectId && options && !blocker && targetReady && available.length && !busy)

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canStart || !projectId) return
    setBusy(true); setError(null)
    const target: MobileTestTarget = kind === 'checkout' ? { kind } : kind === 'delivery' ? { kind, deliveryId } : { kind, branch: branch.trim() }
    try {
      const chosen = Object.fromEntries(platforms.flatMap((p) => (devices[p] ? [[p, devices[p]]] : [])))
      const runId = await startMobileTestRun(projectId, { target, platforms, devices: chosen })
      setRun({ projectId, view: { runId, state: 'running', devices: [] } })
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      setError(code && KNOWN_ERRORS.has(code) ? t(`runOnDevice.errors.${code}`) : (err as Error).message || t('runOnDevice.errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  const open = (device: MobileTestRunView['devices'][number]) => {
    void openRunDevice({ deviceId: device.id, sessionId: device.sessionId, buildId: device.buildId, platform: device.platform, name: device.name })
      .catch((err: Error) => setError(err.message))
  }
  const platformName = (p: MobilePlatform) => t(`runOnDevice.platform.${p}`)

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent size="form" data-testid="run-on-device-dialog">
        <DialogHeader icon={<Smartphone />}>
          <DialogTitle>{t('runOnDevice.title')}</DialogTitle>
          <DialogDescription>{t('runOnDevice.description')}</DialogDescription>
        </DialogHeader>
        {run ? (
          <>
            <DialogBody className="flex flex-col gap-3" data-testid="run-on-device-progress" data-state={run.view.state}>
              <p className="text-sm text-foreground">
                {run.view.state === 'running' ? t('runOnDevice.running')
                  : run.view.state === 'launched' ? t('runOnDevice.launched', { summary: run.view.devices.map((device) => t('runOnDevice.onDevice', { platform: platformName(device.platform), device: device.name })).join(', ') || run.view.summary || '' })
                  : t('runOnDevice.failed')}
              </p>
              {run.view.state === 'failed' && run.view.detail && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{run.view.detail}</p>}
              {run.view.devices.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {run.view.devices.map((device) => (
                    <Button key={`${device.platform}:${device.id}`} type="button" size="sm" variant="outline" onClick={() => open(device)} data-testid="run-on-device-open">
                      {t('runOnDevice.openDevice', { device: device.name })}
                    </Button>
                  ))}
                </div>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <p className="text-xs text-muted-foreground">{t('runOnDevice.runHint')}</p>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>{t('runOnDevice.close')}</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <DialogBody className="flex flex-col gap-4">
              {projects.length > 1 && (
                <Field label={t('runOnDevice.project')}>
                  <Select value={projectId ?? undefined} onValueChange={setProjectId} disabled={busy}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t('runOnDevice.project')} data-testid="run-on-device-project"><SelectValue /></SelectTrigger>
                    <SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id} className="text-xs">{project.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
              {!options && !loadError && <p className="text-sm text-muted-foreground">{t('runOnDevice.loading')}</p>}
              {options && (
                <>
                  <Field label={t('runOnDevice.what')}>
                    <SegmentedControl<TargetKind>
                      className="self-start"
                      value={kind}
                      onChange={setKind}
                      label={t('runOnDevice.what')}
                      options={[
                        { value: 'checkout', label: t('runOnDevice.target.checkout'), testId: 'run-on-device-target-checkout' },
                        ...(options.deliveries.length ? [{ value: 'delivery' as const, label: t('runOnDevice.target.delivery'), testId: 'run-on-device-target-delivery' }] : []),
                        { value: 'branch', label: t('runOnDevice.target.branch'), testId: 'run-on-device-target-branch' },
                      ]}
                    />
                    <p className="text-xs text-muted-foreground">
                      {kind === 'checkout' ? (options.checkout.platforms.length
                        ? t('runOnDevice.checkoutHint', { branch: options.checkout.branch ?? t('runOnDevice.detached') })
                        : t('runOnDevice.checkoutNoApp'))
                        : kind === 'branch' ? t('runOnDevice.branchHint') : t('runOnDevice.deliveryHint')}
                    </p>
                    {kind === 'delivery' && (
                      <Select value={deliveryId} onValueChange={setDeliveryId}>
                        <SelectTrigger className="h-8 text-xs" aria-label={t('runOnDevice.target.delivery')} data-testid="run-on-device-delivery"><SelectValue /></SelectTrigger>
                        <SelectContent>{options.deliveries.map((delivery) => <SelectItem key={delivery.id} value={delivery.id} className="text-xs">{delivery.label}</SelectItem>)}</SelectContent>
                      </Select>
                    )}
                    {kind === 'branch' && options.branches.length > 0 && (
                      <Select value={branch} onValueChange={setBranch}>
                        <SelectTrigger className="h-8 text-xs" aria-label={t('runOnDevice.target.branch')} data-testid="run-on-device-branch"><SelectValue /></SelectTrigger>
                        <SelectContent>{options.branches.map((name) => <SelectItem key={name} value={name} className="text-xs">{name}</SelectItem>)}</SelectContent>
                      </Select>
                    )}
                  </Field>
                  {available.length > 0 && (
                    <Field label={t('runOnDevice.platformLabel')}>
                      <SegmentedControl<PlatformChoice>
                        className="self-start"
                        value={platform}
                        onChange={setPlatform}
                        label={t('runOnDevice.platformLabel')}
                        options={[
                          ...available.map((p) => ({ value: p, label: platformName(p), testId: `run-on-device-platform-${p}` })),
                          ...(available.length > 1 ? [{ value: 'both' as const, label: t('runOnDevice.both'), testId: 'run-on-device-platform-both' }] : []),
                        ]}
                      />
                    </Field>
                  )}
                  {options.devices && options.devices.length > 0 && (
                    <details className="text-sm" data-testid="run-on-device-devices">
                      <summary className="cursor-pointer text-muted-foreground">{t('runOnDevice.deviceLabel')}</summary>
                      <div className="mt-2 flex flex-col gap-2">
                        {platforms.map((p) => {
                          const ofPlatform = options.devices!.filter((device) => device.platform === p)
                          return ofPlatform.length ? (
                            <Select key={p} value={devices[p] ?? AUTO} onValueChange={(value) => setDevices((current) => ({ ...current, [p]: value === AUTO ? undefined : value }))}>
                              <SelectTrigger className="h-8 text-xs" aria-label={t('runOnDevice.deviceFor', { platform: platformName(p) })} data-testid={`run-on-device-device-${p}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value={AUTO} className="text-xs">{t('runOnDevice.deviceAuto', { platform: platformName(p) })}</SelectItem>
                                {ofPlatform.map((device) => (
                                  <SelectItem key={device.id} value={device.id} className="text-xs">{device.booted ? t('runOnDevice.deviceBooted', { device: device.name }) : device.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : null
                        })}
                      </div>
                    </details>
                  )}
                </>
              )}
              {(blocker || error) && <p role="alert" className="text-sm text-destructive" data-testid="run-on-device-error">{blocker ?? error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t('runOnDevice.cancel')}</Button>
              <Button type="submit" disabled={!canStart} data-testid="run-on-device-submit">{busy ? t('runOnDevice.starting') : t('runOnDevice.submit')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="text-foreground">{label}</span>
      {children}
    </div>
  )
}
