// Note: the pkg-binary native-addon hijacks (better_sqlite3.node, node-pty, pty.node)
// used to live here but had to move to an esbuild `banner.js` in scripts/build-sidecar.mjs
// so they run BEFORE esbuild's top-of-bundle `require('node-pty')` statement.
// See the banner in that script for the actual patches.

import http from 'http'
import path from 'path'
import fs from 'fs'
import os from 'os'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsMessage } from './types'
import { ProjectRegistry } from './project-registry'
import { createDesktopRouter } from './desktop-router'
import { createProjectRouter } from './project-router'
import { createDocsRouter } from './docs-router'
import { requireAuth, requireLoopback, hostValidationMiddleware, safeEqual, loadOrGenerateToken, tokenFromUpgradeRequest } from './auth'
import { shouldDeliverToSubscriber, parseSubscribeFrame } from './ws-routing'
import { getTerminalManager } from './terminal-manager'
import { cleanupStaleShimDirs } from './terminal-shell-integration'
import { isBrowserCaptureEnabled } from './feature-flags'
import { MobileGateway, createMobileAdminRouter, getMobileEventBus } from './mobile'
import { McpServerManager, requireMcpAuth, createMcpAdminRouter } from './mcp'
import { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter, isAgentChatEnabled } from './agent-chat-router'
import { setAgentChatManager } from './agent-chat-registry'
import type { BrowserWsClient } from './browser-capture-manager'
import type { BrowserInputEvent } from './browser-capture-types'
import { isNavigableUrl } from './browser-playwright'
import { createTelemetryRouter } from './telemetry-receiver'
import { HeadroomManager } from './headroom-manager'
import { createGlobalPluginsRouter } from './global-plugins-router'
import { runCompactionForAll } from './telemetry-compactor'
import { FrameworkManager } from './framework-manager'
import { withFileLock } from './artifact-registry'
import { resolveStartupPath, augmentPathFromLoginShell, augmentAuthEnvFromLoginShell, getPathDiagnostic, ensureWindowsBaseEnv } from './path-resolver'
import { resolveServerPort } from './dev-ports'
// Side-effect import: registers every bundled ProviderAdapter (claude, codex,
// future providers) so `getAdapter`/`hasAdapter`/`listAdapters` are populated
// before any manager constructs a project context. See
// openspec/changes/add-multi-provider-support/specs/multi-provider-architecture/spec.md.
import './providers'

const inheritedPathBeforeResolve = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length
// Backfill SystemRoot/ComSpec/etc into process.env BEFORE anything spawns, so a
// stripped GUI-launch sidecar env never breaks cmd.exe-mediated spawns (PTY,
// where-probes, .cmd shims). No-op on POSIX. Must precede resolveStartupPath().
ensureWindowsBaseEnv()
resolveStartupPath()

const TERMINAL_PANEL_ENABLED = process.env.SPECRAILS_TERMINAL_PANEL !== 'false'
const BROWSER_CAPTURE_ENABLED = isBrowserCaptureEnabled()

// Read package.json version once at startup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// ─── Desktop app watchdog ─────────────────────────────────────────────────────

// When running as a Tauri sidecar, the parent Tauri process passes its PID via
// --parent-pid=<pid>. We poll every 3 seconds and exit if the parent is gone,
// preventing orphaned server processes after an app crash.
const parentPidArg = process.argv.find((a) => a.startsWith('--parent-pid='))
if (parentPidArg) {
  const parentPid = parseInt(parentPidArg.split('=')[1], 10)
  if (!isNaN(parentPid)) {
    // Poll at 1s (not 3s): on a self-update relaunch the Tauri host exits and the
    // freshly-launched instance needs port 4200 freed fast. The old 3s latency
    // raced the new instance's startup port check and produced "port already in
    // use". Faster detection + a graceful exit shrinks that window.
    const watchdog = setInterval(() => {
      try {
        // signal 0 = existence check only, does not actually send a signal
        process.kill(parentPid, 0)
      } catch {
        // Parent process is gone — shut down GRACEFULLY (tree-kill child rails,
        // PTYs, remove the PID file, release the port) instead of a bare
        // process.exit(0) that orphans children and leaks the PID file.
        clearInterval(watchdog)
        void shutdown()
      }
    }, 1000)
  }
}

