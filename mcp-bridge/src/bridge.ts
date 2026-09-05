import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export const DEFAULT_PORT = 4200

/** Reads the MCP-scoped token written by the app (~/.specrails/mcp.token). */
export function readMcpToken(): string | null {
  try {
    const home = process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
    const t = fs.readFileSync(path.join(home, '.specrails', 'mcp.token'), 'utf-8').trim()
    return t || null
  } catch {
    return null
  }
}

export function appUrl(): URL {
  const port = Number(process.env.SPECRAILS_MCP_PORT || process.env.SPECRAILS_PORT || DEFAULT_PORT)
  return new URL(`http://127.0.0.1:${port}/api/mcp`)
}

/**
 * The in-app agent gets a server-minted per-turn capability in a 0600 file. Read
 * it once and present it as a bearer-like header on every HTTP request. The file
 * indirection keeps the secret out of Codex's visible `-c` argv. Tier, project,
 * and conversation are bound to the capability server-side; legacy
 * SPECRAILS_AGENT_* context env vars are intentionally NOT forwarded.
 *
 * NOTE: this package cannot import server/agent-tier.ts, so these two names are
 * deliberately duplicated string literals (keep in sync):
 *   SPECRAILS_AGENT_CAPABILITY_FILE → x-specrails-agent-capability
 */
export function agentForwardHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const capabilityFile = env.SPECRAILS_AGENT_CAPABILITY_FILE?.trim()
  if (!capabilityFile) return {}
  try {
    const capability = fs.readFileSync(capabilityFile, 'utf8').trim()
    if (capability.length < 32 || capability.length > 256) throw new Error('Invalid capability length')
    return { 'x-specrails-agent-capability': capability }
  } catch {
    throw new Error('Cannot read the mission capability. Start a new mission turn; refusing to connect as an unrestricted external client.')
  }
}

function isUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg)
}

const APP_NOT_RUNNING = 'Specrails app is not running. Start the Specrails Desktop app, then retry.'

function jsonRpcId(msg: JSONRPCMessage): string | number | null {
  if (typeof (msg as { method?: unknown }).method !== 'string') return null
  const id = (msg as { id?: string | number }).id
  return id ?? null
}

/**
 * Wires a transparent relay: every JSON-RPC message from the MCP client (over
 * `clientFacing`, a StdioServerTransport) is forwarded to the app (over
 * `appFacing`, a StreamableHTTPClientTransport) and vice-versa. The bridge knows
 * NOTHING about the tool catalog — it just moves messages. When the app is
 * unreachable, a request gets a clear JSON-RPC error instead of a silent hang.
 */
export function connectBridge(clientFacing: Transport, appFacing: Transport): void {
  const pending = new Set<string | number>()
  clientFacing.onmessage = async (msg: JSONRPCMessage) => {
    const id = jsonRpcId(msg)
    if (id !== null) pending.add(id)
    try {
      await appFacing.send(msg)
    } catch (err) {
      const message = isUnreachable(err) ? APP_NOT_RUNNING : err instanceof Error ? err.message : String(err)
      if (id !== null && pending.delete(id)) {
        await clientFacing
          .send({ jsonrpc: '2.0', id, error: { code: -32000, message } } as JSONRPCMessage)
          .catch(() => {})
      }
    }
  }

  appFacing.onmessage = (msg: JSONRPCMessage) => {
    if ('result' in msg || 'error' in msg) pending.delete(msg.id as string | number)
    void clientFacing.send(msg).catch(() => {})
  }

  // Closing either side closes the other, guarded against the close→onclose→close
  // recursion (a transport's close() fires its own onclose).
  let closing = false
  const closeBoth = (): void => {
    if (closing) return
    closing = true
    void clientFacing.close().catch(() => {})
    void appFacing.close().catch(() => {})
  }
  appFacing.onclose = closeBoth
  clientFacing.onclose = closeBoth
  // Per-request transport errors are surfaced via the send() catch above; a
  // transport-level error should not crash the bridge process.
  appFacing.onerror = (err) => {
    // A lost response stream has no send() rejection: the SDK has already
    // returned from POST. Resolve pending calls explicitly instead of hanging
    // until the host's timeout. An operation may have started; never replay it.
    if (!/SSE stream disconnected|Maximum reconnection attempts|Failed to reconnect/i.test(err.message)) return
    for (const id of pending) {
      void clientFacing.send({ jsonrpc: '2.0', id, error: {
        code: -32000, message: 'Connection lost before the action result arrived. Reconnect and inspect current state before retrying mutations.',
      } }).catch(() => {})
    }
    pending.clear()
    closeBoth()
  }
}

export { APP_NOT_RUNNING }
