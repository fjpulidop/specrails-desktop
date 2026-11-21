import { defineTool } from '../core/registry'
import { F } from '../core/views'

/** WP2. App mood, a project's board, the live board and the planning briefing. */
export const overviewTool = defineTool({
  name: 'specrails_overview',
  title: 'Overview',
  description: 'Start here. app: needs-you, running, failures, spend, quotas; project: board, rails, queue, blueprint; live: lanes; context: briefing.',
  owner: 'WP2',
  readOnly: true,
  alwaysLoad: true,
  fields: { project: F.project, view: F.view, fields: F.fields(['columns', 'rails', 'queue', 'blueprint', 'lanes', 'sections']), lang: F.lang },
  actions: {
    app: { tier: 'read' },
    project: { tier: 'read' },
    live: { tier: 'read' },
    context: { tier: 'read' },
  },
})
