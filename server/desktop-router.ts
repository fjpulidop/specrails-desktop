/**
 * App-level (`/api`) router composition.
 *
 * Mounted by `server/index.ts` BEFORE the `/api/projects` project router, so
 * the desktop routes here (including `/projects/:projectId/repositories`) take
 * precedence over overlapping project-scoped paths. Each `register*` call adds
 * one concern's routes; no two of them match the same method and path, so the
 * order below only matters relative to the externally owned registrars, which
 * keep their original positions. Route-local singletons are constructed in
 * this order: WebhookManager (webhooks), then CoreUpdateManager (core update).
 */
import { Router } from 'express'
import { registerInboxRoutes } from './modules/inbox/adapters/http'
import { registerLiveBoardRoutes } from './modules/live-board/adapters/http'
import { registerCapacityRoutes } from './modules/capacity/adapters/http'
import { registerAppResourceRoutes } from './app-resources-router'
import { registerRetainedWorktreeRoutes } from './modules/delivery/adapters/retained-worktrees-http'
import { registerUsageRoutes } from './modules/subscription-usage/adapters/http'
import type { UsageService } from './modules/subscription-usage/runtime/usage-service'
import { registerRuntimeRolePromptRoutes } from './runtime-role-prompts-router'
import { registerLoopsRoutes } from './modules/loops/runtime/loops-router'
import { countRunningForLoop } from './modules/loops/runtime/loop-runs-store'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { registerAgentRegistryRoutes, registerSpecrailsTechRoutes } from './desktop-router-agents'
import { registerAnalyticsRoutes } from './desktop-router-analytics'
import { registerCoreUpdateRoutes } from './desktop-router-core-update'
import { registerProjectRepositoryRoutes, registerProjectRoutes, registerSampleProjectRoutes } from './desktop-router-projects'
import { createNewlyDetectedAssembler, registerProviderRoutes } from './desktop-router-providers'
import { registerRuntimeProviderRoutes } from './desktop-router-runtime-providers'
import { registerAppSettingsRoutes } from './desktop-router-settings'
import { registerMachineInstallRoutes } from './modules/machine-installs/adapters/http'
import { createSqliteApprovalStore } from './modules/machine-installs/adapters/sqlite'
import type { MissionConnectors } from './modules/missions/runtime/mission-connectors-discovery'
import { registerWebhookRoutes } from './desktop-router-webhooks'
import { registerDesktopUpdateRoutes } from './desktop-router-updates'
import { registerQuotaRoutes } from './modules/provider-quota/adapters/http'
import { registerLaunchPreflightRoutes } from './modules/launch-preflight/adapters/http'
import { createDesktopLaunchPreflight } from './modules/launch-preflight/runtime/composition'
import { setRailLaunchPreflight } from './modules/delivery/runtime/rail-launch-preflight'
import type { QuotaStore } from './modules/provider-quota/runtime/quota-store'

export type { RuntimeProviderStatus, RuntimeProviderStatusMap } from './desktop-router-runtime-providers'
export { AVAILABLE_PROVIDERS_TTL_MS, _resetAvailableProvidersCacheForTests } from './desktop-router-providers'

export function createDesktopRouter(
  registry: ProjectRegistry,
  broadcast: (msg: WsMessage) => void,
  usageService?: UsageService,
  options: { missionConnectors?: MissionConnectors; quotaStore?: QuotaStore } = {},
): Router {
  const router = Router()
  if (usageService) registerUsageRoutes(router, usageService)
  // Provider quota (modules/provider-quota): the latest usage-limit state per provider account.
  if (options.quotaStore) registerQuotaRoutes(router, options.quotaStore)
  // Launch preflight (modules/launch-preflight): disk, sign-in and quota before "Launch all".
  const quota = options.quotaStore
  const launchPreflight = createDesktopLaunchPreflight((providerId) => quota?.view(providerId) ?? null)
  registerLaunchPreflightRoutes(router, registry, launchPreflight)
  // The rail launch door runs the same disk + sign-in check (GitHub and quota only warn there too).
  setRailLaunchPreflight(({ worktreesDir, providers }) => launchPreflight.run({ worktreesDir, providers, github: false }))
  // "Needs you" inbox: read-only projection across projects (modules/inbox).
  registerInboxRoutes(router, registry)
  // Live board: every run across every project, read-only (modules/live-board).
  registerLiveBoardRoutes(router, registry)
  registerCapacityRoutes(router)
  // App-wide Resources (status bar): CPU/memory of everything the server launched.
  registerAppResourceRoutes(router, registry)
  // Settings ▸ Storage: retained run worktrees across projects, removed through the release path.
  registerRetainedWorktreeRoutes(router, registry)
  // Sample-project first run (modules/onboarding). Registered before the
  // `/projects` routes below; it shares their registration side effects.
  registerSampleProjectRoutes(router, { registry, broadcast })

  // Loops (global, cross-project library) — /api/loops*. Registered here so the
  // routes live on the global `/api` router (loops are NOT project-scoped). The
  // A loop is "running" iff any project's per-project DB has an in-flight
  // loop_run for it — so edit/unpublish/delete are blocked (409) while it runs.
  // Built-ins are seeded as editable rows here (startup) and on `GET /loops`.
  registerLoopsRoutes(router, {
    db: registry.desktopDb,
    builtinLoops: {},
    isLoopRunning: (loopId) =>
      registry.listContexts().some((c) => countRunningForLoop(c.db, loopId) > 0),
  })

  // Shared by project registration and an explicit provider re-detect.
  const assembleNewlyDetected = createNewlyDetectedAssembler(registry)
  registerProjectRoutes(router, { registry, broadcast, assembleNewlyDetected })
  registerProjectRepositoryRoutes(router, { registry, broadcast })
  registerProviderRoutes(router, { broadcast, assembleNewlyDetected })
  registerAnalyticsRoutes(router, { registry })
  registerAppSettingsRoutes(router, { registry, broadcast, missionConnectors: options.missionConnectors })
  // Settings ▸ remembered machine-wide installs (modules/machine-installs): list and revoke.
  registerMachineInstallRoutes(router, createSqliteApprovalStore(registry.desktopDb))
  registerAgentRegistryRoutes(router, { registry })
  registerSpecrailsTechRoutes(router, { registry })
  registerWebhookRoutes(router, { registry })
  registerRuntimeRolePromptRoutes(router)
  registerRuntimeProviderRoutes(router, { registry, broadcast })
  registerCoreUpdateRoutes(router, { registry, broadcast })
  // Desktop app updates over HTTP (MCP): manifest check + relay to the window's updater.
  registerDesktopUpdateRoutes(router, { desktopDb: registry.desktopDb, broadcast })

  return router
}
