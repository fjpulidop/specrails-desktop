import { Router } from 'express'
import type { Request, Response } from 'express'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import type { McpServerManager } from './mcp-server'
import { getMcpToken, mcpTokenPath, regenerateMcpToken } from './mcp-token'
import { safeEqual } from '../auth'
import { setDesktopSetting } from '../desktop-db'
import { TIER_SETTING_KEY, isTierEnabled, type McpTier } from './mcp-tiers'
import { CONFIRM_ABOVE_USD_KEY, readConfirmThreshold } from './v2/core/confirm'
import { MCP_V2_KEY, isMcpV2Enabled } from './v2/flag'
import { buildSpecrailsMcpEntry } from '../agent-mcp-config'
import type { BridgeEntry, ConnectClient, ConnectScope } from './connect/client-config'
import { registrationCommand } from './connect/client-config'
import { CONNECT_CLIENTS, ConnectError, connect, defaultConnectEnv, detectClients, type ConnectEnv } from './connect/connect'
import { verifyBridge, type VerifyResult } from './connect/verify'
import { stableNodeCommand, type StableNode } from './connect/node-path'
import { findNodeOnPath } from '../core-node-runtime'
import { runDoctor, type DoctorInput } from './connect/doctor'
import { resolveBundledNodeExe } from '../path-resolver'
import fs from 'fs'
import path from 'path'

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
  /** Connect seams (tests): the person's home/env, the bridge entry and the verify step. */
  connect?: {
    env?: () => ConnectEnv
    entry?: () => BridgeEntry | null
    verify?: (entry: BridgeEntry) => Promise<VerifyResult>
    /** How the entry's Node was chosen (doctor reports it). */
    nodeSource?: () => StableNode | undefined
    /** Doctor seams: the token file and the Node version probe. */
    tokenFile?: () => string
    nodeVersion?: DoctorInput['nodeVersion']
    doctorFs?: DoctorInput['fs']
  }
}

/** Highest "Ask before spending" threshold the panel accepts (USD). */
export const MAX_CONFIRM_ABOVE_USD = 1000

function preferences(db: DbInstance): { confirmAboveUsd: number; v2: { enabled: boolean; forcedByEnv: boolean } } {
  const override = process.env.SPECRAILS_MCP_V2
  return {
    confirmAboveUsd: readConfirmThreshold(db),
    v2: { enabled: isMcpV2Enabled(db), forcedByEnv: override === 'true' || override === 'false' },
  }
}

/**
 * How a source checkout's entry runs the bridge: this server's own Node, through
 * a stable link when its path is versioned (Homebrew Cellar, nvm, …). The
 * packaged app uses its bundled runtime.
 */
function defaultNodeSource(): StableNode {
  const packagedServer = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
  return stableNodeCommand({
    execPath: process.execPath,
    bundled: resolveBundledNodeExe(),
    env: process.env,
    platform: process.platform,
    packagedServer,
    nodeOnPath: packagedServer ? findNodeOnPath(process.env, process.platform) : null,
  })
}

/**
 * The entry an external client registers: the bundled Node (or this server's
 * own Node, absolute and version-stable, in a source checkout) and the bridge
 * script, with the app's port. No token: the bridge reads ~/.specrails/mcp.token.
 */
