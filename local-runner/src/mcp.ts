import fs from 'fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { RunnableTool } from './types'

/**
 * MCP client (design D8). `--mcp-config` takes the JSON shape claude accepts
 * (`{ mcpServers: { <name>: { command, args, env } } }`); every stdio server is
 * started with the SDK `Client`, its tools are exposed to the model as
 * `mcp__<server>__<tool>` (claude's naming, so the operator prompt and the
 * activity chip work unchanged), and results flow back as `tool_result`
 * frames. A server that fails to start is logged on stderr and skipped — the
 * turn continues with the remaining tools.
 */
export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpConfig {
  mcpServers: Record<string, McpServerSpec>
}

export function readMcpConfig(file: string): McpConfig {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<McpConfig>
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}
  return { mcpServers: servers }
}

export interface McpSession {
  tools: RunnableTool[]
  close: () => Promise<void>
}

function toText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return content
    .map((c: { type?: string; text?: string; data?: string; mimeType?: string }) => {
      if (c.type === 'text' && typeof c.text === 'string') return c.text
      if (c.type === 'image') return `[image ${c.mimeType ?? ''}]`
      return JSON.stringify(c)
    })
    .join('\n')
}

export async function connectMcpServers(
  config: McpConfig,
  env: Record<string, string | undefined>,
  stderr: { write(chunk: string): unknown },
): Promise<McpSession> {
  const clients: Client[] = []
  const tools: RunnableTool[] = []
  for (const [name, spec] of Object.entries(config.mcpServers)) {
    if (!spec || typeof spec.command !== 'string' || (spec as { type?: string }).type === 'http' || (spec as { url?: string }).url) {
      stderr.write(`[local-runner] mcp server "${name}": unsupported spec (stdio only), skipped\n`)
      continue
    }
    const client = new Client({ name: 'specrails-local-runner', version: '1.0.0' })
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...(env as Record<string, string>), ...(spec.env ?? {}) },
        cwd: spec.cwd,
        stderr: 'pipe',
      })
      transport.stderr?.on('data', () => {
        /* server chatter is not our diagnostics; drop it */
      })
      await client.connect(transport)
      const listed = await client.listTools()
      for (const t of listed.tools) {
        const exposed = `mcp__${name}__${t.name}`
        tools.push({
          definition: {
            type: 'function',
            function: {
              name: exposed,
              description: t.description ?? '',
              parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
            },
          },
          run: async (input) => {
            try {
              const res = await client.callTool({ name: t.name, arguments: input })
              return { content: toText(res.content), isError: res.isError === true }
            } catch (err) {
              return { content: `mcp tool ${exposed} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
            }
          },
        })
      }
      clients.push(client)
    } catch (err) {
      stderr.write(`[local-runner] mcp server "${name}" failed to start: ${err instanceof Error ? err.message : String(err)}; skipped\n`)
      try {
        await client.close()
      } catch {
        /* never connected */
      }
    }
  }
  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
    },
  }
}