// ─── Parse CLI args ───────────────────────────────────────────────────────────

const port = resolveServerPort(process.argv)

// ─── PID file management ──────────────────────────────────────────────────────

const PID_DIR = path.join(os.homedir(), '.specrails')
const PID_FILE = path.join(PID_DIR, 'manager.pid')

function writePidFile(): void {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true })
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8')
  } catch {
    // Non-fatal
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE)
  } catch {
    // Non-fatal
  }
}

// ─── Express + WebSocket setup ────────────────────────────────────────────────

const app = express()

// Host-header validation (H-08) — first barrier, anti DNS-rebinding.
// Implementation in auth.ts (unit-tested there); index.ts is coverage-excluded.
app.use(hostValidationMiddleware)

// ─── CORS — allow only localhost origins (CRIT-02) ────────────────────────────

// Tauri's desktop WebView exposes two different origin formats:
//   - macOS / Linux: tauri://localhost
//   - Windows WebView2: http://tauri.localhost (virtual-host mapping on the
//     custom scheme; shows up as a regular http origin from the fetch layer)
const ALLOWED_ORIGIN_PATTERN = /^(https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri:\/\/localhost)$/

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGIN_PATTERN.test(origin)
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers['origin']
  if (origin) {
    if (ALLOWED_ORIGIN_PATTERN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    } else {
      // Non-localhost origin — reject with 403
      res.status(403).json({ error: 'Forbidden: cross-origin requests not allowed' })
      return
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Desktop-Token')
  res.setHeader('Access-Control-Max-Age', '600')

  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
}

app.use(corsMiddleware)

// ─── Body size limit (MED-02) ─────────────────────────────────────────────────

// OTLP telemetry blobs can legitimately reach the BLOB_SIZE_CAP (10 MB); the 1mb
// global limit silently 413'd them and dropped telemetry. Parse /otlp with a
// 12mb limit FIRST — once it sets req._body the global parser below no-ops for
// these paths. (The actual /otlp router still requires loopback.)
app.use('/otlp', express.json({ limit: '12mb' }))

// ─── MCP streamable-HTTP transport (design D1) ───────────────────────────────
// Mounted BEFORE the global express.json so it claims `/api/mcp` with a larger
// body limit (req._body makes the global parser no-op for this path), and
// BEFORE `app.use('/api', requireAuth)` so it uses the SCOPED mcp token via
// requireMcpAuth rather than inheriting the all-powerful master token. The
// dispatcher delegates to the McpServerManager constructed during Super-mode
// bootstrap (lazily referenced — it exists by request time).
app.use(
  '/api/mcp',
  express.json({ limit: '4mb' }),
  requireLoopback,
  requireMcpAuth,
  (req, res) => {
    if (_mcpManager) {
      void _mcpManager.handleHttp(req, res)
      return
    }
    res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP transport not ready' }, id: null })
  },
)

app.use(express.json({ limit: '1mb' }))

const server = http.createServer(app)
const wsServerOptions = {
  noServer: true,
  // Cap inbound frame size (H-10). Shared by the main, terminal and browser WS
  // servers. Terminal/browser input frames (keystrokes, control JSON, pastes)
  // are tiny; 1 MB tolerates a large bracketed paste while bounding the memory
  // a single malicious frame can force the sidecar to buffer.
  maxPayload: 1024 * 1024,
  handleProtocols: (protocols: Set<string>) => {
    if (protocols.has('specrails-desktop')) return 'specrails-desktop'

    // Backward compatibility for clients that only offer the auth carrier.
    for (const protocol of protocols) {
      if (protocol.startsWith('desktop-token.')) return protocol
    }
    return false
  },
} satisfies ConstructorParameters<typeof WebSocketServer>[0]

const wss = new WebSocketServer(wsServerOptions)
const terminalWss = new WebSocketServer(wsServerOptions)
const browserWss = new WebSocketServer(wsServerOptions)

// ─── Per-connection WS state (H-09 / H-10) ────────────────────────────────────
//
// H-09: project isolation must be enforced SERVER-SIDE, not only client-side.
// Each connection may declare the project it is interested in via a
// `{ type: 'subscribe', projectId }` control frame; `broadcast` then routes a
// project-scoped message only to connections subscribed to that project (plus
// connections that have NOT declared a subscription — back-compat, they get
// everything exactly like before). App-level messages (no projectId) always go
// to everyone. The current web client does not send `subscribe`, so it keeps
// receiving everything and the existing client-side filter stays as a redundant
// second layer. The Mobile Gateway will subscribe per device, turning this into
// a hard authorization boundary instead of an opt-in optimization.
//
// H-10: skip sending to a client whose outbound buffer is already saturated so a
// single slow/stalled consumer can't make the sidecar buffer unboundedly.
interface WsConnState {
  subscribedProjectId: string | null
}
const clients = new Map<WebSocket, WsConnState>()

// 8 MB: a healthy client drains far faster than we produce; crossing this means
// the socket is stalled. Dropping an event is safe — clients reconcile via the
// REST polling paths — and far better than an unbounded memory leak.
const WS_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024

const TERMINAL_WS_RE = /^\/ws\/terminal\/([0-9a-f-]+)$/i
const BROWSER_WS_RE = /^\/ws\/browser\/([0-9a-f-]+)$/i

function rejectUpgrade(socket: { write: (s: string) => void; destroy: () => void }, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function authorizeUpgrade(request: http.IncomingMessage): 'ok' | 'forbidden' | 'unauthorized' {
  const origin = request.headers.origin
  if (!isAllowedBrowserOrigin(origin)) return 'forbidden'

  const provided = tokenFromUpgradeRequest(request)
  if (!provided || !safeEqual(provided, loadOrGenerateToken())) return 'unauthorized'

  return 'ok'
}

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg)
  // Project-scoped messages carry a projectId; app-level messages do not.
  const msgProjectId = (msg as { projectId?: string }).projectId
  for (const [client, state] of clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    // H-09: route project-scoped messages only to matching/undeclared subscribers.
    if (!shouldDeliverToSubscriber(msgProjectId, state.subscribedProjectId)) continue
    // H-10: drop for a back-pressured client instead of growing its buffer.
    if (client.bufferedAmount > WS_BACKPRESSURE_LIMIT_BYTES) continue
    client.send(data)
  }
  // Fan a copy to the Mobile Gateway's in-process bus (no-op when no phone is
  // attached). publish() swallows mobile-side errors so the main loop is safe.
  getMobileEventBus().publish(msg)
}

