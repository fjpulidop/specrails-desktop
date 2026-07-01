#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { connectBridge, readMcpToken, appUrl } from './bridge'

// specrails-mcp: a thin stdio↔HTTP relay. An MCP client (Claude Desktop, Cursor,
// Cline, …) spawns this over stdio; it forwards to the embedded MCP server in
// the running Specrails app, attaching the locally-stored MCP token so the
// secret never appears in client config. Bundled and run by the app's Node
// runtime (no separately code-signed binary).

async function main(): Promise<void> {
  const token = readMcpToken()
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

  // The in-app agent chat spawns this bridge with SPECRAILS_AGENT_TIER set to its
  // current cumulative ladder level; forward it as a loopback-only header so the
  // app's tool guard enforces the agent ladder (not the external Settings tiers).
  const agentTier = process.env.SPECRAILS_AGENT_TIER
  if (agentTier && agentTier.trim()) headers['x-specrails-agent-tier'] = agentTier.trim()
  const activeProject = process.env.SPECRAILS_ACTIVE_PROJECT
  if (activeProject && activeProject.trim()) headers['x-specrails-active-project'] = activeProject.trim()

  const appFacing = new StreamableHTTPClientTransport(appUrl(), { requestInit: { headers } })
  const clientFacing = new StdioServerTransport()

  connectBridge(clientFacing, appFacing)

  await appFacing.start()
  await clientFacing.start()
}

main().catch((err) => {
  process.stderr.write(`[specrails-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
