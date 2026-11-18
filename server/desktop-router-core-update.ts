/**
 * specrails-core update channel and version negotiation: `/meta` and
 * `/core-update/*`. One CoreUpdateManager lives for the router's lifetime.
 */
import type { Router } from 'express'
import type { ProjectRegistry } from './project-registry'
import type { WsMessage } from './types'
import { getUpdateChannel } from './desktop-db'
import { CoreUpdateManager } from './core-update-manager'
import { API_VERSION } from './api-version'
import { appUpdaterManifestUrl } from './update-channel'
import { reseedStaleWorkspaces } from './framework-reseed'
import { checkCoreCompat } from './core-compat'
import { logRejection } from './util/log-rejection'

export function registerCoreUpdateRoutes(router: Router, deps: { registry: ProjectRegistry; broadcast: (msg: WsMessage) => void }): void {
  const { registry, broadcast } = deps
  // ─── specrails-core update channel (app-global) ─────────────────────────────
  // Detect + apply a specrails-core framework update independently of the desktop
  // app update. See server/core-update-manager.ts. A single manager instance
  // persists for the router lifetime (holds the cached latest + in-progress flag).
  const coreUpdate = new CoreUpdateManager({
    // `core_update.progress` / `framework.updated` are app-level (no projectId)
    // and not members of the WsMessage union; cast at this single boundary.
    broadcast: (msg) => broadcast(msg as unknown as WsMessage),
    providers: () => registry.installedProvidersUnion(),
    channel: () => getUpdateChannel(registry.desktopDb),
    reseed: version => reseedStaleWorkspaces(registry.listContexts().map(context => ({
      id: context.project.id,
      slug: context.project.slug,
      path: context.project.path,
    })), version),
  })

  // GET /api/meta — versions a client needs to negotiate with this server.
  // Additive-only shape; see docs/internals/api-reference.md (versioning policy).
  router.get('/meta', async (_req, res) => {
    const channel = getUpdateChannel(registry.desktopDb)
    const compat = await checkCoreCompat().catch(() => null)
    const core = coreUpdate.getStatus()
    res.json({
      apiVersion: API_VERSION,
      appVersion: compat?.desktopVersion ?? null,
      coreVersion: core.currentVersion ?? compat?.coreVersion ?? core.bundledVersion ?? null,
      contractSchemaVersion: compat?.contractSchemaVersion ?? null,
      channel,
      updateManifestUrl: appUpdaterManifestUrl(channel),
    })
  })

  // GET /api/core-update/status — current/bundled/latest versions, no network.
  router.get('/core-update/status', (_req, res) => {
    res.json(coreUpdate.getStatus())
  })

  // POST /api/core-update/check — hit npm for the latest version, refresh status.
  router.post('/core-update/check', (_req, res) => {
    void coreUpdate
      .checkForUpdate()
      .then((status) => res.json(status))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'check failed'
        res.status(502).json({ error: 'check_failed', message })
      })
  })

  // POST /api/core-update/update — materialize + swap to the target (default latest).
  // 202 + async progress over the `core_update.progress` WS event.
  router.post('/core-update/update', (req, res) => {
    if (!coreUpdate.isAvailable()) {
      res.status(409).json({ error: 'unavailable', message: 'Core updates are unavailable in this build.' })
      return
    }
    const status = coreUpdate.getStatus()
    if (status.updating) {
      res.status(409).json({ error: 'in_progress', message: 'An update is already in progress.' })
      return
    }
    const version = (req.body as { version?: unknown } | undefined)?.version
    const target = typeof version === 'string' ? version : undefined
    res.status(202).json({ accepted: true })
    // Fire-and-forget; outcome is delivered over WS (`core_update.progress`).
    void coreUpdate.update(target).catch(logRejection('core update'))
  })
}
