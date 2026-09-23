/** Stable database API. Implementations live in domain-specific repositories.
 * Repositories receive their connection explicitly; only connection.ts opens it. */
export type {
  ProposalRow,
  DbInstance,
  NewJob,
  QueuedJobRecord,
  InteractiveTurnUsage,
  JobResult,
  AppEvent,
  ListJobsOpts,
} from './db/types'
export { initDb } from './db/connection'
export {
  createJob,
  upsertQueuedJob,
  deleteQueuedJob,
  markJobInteractive,
  accumulateInteractiveTurn,
  finalizeInteractiveJob,
  finishJob,
  appendEvent,
  upsertPhase,
  listJobs,
  getJob,
  getJobEvents,
  JobRecoveryPendingError,
  deleteJob,
  purgeJobs,
  skipJob,
  getPipelineJobs,
} from './db/jobs'
export type { ActivityQueryOpts } from './db/activity'
export { getProjectActivity } from './db/activity'
export {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  updateConversation,
  addMessage,
  getMessages,
} from './db/conversations'
export { createProposal, getProposal, listProposals, updateProposal, deleteProposal } from './db/proposals'
export type { JobTemplateRow } from './db/templates'
export { createTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate } from './db/templates'
export { getStats } from './db/stats'
export type { ProjectSettings } from './db/settings'
export {
  DEFAULT_FREESTYLE_PRE_PROMPT,
  WORKTREE_ENV_NAME_RE,
  normalizeWorktreeEnvPassthrough,
  getProjectSettings,
  getFreestylePrePrompt,
  updateProjectSettings,
  getQuickContractRefineLast,
  hasQuickContractRefineLast,
  setQuickContractRefineLast,
} from './db/settings'
export type { TelemetryBlobRow, TelemetrySummaryRow } from './db/telemetry'
export {
  getTelemetryBlob,
  upsertTelemetryBlob,
  listActiveTelemetryBlobs,
  setTelemetryBlobCompacted,
  insertTelemetrySummary,
  getTelemetrySummaries,
  deleteTelemetryForJob,
  getJobsWithTelemetry,
  hasJobTelemetry,
} from './db/telemetry'
