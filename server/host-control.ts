import { Router } from 'express'
import { isLoopbackAddress, safeEqual } from './auth'

const TOKEN_ENV = 'SPECRAILS_HOST_CONTROL_TOKEN'

/** Consume the host-only capability before provider/terminal environments are copied. */
export function consumeHostControlToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let token: string | undefined
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== TOKEN_ENV) continue
    token ??= env[key]
    delete env[key]
  }
  return token && /^[a-zA-Z0-9_-]{32,256}$/.test(token) ? token : undefined
}

/** Private host control; deliberately independent of the renderer's desktop token. */
export function createHostControlRouter(options: {
  token?: string
  onShutdown: () => void | Promise<void>
  pid?: number
}): Router {
  const router = Router()
  let requested = false
  router.post('/shutdown', (req, res) => {
    if (!options.token) { res.status(404).json({ error: 'Not found' }); return }
    const supplied = req.headers['x-specrails-host-token']
    if (!isLoopbackAddress(req.socket.remoteAddress) || req.headers.origin !== undefined
      || typeof supplied !== 'string' || !safeEqual(supplied, options.token)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    if (!requested) {
      // The host must receive the owned PID before shutdown closes all sockets.
      res.once('finish', () => {
        if (requested) return
        requested = true
        setImmediate(() => {
          void Promise.resolve().then(options.onShutdown).catch(() => {
            // No credentials or environment values in this diagnostic. The host
            // retains its bounded, identity-checked force-stop fallback.
            console.error('[host-control] graceful shutdown failed')
          })
        })
      })
    }
    res.status(202).json({ ok: true, pid: options.pid ?? process.pid })
  })
  return router
}
