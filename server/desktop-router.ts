import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import net from 'net'
import dns from 'dns'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { getDesktopSetting, setDesktopSetting, listProjects, listAgents, getAgent, addAgent, updateAgent, listWebhooks, getWebhook, addWebhook, updateWebhook, removeWebhook, getProjectSetupSession } from './desktop-db'
import type { WebhookEvent } from './desktop-db'
import { WebhookManager } from './webhook-manager'
import { CoreUpdateManager } from './core-update-manager'
import { createSpecrailsTechClient } from './specrails-tech-client'
import { checkCoreCompat, getCLIStatus, detectAvailableCLIs } from './core-compat'
import { hasAdapter, listAdapters } from './providers'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './desktop-analytics'
import { getSetupPrerequisitesStatus } from './setup-prerequisites'
import { getPathDiagnostic } from './path-resolver'
import {
  getDesktopTerminalSettings,
  patchDesktopTerminalSettings,
  TerminalSettingsValidationError,
} from './terminal-settings'
import type { AnalyticsOpts, AnalyticsPeriod } from './types'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Deterministic slug allocation with a `-N` dedup suffix — byte-parity with
 * specrails-core's `allocateSlug` (and artifact-registry). Without this, two
 * repos that share a basename (e.g. `frontend` in two parent dirs) both slugify
 * to `frontend`, and the second `addProject` dies on the `projects.slug UNIQUE`
 * constraint with a misleading 409 ("already registered") even though the PATH
 * is new. The `-2`, `-3`… suffix gives the second repo a distinct slug.
 */
function allocateSlug(name: string, existing: ReadonlySet<string>): string {
  let base = slugify(name)
  if (base === '') base = 'project'
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

// Emergency rollback for the codex provider: SPECRAILS_CODEX_BETA=0 forces
// codex back to "unavailable" without redeploying. The pre-rebrand
// SPECRAILS_HUB_CODEX_BETA name is read as a legacy fallback when the new
// var is unset (legacy fallback — do not remove while old installs exist).
function isCodexBetaDisabled(): boolean {
  const v = process.env.SPECRAILS_CODEX_BETA ?? process.env.SPECRAILS_HUB_CODEX_BETA
  return v === '0'
}

// Gemini is enabled by DEFAULT now that its stream-json schema and the full rails
// pipeline (architect→developer→reviewer delegation, headless agent loading, the
// MAX_TURNS resume + reviewer gate) are validated against the live binary
// (0.46/0.47). Emergency rollback: SPECRAILS_GEMINI_BETA=0 forces it back to
// "unavailable" without redeploying — parity with codex's SPECRAILS_CODEX_BETA.
// The adapter is always registered (pricing/getAdapter work); only project
// selection is gated.
function isGeminiBetaDisabled(): boolean {
  return process.env.SPECRAILS_GEMINI_BETA === '0'
}

// Theme allow-list. Mirror of THEME_IDS in `client/src/lib/themes.ts` —
// kept duplicated to avoid pulling client code into the server bundle.
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails'])

// Language allow-list. Mirror of LANGUAGE_IDS in `client/src/lib/i18n.ts` —
// kept duplicated to avoid pulling client code into the server bundle.
const LANGUAGE_ID_ALLOWLIST = new Set<string>(['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])

// LOW-04: Deny registration of system-critical directory paths. The POSIX list
// is matched against forward-slash-normalized, lowercased paths; on Windows it
// was a complete no-op (no path matches `/etc`), so add a Windows deny-list and
// fold case (Windows FS is case-insensitive).
const DENIED_PATH_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/sys', '/proc', '/dev', '/boot', '/run',
]
// Windows: deny the Windows dir, Program Files variants, and any bare drive root.
const DENIED_WINDOWS_PREFIXES = [
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata',
]

function isPathSafe(resolvedPath: string): boolean {
  const slashed = resolvedPath.replace(/\\/g, '/')
  const normalized = slashed.endsWith('/') ? slashed : slashed + '/'
  if (process.platform === 'win32') {
    const lower = normalized.toLowerCase()
    // Bare drive root (C:/) is never a valid project location.
    if (/^[a-z]:\/$/.test(lower)) return false
    return !DENIED_WINDOWS_PREFIXES.some(
      (prefix) => lower.startsWith(prefix + '/') || lower === prefix + '/'
    )
  }
  return !DENIED_PATH_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix + '/') || normalized === prefix + '/'
  )
}

