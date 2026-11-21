// Spawn environment construction for a queue job (stage of
// QueueManager._startJob): the project agent base env, telemetry, profile path,
// repo map, plugin resolution/snapshot and the plugin telemetry overlay.
// Ordering of overlays is part of the contract (later spreads win).
import type { WsMessage } from '../../../types'
import type { DbInstance } from '../../../db'
import { getProjectSettings } from '../../../db'
import type { ProviderAdapter, ProviderId } from '../../../providers'
import { providerEnvAllowlist } from '../../../providers/runtime'
import type { ProjectExecution } from '../../../workspace-resolution'
import { resolveProjectAgentEnv, worktreeEnvPassthroughWarning } from '../../../project-env'
import { readCurrentFrameworkVersion } from '../../../framework-manager'
import { injectRepoMapEnv } from '../../../repo-map'
import { buildTelemetryEnv } from '../../../providers/telemetry-env'
import { headlessJobEnv } from '../../../util/headless-env'

export interface BaseJobSpawnEnv {
  spawnEnv: NodeJS.ProcessEnv
  /** One value-free line naming unresolved configured passthrough names. */
  environmentNotice: string | null
  telemetryEnabled: boolean
  frameworkVersion: string | null
}

export interface BaseJobSpawnEnvInput {
  adapter: ProviderAdapter
  execution: ProjectExecution
  jobId: string
  db: DbInstance | null
  projectId: string | null
  desktopPort: number
  profileName: string | null
  profileSnapshotPath: string | null
}

export function buildBaseJobSpawnEnv(input: BaseJobSpawnEnvInput): BaseJobSpawnEnv {
  const { adapter, execution, jobId, db, projectId, profileName, profileSnapshotPath } = input
  // Read pipelineTelemetryEnabled at spawn time (not constructor time) so
  // toggling the setting takes effect on the next job without restarting.
  // OTEL env injection is gated on `adapter.capabilities.nativeOtelEnv`:
  // claude honours OTEL_* env vars natively; codex does not and instead
  // gets signals synthesised by the codex-otel-bridge attached below.
  let spawnEnv: NodeJS.ProcessEnv = process.env
  // Per-project agent environment: the passthrough overlay (names stored,
  // values read at spawn time with login-shell recovery) and, in `minimal`
  // mode, the allowlist filter. Apply this before Specrails' own env overlays
  // so internal SPECRAILS_* control-plane values always win.
  let environmentNotice: string | null = null
  if (db) {
    spawnEnv = resolveProjectAgentEnv(db, { providerAllowlist: providerEnvAllowlist(adapter) })
    // One value-free line naming unresolved configured names (written to the
    // job log once the readers exist). The run proceeds without them.
    environmentNotice = worktreeEnvPassthroughWarning(db, spawnEnv)
  }
  const telemetryEnabled = !!(projectId && db && getProjectSettings(db).pipelineTelemetryEnabled)
  // Resolve the framework version ONCE at spawn time — `framework/current`
  // is read from `~/.specrails/framework/current`. A concurrent atomic swap
  // (FrameworkManager.swapCurrent) does not disturb this job: we captured the
  // version here and the per-job snapshot resolved its handles from this
  // value. GATED on `execution.relocated`: a LEGACY (in-repo) job does NOT
  // assemble from `framework/current`, so stamping it with a sibling project's
  // materialized framework version would be wrong telemetry. Null otherwise.
  const frameworkVersion = execution.relocated ? readCurrentFrameworkVersion() : null
  if (telemetryEnabled && adapter.capabilities.nativeOtelEnv && projectId) {
    const extra: Record<string, string> = {}
    if (profileName) extra['specrails.profile_name'] = profileName
    if (profileName) extra['specrails.profile_schema_version'] = '1'
    if (frameworkVersion) extra['specrails.framework_version'] = frameworkVersion
    spawnEnv = {
      ...spawnEnv,
      ...buildTelemetryEnv(jobId, projectId, input.desktopPort, extra, adapter.id),
    }
  }
  // Inject the profile path whenever the adapter honours it (was: claude-
  // only). The codex skill rails read SPECRAILS_PROFILE_PATH the same way.
  if (profileSnapshotPath) {
    spawnEnv = { ...spawnEnv, SPECRAILS_PROFILE_PATH: profileSnapshotPath }
  }

  // Deterministic repo map (zero-AI, best-effort) — orients the pipeline's
  // exploration phase so it doesn't spend its first turns on `ls`/`find`.
  spawnEnv = injectRepoMapEnv(spawnEnv, execution.repoDir)
  // Jobs never open windows or browser tabs over the person's (util/headless-env).
  spawnEnv = headlessJobEnv(spawnEnv)

  return { spawnEnv, environmentNotice, telemetryEnabled, frameworkVersion }
}

