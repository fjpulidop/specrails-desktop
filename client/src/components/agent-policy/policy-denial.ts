/**
 * In-turn agent policy denials as the client sees them (server:
 * server/modules/agent-policy). Two transports:
 * - job and loop logs: one `log` line `[specrails-policy:<rule>] <reason>`;
 * - missions: a `system` row `{ kind: 'policy-denied', rule, reason, tool }`.
 */

export const POLICY_RULES = [
  'git-force-push',
  'git-push-protected',
  'git-push-delete',
  'git-reset-hard',
  'git-branch-delete',
  'gh-pr-merge',
  'rm-outside-run',
  'secret-access',
  'policy-tamper',
  'policy-error',
] as const
export type PolicyRule = typeof POLICY_RULES[number]

export function isPolicyRule(value: unknown): value is PolicyRule {
  return typeof value === 'string' && (POLICY_RULES as readonly string[]).includes(value)
}

export interface PolicyDenial {
  rule: PolicyRule
  reason: string
  tool?: string
}

const LOG_LINE_RE = /^\[specrails-policy:([a-z-]+)\]\s*(.*)$/s

/** A job/loop log line written for a denial, or null. */
export function parsePolicyLogLine(line: string): PolicyDenial | null {
  const match = LOG_LINE_RE.exec(line)
  if (!match || !isPolicyRule(match[1])) return null
  return { rule: match[1], reason: match[2]!.trim() }
}

/** A mission system row for a denial, or null. */
export function parsePolicyDeniedRow(content: string): PolicyDenial | null {
  let value: unknown
  try { value = JSON.parse(content) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.kind !== 'policy-denied' || !isPolicyRule(row.rule)) return null
  return {
    rule: row.rule,
    reason: typeof row.reason === 'string' ? row.reason : '',
    ...(typeof row.tool === 'string' && row.tool ? { tool: row.tool } : {}),
  }
}
