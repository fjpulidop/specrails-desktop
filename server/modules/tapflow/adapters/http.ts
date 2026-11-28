/**
 * `GET /api/global-plugins/tapflow` (status), `POST …/install` (opens the installer terminal and returns
 * its session id), `POST …/activate`, `POST …/deactivate`, `POST …/uninstall`. Mounted by
 * `server/global-plugins-router.ts`.
 */
import type { Request, Response, Router } from 'express'
import type { TapflowPlugin } from '../application'
import type { ProjectContext } from '../../../project-registry'
import { dismissMobileTestOffer, mobileTestOptions, mobileTestRunView, runDevice, startMobileTest, type MobileOfferEnv, type MobileTestTargetRequest } from './mobile-offer'
import { validDeviceTarget, type createDeviceWindows } from './device-window'

export function registerTapflowRoutes(router: Router, tapflow: TapflowPlugin, deviceWindows?: () => ReturnType<typeof createDeviceWindows>): void {
  // Device windows: a single-use link the native window opens (signed in to Tapflow), and release on close.
  router.post('/tapflow/device-window', (req: Request, res: Response) => {
    const target = validDeviceTarget((req.body ?? {}).target)
    const host = req.get('host') ?? ''
    if (!target || !deviceWindows) { res.status(400).json({ error: 'A device target is required.' }); return }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.status(400).json({ error: 'Device windows open from the local app only.' }); return }
    res.json({ url: `http://${host.replace(/^localhost/, '127.0.0.1')}/tapflow-window/${deviceWindows().issue(target)}`, title: target.name })
  })
  router.post('/tapflow/device-window/release', (req: Request, res: Response) => {
    const target = validDeviceTarget((req.body ?? {}).target)
    if (!target || !deviceWindows) { res.status(400).json({ error: 'A device target is required.' }); return }
    deviceWindows().release(target)
    res.json({ ok: true })
  })
  router.get('/tapflow', async (_req: Request, res: Response) => { res.json({ status: await tapflow.status() }) })
  const action = (name: 'install' | 'activate' | 'deactivate' | 'uninstall') => async (_req: Request, res: Response) => {
    try {
      const result = await tapflow[name]()
      res.status(result.ok ? 200 : 409).json(result)
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message, status: await tapflow.status() })
    }
  }
  router.post('/tapflow/install', action('install'))
  router.post('/tapflow/activate', action('activate'))
  router.post('/tapflow/deactivate', action('deactivate'))
  router.post('/tapflow/uninstall', action('uninstall'))
}

/**
 * Project routes of Test in Mobile Device, under `/api/projects/:projectId/mobile-test`:
 * - `POST /start` `{ target, platforms, devices?, conversationId? }` (202 `{ runId }`); `target` is
 *   `{ kind: 'delivery', deliveryId }`, `{ kind: 'checkout' }`, `{ kind: 'branch', branch }` or
 *   `{ kind: 'mission' }` (the Intent worktree of `conversationId`). A bare `deliveryId` still means a
 *   delivery (the mission card). `conversationId`: the mission the run shows in (Processes, Resources).
 * - `GET /options`: what the Loops start form offers; `GET /runs/:runId`: a run's state and devices.
 * - `POST /runs/:runId/open-device` `{ platform? }`: the app's main window opens the device (MCP).
 * - `POST /runs/:runId/release-device` `{ platform?, now? }`: shut the device down after the grace period, or now.
 * - `POST /dismiss` `{ deliveryId }`.
 */
export function registerMobileTestRoutes(router: Router, env: MobileOfferEnv): void {
  const ctx = (req: Request) => (req as Request & { projectCtx?: ProjectContext }).projectCtx!
  router.post('/start', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { deliveryId?: unknown; target?: unknown; platforms?: unknown; devices?: unknown; conversationId?: unknown }
    const target = parseTarget(body.target, body.deliveryId)
    if (!target || !Array.isArray(body.platforms)) { res.status(400).json({ error: 'target (or deliveryId) and platforms are required', code: 'invalid_input' }); return }
    const devices = body.devices && typeof body.devices === 'object' ? body.devices as Record<string, unknown> : {}
    const result = await startMobileTest(ctx(req), {
      target,
      platforms: body.platforms.filter((p): p is 'ios' | 'android' => p === 'ios' || p === 'android'),
      devices: { ...(typeof devices.ios === 'string' ? { ios: devices.ios } : {}), ...(typeof devices.android === 'string' ? { android: devices.android } : {}) },
      ...(typeof body.conversationId === 'string' && body.conversationId ? { conversationId: body.conversationId } : {}),
    }, env)
    if (!result.ok) { res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) }); return }
    res.status(202).json({ runId: result.runId })
  })
  router.get('/options', async (req: Request, res: Response) => {
    res.json(await mobileTestOptions(ctx(req), env))
  })
  router.post('/runs/:runId/open-device', (req: Request, res: Response) => {
    const c = ctx(req)
    const platform = (req.body ?? {}).platform
    const target = runDevice(c, String(req.params.runId), platform === 'ios' || platform === 'android' ? platform : undefined)
    if (!target) { res.status(409).json({ error: 'This run has no running device to open (it is still building, or it failed).', code: 'no_device' }); return }
    // The main window holds device windows (and releases them on close): it opens this one.
    c.broadcast({ type: 'mobile_test.open_device', projectId: c.project.id, target } as never)
    res.json({ ok: true, device: target })
  })
  router.post('/runs/:runId/release-device', async (req: Request, res: Response) => {
    const c = ctx(req)
    const body = (req.body ?? {}) as { platform?: unknown; now?: unknown }
    const target = runDevice(c, String(req.params.runId), body.platform === 'ios' || body.platform === 'android' ? body.platform : undefined)
    if (!target) { res.status(409).json({ error: 'This run has no device to release.', code: 'no_device' }); return }
    if (!env.releaseDevice) { res.status(409).json({ error: 'Tapflow is not set up by Specrails.', code: 'tapflow_not_installed' }); return }
    await env.releaseDevice(target, body.now === true)
    res.json({ ok: true, device: target, now: body.now === true })
  })
  router.get('/runs/:runId', (req: Request, res: Response) => {
    const view = mobileTestRunView(ctx(req), String(req.params.runId))
    if (!view) { res.status(404).json({ error: 'Mobile test run not found' }); return }
    res.json(view)
  })
  router.post('/dismiss', (req: Request, res: Response) => {
    const deliveryId = (req.body ?? {}).deliveryId
    if (typeof deliveryId !== 'string') { res.status(400).json({ error: 'deliveryId is required' }); return }
    res.json({ ok: dismissMobileTestOffer(ctx(req), deliveryId) })
  })
}

function parseTarget(target: unknown, deliveryId: unknown): MobileTestTargetRequest | null {
  if (target === undefined) return typeof deliveryId === 'string' && deliveryId ? { kind: 'delivery', deliveryId } : null
  const t = target as Record<string, unknown> | null
  if (!t || typeof t !== 'object') return null
  if (t.kind === 'checkout') return { kind: 'checkout' }
  if (t.kind === 'mission') return { kind: 'mission' }
  if (t.kind === 'delivery' && typeof t.deliveryId === 'string' && t.deliveryId) return { kind: 'delivery', deliveryId: t.deliveryId }
  if (t.kind === 'branch' && typeof t.branch === 'string' && t.branch.trim() && t.branch.length <= 250) return { kind: 'branch', branch: t.branch.trim() }
  return null
}
