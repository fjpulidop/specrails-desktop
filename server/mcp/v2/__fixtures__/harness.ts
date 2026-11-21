import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { addProject, initDesktopDb, listProjects, getProject } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import type { ProjectContext, ProjectRegistry } from '../../../project-registry'
import { MobileEventBus } from '../../../mobile/mobile-event-bus'
import type { WsMessage } from '../../../types'
import type { McpToolContext } from '../../tools/types'

/**
 * Test harness for v2 tools: an in-memory desktop DB with projects, a stub
 * registry, and an MCP client linked to a server the caller fills. Shared by
 * every v2 work package's tests (see docs/internals/mcp-v2.md §Tests).
 */
export interface Harness {
  db: DbInstance
  ctx: McpToolContext
  server: McpServer
  broadcasts: WsMessage[]
  connect(): Promise<Client>
}

export function createHarness(options: { projects?: Array<{ id: string; slug: string; name: string; path: string }>; instructions?: string } = {}): Harness {
  const db = initDesktopDb(':memory:')
  for (const project of options.projects ?? [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }]) {
    addProject(db, { ...project, db_path: ':memory:' } as never)
  }
  const contexts = new Map(listProjects(db).map((row) => [row.id, { project: row } as ProjectContext]))
  const registry = {
    desktopDb: db,
    listContexts: () => [...contexts.values()],
    listProjects: () => listProjects(db),
    getProjectRow: (id: string) => getProject(db, id),
    getContext: (id: string) => contexts.get(id),
  } as unknown as ProjectRegistry
  const broadcasts: WsMessage[] = []
  const ctx: McpToolContext = {
    registry, desktopDb: db, broadcast: (msg) => { broadcasts.push(msg) }, eventBus: new MobileEventBus(), desktopPort: 4299,
    sessionState: { activeProjectId: null, sessionKey: 'session-a' } as McpToolContext['sessionState'],
  }
  const server = new McpServer({ name: 'v2-test', version: '1' }, { capabilities: { tools: {} }, ...(options.instructions ? { instructions: options.instructions } : {}) })
  return {
    db, ctx, server, broadcasts,
    async connect() {
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new Client({ name: 'v2-test-client', version: '1' })
      await client.connect(clientSide)
      return client
    },
  }
}

/** A tool call's structured envelope and error flag. */
export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ envelope: Record<string, any>; isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args }) as { structuredContent?: Record<string, any>; isError?: boolean; content?: Array<{ type: string; text?: string }> }
  return { envelope: result.structuredContent ?? {}, isError: result.isError === true, text: result.content?.[0]?.text ?? '' }
}
