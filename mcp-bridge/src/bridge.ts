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

function isUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg)
}

const APP_NOT_RUNNING = 'Specrails app is not running. Start the Specrails Desktop app, then retry.'

function jsonRpcId(msg: JSONRPCMessage): string | number | null {
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
  clientFacing.onmessage = async (msg: JSONRPCMessage) => {
    try {
      await appFacing.send(msg)
    } catch (err) {
      const id = jsonRpcId(msg)
      const message = isUnreachable(err) ? APP_NOT_RUNNING : err instanceof Error ? err.message : String(err)
      if (id !== null) {
        await clientFacing
          .send({ jsonrpc: '2.0', id, error: { code: -32000, message } } as JSONRPCMessage)
          .catch(() => {})
      }
    }
  }

  appFacing.onmessage = (msg: JSONRPCMessage) => {
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
  appFacing.onerror = () => {}
}

export { APP_NOT_RUNNING }
