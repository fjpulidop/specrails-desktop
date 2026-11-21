import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'

/** WP3 (with runs). Rail configuration; launching is specrails_runs(launch). */
export const railsTool = defineTool({
  name: 'specrails_rails',
  title: 'Rails',
  description: 'Rails of a project: list, create, rename, configure (specs, mode, loop, engine, profile, model, target PR), worktrees, overlaps, forecast. Launch via specrails_runs.',
  owner: 'WP3',
  fields: {
    ...WRITE_FIELDS,
    rail: z.union([z.number().int().min(0).max(999), z.string()]).describe('Index or rail ref'),
    name: z.string(),
    config: F.object().describe('specIds mode loop engine profile model effort targetPr'),
  },
  actions: {
    list: { tier: 'read' },
    create: { tier: 'write' },
    remove: { tier: 'destructive', confirm: 'irreversible', required: ['rail'] },
    rename: { tier: 'write', required: ['rail', 'name'] },
    configure: { tier: 'write', required: ['rail', 'config'] },
    prepare_worktrees: { tier: 'write', required: ['rail'] },
    release_worktrees: { tier: 'destructive', confirm: 'irreversible', required: ['rail'] },
    overlaps: { tier: 'read' },
    forecast: { tier: 'read', required: ['rail'] },
  },
})