function defaultBridgeEntry(port: number): BridgeEntry | null {
  const entry = buildSpecrailsMcpEntry({ port })
  if (!entry) return null
  return { ...entry, command: entry.command === 'node' ? defaultNodeSource().command : entry.command }
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

  const connectEnv = deps.connect?.env ?? defaultConnectEnv
  const bridgeEntry = deps.connect?.entry ?? (() => defaultBridgeEntry(desktopPort))
  const verify = deps.connect?.verify ?? ((entry: BridgeEntry) => verifyBridge(entry))

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ ...manager.status(), tiers: tierState(desktopDb), tokenHint: redact(getMcpToken()), ...preferences(desktopDb) })
  })

  // "Ask before spending" (the v2 confirmation threshold, USD) and the v2
  // surface flag. Validated as a whole before anything is written.
  router.patch('/preferences', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if ('confirmAboveUsd' in body) {
      const value = body.confirmAboveUsd
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CONFIRM_ABOVE_USD) {
        res.status(400).json({ error: `confirmAboveUsd must be a number from 0 to ${MAX_CONFIRM_ABOVE_USD}` })
        return
      }
    }
    if ('v2' in body && typeof body.v2 !== 'boolean') {
      res.status(400).json({ error: 'v2 must be a boolean' })
      return
    }
    desktopDb.transaction(() => {
      if ('confirmAboveUsd' in body) setDesktopSetting(desktopDb, CONFIRM_ABOVE_USD_KEY, String(Math.round((body.confirmAboveUsd as number) * 100) / 100))
      if ('v2' in body) setDesktopSetting(desktopDb, MCP_V2_KEY, body.v2 ? 'true' : 'false')
    })()
    res.json({ ok: true, ...preferences(desktopDb) })
  })

  // Which clients are installed and whether each already runs this app's
  // bridge, with the exact registration command for people who prefer to run it.
  router.get('/connect', (_req: Request, res: Response) => {
    const entry = bridgeEntry()
    const cenv = connectEnv()
    res.json({
      available: entry !== null,
      entry,
      clients: detectClients(entry, cenv).map((detected) => ({
        ...detected,
        command: entry ? registrationCommand(detected.client, entry, 'user', cenv.platform) : null,
      })),
    })
  })

  // One-step connect (or --remove) for Claude Code or Codex, then a real
  // stdio round trip through the registered entry. Used by the panel button
  // and by `specrails-desktop mcp connect`.
  router.post('/connect', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const client = body.client as ConnectClient
    if (!CONNECT_CLIENTS.includes(client)) {
      res.status(400).json({ error: 'client must be claude or codex', code: 'invalid_input' })
      return
    }
    for (const flag of ['remove', 'dryRun', 'force', 'verify'] as const) {
      if (flag in body && typeof body[flag] !== 'boolean') {
        res.status(400).json({ error: `${flag} must be a boolean`, code: 'invalid_input' })
        return
      }
    }
    if ('projectDir' in body && typeof body.projectDir !== 'string') {
      res.status(400).json({ error: 'projectDir must be a string', code: 'invalid_input' })
      return
    }
    const entry = bridgeEntry()
    try {
      const result = connect({
        client,
        scope: (body.scope as ConnectScope | undefined) ?? 'user',
        projectDir: body.projectDir as string | undefined,
        remove: body.remove === true,
        dryRun: body.dryRun === true,
        force: body.force === true,
      }, entry, connectEnv())
      if (result.outcome === 'conflict') {
        res.status(409).json({ ...result, code: 'conflict', error: result.reason === 'foreign_entry'
          ? `${result.file} already has a "specrails" server that is not the Specrails bridge. Rename it, or pass force to replace it.`
          : result.reason === 'invalid_config'
            ? `${result.file} is not valid. Fix it first; connect never resets a config file.`
            : `${result.file} defines "specrails" in a layout connect does not edit. Edit it by hand or remove that definition.` })
        return
      }
      const shouldVerify = body.verify !== false && !result.dryRun && !body.remove && entry !== null && manager.isEnabledSetting()
      const verified = shouldVerify ? await verify(entry!) : undefined
      res.json({
        ...result,
        mcpEnabled: manager.isEnabledSetting(),
        ...(verified ? { verify: verified } : {}),
      })
    } catch (err) {
      const code = err instanceof ConnectError ? err.code : 'io'
      res.status(code === 'invalid_input' ? 400 : code === 'no_bridge' ? 503 : 500).json({ error: err instanceof Error ? err.message : String(err), code })
    }
  })

  // `specrails-desktop mcp doctor`: read-only end-to-end diagnosis of external
  // client connections (token, bridge, Node, each client's entry, a stdio round trip).
  router.get('/doctor', async (req: Request, res: Response) => {
    const projectDir = typeof req.query.projectDir === 'string' && path.isAbsolute(req.query.projectDir) ? req.query.projectDir : undefined
    const entry = bridgeEntry()
    const nodeSource = deps.connect?.nodeSource ? deps.connect.nodeSource() : deps.connect?.entry || !entry ? undefined : defaultNodeSource()
    const status = manager.status()
    try {
      const report = await runDoctor({
        cenv: connectEnv(),
        port: desktopPort,
        ...(projectDir && fs.existsSync(projectDir) ? { projectDir } : {}),
        mcpEnabled: manager.isEnabledSetting(),
        expected: entry,
        ...(nodeSource ? { nodeSource } : {}),
        tokenFile: deps.connect?.tokenFile?.() ?? mcpTokenPath(),
        tokenMatches: (value) => safeEqual(value, getMcpToken()),
        versions: { app: manager.version, catalog: isMcpV2Enabled(desktopDb) ? 'v2' : 'v1', advertisedTools: status.toolCount },
        ...(deps.connect?.nodeVersion ? { nodeVersion: deps.connect.nodeVersion } : {}),
        ...(deps.connect?.doctorFs ? { fs: deps.connect.doctorFs } : {}),
        ...(req.query.verify === 'false' ? {} : { verify }),
      })
      res.json(report)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
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

  // Update the opt-out permission tiers (all on by default; read is always on, not settable here).
  router.patch('/tiers', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const fields: Array<[string, Exclude<McpTier, 'read'>]> = [
      ['write', 'write'],
      ['aiSpawn', 'ai-spawn'],
      ['destructive', 'destructive'],
    ]
    // Validate the complete patch before changing any tier. A 400 must never
    // leave the first fields committed while later fields were rejected.
    for (const [bodyKey] of fields) {
      if (bodyKey in body) {
        if (typeof body[bodyKey] !== 'boolean') {
          res.status(400).json({ error: `${bodyKey} must be a boolean` })
          return
        }
      }
    }
    desktopDb.transaction(() => {
      for (const [bodyKey, tier] of fields) {
        if (bodyKey in body) setDesktopSetting(desktopDb, TIER_SETTING_KEY[tier], body[bodyKey] ? 'true' : 'false')
      }
    })()
    res.json({ ok: true, tiers: tierState(desktopDb) })
  })

  // The full token — deliberately a separate loopback-only action so it never
  // leaks through a general settings payload. Used by the panel's copy button.
  router.get('/token', (_req: Request, res: Response) => {
    res.json({ token: getMcpToken() })
  })

  router.post('/regenerate-token', async (_req: Request, res: Response) => {
    try {
      const token = regenerateMcpToken()
      // Already-open SSE streams were authenticated before rotation. Close
      // them too; new requests must initialize with the newly persisted token.
      await manager.stop()
      res.json({ token })
    } catch (err) {
      res.status(500).json({ error: 'Could not regenerate MCP token', detail: err instanceof Error ? err.message : String(err) })
    }
  })

  // Connection info for the panel to render a ready-to-paste client config.
  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      httpUrl: `http://127.0.0.1:${desktopPort}/api/mcp`,
      bridgeCommand: 'specrails-mcp',
      hasToken: true,
      // The resolved stdio entry (absolute paths, no secret) when the bridge is bundled.
      entry: bridgeEntry(),
    })
  })

  return router
}
