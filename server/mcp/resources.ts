import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { SPECRAILS_GUIDE } from './guide'
import { serializeProject } from './tools/projects'
import type { McpToolContext } from './tools/types'
import { getProject, listProjects } from '../desktop-db'

// Read-only state exposed as MCP resources. Read-tier only (resources are never
// mutating). Per-project resource templates (tickets, rails, analytics) are
// added in subsequent phases.
export function registerResources(server: McpServer, ctx: McpToolContext): void {
  server.registerResource(
    'guide',
    'specrails://guide',
    { title: 'Specrails platform guide', description: 'Concepts, workflow and invariants for operating Specrails.', mimeType: 'text/markdown' },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, text: SPECRAILS_GUIDE }],
    }),
  )

  server.registerResource(
    'projects',
    'specrails://projects',
    { title: 'Projects', description: 'All registered Specrails projects.', mimeType: 'application/json' },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, text: JSON.stringify(listProjects(ctx.desktopDb).map(serializeProject), null, 2) }],
    }),
  )

  server.registerResource(
    'project',
    new ResourceTemplate('specrails://projects/{projectId}', { list: undefined }),
    { title: 'Project', description: 'A single project by id.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const projectId = String(variables.projectId)
      const project = getProject(ctx.desktopDb, projectId)
      if (!project) throw new Error(`Unknown projectId "${projectId}".`)
      return { contents: [{ uri: uri.href, text: JSON.stringify(serializeProject(project), null, 2) }] }
    },
  )
}
