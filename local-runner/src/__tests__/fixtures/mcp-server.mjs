// Tiny stdio MCP server fixture for the local-runner MCP tests. Exposes one
// `specrails_specs` tool (mirroring the bridge's naming) that echoes its
// arguments, plus a `boom` tool that reports an error.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
server.registerTool(
  'specrails_specs',
  { description: 'List specs (fixture)', inputSchema: { action: z.string() } },
  async ({ action }) => ({ content: [{ type: 'text', text: `specs:${action}` }] }),
)
server.registerTool('boom', { description: 'Always fails', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'kaboom' }],
  isError: true,
}))
await server.connect(new StdioServerTransport())
