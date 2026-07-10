#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { connectBridge, readMcpToken, appUrl, agentForwardHeaders } from './bridge'

// specrails-mcp: a thin stdio↔HTTP relay. An MCP client (Claude Desktop, Cursor,
// Cline, …) spawns this over stdio; it forwards to the embedded MCP server in
// the running Specrails app, attaching the locally-stored MCP token so the
// secret never appears in client config. Bundled and run by the app's Node
// runtime (no separately code-signed binary).

async function main(): Promise<void> {
  const token = readMcpToken()
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

  // The in-app agent chat gives this bridge a path to its 0600 per-turn
  // capability. The server validates it and derives tier/project/conversation
  // from its own in-memory binding; no caller-authored context header is trusted.
  Object.assign(headers, agentForwardHeaders())

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
