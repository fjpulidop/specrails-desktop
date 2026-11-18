/**
 * App-level provider detection routes: `/providers/detected`,
 * `/available-providers`, `/setup-prerequisites`, `/core-compat` and
 * `/cli-status`.
 *
 * Owns provider CLI readiness probing (shared with project registration), the
 * memoized `/available-providers` probes and the lazy per-provider workspace
 * assembly that runs when the usable provider set grows. Provider presence is a
 * machine property; nothing here reads project data.
 */
import type { Router } from 'express'
import path from 'path'
import fs from 'fs'
import type { ProjectRegistry } from './project-registry'
import type { WsMessage } from './types'
import { checkCoreCompat, coreCompatSupportsProvider, getCLIStatus, detectAvailableCLIsAsync } from './core-compat'
import { getAdapter, hasAdapter, listAdapters } from './providers'
import {
  getDetectionSnapshot,
  getSnapshotSync,
  refreshDetection,
  detectionGeneration,
  isCodexBetaDisabled,
  isGeminiBetaDisabled,
} from './provider-detection'
import { createAsyncMemo } from './util/async-memo'
import { isLocalAdapter } from './providers/local-adapter'
import { workspacePathFor } from './workspace-manager'
import { isWorkspacePopulated } from './workspace-resolution'
import type { DetectionResult, ProviderAdapter } from './providers/types'
import { getSetupPrerequisitesStatus } from './setup-prerequisites'
import { getPathDiagnostic } from './path-resolver'

// Beta kill switches live with the app-level detection singleton now
// (provider-detection.ts) so detection and route gating can never disagree.
// Re-imported here under the original names.

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

export async function detectProviderReadiness(
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

/** Machine-level PATH + Kimi readiness probes behind /available-providers. */
interface AvailableProviderProbes {
  clis: Record<string, boolean>
  kimiIssue: { code: string; message: string } | null
}

async function probeAvailableProviders(): Promise<AvailableProviderProbes> {
  const clis = await detectAvailableCLIsAsync()
  let kimiIssue: AvailableProviderProbes['kimiIssue'] = null
  if (clis.kimi) {
    const readiness = await detectProviderReadiness(getAdapter('kimi'))
    if (readiness.issue) kimiIssue = readiness.issue
    else if (!coreCompatSupportsProvider(await checkCoreCompat(), 'kimi')) {
      kimiIssue = {
        code: 'core_provider_unsupported',
        message:
          'This Specrails Core build cannot render Kimi skills. Update or reinstall Specrails, then retry.',
      }
    }
  }
  return { clis, kimiIssue }
}

/**
 * Provider presence is a machine property (no project data), probed by
 * spawning `which` and `kimi --version`. Every Board/rail card asks for it, so
 * the probes are shared by concurrent requests and reused for the detection
 * cache's lifetime; an explicit re-detect (new detection generation) or the
 * TTL forces a new probe.
 */
export const AVAILABLE_PROVIDERS_TTL_MS = 60_000
const availableProviderProbes = createAsyncMemo<number, AvailableProviderProbes>({ ttlMs: AVAILABLE_PROVIDERS_TTL_MS, maxEntries: 2 })
/** Test seam: forget cached /available-providers probes. */
export function _resetAvailableProvidersCacheForTests(): void { availableProviderProbes.invalidate() }

/** The assembler shared by project registration and an explicit provider re-detect. */
export function createNewlyDetectedAssembler(registry: ProjectRegistry): (detected: string[]) => void {
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
  return assembleNewlyDetected
}

export function registerProviderRoutes(router: Router, deps: {
  broadcast: (msg: WsMessage) => void
  assembleNewlyDetected: (detected: string[]) => void
}): void {
  const { broadcast, assembleNewlyDetected } = deps
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
    const probes = await availableProviderProbes.get(detectionGeneration(), probeAvailableProviders)
    // Return the full detected map (registry-driven) so a newly-registered
    // provider surfaces here with no edit. Apply per-provider beta gates: codex
    // is forced unavailable when SPECRAILS_CODEX_BETA=0 (emergency rollback).
    const gated: Record<string, boolean> = { ...probes.clis }
    // Local (OpenAI-compatible) engines have no CLI to `which`: their binary is
    // the bundled node, so the PATH probe above always says "installed" even
    // when the endpoint is down. Their availability is the bounded HTTP probe
    // from the detection cycle (awaited only when no cycle has completed yet,
    // so a first call after boot is not blind); an id the snapshot does not
    // know stays unavailable. An expired snapshot answers now and refreshes in
    // the background: an unreachable endpoint's probe takes up to 8 s, which
    // would otherwise stall every Board render once a minute.
    const localIds = listAdapters().filter(isLocalAdapter).map((adapter) => adapter.id)
    if (localIds.length > 0) {
      const previous = getSnapshotSync()
      const snapshot = previous ?? await getDetectionSnapshot()
      if (previous) void getDetectionSnapshot().catch(() => { /* next request retries */ })
      for (const id of localIds) gated[id] = snapshot.providers[id]?.usable === true
    }
    if (isCodexBetaDisabled()) gated.codex = false
    // Gemini: enabled by default; forced unavailable only when
    // SPECRAILS_GEMINI_BETA=0 (emergency rollback, parity with codex).
    if (isGeminiBetaDisabled()) gated.gemini = false
    const providerIssues: Record<string, { code: string; message: string }> = {}
    if (gated.kimi && probes.kimiIssue) {
      gated.kimi = false
      providerIssues.kimi = probes.kimiIssue
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
    // Display names so app-level selectors (Agent composer, Builder) can label
    // a local engine with its connection label instead of its raw id.
    const labels = Object.fromEntries(listAdapters().map((adapter) => [adapter.id, adapter.displayName]))
    res.json({ ...gated, tiers, providerIssues, launchDescriptors, labels })
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

  // GET /api/core-compat — compatibility status between the app and specrails-core
  router.get('/core-compat', async (_req, res) => {
    const result = await checkCoreCompat()
    res.json(result)
  })

  // GET /api/cli-status — detected AI CLI provider and version
  router.get('/cli-status', async (_req, res) => {
    try {
      res.json(await getCLIStatus())
    } catch (err) {
      console.error('[cli-status] probe failed:', err)
      res.json({ provider: null, version: null })
    }
  })
}