export type PluginSpawnResolver = (
  projectPath: string,
  projectId: string,
  jobId: string,
  providerId?: string,
  legacyProviderId?: string,
  slug?: string,
) => Promise<{
  active: Array<{ name: string; version: string }>
  degraded: Array<{ name: string; reason: string }>
}>

export interface JobPluginResolution {
  active: Array<{ name: string; version: string }>
  degraded: Array<{ name: string; reason: string }>
  snapshotPath: string | null
}

export interface JobPluginInput {
  adapter: ProviderAdapter
  execution: ProjectExecution
  jobId: string
  projectId: string | null
  projectSlug: string | null
  cwd: string | undefined
  /** Project primary provider (legacy plugin scope). */
  legacyProviderId: ProviderId
  /** Injected resolver (tests); null loads the production integration lazily. */
  resolver: PluginSpawnResolver | null
  broadcast: (msg: WsMessage) => void
  /** False once the manager generation no longer owns the reserved slot. */
  canContinue: () => boolean
}

/**
 * Plugin resolution + snapshot. Active = installed + verify ok; degraded =
 * installed but verify failed or timed out. Degraded does NOT block spawn —
 * rail proceeds, UI gets a `plugin.degraded` event so the user can reinstall.
 *
 * Project-json providers (Claude, Kimi, Gemini) resolve only the plugin
 * installations scoped to this rail's effective provider. CLI-managed MCP
 * registries remain outside this snapshot path.
 *
 * Returns null when the start lost slot ownership while verification awaited
 * (nothing is snapshotted or broadcast in that case). Without an eligible
 * provider/project, or when the resolver cannot be invoked, the result is
 * returned synchronously: the caller must not introduce an await (and a
 * microtask) the spawn never had.
 */
export function resolveJobPlugins(input: JobPluginInput): JobPluginResolution | Promise<JobPluginResolution | null> {
  const { adapter } = input
  if (adapter.mcpRegistration === 'project-json' && input.projectId && input.projectSlug && input.cwd) {
    return resolveProjectJsonPlugins(input, input.projectId, input.projectSlug)
  }
  return { active: [], degraded: [], snapshotPath: null }
}

type PluginSnapshotter = typeof import('../../../plugins/rail-integration')['snapshotPluginsForJob']

/**
 * Synchronous prefix of the resolution: choose the resolver (lazy production
 * load) and invoke it. A throw here is handled without any await, exactly as
 * when this was one inline try block.
 */
function resolveProjectJsonPlugins(
  input: JobPluginInput,
  projectId: string,
  projectSlug: string,
): JobPluginResolution | Promise<JobPluginResolution | null> {
  const { adapter, execution, jobId } = input
  let snapshotter: PluginSnapshotter | null = null
  let pending: ReturnType<PluginSpawnResolver>
  try {
    let resolver = input.resolver
    if (!resolver) {
      const pluginIntegration = require('../../../plugins/rail-integration') as typeof import('../../../plugins/rail-integration')
      resolver = pluginIntegration.resolvePluginsForSpawn
      snapshotter = pluginIntegration.snapshotPluginsForJob
    }
    // Relocated ⇒ `.mcp.json`/plugin state live in the workspace (execution.cwd).
    pending = resolver(
      execution.cwd,
      projectId,
      jobId,
      adapter.id,
      input.legacyProviderId,
      projectSlug,
    )
  } catch (err) {
    console.warn(`[queue-manager] plugin resolution failed for job ${jobId}: ${(err as Error).message}`)
    return { active: [], degraded: [], snapshotPath: null }
  }
  return finishProjectJsonPlugins(input, projectId, projectSlug, pending, snapshotter)
}

