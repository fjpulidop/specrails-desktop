import { z } from 'zod'
import { defineTool } from '../core/registry'
import type { ConfirmClass } from '../core/decision-state'
import type { McpTier } from '../../mcp-tiers'
import { F, WRITE_FIELDS } from '../core/views'

export const DELIVERY_DECISIONS = [
  'create_pr', 'publish', 'merge_local', 'discard', 'dismiss', 'poll_merge', 'reopen', 'acknowledge_no_changes',
  'recover_and_retry', 'request_changes', 'checkout', 'ci_fix', 'refresh_on_base', 'local_restore', 'local_bring_back', 'local_discard_branch',
] as const
export type DeliveryDecision = (typeof DELIVERY_DECISIONS)[number]

/** Tier and confirmation class of each decision (§6 of the design). */
export const DECISION_POLICY: Record<DeliveryDecision, { tier: McpTier; confirm: ConfirmClass | null }> = {
  create_pr: { tier: 'destructive', confirm: 'external' },
  publish: { tier: 'destructive', confirm: 'external' },
  reopen: { tier: 'destructive', confirm: 'external' },
  merge_local: { tier: 'destructive', confirm: 'irreversible' },
  discard: { tier: 'destructive', confirm: 'irreversible' },
  local_discard_branch: { tier: 'destructive', confirm: 'irreversible' },
  dismiss: { tier: 'write', confirm: null },
  poll_merge: { tier: 'write', confirm: null },
  acknowledge_no_changes: { tier: 'write', confirm: null },
  checkout: { tier: 'write', confirm: null },
  local_restore: { tier: 'write', confirm: null },
  local_bring_back: { tier: 'write', confirm: null },
  refresh_on_base: { tier: 'write', confirm: null },
  recover_and_retry: { tier: 'ai-spawn', confirm: 'costly' },
  request_changes: { tier: 'ai-spawn', confirm: 'costly' },
  ci_fix: { tier: 'ai-spawn', confirm: 'costly' },
}

const policyOf = (args: Record<string, unknown>) => DECISION_POLICY[args.decision as DeliveryDecision] ?? { tier: 'destructive' as const, confirm: 'irreversible' as const }

/** WP4. Deliveries (PR decisions, local integration, CI). */
export const deliveriesTool = defineTool({
  name: 'specrails_deliveries',
  title: 'Deliveries',
  description: 'Deliveries waiting for a decision first: review packet, changes, diffs, merge preview, CI; decide create_pr, merge_local, request_changes and more.',
  owner: 'WP4',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(['packet', 'changes', 'file_diff', 'merge_preview', 'ci', 'local_changes']),
    decision: z.enum(DELIVERY_DECISIONS),
    note: z.string().describe('request_changes: what to change'),
    path: z.string().describe('file_diff: file'),
    filter: F.filter.describe('list: decision[], spec, since'),
  },
  actions: {
    list: { tier: 'read' },
    get: { tier: 'read', required: ['ref'] },
    decide: { tier: (args) => policyOf(args).tier, confirm: (args) => policyOf(args).confirm, required: ['ref', 'decision'] },
  },
})
