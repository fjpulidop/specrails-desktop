import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'

/** WP6. Project builder conversation, milestones and milestone chains. */
export const blueprintTool = defineTool({
  name: 'specrails_blueprint',
  title: 'Blueprint',
  description: 'Project builder: converse, commit into a project with milestone 1, generate milestones, launch and steer milestone chains.',
  owner: 'WP6',
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(['conversation', 'blueprint', 'milestones', 'specs', 'plan']),
    message: z.string(),
    intent: z.enum(['message', 'surprise', 'approve']),
    from: z.enum(['recommended', 'failed_step', 'start']).describe('chain_resume'),
    enabled: z.boolean().describe('chain_auto_advance'),
    milestone: z.number().int().min(1).max(999),
  },
  actions: {
    sessions: { tier: 'read' },
    start: { tier: 'ai-spawn', confirm: 'costly', required: ['message'] },
    send: { tier: 'ai-spawn', confirm: 'costly', required: ['ref', 'message'] },
    repair: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    abort: { tier: 'write', required: ['ref'] },
    get: { tier: 'read', required: ['ref'] },
    commit: {
      tier: 'ai-spawn', required: ['ref'],
      // Creating a GitHub repository is an external change; otherwise it is costly AI work.
      confirm: (args) => (args.options as Record<string, unknown> | undefined)?.githubRepo ? 'external' : 'costly',
    },
    milestones: { tier: 'read', required: ['project'] },
    milestone_generate: { tier: 'ai-spawn', confirm: 'costly', required: ['project'] },
    milestone_commit: { tier: 'write', required: ['project', 'milestone'] },
    chain_launch: { tier: 'ai-spawn', confirm: 'costly', required: ['project', 'milestone'] },
    chain_get: { tier: 'read', required: ['ref'] },
    chain_resume: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    chain_auto_advance: { tier: 'write', required: ['ref', 'enabled'] },
    chain_cancel: { tier: 'destructive', confirm: 'irreversible', required: ['ref'] },
    settings_get: { tier: 'read' },
    settings_set: { tier: 'write', required: ['options'] },
  },
})