function deriveProjectName(projectPath: string): string {
  return path.basename(projectPath)
}

function hasCommandFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.md'))
  } catch {
    return false
  }
}

function hasSpecrails(projectPath: string): boolean {
  return hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'sr'))
    || hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'specrails'))
}

function canonicalizePath(resolvedPath: string): string {
  try {
    return fs.realpathSync(resolvedPath)
  } catch {
    return resolvedPath
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
}

// BUG-WEBHOOK-01: alternate IPv4 encodings (decimal `2130706433`, octal
// `0177.0.0.1`, hex `0x7f.0.0.1` or a single `0x7f000001`) all resolve to the
// same address as `127.0.0.1` but evade the dotted-quad-only `isPrivateIpv4`.
// Canonicalize any whole-number / non-dotted-decimal form to a dotted quad so
// the private-range check sees the real address. Returns null when the input is
// not an unambiguous IPv4 literal (e.g. a real DNS name) so callers fall back to
// DNS resolution.
function canonicalizeIpv4Literal(host: string): string | null {
  const u32ToDotted = (n: number): string =>
    `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
  // Single integer form (decimal / 0x-hex / 0-octal): https://2130706433/
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/.test(host)) {
    let n: number
    if (host.startsWith('0x')) n = Number.parseInt(host.slice(2), 16)
    else if (host.startsWith('0') && host !== '0') n = Number.parseInt(host, 8)
    else n = Number.parseInt(host, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return u32ToDotted(n >>> 0)
  }
  // Dotted form where one or more octets are octal/hex: 0177.0.0.1 / 0x7f.0.0.1
  if (/^[0-9a-fx.]+$/.test(host) && host.includes('.')) {
    const segs = host.split('.')
    if (segs.length !== 4) return null
    const nums: number[] = []
    for (const seg of segs) {
      if (seg === '') return null
      let v: number
      if (/^0x[0-9a-f]+$/.test(seg)) v = Number.parseInt(seg.slice(2), 16)
      else if (/^0[0-7]+$/.test(seg)) v = Number.parseInt(seg, 8)
      else if (/^[0-9]+$/.test(seg)) v = Number.parseInt(seg, 10)
      else return null
      if (!Number.isFinite(v) || v < 0 || v > 255) return null
      nums.push(v)
    }
    return nums.join('.')
  }
  return null
}

function isPrivateIp(hostname: string): boolean {
  // Strip IPv6 brackets that URL.hostname can include (else net.isIP returns 0
  // and an IPv6 literal would slip through as "not an IP").
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // IPv4-mapped IPv6 — both the dotted-decimal embedding (`::ffff:127.0.0.1`)
  // and the hex embedding (`::ffff:7f00:1`) must be unwrapped to their v4 form.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isPrivateIpv4(v4)
  }
  // Alternate IPv4 encodings (decimal / octal / hex) → canonicalize then check.
  const canon = canonicalizeIpv4Literal(host)
  if (canon) return isPrivateIpv4(canon)
  const ipVersion = net.isIP(host)
  if (ipVersion === 0) return false
  if (ipVersion === 6) {
    return host === '::1' || host === '::' ||
      host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  }
  return isPrivateIpv4(host)
}

// BUG-WEBHOOK-01 (DNS-rebinding SSRF): `isPrivateIp` only inspects IP literals,
// so a public DNS name that resolves to a loopback/private/link-local address
// slips through. Resolve ALL addresses for the host and reject if ANY of them
// is private. Returns true ⇒ the host is safe to target; false ⇒ blocked.
// Tolerant of resolution failure: an unresolvable host can't be a confirmed
// SSRF target, so it is allowed through (delivery will simply fail).
async function resolvesToPublicOnly(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '')
  // Literal IPs are already handled synchronously by isPrivateIp; skip lookup.
  if (net.isIP(host) !== 0 || canonicalizeIpv4Literal(host.toLowerCase())) return true
  let addrs: dns.LookupAddress[]
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    return true
  }
  return !addrs.some((a) => isPrivateIp(a.address))
}

function validateHttpUrl(raw: string, opts: { allowLoopback: boolean; requireHttps: boolean }): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (opts.requireHttps && parsed.protocol !== 'https:') {
    if (!opts.allowLoopback || !isLoopbackHost(parsed.hostname)) return null
  }
  if (!opts.allowLoopback && (isLoopbackHost(parsed.hostname) || isPrivateIp(parsed.hostname))) return null
  return parsed.toString().replace(/\/$/, '')
}

function publicWebhook(row: ReturnType<typeof getWebhook>) {
  if (!row) return row
  const { secret: _secret, ...rest } = row
  return { ...rest, hasSecret: row.secret.length > 0 }
}

export function createDesktopRouter(
  registry: ProjectRegistry,
  broadcast: (msg: WsMessage) => void
): Router {
  const router = Router()

  // GET /api/projects — list all registered projects
  router.get('/projects', (_req, res) => {
    const projects = listProjects(registry.desktopDb)
    // Detect projects that are currently in the setup wizard so the client
    // can restore the wizard after a page refresh.
    const setupProjectIds: string[] = []
    for (const p of projects) {
      const ctx = registry.getContext(p.id)
      if (!ctx) continue
      const installing = ctx.setupManager.isInstalling(p.id)
      const settingUp = ctx.setupManager.isSettingUp(p.id)
      const hasSession = !!getProjectSetupSession(registry.desktopDb, p.id)
      const specrailsInstalled = hasSpecrails(p.path)
      if (installing || settingUp || (hasSession && !specrailsInstalled)) {
        setupProjectIds.push(p.id)
      }
    }
    res.json({ projects, setupProjectIds })
  })

  // GET /api/available-providers — which AI CLIs are installed, plus supported install tiers
  //
  // Codex (OpenAI) is supported as a first-class provider as of Stage C of
  // the multi-provider work. The `SPECRAILS_CODEX_BETA=0` env var is honoured
  // as an emergency rollback (forces codex back to "unavailable" in the UI
  // without redeploying) — unset or `1` reports the real detection.
  router.get('/available-providers', (_req, res) => {
    const providers = detectAvailableCLIs()
    // tiers: quick install is always available (app-driven config); full requires an AI CLI
    const tiers: ('quick' | 'full')[] = ['quick']
    if (Object.values(providers).some(Boolean)) tiers.push('full')
    // Return the full detected map (registry-driven) so a newly-registered
    // provider surfaces here with no edit. Apply per-provider beta gates: codex
    // is forced unavailable when SPECRAILS_CODEX_BETA=0 (emergency rollback).
    const gated: Record<string, boolean> = { ...providers }
    if (isCodexBetaDisabled()) gated.codex = false
    // Gemini: enabled by default; forced unavailable only when
    // SPECRAILS_GEMINI_BETA=0 (emergency rollback, parity with codex).
    if (isGeminiBetaDisabled()) gated.gemini = false
    res.json({ ...gated, tiers })
  })

  router.get('/setup-prerequisites', (req, res) => {
    const status = getSetupPrerequisitesStatus()
    if (req.query.diagnostic === '1') {
      const diag = getPathDiagnostic()
      const whichResults: Record<string, string | null> = {}
      for (const item of status.prerequisites) {
        whichResults[item.command] = item.resolvedPath ?? null
      }
      res.json({
        ...status,
        diagnostic: {
          pathSegments: diag.pathSegments,
          pathSources: diag.pathSources,
          loginShellStatus: diag.loginShellStatus,
          whichResults,
          nodeEnv: process.env.NODE_ENV ?? null,
          platform: status.platform,
        },
      })
      return
    }
    res.json(status)
  })

  // POST /api/projects — register a new project by path
  router.post('/projects', (req, res) => {
    const { path: projectPath, name, provider, providers: providersRaw } = req.body ?? {}
    if (!projectPath || typeof projectPath !== 'string') {
      res.status(400).json({ error: 'path is required' })
      return
    }
    // Normalise to a providers list. New multi-provider clients send
    // `providers: ['claude','codex']`; legacy clients send a single
    // `provider`; omitting both defaults to ['claude']. The first entry is the
    // primary/default provider.
    let providers: string[]
    if (Array.isArray(providersRaw) && providersRaw.length > 0) {
      providers = providersRaw
    } else if (typeof provider === 'string') {
      providers = [provider]
    } else {
      providers = ['claude']
    }
    // De-duplicate while preserving order (primary stays first).
    providers = providers.filter((p, i) => providers.indexOf(p) === i)
    // Provider validation walks the registry — `claude` and `codex` are
    // both accepted as of Stage C; future providers register one adapter
    // file and become acceptable here without further changes.
    for (const p of providers) {
      if (!hasAdapter(p)) {
        res.status(400).json({
          error: `provider must be one of: ${[...listAdapters().map((a) => a.id)].join(', ')}`,
        })
        return
      }
    }
    // Beta-gate parity: if codex beta is forced off via env, refuse codex
    // selections too (consistency with /available-providers).
    if (providers.includes('codex') && isCodexBetaDisabled()) {
      res.status(400).json({
        error: 'Codex provider is currently disabled (SPECRAILS_CODEX_BETA=0). Unset or set to 1 to enable.',
      })
      return
    }
    if (providers.includes('gemini') && isGeminiBetaDisabled()) {
      res.status(400).json({
        error: 'Gemini provider is currently disabled (SPECRAILS_GEMINI_BETA=0). Unset or set to 1 to enable.',
      })
      return
    }

    const resolvedPath = path.resolve(projectPath)

    // Validate path exists
    if (!fs.existsSync(resolvedPath)) {
      res.status(400).json({ error: `Path does not exist: ${resolvedPath}` })
      return
    }

    const canonicalPath = canonicalizePath(resolvedPath)

    // LOW-04: Reject registration of system-critical directories
    if (!isPathSafe(canonicalPath)) {
      res.status(400).json({ error: 'Registering system directories is not allowed' })
      return
    }

    const derivedName = (name && typeof name === 'string' && name.trim())
      ? name.trim()
      : deriveProjectName(canonicalPath)
    // Dedup the slug against already-registered projects so two same-basename
    // repos don't collide on the projects.slug UNIQUE constraint (which would
    // surface as a misleading 409 for a brand-new PATH).
    const existingSlugs = new Set(listProjects(registry.desktopDb).map((p) => p.slug))
    const slug = allocateSlug(derivedName, existingSlugs)
    const id = randomUUID()
    const specrailsInstalled = hasSpecrails(canonicalPath)

    try {
      const ctx = registry.addProject({
        id,
        slug,
        name: derivedName,
        path: canonicalPath,
        provider: providers[0],
        providers,
      })
      broadcast({
        type: 'desktop.project_added',
        project: ctx.project,
        timestamp: new Date().toISOString(),
      })
      res.status(201).json({ project: ctx.project, has_specrails: specrailsInstalled })
    } catch (err) {
      const message = (err as Error).message ?? ''
      // SQLite UNIQUE constraint violation means path or slug already registered
      if (message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A project with this path is already registered' })
      } else {
        console.error('[desktop] add project error:', err)
        res.status(500).json({ error: 'Failed to register project' })
      }
    }
  })

  // DELETE /api/projects/:id — unregister a project
  router.delete('/projects/:id', (req, res) => {
    const { id } = req.params
    const ctx = registry.getContext(id)
    if (!ctx) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    registry.removeProject(id)
    broadcast({
      type: 'desktop.project_removed',
      projectId: id,
      timestamp: new Date().toISOString(),
    })
    res.json({ ok: true })
  })

  // GET /api/state — app-level state summary
  router.get('/state', (_req, res) => {
    const projects = listProjects(registry.desktopDb)
    const todayStats = getDesktopTodayStats(registry)
    res.json({
      projects,
      projectCount: projects.length,
      ...todayStats,
    })
  })

  // GET /api/analytics?period= — cross-project aggregated analytics
  router.get('/analytics', (req, res) => {
    const period = (req.query.period as AnalyticsPeriod | undefined) ?? '7d'
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const opts: AnalyticsOpts = { period, from, to }
    const result = getDesktopAnalytics(registry, opts)
    res.json(result)
  })

  // GET /api/recent-jobs?limit= — last N jobs across all projects
  router.get('/recent-jobs', (req, res) => {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '10', 10) || 10, 1), 50)
    const jobs = getDesktopRecentJobs(registry, limit)
    res.json({ jobs })
  })

  // GET /api/resolve?path=<cwd> — resolve a project from a filesystem path
  router.get('/resolve', (req, res) => {
    const queryPath = req.query.path as string | undefined
    if (!queryPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    const resolvedPath = canonicalizePath(path.resolve(queryPath))
    const ctx = registry.getContextByPath(resolvedPath)
    if (!ctx) {
      res.status(404).json({ error: 'No project registered for this path' })
      return
    }

    registry.touchProject(ctx.project.id)
    res.json({ project: ctx.project })
  })

  // GET /api/settings — get app-level settings
  router.get('/settings', (_req, res) => {
    const port = getDesktopSetting(registry.desktopDb, 'port') ?? '4200'
    const specrailsTechUrl =
      getDesktopSetting(registry.desktopDb, 'specrails_tech_url') ??
      process.env.SPECRAILS_TECH_URL ??
      'http://localhost:3000'
    const costAlertThresholdRaw = getDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd')
    const costAlertThresholdUsd = costAlertThresholdRaw != null ? parseFloat(costAlertThresholdRaw) : null
    res.json({ port: parseInt(port, 10), specrailsTechUrl, costAlertThresholdUsd })
  })

  // PUT /api/settings — update app-level settings
  router.put('/settings', (req, res) => {
    const { port, specrailsTechUrl, costAlertThresholdUsd } = req.body ?? {}
    if (port !== undefined) {
      const n = Number(port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        res.status(400).json({ error: 'port must be an integer between 1 and 65535' })
        return
      }
      setDesktopSetting(registry.desktopDb, 'port', String(n))
    }
    if (specrailsTechUrl !== undefined && typeof specrailsTechUrl === 'string') {
      const normalized = validateHttpUrl(specrailsTechUrl.trim(), {
        allowLoopback: true,
        requireHttps: false,
      })
      if (!normalized) {
        res.status(400).json({ error: 'specrailsTechUrl must be a valid http(s) URL' })
        return
      }
      setDesktopSetting(registry.desktopDb, 'specrails_tech_url', normalized)
    }
    if (costAlertThresholdUsd !== undefined) {
      if (costAlertThresholdUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('cost_alert_threshold_usd')
      } else if (typeof costAlertThresholdUsd === 'number' && costAlertThresholdUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd', String(costAlertThresholdUsd))
      }
    }
    res.json({ ok: true })
  })

  // ─── Budget routes ────────────────────────────────────────────────────────────

  // GET /api/budget — get app-level budget status
  router.get('/budget', (_req, res) => {
    const desktopDailyBudgetRaw = getDesktopSetting(registry.desktopDb, 'desktop_daily_budget_usd')
    const desktopDailyBudgetUsd = desktopDailyBudgetRaw != null ? parseFloat(desktopDailyBudgetRaw) : null
    const costAlertRaw = getDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd')
    const costAlertThresholdUsd = costAlertRaw != null ? parseFloat(costAlertRaw) : null
    const { costToday } = getDesktopTodayStats(registry)
    const budgetUtilizationPct = desktopDailyBudgetUsd != null && desktopDailyBudgetUsd > 0
      ? (costToday / desktopDailyBudgetUsd) * 100
      : null
    res.json({ desktopDailyBudgetUsd, costAlertThresholdUsd, costToday, budgetUtilizationPct })
  })

  // PATCH /api/budget — update app-level budget settings
  router.patch('/budget', (req, res) => {
    const { desktopDailyBudgetUsd, costAlertThresholdUsd } = req.body ?? {}
    if (desktopDailyBudgetUsd !== undefined) {
      if (desktopDailyBudgetUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('desktop_daily_budget_usd')
      } else if (typeof desktopDailyBudgetUsd === 'number' && desktopDailyBudgetUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'desktop_daily_budget_usd', String(desktopDailyBudgetUsd))
      }
    }
    if (costAlertThresholdUsd !== undefined) {
      if (costAlertThresholdUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('cost_alert_threshold_usd')
      } else if (typeof costAlertThresholdUsd === 'number' && costAlertThresholdUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd', String(costAlertThresholdUsd))
      }
    }
    res.json({ ok: true })
  })

  // ─── Agent routes ────────────────────────────────────────────────────────────

  // GET /api/agents — list all registered agents
  router.get('/agents', (_req, res) => {
    res.json({ agents: listAgents(registry.desktopDb) })
  })

  // GET /api/agents/:id — get agent by ID
  router.get('/agents/:id', (req, res) => {
    const agent = getAgent(registry.desktopDb, req.params.id)
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    res.json({ agent })
  })

  // POST /api/agents — register a new agent
  router.post('/agents', (req, res) => {
    const { slug, name, role, config } = req.body ?? {}
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'slug is required' })
      return
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const id = randomUUID()
    try {
      const agent = addAgent(registry.desktopDb, { id, slug, name, role, config })
      res.status(201).json({ agent })
    } catch (err) {
      const message = (err as Error).message ?? ''
      if (message.includes('UNIQUE')) {
        res.status(409).json({ error: 'An agent with this slug already exists' })
      } else {
        console.error('[desktop] add agent error:', err)
        res.status(500).json({ error: 'Failed to register agent' })
      }
    }
  })

  // PATCH /api/agents/:id — update agent fields
  router.patch('/agents/:id', (req, res) => {
    const agent = getAgent(registry.desktopDb, req.params.id)
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    const { name, role, status, current_job_id, last_heartbeat_at, config } = req.body ?? {}
    const updates: Parameters<typeof updateAgent>[2] = {}
    if (name !== undefined) updates.name = name
    if (role !== undefined) updates.role = role
    if (status !== undefined) updates.status = status
    if (current_job_id !== undefined) updates.current_job_id = current_job_id
    if (last_heartbeat_at !== undefined) updates.last_heartbeat_at = last_heartbeat_at
    if (config !== undefined) updates.config = config
    const updated = updateAgent(registry.desktopDb, req.params.id, updates)
    res.json({ agent: updated })
  })

  // GET /api/core-compat — compatibility status between the app and specrails-core
  router.get('/core-compat', async (_req, res) => {
    const result = await checkCoreCompat()
    res.json(result)
  })

  // GET /api/cli-status — detected AI CLI provider and version
  router.get('/cli-status', (_req, res) => {
    res.json(getCLIStatus())
  })


  // ─── specrails-tech proxy routes ────────────────────────────────────────────

  function getSpecrailsTechClient() {
    const url =
      getDesktopSetting(registry.desktopDb, 'specrails_tech_url') ??
      process.env.SPECRAILS_TECH_URL ??
      'http://localhost:3000'
    return createSpecrailsTechClient(url)
  }

  // GET /api/specrails-tech/status — health + connected flag
  router.get('/specrails-tech/status', async (_req, res) => {
    const client = getSpecrailsTechClient()
    const result = await client.health()
    if (!result.connected) {
      res.json({ connected: false, error: result.error })
      return
    }
    res.json({ connected: true, data: result.data })
  })

  // GET /api/specrails-tech/agents — list agents
  router.get('/specrails-tech/agents', async (_req, res) => {
    const client = getSpecrailsTechClient()
    const result = await client.listAgents()
    if (!result.connected) {
      res.json({ connected: false, error: result.error, data: [] })
      return
    }
    res.json({ connected: true, data: result.data })
  })

  // GET /api/specrails-tech/agents/:slug — agent detail
  router.get('/specrails-tech/agents/:slug', async (req, res) => {
    const client = getSpecrailsTechClient()
    const result = await client.getAgent(req.params.slug)
    if (!result.connected) {
      res.status(503).json({ connected: false, error: result.error })
      return
    }
    res.json({ connected: true, data: result.data })
  })

  // GET /api/specrails-tech/docs — list docs
  router.get('/specrails-tech/docs', async (_req, res) => {
    const client = getSpecrailsTechClient()
    const result = await client.listDocs()
    if (!result.connected) {
      res.json({ connected: false, error: result.error, data: [] })
      return
    }
    res.json({ connected: true, data: result.data })
  })

  // GET /api/specrails-tech/docs/:page — doc page detail
  router.get('/specrails-tech/docs/:page', async (req, res) => {
    const client = getSpecrailsTechClient()
    const result = await client.getDoc(req.params.page)
    if (!result.connected) {
      res.status(503).json({ connected: false, error: result.error })
      return
    }
    res.json({ connected: true, data: result.data })
  })

  // ─── Webhook routes ──────────────────────────────────────────────────────────

  const webhookManager = new WebhookManager(registry.desktopDb)

  // GET /api/webhooks — list all webhooks
  router.get('/webhooks', (_req, res) => {
    res.json({ webhooks: listWebhooks(registry.desktopDb).map(publicWebhook) })
  })

  // BUG-WEBHOOK-01: webhook destinations must not resolve to internal hosts.
  // `validateHttpUrl` blocks IP literals; this adds the DNS-resolution gate so a
  // public hostname that resolves to a loopback/private/link-local address is
  // rejected too. Skipped when loopback is explicitly allowed (dev opt-in).
  async function webhookHostAllowed(normalizedUrl: string): Promise<boolean> {
    if (process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1') return true
    let hostname: string
    try {
      hostname = new URL(normalizedUrl).hostname
    } catch {
      return false
    }
    return resolvesToPublicOnly(hostname)
  }

  // POST /api/webhooks — create a webhook
  router.post('/webhooks', async (req, res) => {
    const { url, secret, events, projectId } = req.body ?? {}
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' })
      return
    }

    const validEvents: WebhookEvent[] = ['job.completed', 'job.failed', 'job.canceled', 'daily_budget_exceeded', 'desktop_daily_budget_exceeded']
    const parsedEvents: WebhookEvent[] = Array.isArray(events)
      ? (events as string[]).filter((e): e is WebhookEvent => validEvents.includes(e as WebhookEvent))
      : ['job.completed', 'job.failed', 'job.canceled']

    if (parsedEvents.length === 0) {
      res.status(400).json({ error: 'at least one valid event is required' })
      return
    }

    if (projectId != null) {
      const ctx = registry.getContext(projectId)
      if (!ctx) {
        res.status(400).json({ error: 'project not found' })
        return
      }
    }

    const normalizedUrl = validateHttpUrl(url.trim(), {
      allowLoopback: process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1',
      requireHttps: true,
    })
    if (!normalizedUrl) {
      res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
      return
    }

    if (!(await webhookHostAllowed(normalizedUrl))) {
      res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
      return
    }

    const webhook = addWebhook(registry.desktopDb, {
      id: randomUUID(),
      projectId: projectId ?? null,
      url: normalizedUrl,
      secret: typeof secret === 'string' ? secret.trim() : '',
      events: parsedEvents,
    })
    res.status(201).json({ webhook: publicWebhook(webhook) })
  })

  // PATCH /api/webhooks/:id — update a webhook
  router.patch('/webhooks/:id', async (req, res) => {
    const existing = getWebhook(registry.desktopDb, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }

    const { url, secret, events, enabled } = req.body ?? {}
    const validEvents: WebhookEvent[] = ['job.completed', 'job.failed', 'job.canceled', 'daily_budget_exceeded', 'desktop_daily_budget_exceeded']
    const parsedEvents: WebhookEvent[] | undefined = Array.isArray(events)
      ? (events as string[]).filter((e): e is WebhookEvent => validEvents.includes(e as WebhookEvent))
      : undefined

    let normalizedUrl: string | undefined
    if (typeof url === 'string') {
      const candidate = validateHttpUrl(url.trim(), {
        allowLoopback: process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1',
        requireHttps: true,
      })
      if (!candidate) {
        res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
        return
      }
      if (!(await webhookHostAllowed(candidate))) {
        res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
        return
      }
      normalizedUrl = candidate
    }

    const updated = updateWebhook(registry.desktopDb, req.params.id, {
      url: normalizedUrl,
      secret: typeof secret === 'string' ? secret.trim() : undefined,
      events: parsedEvents,
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
    })
    res.json({ webhook: publicWebhook(updated) })
  })

  // DELETE /api/webhooks/:id — delete a webhook
  router.delete('/webhooks/:id', (req, res) => {
    const existing = getWebhook(registry.desktopDb, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }
    removeWebhook(registry.desktopDb, req.params.id)
    res.json({ ok: true })
  })

  // POST /api/webhooks/:id/test — send a test ping
  router.post('/webhooks/:id/test', (req, res) => {
    const webhook = getWebhook(registry.desktopDb, req.params.id)
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }
    webhookManager.deliverTest(webhook)
    res.json({ ok: true, message: 'Test ping queued' })
  })

  // GET /api/terminal-settings — Desktop-wide terminal defaults
  router.get('/terminal-settings', (_req, res) => {
    res.json(getDesktopTerminalSettings(registry.desktopDb))
  })

  // PATCH /api/terminal-settings — partial update of Desktop-wide defaults
  router.patch('/terminal-settings', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    try {
      const updated = patchDesktopTerminalSettings(registry.desktopDb, req.body as Record<string, unknown>)
      res.json(updated)
    } catch (err) {
      if (err instanceof TerminalSettingsValidationError) {
        res.status(400).json({ error: 'validation_failed', field: err.field, message: err.message })
        return
      }
      throw err
    }
  })

  // ─── Theme (app-wide UI theme) ────────────────────────────────────────────
  // Allow-list synchronized with `client/src/lib/themes.ts THEME_IDS`.
  // Persisted under desktop_settings key `ui_theme`. Default seeded by migration 8.
  router.get('/theme', (_req, res) => {
    const stored = getDesktopSetting(registry.desktopDb, 'ui_theme')
    const theme = stored && THEME_ID_ALLOWLIST.has(stored) ? stored : 'specrails'
    res.json({ theme })
  })

  router.patch('/theme', (req, res) => {
    const next = (req.body as { theme?: unknown } | undefined)?.theme
    if (typeof next !== 'string' || !THEME_ID_ALLOWLIST.has(next)) {
      res.status(400).json({
        error: 'invalid_theme',
        message: `theme must be one of: ${[...THEME_ID_ALLOWLIST].join(', ')}`,
      })
      return
    }
    setDesktopSetting(registry.desktopDb, 'ui_theme', next)
    res.json({ theme: next })
  })

  // ─── Language (app-wide UI language) ──────────────────────────────────────
  // Allow-list synchronized with `client/src/lib/i18n.ts LANGUAGE_IDS`.
  // Persisted under desktop_settings key `ui_language`. No default is seeded:
  // `language: null` means "user never chose" and the client keeps following
  // the OS/browser language until an explicit choice is PATCHed.
  router.get('/language', (_req, res) => {
    const stored = getDesktopSetting(registry.desktopDb, 'ui_language')
    const language = stored && LANGUAGE_ID_ALLOWLIST.has(stored) ? stored : null
    res.json({ language })
  })

  router.patch('/language', (req, res) => {
    const next = (req.body as { language?: unknown } | undefined)?.language
    if (typeof next !== 'string' || !LANGUAGE_ID_ALLOWLIST.has(next)) {
      res.status(400).json({
        error: 'invalid_language',
        message: `language must be one of: ${[...LANGUAGE_ID_ALLOWLIST].join(', ')}`,
      })
      return
    }
    setDesktopSetting(registry.desktopDb, 'ui_language', next)
    res.json({ language: next })
  })

  // ─── Code Explorer settings (summary language + monthly budget) ───────────
  router.get('/code-explorer-settings', (_req, res) => {
    const langRaw = getDesktopSetting(registry.desktopDb, 'summary_language')
    const language = langRaw === 'es' ? 'es' : 'en'
    const budgetRaw = getDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd')
    const parsed = budgetRaw !== undefined ? Number(budgetRaw) : NaN
    const monthlyBudgetUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5.0
    res.json({ language, monthlyBudgetUsd })
  })

  router.patch('/code-explorer-settings', (req, res) => {
    const body = (req.body ?? {}) as { language?: unknown; monthlyBudgetUsd?: unknown }
    if (body.language !== undefined) {
      if (body.language !== 'en' && body.language !== 'es') {
        res.status(400).json({
          error: 'invalid_language',
          message: "language must be one of: 'en', 'es'",
        })
        return
      }
    }
    if (body.monthlyBudgetUsd !== undefined) {
      if (typeof body.monthlyBudgetUsd !== 'number' || !Number.isFinite(body.monthlyBudgetUsd) || body.monthlyBudgetUsd < 0) {
        res.status(400).json({
          error: 'invalid_monthly_budget_usd',
          message: 'monthlyBudgetUsd must be a non-negative number',
        })
        return
      }
    }
    if (body.language !== undefined) {
      setDesktopSetting(registry.desktopDb, 'summary_language', body.language as string)
    }
    if (body.monthlyBudgetUsd !== undefined) {
      setDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd', String(body.monthlyBudgetUsd))
    }
    const langRaw = getDesktopSetting(registry.desktopDb, 'summary_language')
    const language = langRaw === 'es' ? 'es' : 'en'
    const budgetRaw = getDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd')
    const parsed = budgetRaw !== undefined ? Number(budgetRaw) : NaN
    const monthlyBudgetUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5.0
    res.json({ language, monthlyBudgetUsd })
  })

  // ─── specrails-core update channel (app-global) ─────────────────────────────
  // Detect + apply a specrails-core framework update independently of the desktop
  // app update. See server/core-update-manager.ts. A single manager instance
  // persists for the router lifetime (holds the cached latest + in-progress flag).
  const coreUpdate = new CoreUpdateManager({
    // `core_update.progress` / `framework.updated` are app-level (no projectId)
    // and not members of the WsMessage union; cast at this single boundary.
    broadcast: (msg) => broadcast(msg as unknown as WsMessage),
    providers: () => registry.installedProvidersUnion(),
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
    void coreUpdate.update(target)
  })

  return router
}
