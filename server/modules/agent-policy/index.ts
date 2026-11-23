// Public API of the in-turn agent policy. The hook entry (`hook/main.ts`) is
// bundled into a standalone script and is never imported by the server.
export {
  POLICY_RULES,
  evaluateToolCall,
  evaluateShell,
  isPolicyRule,
  type PolicyDecision,
  type PolicyFacts,
  type PolicyRule,
} from './domain/rules'
export {
  claudeFrameDenials,
  formatDenialReason,
  parsePolicyDenial,
  policyMarker,
  toolResultText,
  type ClaudeFrameDenial,
  type PolicyDenial,
} from './domain/denial'
export {
  POLICY_HOOK_SCRIPT_NAME,
  hasAnyPolicyHook,
  hasPolicyHook,
  isPolicyHookCommand,
  mergePolicyHook,
  policyHookCommand,
  stripPolicyHook,
  type ClaudeSettings,
} from './domain/settings'
export {
  currentPolicyHookCommand,
  ensurePolicyHookScript,
  installPolicyHookIn,
  policyHookDir,
  policyHookSupported,
  updateClaudeLocalSettings,
} from './adapters/install'
export { DENIAL_SPOOL_GRACE_MS, denialSpoolDir, drainDenialSpool, startDenialSpool, type DenialIngestResult } from './adapters/spool'
export { createDenialIngest, type DenialIngestProject } from './adapters/ingest'
export { parseDenialReport, type DenialReport } from './domain/report'
