import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F } from '../core/views'

/** WP1. Blocking wait on the event journal; replaces every polling loop. */
export const waitTool = defineTool({
  name: 'specrails_wait',
  title: 'Wait',
  description: 'Block until refs change (no polling). until returns fired changes and a cursor; re-call with it. events pages the journal.',
  owner: 'WP1',
  readOnly: true,
  alwaysLoad: true,
  fields: {
    refs: F.refs.describe('Omit: anything that needs the person'),
    for: z.enum(['settled', 'needs_you', 'changed', 'any']),
    since: z.string().describe('Cursor from the last wait'),
    timeoutMs: z.number().int().min(1000).max(45000).describe('Default 25000'),
    project: F.project,
    limit: F.limit,
    lang: F.lang,
  },
  actions: {
    until: { tier: 'read' },
    events: { tier: 'read' },
  },
})