// ─── Health endpoint state (populated by the Super-mode bootstrap below) ─────

let _getProjectCount: () => number = () => 0
/** Captured by the Super-mode bootstrap block so graceful shutdown can tear down every
 *  project's spawners (rail/chat children) instead of orphaning them. */
let _registry: ProjectRegistry | null = null
/** The mobile companion gateway (off by default); torn down on shutdown. */
let _mobileGateway: MobileGateway | null = null
let _mcpManager: McpServerManager | null = null
let _agentChatManager: AgentChatManager | null = null
let _headroomManager: HeadroomManager | null = null

server.on('upgrade', (request, socket, head) => {
  const urlStr = request.url ?? '/'
  const auth = authorizeUpgrade(request)
  if (auth === 'forbidden') return rejectUpgrade(socket, 403, 'Forbidden')
  if (auth === 'unauthorized') return rejectUpgrade(socket, 401, 'Unauthorized')

  // Terminal PTY WebSocket endpoint: /ws/terminal/:id?projectId=...
  const pathOnly = urlStr.split('?')[0]
  const termMatch = pathOnly.match(TERMINAL_WS_RE)
  if (termMatch) {
    if (!TERMINAL_PANEL_ENABLED) return rejectUpgrade(socket, 404, 'Not Found')
    let parsed: URL
    try { parsed = new URL(urlStr, 'http://localhost') } catch { return rejectUpgrade(socket, 400, 'Bad Request') }
    const projectId = parsed.searchParams.get('projectId')
    const sessionId = termMatch[1]
    const tm = getTerminalManager()
    const session = tm.getUnsafe(sessionId)
    if (!session) {
      // The session may have died right after POST /terminals returned (e.g. a
      // shell that failed to acquire a controlling tty). If we have a tombstone,
      // upgrade just long enough to tell the client WHY, then close — otherwise
      // the client sees a bare 404 and a silent dead terminal.
      if (projectId) {
        const tomb = tm.getTombstone(sessionId, projectId)
        if (tomb) {
          terminalWss.handleUpgrade(request, socket, head, (ws) => {
            try { ws.send(JSON.stringify({ type: 'exit', code: tomb.code, signal: tomb.signal, early: tomb.early })) } catch { /* ignore */ }
            try { ws.close(1000, tomb.early ? 'pty_exit_early' : 'pty_exit') } catch { /* ignore */ }
          })
          return
        }
      }
      return rejectUpgrade(socket, 404, 'Not Found')
    }
    if (!projectId || session.projectId !== projectId) return rejectUpgrade(socket, 403, 'Forbidden')
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      // BUG-MOBILE-07: throttle inbound control frames (PTY-tuned cap).
      applyPtyWsRateLimiting(ws)
      const meta = tm.attach(sessionId, ws)
      if (!meta) {
        // Lost the race: the pty exited between the getUnsafe check and attach.
        const tomb = tm.getTombstone(sessionId, projectId)
        if (tomb) {
          try { ws.send(JSON.stringify({ type: 'exit', code: tomb.code, signal: tomb.signal, early: tomb.early })) } catch { /* ignore */ }
        }
        try { ws.close(1000, tomb?.early ? 'pty_exit_early' : 'pty_exit') } catch { /* ignore */ }
        return
      }
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          tm.write(sessionId, data as Buffer)
          return
        }
        try {
          const txt = (data as Buffer).toString('utf8')
          const msg = JSON.parse(txt) as { type?: string; cols?: number; rows?: number; data?: string }
          if (msg?.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            tm.resize(sessionId, msg.cols, msg.rows)
          } else if (msg?.type === 'write' && typeof msg.data === 'string') {
            tm.write(sessionId, msg.data)
          }
        } catch { /* ignore malformed control */ }
      })
      ws.on('close', () => tm.detach(sessionId, ws))
      ws.on('error', () => tm.detach(sessionId, ws))
    })
    return
  }

  // Embedded-browser screencast WebSocket: /ws/browser/:id?projectId=...
  // Frames stream server→client as binary; client→server are JSON control
  // messages (input/navigate). Kept off the shared /ws so high-rate screencast
  // throughput can't starve the project event stream (mirrors the terminal WS).
  const browserMatch = pathOnly.match(BROWSER_WS_RE)
  if (browserMatch) {
    if (!BROWSER_CAPTURE_ENABLED) return rejectUpgrade(socket, 404, 'Not Found')
    let parsed: URL
    try { parsed = new URL(urlStr, 'http://localhost') } catch { return rejectUpgrade(socket, 400, 'Bad Request') }
    const projectId = parsed.searchParams.get('projectId')
    const sessionId = browserMatch[1]
    if (!projectId) return rejectUpgrade(socket, 400, 'Bad Request')
    const mgr = _registry?.getContext(projectId)?.browserCaptureManager
    const session = mgr?.getSession(sessionId)
    if (!mgr || !session) return rejectUpgrade(socket, 404, 'Not Found')
    browserWss.handleUpgrade(request, socket, head, (ws) => {
      // BUG-MOBILE-07: throttle inbound control frames (PTY-tuned cap).
      applyPtyWsRateLimiting(ws)
      const client = ws as unknown as BrowserWsClient
      void mgr.attach(sessionId, client).then((meta) => {
        if (!meta) {
          // Session died between the upgrade check and attach — tell the client
          // explicitly instead of leaving a silent, frame-less socket open.
          try { ws.close(1000, 'session_closed') } catch { /* ignore */ }
        }
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) return // browser inbound is JSON control only
        try {
          const msg = JSON.parse((data as Buffer).toString('utf8')) as
            | { type: 'input'; event: BrowserInputEvent }
            | { type: 'navigate'; action?: 'goto' | 'back' | 'forward' | 'reload'; url?: string }
            | { type: 'probe'; x: number; y: number }
          if (msg.type === 'input' && msg.event) {
            void mgr.handleInput(sessionId, msg.event)
          } else if (msg.type === 'navigate') {
            // BUG-BROWSER-01: scheme-allowlist + SSRF guard for the WS navigate
            // path (mirrors REST /navigate). Only `goto` carries a user URL; the
            // history actions (back/forward/reload) replay already-vetted state.
            const action = msg.action ?? 'goto'
            if (action !== 'goto' || (typeof msg.url === 'string' && isNavigableUrl(msg.url))) {
              void mgr.navigate(sessionId, action, msg.url)
            }
          } else if (msg.type === 'probe' && Number.isFinite(msg.x) && Number.isFinite(msg.y) && msg.x >= 0 && msg.y >= 0) {
            // Hover-to-select: resolve the element under the cursor and reply with
            // its rect so the client can draw a highlight box.
            void mgr.probeElement(sessionId, { x: msg.x, y: msg.y }).then((probe) => {
              try { ws.send(JSON.stringify({ type: 'hover', rect: probe?.rect ?? null, selector: probe?.selector ?? null, path: probe?.path ?? null })) } catch { /* drop */ }
            })
          }
        } catch { /* ignore malformed control */ }
      })
      ws.on('close', () => mgr.detach(sessionId, client))
      ws.on('error', () => mgr.detach(sessionId, client))
    })
    return
  }

  // Default: main event WebSocket.
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

