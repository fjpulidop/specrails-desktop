/** Compatibility entry point; decision workflows have capability-owned implementations. */
export { PR_DECISION_ACTIONS, isPrDecisionAction, actionAllowed, type PrDecisionAction } from '..'
export { executePrDecision } from '../adapters/decisions/dispatch'
export { sweepMergedChainAncestors } from '../adapters/decisions/chains'
export type { PrDecisionDeps, PrDecisionInput, PrDecisionResult } from '../adapters/decisions/contracts'
