/**
 * Composition of the diagnostics capability for one server process: host log
 * folder, redactor, report collector and HTTP router. Wired once by
 * `server/index.ts`; the inputs are injected so no project state is cached here.
 */
import os from 'os'
import { randomUUID } from 'crypto'
import type { Router } from 'express'
import type { DbInstance } from '../../../db/types'
import { createCrashNotices, createProblemReports, type CrashNotices, type ProblemReports, type ReportVersions } from '..'
import type { EventLoopProbe } from '../runtime/event-loop-probe'
import type { LogRing } from '../runtime/log-ring'
import { createHostCrashStore, hostLogDirFromEnv, readHostLogTail } from './host-files'
import { createDiagnosticsRouter } from './http'
import { createDiagnosticRedactor } from './redaction'
import { readDesktopSettingsRows } from './sqlite'

export interface DiagnosticsDeps {
  logRing: LogRing
  probe: Pick<EventLoopProbe, 'snapshot'>
  /** Exact secret values to remove wherever they appear (tokens this server holds). */
  knownSecrets: () => Array<string | null | undefined>
  versions: () => Promise<ReportVersions>
  desktopDb: () => DbInstance | undefined
  projectCount: () => number
  /** Defaults to `SPECRAILS_HOST_LOG_DIR`; null outside the desktop app. */
  hostLogDir?: string | null
}

export interface Diagnostics {
  router: Router
  reports: ProblemReports
  crashes: CrashNotices
}

export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const hostLogDir = deps.hostLogDir === undefined ? hostLogDirFromEnv() : deps.hostLogDir
  const store = createHostCrashStore(hostLogDir)
  const crashes = createCrashNotices(store)
  const reports = createProblemReports({
    redact: createDiagnosticRedactor(deps.knownSecrets),
    newId: randomUUID,
    collect: async () => ({
      versions: await deps.versions().catch(() => ({ app: null, core: null, api: null, contractSchema: null })),
      system: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: process.memoryUsage().rss,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      desktopHost: hostLogDir !== null,
      projectCount: deps.projectCount(),
      settings: readDesktopSettingsRows(deps.desktopDb()),
      serverLog: deps.logRing.text(),
      sidecarLog: readHostLogTail(hostLogDir, 'sidecar.log'),
      desktopLog: readHostLogTail(hostLogDir, 'desktop.log'),
      crashes: store.list(),
      stalls: deps.probe.snapshot(),
    }),
  })
  return { router: createDiagnosticsRouter({ reports, crashes, stalls: () => deps.probe.snapshot() }), reports, crashes }
}
