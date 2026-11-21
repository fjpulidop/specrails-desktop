import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'

const queueTier = (args: Record<string, unknown>) => (args.options as Record<string, unknown> | undefined)?.op === 'get' || !(args.options as Record<string, unknown> | undefined)?.op ? 'read' as const : 'write' as const
const LIMIT_SWITCH = (args: Record<string, unknown>) => args.choice === 'switch' ? 'costly' as const : null
const generates = (args: Record<string, unknown>) => (args.options as Record<string, unknown> | undefined)?.generate === true

/** WP3. Every run (jobs, loop runs, Intent runs): views, launch, control, answers, recovery. */
export const runsTool = defineTool({
  name: 'specrails_runs',
  title: 'Runs',
  description: 'Runs (jobs, loop and Intent runs): list, get views, launch (assign+launch in one call), pause/resume/stop, answer, limit, remedy, recovery, queue.',
  owner: 'WP3',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(['steps', 'graph', 'logs', 'narrated', 'verification', 'cost', 'attempts', 'events']),
    target: F.object().describe('launch: {specIds,rail?}|{rail}|{loopId}|{command}|{template}'),
    answer: z.string(),
    optionId: z.string(),
    message: z.string().describe('steer: instruction'),
    choice: z.enum(['resume_now', 'auto', 'switch', 'continue', 'continue_to_review', 'edit_spec', 'change_model', 'start_over']),
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
    filter: F.filter.describe('list: status[], kind[], spec, rail, since, needsYou'),
  },
  actions: {
    list: { tier: 'read' },
    get: { tier: 'read', required: ['ref'] },
    launch: { tier: 'ai-spawn', confirm: 'costly', required: ['target'] },
    launch_all: { tier: 'ai-spawn', confirm: 'costly' },
    pause: { tier: 'write', required: ['ref'] },
    resume: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    stop: { tier: 'write', required: ['ref'] },
    cancel: { tier: 'destructive', confirm: 'irreversible', required: ['ref'] },
    answer: { tier: 'write', required: ['ref'], oneOf: ['answer', 'optionId'] },
    approve: { tier: 'write', required: ['ref'] },
    reject: { tier: 'write', required: ['ref'] },
    limit: { tier: (args) => args.choice === 'switch' ? 'ai-spawn' : 'write', confirm: LIMIT_SWITCH, required: ['ref', 'choice'] },
    remedy: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'], oneOf: ['choice', 'optionId'] },
    fork: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    steer: { tier: 'write', required: ['ref', 'message'] },
    diagnose: { tier: (args) => generates(args) ? 'ai-spawn' : 'read', confirm: (args) => generates(args) ? 'costly' : null, required: ['ref'] },
    recovery_inspect: { tier: 'read', required: ['ref'] },
    recovery_read: { tier: 'read', required: ['ref', 'options.path'] },
    recovery_diff: { tier: 'read', required: ['ref'] },
    recovery_patch: { tier: 'write', required: ['ref', 'options.patch'] },
    recovery_check: { tier: 'write', required: ['ref'] },
    settle: { tier: 'write', required: ['ref'] },
    dismiss: { tier: 'write', required: ['ref'] },
    queue: { tier: queueTier, doc: 'options.op: get | pause | resume | reorder | priority' },
    delete_history: { tier: 'destructive', confirm: 'irreversible', oneOf: ['ref', 'filter'] },
  },
})
