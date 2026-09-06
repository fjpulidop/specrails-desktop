import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import net from 'net'
import dns from 'dns'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { RepositoryValidationError, inspectRepositoryPath, assertDistinctRepositories, getProjectRepositories, resolveRepositoryProject, type ProjectRepositoryInput } from './project-repositories'
import { getDesktopSetting, setDesktopSetting, listProjects, listAgents, getAgent, addAgent, updateAgent, listWebhooks, getWebhook, addWebhook, updateWebhook, removeWebhook, getProjectSetupSession } from './desktop-db'
import type { WebhookEvent } from './desktop-db'
import { WebhookManager } from './webhook-manager'
import { CoreUpdateManager } from './core-update-manager'
import { reseedStaleWorkspaces } from './framework-reseed'
import { createSpecrailsTechClient } from './specrails-tech-client'
import {
  checkCoreCompat,
  coreCompatSupportsProvider,
  getCLIStatus,
  detectAvailableCLIs,
} from './core-compat'
import { getAdapter, hasAdapter, listAdapters } from './providers'
import {
  getDetectionSnapshot,
  getDetectedIdsSync,
  refreshDetection,
  isCodexBetaDisabled,
  isGeminiBetaDisabled,
} from './provider-detection'
import {
  AgentDefaultsValidationError,
  applyAgentDefaultsPatch,
  buildAgentDefaultsCatalog,
  readAgentDefaultsSettings,
} from './agent-defaults'
import {
  ExternalMcpValidationError,
  applyExternalMcpPatch,
  discoverExternalMcp,
  readExternalMcpSettings,
} from './external-mcp'
import { workspacePathFor } from './workspace-manager'
import { isWorkspacePopulated } from './workspace-resolution'
import type { DetectionResult, ProviderAdapter } from './providers/types'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './desktop-analytics'
import { getSetupPrerequisitesStatus } from './setup-prerequisites'
import { getPathDiagnostic } from './path-resolver'
import {
  getDesktopTerminalSettings,
  patchDesktopTerminalSettings,
  TerminalSettingsValidationError,
} from './terminal-settings'
import type { AnalyticsOpts, AnalyticsPeriod } from './types'
import { registerLoopsRoutes } from './loops-router'
import { countRunningForLoop } from './loop-runs-store'

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

// Beta kill switches live with the app-level detection singleton now
// (provider-detection.ts) so detection and route gating can never disagree.
// Re-imported here under the original names.

// Theme allow-list. Mirror of THEME_IDS in `client/src/lib/themes.ts` —
// kept duplicated to avoid pulling client code into the server bundle.
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'specrails', 'galaxy'])
const LEGACY_THEME_ID_MAP: Record<string, string> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}

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

function hasProviderSkillFiles(dir: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, entry, 'SKILL.md'))) return true
      if (entry === 'rails') {
        for (const role of fs.readdirSync(path.join(dir, entry))) {
          if (fs.existsSync(path.join(dir, entry, role, 'SKILL.md'))) return true
        }
      }
    }
  } catch {
    return false
  }
  return false
}

function hasSpecrails(projectPath: string): boolean {
  return hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'sr'))
    || hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'specrails'))
    || hasProviderSkillFiles(path.join(projectPath, '.kimi-code', 'skills'))
}

interface ProviderReadinessIssue {
  code: 'provider_cli_missing' | 'provider_cli_unusable' | 'provider_cli_outdated'
  message: string
}

function readinessIssue(
  adapter: ProviderAdapter,
  detection: DetectionResult,
): ProviderReadinessIssue | null {
  if (!detection.installed) {
    return {
      code: 'provider_cli_missing',
      message: `${adapter.displayName} CLI was not found on PATH. Install it, authenticate, then restart Specrails.`,
    }
  }
  if (!detection.executable) {
    return {
      code: 'provider_cli_unusable',
      message:
        detection.error
        ?? `${adapter.displayName} was found but its executable readiness probe failed. Reinstall it, authenticate, then restart Specrails.`,
    }
  }
  // An adapter with a pinned floor is usable only when the probe positively
  // verifies that floor. Treat an unparseable/unknown version as incompatible;
  // otherwise the UI could advertise a binary that cannot honour our contract.
  if (adapter.minCliVersion && detection.meetsMinimum !== true) {
    return {
      code: 'provider_cli_outdated',
      message:
        detection.error
        ?? `${adapter.displayName} ${detection.version ?? '(unknown version)'} does not satisfy the required minimum ${adapter.minCliVersion}.`,
    }
  }
  return null
}

