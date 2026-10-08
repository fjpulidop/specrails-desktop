#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { connectBridge, appUrl, agentForwardHeaders } from './bridge'
import { authenticatedFetch, RecoveringHttpTransport, type BridgeLog } from './http-transport'
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LOG_LIMIT_BYTES = 256 * 1024

/**
 * Mission bridges note their lifecycle next to their capability so a client
 * reporting "Transport closed" can be explained. External clients log nothing.
 */
function lifecycleLog(): BridgeLog {
  const capabilityFile = process.env.SPECRAILS_AGENT_CAPABILITY_FILE?.trim()
  if (!capabilityFile) return () => {}
  const file = join(dirname(capabilityFile), 'bridge.log')
  return (event, detail) => {
    try {
      try { if (statSync(file).size > LOG_LIMIT_BYTES) truncateSync(file, 0) } catch { /* first write */ }
      appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${event}${detail ? ` ${detail.replace(/\s+/g, ' ').slice(0, 500)}` : ''}\n`, { mode: 0o600 })
    } catch { /* diagnostics must never break the bridge */ }
  }
}

// specrails-mcp: a thin stdio↔HTTP relay. An MCP client (Claude Desktop, Cursor,
// Cline, …) spawns this over stdio; it forwards to the embedded MCP server in
// the running Specrails app, attaching the locally-stored MCP token so the
// secret never appears in client config. Bundled and run by the app's Node
// runtime (no separately code-signed binary).

async function main(): Promise<void> {
  // The in-app agent chat gives this bridge a path to its 0600 per-turn
  // capability. The server validates it and derives tier/project/conversation
  // from its own in-memory binding; no caller-authored context header is trusted.
  // Validate it once at startup (refuse to run unrestricted), then re-read it on
  // every request: a resident agent session keeps this bridge alive across
  // turns while Desktop rotates the capability file per turn.
  const log = lifecycleLog()
  log('start', `ppid=${process.ppid}`)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { log('signal', signal); process.exit(0) })
  process.on('exit', (code) => log('exit', `code=${code}`))
  process.stdin.once('end', () => log('stdin-end', 'the client closed its side'))
  agentForwardHeaders()
  const fetchWithCredentials = authenticatedFetch(() => agentForwardHeaders())
  const appFacing = new RecoveringHttpTransport(() => new StreamableHTTPClientTransport(appUrl(), { fetch: fetchWithCredentials }), log)
  const clientFacing = new StdioServerTransport()

  connectBridge(clientFacing, appFacing)
  const relayError = appFacing.onerror
  appFacing.onerror = (error) => { log('app-error', error.message); relayError?.(error) }
  const relayClose = appFacing.onclose
  appFacing.onclose = () => { log('close', 'app side closed'); relayClose?.() }

  await appFacing.start()
  await clientFacing.start()
}

main().catch((err) => {
  lifecycleLog()('fatal', err instanceof Error ? err.message : String(err))
  process.stderr.write(`[specrails-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
