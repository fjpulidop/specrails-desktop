import { Router } from 'express'
import type { Request, Response } from 'express'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import type { McpServerManager } from './mcp-server'
import { getMcpToken, regenerateMcpToken } from './mcp-token'
import { setDesktopSetting } from '../desktop-db'
import { TIER_SETTING_KEY, isTierEnabled, type McpTier } from './mcp-tiers'

// Loopback-only control plane for the Settings ▸ MCP panel, mounted on the MAIN
// server at /api/mcp-admin behind requireAuth (the MASTER token — this is the
// desktop user, not the third-party MCP client) + requireLoopback. Mirrors
// createMobileAdminRouter. The MCP transport itself lives at /api/mcp with the
// scoped token; these admin routes manage enable/tiers/token.

export interface McpAdminDeps {
  manager: McpServerManager
  desktopDb: DbInstance
  desktopPort: number
  broadcast: (msg: WsMessage) => void
}

function tierState(db: DbInstance): { write: boolean; aiSpawn: boolean; destructive: boolean } {
  return {
    write: isTierEnabled(db, 'write'),
    aiSpawn: isTierEnabled(db, 'ai-spawn'),
    destructive: isTierEnabled(db, 'destructive'),
  }
}

function redact(token: string): string {
  return token.length > 4 ? `…${token.slice(-4)}` : '…'
}

export function createMcpAdminRouter(deps: McpAdminDeps): Router {
  const router = Router()
  const { manager, desktopDb, desktopPort } = deps

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ ...manager.status(), tiers: tierState(desktopDb), tokenHint: redact(getMcpToken()) })
  })

  router.post('/enable', async (_req: Request, res: Response) => {
    try {
      res.json(await manager.setEnabled(true))
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Failed to enable MCP' })
    }
  })

  router.post('/disable', async (_req: Request, res: Response) => {
    res.json(await manager.setEnabled(false))
  })

  // Update the opt-in permission tiers (read is always on, not settable here).
  router.patch('/tiers', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const fields: Array<[string, Exclude<McpTier, 'read'>]> = [
      ['write', 'write'],
      ['aiSpawn', 'ai-spawn'],
      ['destructive', 'destructive'],
    ]
    for (const [bodyKey, tier] of fields) {
      if (bodyKey in body) {
        if (typeof body[bodyKey] !== 'boolean') {
          res.status(400).json({ error: `${bodyKey} must be a boolean` })
          return
        }
        setDesktopSetting(desktopDb, TIER_SETTING_KEY[tier], body[bodyKey] ? 'true' : 'false')
      }
    }
    res.json({ ok: true, tiers: tierState(desktopDb) })
  })

  // The full token — deliberately a separate loopback-only action so it never
  // leaks through a general settings payload. Used by the panel's copy button.
  router.get('/token', (_req: Request, res: Response) => {
    res.json({ token: getMcpToken() })
  })

  router.post('/regenerate-token', (_req: Request, res: Response) => {
    res.json({ token: regenerateMcpToken() })
  })

  // Connection info for the panel to render a ready-to-paste client config.
  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      httpUrl: `http://127.0.0.1:${desktopPort}/api/mcp`,
      bridgeCommand: 'specrails-mcp',
      hasToken: true,
    })
  })

  return router
}