// ─── Docs portal (available in all modes) ────────────────────────────────────

// Loopback-only (H-04): docs are unauthenticated by design (no token needed to
// read them), so a loopback guard is the only thing standing between them and
// the network the day the bind changes.
app.use('/api/docs', requireLoopback, createDocsRouter())

// ─── Auth — protect all /api/* except /api/health and /api/token ─────────────
// (CRIT-01) Token is served publicly so the local client can bootstrap itself.

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: PKG_VERSION,
    uptime: Math.floor(process.uptime()),
    projects: _getProjectCount(),
    mode: 'super',
  })
})

// Loopback-only (H-03): this is the most sensitive endpoint — it hands out the
// master token, which grants terminals/spawn/fs/admin. It must stay public (no
// token) so the local client can bootstrap. Two complementary guards protect it:
// `requireLoopback` rejects a non-local PEER (matters if the bind ever changes
// from 127.0.0.1), and the Host-header guard above rejects DNS-rebinding (where
// the peer IS loopback — the victim's own browser — but the Host is the
// attacker's domain). Neither alone is sufficient; together they close both.
app.get('/api/token', requireLoopback, (_req, res) => {
  res.json({ token: loadOrGenerateToken() })
})

app.use('/api', requireAuth)

// ─── WebSocket rate limiting helper (LOW-03) ──────────────────────────────────

