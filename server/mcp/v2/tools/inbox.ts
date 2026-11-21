import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'
import { z } from 'zod'

/** WP2. Everything that needs the person, app-wide, and acting on it. */
export const inboxTool = defineTool({
  name: 'specrails_inbox',
  title: 'Inbox',
  description: 'What needs the person across projects, most urgent first. act runs any offer by offerId.',
  owner: 'WP2',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    offerId: z.string().describe('From state.offers'),
    answer: z.string(),
    optionId: z.string(),
    until: z.string().describe('snooze: ISO time'),
    filter: F.filter.describe('list: project, kind[]'),
  },
  actions: {
    list: { tier: 'read' },
    open: { tier: 'read', required: ['ref'] },
    answer: { tier: 'write', required: ['ref'], oneOf: ['answer', 'optionId'] },
    approve: { tier: 'write', required: ['ref'] },
    reject: { tier: 'write', required: ['ref'] },
    snooze: { tier: 'write', required: ['ref', 'until'] },
    done: { tier: 'write', required: ['ref'] },
    // The offer's own tool, tier and confirmation class apply (WP2 re-dispatches through the catalog).
    act: { tier: 'write', required: ['ref', 'offerId'] },
  },
})
