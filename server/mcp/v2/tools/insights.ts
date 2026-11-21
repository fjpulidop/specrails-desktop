import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F } from '../core/views'

/** WP8. Spend, analytics, subscription usage, quotas, capacity, forecasts and budgets. */
export const insightsTool = defineTool({
  name: 'specrails_insights',
  title: 'Insights',
  description: 'Spend and analytics, subscription usage and provider quotas, capacity, preflight, forecasts, what-if, budgets, machine resources.',
  owner: 'WP8',
  fields: {
    project: F.project,
    scope: z.enum(['app', 'project']),
    report: z.enum(['dashboard', 'invocations', 'ticket_summary', 'decision_times', 'loop_economics']).describe('analytics'),
    since: z.string(),
    until: z.string(),
    view: F.view,
    lang: F.lang,
    options: F.options,
  },
  actions: {
    spend: { tier: 'read' },
    analytics: { tier: 'read' },
    export: { tier: 'read' },
    usage: { tier: (args) => (args.options as Record<string, unknown> | undefined)?.refresh === true ? 'write' : 'read' },
    quota: { tier: 'read' },
    capacity: { tier: 'read' },
    preflight: { tier: 'read', required: ['options.target'] },
    forecast: { tier: 'read' },
    what_if: { tier: 'read', required: ['options.scenario'] },
    budget_get: { tier: 'read' },
    budget_set: { tier: 'write', required: ['scope', 'options.limits'] },
    resources: { tier: 'read' },
  },
})