const WS_MAX_MESSAGES_PER_MINUTE = 120
const WS_MAX_MESSAGE_BYTES = 65_536 // 64 KB

// PTY/screencast control sockets (terminal keystrokes, browser input/probe
// frames) legitimately send far more small messages than the project event
// stream, so they get a higher per-minute cap while keeping a per-message byte
// cap and an absolute ceiling that still stops a tight flood loop (BUG-MOBILE-07).
const WS_PTY_MAX_MESSAGES_PER_MINUTE = 6000
const WS_PTY_MAX_MESSAGE_BYTES = 256 * 1024 // 256 KB (a paste / large resize burst)

function applyWsRateLimitingWith(ws: WebSocket, maxPerMinute: number, maxBytes: number): void {
  let messageCount = 0
  const resetTimer = setInterval(() => { messageCount = 0 }, 60_000)

  ws.on('message', (data: Buffer | string) => {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : (data as Buffer).byteLength

    if (size > maxBytes) {
      ws.close(1009, 'Message too large')
      return
    }

    messageCount++
    if (messageCount > maxPerMinute) {
      ws.close(1008, 'Rate limit exceeded')
    }
  })

  ws.on('close', () => {
    clearInterval(resetTimer)
  })
}

function applyWsRateLimiting(ws: WebSocket): void {
  applyWsRateLimitingWith(ws, WS_MAX_MESSAGES_PER_MINUTE, WS_MAX_MESSAGE_BYTES)
}