async function detectProviderReadiness(
  adapter: ProviderAdapter,
): Promise<{ detection: DetectionResult; issue: ProviderReadinessIssue | null }> {
  try {
    const detection = await adapter.detectInstalled()
    return { detection, issue: readinessIssue(adapter, detection) }
  } catch (err) {
    const detection: DetectionResult = {
      installed: false,
      executable: false,
      error: err instanceof Error ? err.message : String(err),
    }
    return {
      detection,
      issue: {
        code: 'provider_cli_unusable',
        message: `${adapter.displayName} readiness probe failed: ${detection.error}`,
      },
    }
  }
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

  // Loops (global, cross-project library) — /api/loops*. Registered here so the
  // routes live on the global `/api` router (loops are NOT project-scoped). The
  // A loop is "running" iff any project's per-project DB has an in-flight
  // loop_run for it — so edit/unpublish/delete are blocked (409) while it runs.
  registerLoopsRoutes(router, {
    db: registry.desktopDb,
    isLoopRunning: (loopId) =>
      registry.listContexts().some((c) => countRunningForLoop(c.db, loopId) > 0),
  })

  // Lazy per-provider workspace assembly (provider-auto-detection spec): when
  // the usable set gains a provider, every RELOCATED project whose workspace
  // lacks that provider's surface assembles it in the background — installing
  // codex on Tuesday makes it usable everywhere without user action.
  function assembleNewlyDetected(detected: string[]): void {
    for (const ctx of registry.listContexts()) {
      try {
        const workspace = workspacePathFor(ctx.project.slug)
        if (!isWorkspacePopulated(workspace)) continue // legacy → migration owns it
        const missing = detected.filter((p) => {
          try {
            return hasAdapter(p) && !fs.existsSync(path.join(workspace, getAdapter(p).projectDirName))
          } catch {
            return false
          }
        })
        if (missing.length === 0) continue
        ctx.setupManager.startSilentAssemble(
          ctx.project.id, ctx.project.path, ctx.project.slug, missing,
        )
      } catch (err) {
        console.warn(`[desktop] lazy assemble check failed for ${ctx.project.id} (non-fatal):`, err)
      }
    }
  }

  // GET /api/projects — list all registered projects. The old wizard-restore
  // `setupProjectIds` field is retired (silent-project-add): kept as an empty
  // array for wire compat with clients that still destructure it.
  router.get('/projects', (_req, res) => {
    res.json({ projects: listProjects(registry.desktopDb), setupProjectIds: [] })
  })

  // GET /api/providers/detected — the app-level detection snapshot (machine
  // property, not project property). `?refresh=1` bypasses the 60s cache; a
  // changed usable set broadcasts `providers.detected_changed` app-globally.
  router.get('/providers/detected', async (req, res) => {
    try {
      if (req.query.refresh === '1') {
        const { snapshot, changed } = await refreshDetection()
        if (changed) {
          broadcast({
            type: 'providers.detected_changed',
            detected: snapshot.detected,
            providers: snapshot.providers,
            timestamp: new Date().toISOString(),
          } as unknown as WsMessage)
          assembleNewlyDetected(snapshot.detected)
        }
        res.json(snapshot)
        return
      }
      res.json(await getDetectionSnapshot())
    } catch (err) {
      console.error('[provider-detection] snapshot error:', err)
      res.status(500).json({ error: 'provider detection failed' })
    }
  })

  // GET /api/available-providers — which AI CLIs are installed, plus supported install tiers
  //
  // Codex (OpenAI) is supported as a first-class provider as of Stage C of
  // the multi-provider work. The `SPECRAILS_CODEX_BETA=0` env var is honoured
  // as an emergency rollback (forces codex back to "unavailable" in the UI
  // without redeploying) — unset or `1` reports the real detection.
  router.get('/available-providers', async (_req, res) => {
    const providers = detectAvailableCLIs()
    // Return the full detected map (registry-driven) so a newly-registered
    // provider surfaces here with no edit. Apply per-provider beta gates: codex
    // is forced unavailable when SPECRAILS_CODEX_BETA=0 (emergency rollback).
    const gated: Record<string, boolean> = { ...providers }
    if (isCodexBetaDisabled()) gated.codex = false
    // Gemini: enabled by default; forced unavailable only when
    // SPECRAILS_GEMINI_BETA=0 (emergency rollback, parity with codex).
    if (isGeminiBetaDisabled()) gated.gemini = false
    const providerIssues: Record<string, { code: string; message: string }> = {}
    if (gated.kimi) {
      const readiness = await detectProviderReadiness(getAdapter('kimi'))
      if (readiness.issue) {
        gated.kimi = false
        providerIssues.kimi = readiness.issue
      } else {
        const core = await checkCoreCompat()
        if (!coreCompatSupportsProvider(core, 'kimi')) {
          gated.kimi = false
          providerIssues.kimi = {
            code: 'core_provider_unsupported',
            message:
              'This Specrails Core build cannot render Kimi skills. Update or reinstall Specrails, then retry.',
          }
        }
      }
    }
    // tiers: quick install is always available (app-driven config); full
    // requires a CLI that also survives provider-specific compatibility gates.
    const tiers: ('quick' | 'full')[] = ['quick']
    if (Object.values(gated).some(Boolean)) tiers.push('full')
    const launchDescriptors = Object.fromEntries(
      listAdapters().map((adapter) => [
        adapter.id,
        { command: adapter.binary, args: [] as string[] },
      ]),
    )
    res.json({ ...gated, tiers, providerIssues, launchDescriptors })
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
  router.post('/projects', async (req, res) => {
    const { path: projectPath, name, provider, providers: providersRaw, repositories: repositoriesRaw } = req.body ?? {}
    if (!projectPath || typeof projectPath !== 'string') {
      res.status(400).json({ error: 'path is required' })
      return
    }
    // Project registration is a detection refresh trigger (spec:
    // provider-auto-detection). The refresh runs in the BACKGROUND so
    // registration latency never pays for CLI probes; the defaulting below uses
    // the last cached snapshot (null before the first startup detection).
    refreshDetection()
      .then(({ snapshot, changed }) => {
        if (!changed) return
        broadcast({
          type: 'providers.detected_changed',
          detected: snapshot.detected,
          providers: snapshot.providers,
          timestamp: new Date().toISOString(),
        } as unknown as WsMessage)
        assembleNewlyDetected(snapshot.detected)
      })
      .catch(() => { /* detection failure never blocks registration */ })
    const detectedNow: string[] = getDetectedIdsSync() ?? []
    // Normalise to a providers list. Wire compat: `providers`/`provider` are
    // still accepted and recorded, but the DETECTED set is authoritative for
    // what the project offers (delta spec: multi-provider-architecture).
    // Omitting both registers with the detected set.
    let providers: string[]
    if (Array.isArray(providersRaw) && providersRaw.length > 0) {
      providers = providersRaw
    } else if (typeof provider === 'string') {
      providers = [provider]
    } else {
      providers = detectedNow.length > 0 ? [...detectedNow] : ['claude']
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
    if (providers.includes('kimi')) {
      const readiness = await detectProviderReadiness(getAdapter('kimi'))
      if (readiness.issue) {
        res.status(409).json({
          code: readiness.issue.code,
          provider: 'kimi',
          error: readiness.issue.message,
          detection: readiness.detection,
        })
        return
      }
      const core = await checkCoreCompat()
      if (!coreCompatSupportsProvider(core, 'kimi')) {
        res.status(409).json({
          code: 'core_provider_unsupported',
          provider: 'kimi',
          error:
            'This Specrails Core build cannot render Kimi skills. Update or reinstall Specrails, then retry.',
        })
        return
      }
    }

    const resolvedPath = path.resolve(projectPath)

    // Validate path exists
    if (!fs.existsSync(resolvedPath)) {
      res.status(400).json({ error: `Path does not exist: ${resolvedPath}` })
      return
    }

    const canonicalPath = canonicalizePath(resolvedPath)
    let repositories: ProjectRepositoryInput[] = []
    try {
      if (repositoriesRaw !== undefined && !Array.isArray(repositoriesRaw)) throw new RepositoryValidationError('repositories must be an array')
      repositories = (repositoriesRaw ?? []).map((input: ProjectRepositoryInput) => inspectRepositoryPath(input))
      const primary = inspectRepositoryPath({ path: canonicalPath })
      assertDistinctRepositories([primary, ...repositories.map((input) => inspectRepositoryPath(input))])
      if (repositories.some((repository) => !isPathSafe(repository.path))) throw new RepositoryValidationError('Registering system directories is not allowed')
    } catch (err) {
      if (err instanceof RepositoryValidationError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
      throw err
    }

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
        repositories,
      })
      broadcast({
        type: 'desktop.project_added',
        project: ctx.project,
        timestamp: new Date().toISOString(),
      })
      // Silent add (global-core-zero-friction): registration is already done —
      // assemble the relocated workspace in the BACKGROUND for every detected
      // provider. Never blocks or rolls back registration. Skipped when the
      // workspace is already populated (re-register of a relocated repo).
      try {
        const workspace = workspacePathFor(slug)
        const effectiveProviders = detectedNow.length > 0 ? detectedNow : providers
        if (!isWorkspacePopulated(workspace)) {
          ctx.setupManager.startSilentAssemble(id, canonicalPath, slug, effectiveProviders)
        }
      } catch (err) {
        console.warn('[desktop] silent assemble launch failed (non-fatal):', err)
      }
      res.status(201).json({ project: ctx.project, has_specrails: specrailsInstalled })
    } catch (err) {
      const message = (err as Error).message ?? ''
      // SQLite UNIQUE constraint violation means path or slug already registered
      if (err instanceof RepositoryValidationError) {
        res.status(err.status).json({ error: err.message, code: err.code, details: err.details })
      } else if (message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A project with this path is already registered' })
      } else {
        console.error('[desktop] add project error:', err)
        res.status(500).json({ error: 'Failed to register project' })
      }
    }
  })

  // The logical project keeps one backlog; these routes only edit membership.
  const sendRepositoryError = (err: unknown, res: import('express').Response): void => {
    if (err instanceof RepositoryValidationError) res.status(err.status).json({ error: err.message, code: err.code, details: err.details })
    else { console.error('[desktop] repository operation failed:', err); res.status(500).json({ error: 'Could not update project repositories' }) }
  }
  const broadcastRepositories = (): void => broadcast({ type: 'desktop.projects', projects: listProjects(registry.desktopDb), timestamp: new Date().toISOString() })
  router.get('/projects/:projectId/repositories', (req, res) => {
    const project = listProjects(registry.desktopDb).find((item) => item.id === req.params.projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }
    res.json({ repositories: getProjectRepositories(project), primaryRepositoryId: project.primaryRepositoryId })
  })
  router.post('/projects/:projectId/repositories', (req, res) => {
    try {
      const input = inspectRepositoryPath(req.body)
      if (!isPathSafe(input.path)) throw new RepositoryValidationError('Registering system directories is not allowed')
      const repository = registry.addRepository(req.params.projectId as string, input)
      broadcastRepositories()
      res.status(201).json({ repository, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })
  router.patch('/projects/:projectId/repositories/:repositoryId', (req, res) => {
    try {
      const body = req.body ?? {}
      const input: Partial<ProjectRepositoryInput> = {}
      for (const key of ['path', 'name', 'integrationBranch'] as const) if (Object.prototype.hasOwnProperty.call(body, key)) Object.assign(input, { [key]: body[key] })
      if (input.path !== undefined) {
        const inspected = inspectRepositoryPath(input as ProjectRepositoryInput)
        if (!isPathSafe(inspected.path)) throw new RepositoryValidationError('Registering system directories is not allowed')
        input.path = inspected.path
      }
      const repository = registry.updateRepository(req.params.projectId as string, req.params.repositoryId as string, input)
      broadcastRepositories()
      res.json({ repository, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })
  router.delete('/projects/:projectId/repositories/:repositoryId', (req, res) => {
    try {
      registry.removeRepository(req.params.projectId as string, req.params.repositoryId as string)
      broadcastRepositories()
      res.json({ ok: true, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })

  // POST /api/projects/:id/assemble-retry — re-run the silent workspace
  // assemble for the providers that failed (or every detected provider when
  // nothing is recorded as failed). 202; progress rides project.assemble_progress.
  router.post('/projects/:id/assemble-retry', async (req, res) => {
    const ctx = registry.getContext(req.params.id)
    if (!ctx) {
      res.status(404).json({ error: 'unknown project' })
      return
    }
    const state = ctx.setupManager.silentAssembleState(ctx.project.id)
    if (state.running) {
      res.status(202).json({ alreadyRunning: true })
      return
    }
    let providers = state.failed
    if (providers.length === 0) {
      try {
        providers = (await getDetectionSnapshot()).detected
      } catch {
        providers = []
      }
    }
    if (providers.length === 0) {
      res.status(409).json({ error: 'no providers detected to assemble' })
      return
    }
    ctx.setupManager.startSilentAssemble(ctx.project.id, ctx.project.path, ctx.project.slug, providers)
    res.status(202).json({ retrying: providers })
  })

  // DELETE /api/projects/:id — unregister a project
  router.delete('/projects/:id', (req, res) => {
    const { id } = req.params
    if (!registry.getProjectRow(id)) {
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

    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
      const project = resolveRepositoryProject(listProjects(registry.desktopDb), queryPath, projectId)
      if (!project) { res.status(404).json({ error: 'No project registered for this path' }); return }
      const context = registry.getContext(project.id)
      if (!context) { res.status(503).json({ error: 'Project is registered but unavailable', code: 'project_unavailable', project }); return }
      registry.touchProject(project.id)
      res.json({ project: context.project })
    } catch (err) { sendRepositoryError(err, res) }
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
    const { costToday, pricedRuns, unpricedRuns } = getDesktopTodayStats(registry)
    const budgetUtilizationPct =
      desktopDailyBudgetUsd != null && desktopDailyBudgetUsd > 0 && unpricedRuns === 0
      ? (costToday / desktopDailyBudgetUsd) * 100
      : null
    res.json({
      desktopDailyBudgetUsd,
      costAlertThresholdUsd,
      costToday,
      pricedRuns,
      unpricedRuns,
      budgetUtilizationPct,
    })
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
    const migrated = stored ? LEGACY_THEME_ID_MAP[stored] : undefined
    const theme = migrated ?? (stored && THEME_ID_ALLOWLIST.has(stored) ? stored : 'specrails')
    if (migrated) setDesktopSetting(registry.desktopDb, 'ui_theme', migrated)
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

  // ─── Specrails Agents defaults (global per-provider agent model/effort) ───
  // App-level layer read AT SPAWN TIME by QueueManager / rails-router / loop
  // executors — a change applies to the next run with zero restart.
  router.get('/agent-defaults', (_req, res) => {
    res.json({
      settings: readAgentDefaultsSettings(registry.desktopDb),
      catalog: buildAgentDefaultsCatalog(),
    })
  })

  router.patch('/agent-defaults', (req, res) => {
    try {
      const settings = applyAgentDefaultsPatch(registry.desktopDb, req.body)
      res.json({ settings, catalog: buildAgentDefaultsCatalog() })
    } catch (err) {
      if (err instanceof AgentDefaultsValidationError) {
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      res.status(500).json({ error: 'agent_defaults_failed', message: (err as Error).message })
    }
  })

  // ─── External MCP servers (mission agent, app-global) ─────────────────────
  // Registry of the user's OWN MCP servers for mission spawns. Discovery reads
  // provider native configs per request (cheap file reads, read-only); entries
  // resolve at spawn time, so a PATCH applies to the next turn with no restart.
  router.get('/external-mcp', (_req, res) => {
    const settings = readExternalMcpSettings(registry.desktopDb)
    res.json({ discovered: discoverExternalMcp(settings), settings })
  })

  router.patch('/external-mcp', (req, res) => {
    try {
      const settings = applyExternalMcpPatch(registry.desktopDb, req.body)
      res.json({ discovered: discoverExternalMcp(settings), settings })
    } catch (err) {
      if (err instanceof ExternalMcpValidationError) {
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      res.status(500).json({ error: 'external_mcp_failed', message: (err as Error).message })
    }
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
    reseed: version => reseedStaleWorkspaces(registry.listContexts().map(context => ({
      id: context.project.id,
      slug: context.project.slug,
      path: context.project.path,
    })), version),
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
