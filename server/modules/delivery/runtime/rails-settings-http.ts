// Per-rail configuration routes: ticket assignment and mode, default agent
// profile, AI engine override and display name. Each write broadcasts the
// canonical post-mutation rail snapshot as rail.updated.

import type { Router, Request, Response } from 'express'
import { getRail, setRailTickets, setRailProfile, setRailEngine, setRailName } from './rails-store'
import { validateRequestedProvider } from '../../../provider-selection'
import { ROLES_ENGINE } from '../../loops/runtime/loop-role-engines'
import { projectContextOf, broadcastRailUpdated, requireRailIndexParam, VALID_MODES, storedRailMode } from './rails-http-shared'

export function registerRailSettingsRoutes(router: Router): void {
  const ctx = projectContextOf

  // PUT /rails/:railIndex/tickets — set ticket assignments for a rail
  router.put('/:railIndex/tickets', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return

    const { ticketIds } = req.body ?? {}
    if (!Array.isArray(ticketIds) || ticketIds.some((id: unknown) => typeof id !== 'number')) {
      res.status(400).json({ error: 'ticketIds must be an array of numbers' }); return
    }

    const c = ctx(req)
    try {
      // setRailTickets does delete-then-reinsert; without forwarding the rail's
      // current mode/profileName they would reset to defaults ('implement' /
      // null) on every ticket reassignment, silently wiping a configured
      // per-rail profile. Preserve them (an explicit body value still wins).
      const current = getRail(c.db, railIndex)
      const body = req.body ?? {}
      const requestedMode = storedRailMode(body.mode)
      if (requestedMode !== undefined && (typeof requestedMode !== 'string' || !VALID_MODES.has(requestedMode))) {
        res.status(400).json({ error: 'mode must be "implement" or "loop"' }); return
      }
      const mode = typeof requestedMode === 'string' ? requestedMode : String(storedRailMode(current.mode))
      const profileName = 'profileName' in body ? body.profileName : current.profileName
      // Preserve the rail's AI engine across ticket reassignment (undefined →
      // setRailTickets re-reads the current value), so it isn't silently wiped.
      const aiEngine = 'aiEngine' in body ? body.aiEngine : undefined
      const rail = setRailTickets(c.db, railIndex, ticketIds as number[], mode, profileName, aiEngine)
      broadcastRailUpdated(c, railIndex, 'tickets')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail tickets error:', err)
      res.status(500).json({ error: 'Failed to update rail tickets' })
    }
  })

  // PUT /rails/:railIndex/profile — set the default agent profile for a rail
  // Body: { profileName: string | null } (null = force legacy mode for this rail)
  router.put('/:railIndex/profile', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    const body = req.body ?? {}
    if (!('profileName' in body)) {
      res.status(400).json({ error: "body must include 'profileName' (string or null)" }); return
    }
    const value = body.profileName
    if (value !== null && typeof value !== 'string') {
      res.status(400).json({ error: 'profileName must be a string or null' }); return
    }
    const c = ctx(req)
    try {
      const rail = setRailProfile(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'profile')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail profile error:', err)
      res.status(500).json({ error: 'Failed to update rail profile' })
    }
  })

  // PUT /rails/:railIndex/engine — set the AI engine override for a rail
  // Body: { aiEngine: string | null } (null = use the project's primary provider)
  router.put('/:railIndex/engine', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    const body = req.body ?? {}
    if (!('aiEngine' in body)) {
      res.status(400).json({ error: "body must include 'aiEngine' (string or null)" }); return
    }
    const value = body.aiEngine
    const c = ctx(req)
    // null clears the override; a string must be one of the project's providers
    // — or the `roles` sentinel (per-role engines from Settings ▸ Specrails Agents).
    if (value !== null && value !== ROLES_ENGINE) {
      const check = validateRequestedProvider(c.project, value)
      if (!check.ok) { res.status(400).json({ error: check.error }); return }
    }
    try {
      const rail = setRailEngine(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'engine')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail engine error:', err)
      res.status(500).json({ error: 'Failed to update rail engine' })
    }
  })

  // PUT /rails/:railIndex/name — set the rail's display name (the "Rail "-suffix)
  // Body: { name: string | null } (empty/null clears it back to the default label)
  router.put('/:railIndex/name', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    const body = req.body ?? {}
    if (!('name' in body)) {
      res.status(400).json({ error: "body must include 'name' (string or null)" }); return
    }
    const value = body.name
    if (value !== null && typeof value !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' }); return
    }
    // Guard against unbounded labels (UI shows a short chip).
    if (typeof value === 'string' && value.length > 60) {
      res.status(400).json({ error: 'name must be 60 characters or fewer' }); return
    }
    const c = ctx(req)
    try {
      const rail = setRailName(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'name')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail name error:', err)
      res.status(500).json({ error: 'Failed to update rail name' })
    }
  })
}