/** PTY-tuned limiter for the terminal / browser control sockets. */
function applyPtyWsRateLimiting(ws: WebSocket): void {
  applyWsRateLimitingWith(ws, WS_PTY_MAX_MESSAGES_PER_MINUTE, WS_PTY_MAX_MESSAGE_BYTES)
}

// ─── Super-mode bootstrap ─────────────────────────────────────────────────────

{
  const registry = new ProjectRegistry(broadcast, undefined, port)
  registry.loadAll()
  _registry = registry
  _getProjectCount = () => registry.listContexts().length

  // ─── Bundled framework update channel (Phase 6) ─────────────────────────────
  // After the registry + projects have loaded, run a single framework
  // version-check. On FIRST run it materializes the bundled framework to
  // `~/.specrails/framework/<version>/` + points `current`; POST-UPDATE (a new
  // app version ships a newer bundled core) it materializes the new version
  // side-by-side and atomically swaps `current` → every workspace that links
  // `current/...` jumps to it with no per-workspace work. The whole
  // materialize+swap runs under the SAME registry file-lock that serialises
  // artifact resolution, so a concurrently-spawning rail never observes a
  // half-swapped `current` (a rail that already resolved `current` keeps its
  // resolved framework — the atomic swap doesn't disturb open handles). No-op
  // (graceful) when no bundled core is present — every project falls back to
  // the legacy npx path. The `framework.updated` WS event is app-level (no
  // projectId); the client WS layer ignores unknown message types.
  try {
    const framework = new FrameworkManager({
      // `framework.updated` is app-level (no projectId) and not a member of the
      // WsMessage union; cast at this single boundary.
      broadcast: (msg) => broadcast(msg as unknown as WsMessage),
    })
    if (framework.isAvailable()) {
      const providers = registry.installedProvidersUnion()
      withFileLock(undefined, () => framework.versionCheck(providers))
    }
  } catch (err) {
    console.error('[framework-manager] startup versionCheck failed (non-fatal):', err)
  }

  // OTLP/JSON receiver — INTENTIONALLY UNAUTHENTICATED (H-01/H-02). The spawned
  // claude/codex CLIs post telemetry here with no auth header (queue-manager sets
  // OTEL_EXPORTER_OTLP_ENDPOINT but no OTEL_EXPORTER_OTLP_HEADERS), so it cannot
  // be put behind requireAuth. It is also NOT covered by `app.use('/api', ...)`
  // — that middleware is path-scoped to /api, and /otlp is a sibling path (the
  // old comment here claiming otherwise was wrong). It is protected instead by
  // `requireLoopback` (children always connect via 127.0.0.1) + the loopback bind.
  app.use('/otlp', requireLoopback, createTelemetryRouter(registry))

  // Run telemetry compaction at startup after registry is hydrated
  runCompactionForAll(registry).catch((err) => {
    console.error('[telemetry-compactor] startup compaction error:', err)
  })

  // ─── Mobile companion gateway (off by default; boot if previously enabled) ──
  // Second HTTPS+WSS listener in THIS process; the main server stays loopback.
  // The control plane is desktop-only: loopback + (via /api below) requireAuth.
  // Mounted before the /api desktop router so its sub-path is unambiguous.
  const mobileGateway = new MobileGateway({ desktopDb: registry.desktopDb, desktopPort: port, broadcast })
  _mobileGateway = mobileGateway
  app.use('/api/mobile', requireLoopback, createMobileAdminRouter({
    gateway: mobileGateway,
    desktopDb: registry.desktopDb,
    broadcast,
  }))
  if (mobileGateway.isEnabledSetting()) {
    mobileGateway.start().catch((err) => console.error('[mobile-gateway] boot start failed:', err))
  }

  // ─── Embedded MCP server (the /api/mcp transport mounted above) ─────────────
  const mcpManager = new McpServerManager({ registry, broadcast, desktopPort: port, version: PKG_VERSION })
  _mcpManager = mcpManager
  // Loopback + master-token control plane for the Settings ▸ MCP panel.
  app.use('/api/mcp-admin', requireLoopback, createMcpAdminRouter({
    manager: mcpManager,
    desktopDb: registry.desktopDb,
    desktopPort: port,
    broadcast,
  }))
  if (mcpManager.isEnabledSetting()) {
    mcpManager.start().catch((err) => console.error('[mcp] boot start failed:', err))
  }

  // ─── App-global agent chat (drives the app via its own MCP) ────────────────
  const headroomManager = new HeadroomManager(registry.desktopDb, broadcast, () =>
    registry.installedProvidersUnion().filter((provider): provider is 'codex' | 'claude' =>
      provider === 'codex' || provider === 'claude',
    ),
  )
  _headroomManager = headroomManager
  app.use('/api/global-plugins', createGlobalPluginsRouter(headroomManager))
  headroomManager.startActiveProxyOnBoot().catch((err) => {
    console.error('[headroom] boot start failed:', err)
  })

  const agentChatManager = new AgentChatManager(broadcast, registry.desktopDb, port, registry)
  _agentChatManager = agentChatManager
  // Publish the instance to the process-wide registry so the rails layer can
  // post PR-decision cards (safe-pr-review-flow). Left null when agent chat is
  // disabled — the rails callers are null-safe and simply skip the card.
  setAgentChatManager(isAgentChatEnabled() ? agentChatManager : null)
  app.use('/api/agent', createAgentChatRouter({ manager: agentChatManager, desktopDb: registry.desktopDb }))

  // App-level routes. CRITICAL mount order: the desktop router is mounted at
  // '/api' BEFORE the project router below so its exact routes (e.g.
  // GET /api/projects, DELETE /api/projects/:id) are handled here, while
  // everything else under /api/projects/:projectId/* falls through to the
  // project router.
  app.use('/api', createDesktopRouter(registry, broadcast))

  // Per-project routes under /api/projects/:projectId/*
  app.use('/api/projects', createProjectRouter(registry))

  // Return 410 Gone for the old per-project hook endpoint in Super mode
  app.post('/hooks/events', (_req, res) => {
    res.status(410).json({
      error: 'In Super mode, use /api/projects/:projectId/hooks/events',
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const state: WsConnState = { subscribedProjectId: null }
    clients.set(ws, state)
    applyWsRateLimiting(ws)

    // H-09: honor an optional `{ type: 'subscribe', projectId }` control frame so
    // a connection can scope itself to one project's events. Anything else on the
    // inbound channel is ignored (the main event WS is otherwise server→client).
    ws.on('message', (data: Buffer | string) => {
      const txt = typeof data === 'string' ? data : data.toString('utf8')
      const frame = parseSubscribeFrame(txt)
      if (frame.subscribe) state.subscribedProjectId = frame.projectId
    })

    // Send app state init
    const projects = registry.listContexts().map((ctx) => ctx.project)
    ws.send(JSON.stringify({
      type: 'desktop.projects',
      projects,
      timestamp: new Date().toISOString(),
    }))

    ws.on('close', () => {
      clients.delete(ws)
    })
  })

}


// ─── Global async error handler ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[unhandled error]', err)
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Serve built React client (production) ────────────────────────────────────

const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get(/^(?!\/api|\/hooks).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

// ─── Start server ─────────────────────────────────────────────────────────────

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[error] Port ${port} is already in use. Is another manager instance running?`)
    console.error(`[error] Try stopping it first: specrails-desktop stop`)
    process.exit(1)
  }
  throw err
})

server.listen(port, '127.0.0.1', () => {
  console.log(`specrails web manager running on http://127.0.0.1:${port}`)
  writePidFile()
  // Sweep stale shell-integration shim directories left behind by previous runs.
  try {
    const removed = cleanupStaleShimDirs()
    if (removed > 0) console.log(`[terminal-shell-integration] cleaned ${removed} stale shim dirs`)
  } catch { /* best effort */ }
  void augmentPathFromLoginShell().then(() => {
    const diag = getPathDiagnostic()
    const augmented = diag.pathSegments.length - inheritedPathBeforeResolve
    const source = process.stdin.isTTY ? 'terminal' : 'gui'
    console.log(`[path-resolver] inherited=${inheritedPathBeforeResolve} augmented=${Math.max(0, augmented)} loginShell=${diag.loginShellStatus} source=${source}`)
  })
  // Recover provider auth env (e.g. GEMINI_API_KEY) from the user's login shell
  // so a GUI-launched server doesn't force gemini onto its macOS-Keychain OAuth
  // path. Independent of the PATH probe above (which is skipped when the bundle
  // is active). Fire-and-forget; never logs secret values.
  void augmentAuthEnvFromLoginShell()
})

// ─── Clean shutdown ───────────────────────────────────────────────────────────

let shuttingDown = false
async function shutdown(): Promise<void> {
  // Idempotent: the watchdog, SIGTERM and SIGINT can all race into here.
  if (shuttingDown) return
  shuttingDown = true
  removePidFile()
  try {
    await _headroomManager?.shutdown()
  } catch { /* ignore */ }
  try {
    _registry?.shutdown()
  } catch { /* ignore */ }
  try {
    await getTerminalManager().shutdown()
  } catch { /* ignore */ }
  try {
    await _mobileGateway?.stop()
    await _mcpManager?.stop()
    await _agentChatManager?.shutdown()
  } catch { /* ignore */ }
  try { wss.close() } catch { /* ignore */ }
  try { terminalWss.close() } catch { /* ignore */ }
  try { browserWss.close() } catch { /* ignore */ }
  // Force-close lingering keep-alive / WebSocket sockets so server.close()'s
  // callback actually fires. The persistent /ws client connection and terminal
  // sockets would otherwise hold the server open, stalling the port release that
  // a relaunching desktop instance is waiting on. (Node 18.2+.)
  try {
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  } catch { /* ignore */ }
  // Hard-exit fallback in case server.close() still hangs.
  const forceExit = setTimeout(() => process.exit(0), 3000)
  forceExit.unref?.()
  server.close(() => {
    clearTimeout(forceExit)
    process.exit(0)
  })
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
// Last-resort PID-file cleanup for paths that bypass shutdown() (hard crash,
// uncaught exception). 'exit' handlers must be synchronous.
process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE) } catch { /* best effort */ }
})