async function finishProjectJsonPlugins(
  input: JobPluginInput,
  projectId: string,
  projectSlug: string,
  pending: ReturnType<PluginSpawnResolver>,
  snapshotter: PluginSnapshotter | null,
): Promise<JobPluginResolution | null> {
  const { adapter, jobId } = input
  let pluginActive: Array<{ name: string; version: string }> = []
  let pluginDegraded: Array<{ name: string; reason: string }> = []
  let pluginSnapshotPath: string | null = null
  try {
    const resolution = await pending
    // shutdown() may have run while plugin verification was awaiting. Never
    // snapshot, broadcast, or spawn for a manager generation that no longer
    // owns this active slot.
    if (!input.canContinue()) return null
    pluginActive = resolution.active
    pluginDegraded = resolution.degraded
    if (pluginActive.length > 0 || pluginDegraded.length > 0) {
      // The injected resolver normally returns an empty test fixture. Load
      // the snapshotter lazily only if its result actually needs one.
      snapshotter ??= (require('../../../plugins/rail-integration') as typeof import('../../../plugins/rail-integration')).snapshotPluginsForJob
      pluginSnapshotPath = snapshotter(
        projectSlug, jobId, projectId, pluginActive, pluginDegraded,
      )
    }
    for (const d of pluginDegraded) {
      input.broadcast({
        type: 'plugin.degraded',
        projectId,
        name: d.name,
        providerId: adapter.id,
        reason: d.reason,
        jobId,
        timestamp: new Date().toISOString(),
      })
    }
  } catch (err) {
    console.warn(`[queue-manager] plugin resolution failed for job ${jobId}: ${(err as Error).message}`)
  }
  return { active: pluginActive, degraded: pluginDegraded, snapshotPath: pluginSnapshotPath }
}

export interface PluginSpawnEnvInput {
  adapter: ProviderAdapter
  jobId: string
  db: DbInstance | null
  projectId: string | null
  desktopPort: number
  frameworkVersion: string | null
  profileName: string | null
  plugins: JobPluginResolution
}

/** Overlay the plugin snapshot env and, when telemetry is on, the plugin attrs. */
export function applyPluginSpawnEnv(spawnEnv: NodeJS.ProcessEnv, input: PluginSpawnEnvInput): NodeJS.ProcessEnv {
  const { adapter, jobId, frameworkVersion, profileName } = input
  const pluginActive = input.plugins.active
  const pluginDegraded = input.plugins.degraded
  const pluginSnapshotPath = input.plugins.snapshotPath
  if (pluginActive.length > 0 && pluginSnapshotPath) {
    spawnEnv = {
      ...spawnEnv,
      SPECRAILS_PLUGINS_ACTIVE: pluginActive.map((p) => p.name).join(','),
      SPECRAILS_PLUGINS_SNAPSHOT: pluginSnapshotPath,
    }
  }
  // Add OTEL attrs when telemetry already on AND the adapter accepts env
  // injection. Codex spawns receive these attributes via the bridge's
  // resource attribute block instead (see codex-otel-bridge.ts).
  if (adapter.capabilities.nativeOtelEnv && input.projectId && input.db) {
    const settings = getProjectSettings(input.db)
    if (settings.pipelineTelemetryEnabled && (pluginActive.length > 0 || pluginDegraded.length > 0)) {
      const extra: Record<string, string> = {}
      // Re-thread the resolved framework version (this block rebuilds the
      // whole telemetry env, so it must carry the same attr as the first one).
      if (frameworkVersion) extra['specrails.framework_version'] = frameworkVersion
      if (profileName) extra['specrails.profile_name'] = profileName
      if (profileName) extra['specrails.profile_schema_version'] = '1'
      if (pluginActive.length > 0) {
        extra['specrails.plugins.active'] = JSON.stringify(pluginActive.map((p) => p.name))
        extra['specrails.plugins.versions'] = JSON.stringify(
          Object.fromEntries(pluginActive.map((p) => [p.name, p.version])),
        )
      }
      if (pluginDegraded.length > 0) {
        extra['specrails.plugins.degraded'] = JSON.stringify(pluginDegraded.map((d) => d.name))
      }
      spawnEnv = {
        ...spawnEnv,
        ...buildTelemetryEnv(jobId, input.projectId, input.desktopPort, extra),
      }
    }
  }
  return spawnEnv
}
