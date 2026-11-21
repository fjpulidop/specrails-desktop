/**
 * The denial record the hook spools to disk for the audit
 * (`<specrails home>/.specrails/agent-policy/denials/*.json`). The server
 * drains the spool for runs whose transport does not carry tool results
 * (Core's role executor); denials it already saw in a stream are skipped.
 * Pure.
 */
import { isPolicyRule, type PolicyRule } from './rules'

export interface DenialReport {
  v: 1
  at: string
  rule: PolicyRule
  reason: string
  tool: string
  /** The blocked command or path, unredacted: redact before storing anywhere else. */
  target: string
  toolUseId: string | null
  sessionId: string | null
  /** The run directory (Claude's project dir). */
  projectDir: string
  cwd: string
}

export const DENIAL_SPOOL_DIR = 'denials'
/** The hook stops spooling when this many reports are waiting (the server is gone for good). */
export const MAX_SPOOLED_DENIALS = 1000

export function parseDenialReport(raw: string): DenialReport | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.v !== 1 || !isPolicyRule(r.rule) || typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null
  if (typeof r.tool !== 'string' || typeof r.target !== 'string' || typeof r.reason !== 'string' || typeof r.projectDir !== 'string') return null
  return {
    v: 1,
    at: r.at,
    rule: r.rule,
    reason: r.reason.slice(0, 1000),
    tool: r.tool.slice(0, 128),
    target: r.target.slice(0, 2000),
    toolUseId: typeof r.toolUseId === 'string' ? r.toolUseId : null,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
    projectDir: r.projectDir,
    cwd: typeof r.cwd === 'string' ? r.cwd : r.projectDir,
  }
}
