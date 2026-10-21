import { Router } from 'express'
import type { Request, Response } from 'express'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import type { MobileGateway } from './mobile-gateway'
import { listDevices, revokeDevice } from './mobile-devices'

// Loopback-only control plane for the desktop UI, mounted on the MAIN server
// at /api/mobile (behind requireAuth + requireLoopback). The phone never
// touches these routes — they manage the gateway, devices, and the serverless
// WebRTC pairing signaling from the desktop.

export interface MobileAdminDeps {
  gateway: MobileGateway
  desktopDb: DbInstance
  broadcast: (msg: WsMessage) => void
}

const DEVICE_ID_RE = /^[A-Za-z0-9-]{1,64}$/

export function createMobileAdminRouter(deps: MobileAdminDeps): Router {
  const router = Router()
  const { gateway, desktopDb } = deps

  router.get('/status', (_req: Request, res: Response) => {
    res.json(gateway.status())
  })

  router.post('/enable', async (_req: Request, res: Response) => {
    try {
      const status = await gateway.setEnabled(true)
      res.json(status)
    } catch (err) {
      // EADDRINUSE etc — keep the flag off and report, never crash.
      res.status(409).json({ error: err instanceof Error ? err.message : 'Failed to start gateway' })
    }
  })

  router.post('/disable', async (_req: Request, res: Response) => {
    await gateway.setEnabled(false)
    res.json(gateway.status())
  })

  // —— Devices ——
  router.get('/devices', (_req: Request, res: Response) => {
    res.json({ devices: listDevices(desktopDb) })
  })

  router.delete('/devices/:id', (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : ''
    if (!DEVICE_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid device id' })
      return
    }
    const changed = revokeDevice(desktopDb, id)
    if (changed) {
      gateway.bridge?.closeForDevice(id)
      deps.broadcast({ type: 'mobile.device_revoked', deviceId: id, timestamp: new Date().toISOString() })
    }
    res.json({ ok: changed })
  })

  router.post('/cert/rotate', async (_req: Request, res: Response) => {
    const status = await gateway.rotateCert()
    res.json(status)
  })

  // —— Serverless WebRTC pairing signaling (webview ↔ local peer) ——
  // The webview asks for an offer (→ first QR), then posts the companion's
  // scanned answer SDP. No SDP ever leaves the desktop except as a QR.
  router.post('/webrtc/offer', async (_req: Request, res: Response) => {
    if (!gateway.running || !gateway.webrtc) {
      res.status(409).json({ error: 'Enable mobile access first' })
      return
    }
    try {
      const offer = await gateway.webrtcOffer()
      if (!offer) {
        res.status(409).json({ error: 'WebRTC unavailable' })
        return
      }
      res.json(offer)
    } catch {
      res.status(500).json({ error: 'Failed to create offer' })
    }
  })

  router.post('/webrtc/answer', async (req: Request, res: Response) => {
    const sdp = typeof (req.body as { sdp?: unknown })?.sdp === 'string' ? (req.body as { sdp: string }).sdp : ''
    if (!sdp) {
      res.status(400).json({ error: 'sdp required' })
      return
    }
    res.json({ ok: await gateway.webrtcAnswer(sdp) })
  })

  return router
}
