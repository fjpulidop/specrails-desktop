// Public API of diagnostics (crash markers, event-loop stalls, problem reports).
// Infrastructure adapters are wired at the composition root (`adapters/runtime.ts`).
export {
  createCrashNotices,
  createProblemReports,
  REPORT_PREVIEW_TTL_MS,
  type CrashNotices,
  type ProblemReports,
  type ReportPreview,
} from './application'
export {
  DEFAULT_STALL_THRESHOLD_MS,
  buildReportFiles,
  operationLabel,
  parseCrashMarker,
  redactSettings,
  unacknowledgedCrashes,
  type CrashMarker,
  type CrashNotice,
  type ReportFile,
  type ReportVersions,
  type StallRecord,
  type StallSnapshot,
} from './domain'
export type { CrashMarkerStore, ReportCollector } from './ports'
