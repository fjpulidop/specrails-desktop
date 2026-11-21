import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'

const AI_MODES = new Set(['request'])

/** WP5. Specs: read, write, AI authoring, trash, addenda, attachments. */
export const specsTool = defineTool({
  name: 'specrails_specs',
  title: 'Specs',
  description: 'Specs: list, get views, search, create (request=AI, draft, verbatim, idea), edit, AI refine, trash, addenda, attachments.',
  owner: 'WP5',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(['criteria', 'addenda', 'timeline', 'handoff', 'attachments', 'files', 'spend']),
    refs: F.refs.describe('bulk_update/purge: specs'),
    query: z.string(),
    mode: z.enum(['request', 'draft', 'verbatim', 'idea']),
    title: z.string(),
    body: z.string(),
    patch: F.object().describe('Fields to change'),
    filter: F.filter.describe('list: status[], label, rail, since'),
  },
  actions: {
    list: { tier: 'read' },
    get: { tier: 'read', required: ['ref'] },
    search: { tier: 'read', required: ['query'] },
    create: {
      tier: (args) => AI_MODES.has(String(args.mode)) ? 'ai-spawn' : 'write',
      confirm: (args) => AI_MODES.has(String(args.mode)) ? 'costly' : null,
      required: ['mode'], oneOf: ['title', 'body'],
    },
    update: { tier: 'write', required: ['ref', 'patch'] },
    bulk_update: { tier: 'write', required: ['refs', 'patch'] },
    delete: { tier: 'write', required: ['ref'], doc: 'Moves to trash (restore undoes it).' },
    restore: { tier: 'write', required: ['ref'] },
    trash: { tier: 'read' },
    purge: { tier: 'destructive', confirm: 'irreversible', oneOf: ['ref', 'refs'] },
    refine: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    ai_edit: { tier: 'ai-spawn', confirm: 'costly', required: ['ref', 'body'] },
    smash: { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] },
    smash_undo: { tier: 'write', required: ['ref'] },
    triage: { tier: 'write', oneOf: ['ref', 'refs'] },
    addendum_add: { tier: 'write', required: ['ref', 'body'] },
    addendum_update: { tier: 'write', required: ['ref', 'body'] },
    addendum_dismiss: { tier: 'write', required: ['ref'] },
    addendum_reopen: { tier: 'write', required: ['ref'] },
    addendum_delete: { tier: 'destructive', confirm: 'irreversible', required: ['ref'] },
    attach: { tier: 'write', required: ['ref', 'options.file'] },
    detach: { tier: 'destructive', confirm: 'irreversible', required: ['ref'] },
  },
})
