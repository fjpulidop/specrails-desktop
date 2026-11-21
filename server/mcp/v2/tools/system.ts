import { z } from 'zod'
import { defineTool } from '../core/registry'
import type { McpTier } from '../../mcp-tiers'
import type { ConfirmClass } from '../core/decision-state'
import { WRITE_FIELDS } from '../core/views'

const op = (args: Record<string, unknown>) => typeof args.op === 'string' ? args.op : 'list'
/** Sub-operations that change something, per action (`op`); every other op reads. */
const MUTATING: Record<string, Record<string, { tier: McpTier; confirm: ConfirmClass | null }>> = {
  updates: { apply: { tier: 'destructive', confirm: 'irreversible' }, check: { tier: 'write', confirm: null } },
  worktrees: { remove: { tier: 'destructive', confirm: 'irreversible' } },
  background: { kill: { tier: 'destructive', confirm: 'irreversible' } },
  continuity: { settle: { tier: 'write', confirm: null } },
}
const byOp = (action: string) => ({
  tier: (args: Record<string, unknown>) => MUTATING[action]?.[op(args)]?.tier ?? 'read',
  confirm: (args: Record<string, unknown>) => MUTATING[action]?.[op(args)]?.confirm ?? null,
})

/** WP11. Health, help, diagnostics, updates, continuity, housekeeping and read-only terminals/browser/docs. */
export const systemTool = defineTool({
  name: 'specrails_system',
  title: 'System',
  description: 'health, help (topics, describe an action, validate args), triage, problem report, crashes, stalls, updates, continuity, worktrees, background, terminals, browser, docs.',
  owner: 'WP11',
  fields: {
    ...WRITE_FIELDS,
    op: z.string().describe('Sub-operation, e.g. updates: status|check|apply'),
    topic: z.string().describe('help/docs topic'),
    query: z.string(),
    id: z.string(),
  },
  actions: {
    health: { tier: 'read' },
    help: { tier: 'read' },
    triage: { tier: 'read' },
    report: { tier: 'write' },
    crashes: { tier: 'read' },
    crashes_ack: { tier: 'write' },
    stalls: { tier: 'read' },
    updates: byOp('updates'),
    continuity: byOp('continuity'),
    worktrees: byOp('worktrees'),
    machine_installs: { tier: 'read' },
    background: byOp('background'),
    terminals: { tier: 'read' },
    browser: { tier: 'read' },
    docs: { tier: 'read' },
  },
})
