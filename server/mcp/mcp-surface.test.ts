import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../auth', () => ({ loadOrGenerateToken: () => 'surface-test-token-no-filesystem-access' }))
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { addProject, getProject, initDesktopDb, listProjects, type DbInstance } from '../desktop-db'
import type { ProjectContext, ProjectRegistry } from '../project-registry'
import { MobileEventBus } from '../mobile/mobile-event-bus'
import type { WsMessage } from '../types'
import { buildToolSpecs } from './tools/catalog'
import type { McpToolContext } from './tools/types'
import { registerResources, registerResourceSubscriptions, resourceUrisFor } from './resources'
import { PROMPTS, registerPrompts } from './prompts'

// MCP resources (status, board, jobs, missions), their subscriptions and the prompts.

let db: DbInstance
let bus: MobileEventBus
let client: Client
let dispose: () => void
let projectId: string

function routes(url: string): unknown {
  if (url.includes('/tickets?groupBy=status')) return { groups: [{ status: 'todo', count: 2, tickets: [{ id: 7, title: 'Seven', status: 'todo' }] }], total: 2, matched: 2 }
  if (url.endsWith('/rails')) return { rails: [{ railIndex: 0, name: null, availability: 'busy', ticketIds: [7] }], activeJobs: { 0: { jobId: 'job-9', mode: 'implement' } } }
  if (url.endsWith('/queue')) return { jobs: [], paused: false, activeJobId: 'job-9' }
  if (url.includes('/jobs/job-9')) return { job: { id: 'job-9', status: 'running', command: '/implement' }, events: [{ event_type: 'log', payload: 'x' }] }
  if (url.includes('/jobs/')) return { __status: 404, error: 'Job not found' }
  if (url.includes('/agent/conversations/c1')) return { conversation: { id: 'c1', title: 'Mission one' }, messages: [], live: {} }
  return {}
}

beforeEach(async () => {
  db = initDesktopDb(':memory:')
  addProject(db, { id: 'proj-a', slug: 'proj-a', name: 'Project A', path: '/tmp/surface-a', db_path: ':memory:' } as never)
  projectId = listProjects(db)[0].id
  const project = getProject(db, projectId)!
  const pc = { project } as ProjectContext
  const registry = {
    desktopDb: db, listContexts: () => [pc], listProjects: () => listProjects(db),
    getProjectRow: (id: string) => getProject(db, id), getContext: (id: string) => (id === projectId ? pc : undefined),
  } as unknown as ProjectRegistry
  bus = new MobileEventBus()
  const ctx: McpToolContext = { registry, desktopDb: db, broadcast: () => {}, eventBus: bus, desktopPort: 4299, sessionState: { activeProjectId: null } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = routes(String(url)) as { __status?: number }
    const status = body.__status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(body) }
  }))
  const server = new McpServer({ name: 'surface', version: '1' }, { capabilities: { resources: { subscribe: true, listChanged: true }, prompts: {} } })
  registerResources(server, ctx, buildToolSpecs())
  registerPrompts(server)
  dispose = registerResourceSubscriptions(server, ctx, { debounceMs: 20 })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'surface-client', version: '1' })
  await client.connect(clientSide)
})

afterEach(async () => {
  dispose()
  await client.close()
  vi.unstubAllGlobals()
})

describe('MCP resources', () => {
  it('lists the static resources and one board per project, and advertises subscriptions', async () => {
    const { resources } = await client.listResources()
    expect(resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
      'specrails://guide', 'specrails://projects', 'specrails://status', `specrails://projects/${projectId}/board`,
    ]))
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(expect.arrayContaining([
      'specrails://jobs/{jobId}', 'specrails://missions/{conversationId}', 'specrails://projects/{projectId}/board',
    ]))
    expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true })
  })

  it('reads status, a board, a job (found in its project) and a mission', async () => {
    const status = JSON.parse(String((await client.readResource({ uri: 'specrails://status' })).contents[0].text))
    expect(status).toMatchObject({ mood: expect.any(String), etag: expect.any(String) })
    const board = JSON.parse(String((await client.readResource({ uri: `specrails://projects/${projectId}/board` })).contents[0].text))
    expect(board).toMatchObject({ projectId, total: 2, rails: [{ label: 'Rail 1', running: { jobId: 'job-9' } }] })
    expect(board.columns.find((column: { status: string }) => column.status === 'todo')).toMatchObject({ count: 2, top: [{ id: 7 }] })
    const job = JSON.parse(String((await client.readResource({ uri: 'specrails://jobs/job-9' })).contents[0].text))
    expect(job).toMatchObject({ projectId, job: { id: 'job-9', status: 'running' } })
    await expect(client.readResource({ uri: 'specrails://jobs/missing' })).rejects.toThrow(/Unknown job/)
    const project = JSON.parse(String((await client.readResource({ uri: `specrails://projects/${projectId}` })).contents[0].text))
    expect(project).toMatchObject({ id: projectId })
    const mission = JSON.parse(String((await client.readResource({ uri: 'specrails://missions/c1' })).contents[0].text))
    expect(JSON.stringify(mission)).toContain('Mission one')
  })

  it('notifies a subscriber once per burst of matching app events, and stops after unsubscribe', async () => {
    const updates: string[] = []
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => { updates.push(notification.params.uri) })
    await client.subscribeResource({ uri: 'specrails://jobs/job-9' })
    await client.subscribeResource({ uri: `specrails://projects/${projectId}/board` })
    for (let i = 0; i < 5; i++) bus.publish({ type: 'event', projectId, jobId: 'job-9', event_type: 'phase' } as unknown as WsMessage)
    bus.publish({ type: 'log', projectId, jobId: 'job-9', line: 'noise' } as unknown as WsMessage)
    bus.publish({ type: 'ticket_updated', projectId } as unknown as WsMessage)
    bus.publish({ type: 'event', projectId, jobId: 'other' } as unknown as WsMessage)
    await vi.waitFor(() => expect(updates.sort()).toEqual(['specrails://jobs/job-9', `specrails://projects/${projectId}/board`]))
    await client.unsubscribeResource({ uri: 'specrails://jobs/job-9' })
    bus.publish({ type: 'event', projectId, jobId: 'job-9' } as unknown as WsMessage)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(updates).toHaveLength(2)
  })
})

describe('resourceUrisFor', () => {
  it('maps app events to the resources they change and ignores stream noise', () => {
    expect(resourceUrisFor({ type: 'rail.job_completed', projectId: 'p', jobId: 'j' } as unknown as WsMessage))
      .toEqual(['specrails://status', 'specrails://projects/p/board', 'specrails://jobs/j'])
    expect(resourceUrisFor({ type: 'agent_done', conversationId: 'c' } as unknown as WsMessage)).toEqual(['specrails://status', 'specrails://missions/c'])
    expect(resourceUrisFor({ type: 'agent_tool', conversationId: 'c' } as unknown as WsMessage)).toEqual(['specrails://missions/c'])
    expect(resourceUrisFor({ type: 'agent_stream', conversationId: 'c' } as unknown as WsMessage)).toEqual([])
    expect(resourceUrisFor({ type: 'log', jobId: 'j' } as unknown as WsMessage)).toEqual([])
  })
})

describe('MCP prompts', () => {
  it('lists the three prompts and renders them with the tools to call', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['diagnose-failure', 'launch-spec', 'triage-inbox'])
    const diagnose = await client.getPrompt({ name: 'diagnose-failure', arguments: { jobId: 'job-9', projectId: 'p1' } })
    const text = (diagnose.messages[0].content as { text: string }).text
    expect(text).toContain('specrails_jobs(action:"diagnose_failure", jobId, projectId:"p1")')
    expect(text).toContain('specrails_runs(action:"diagnose"')
    const launch = await client.getPrompt({ name: 'launch-spec', arguments: { specId: '12' } })
    expect((launch.messages[0].content as { text: string }).text).toContain('specrails_specs(action:"get", id:12)')
    expect((await client.getPrompt({ name: 'triage-inbox' })).messages[0].content).toMatchObject({ type: 'text' })
    expect(PROMPTS['diagnose-failure'].render({}).messages[0].content).toMatchObject({ text: expect.stringContaining('most recent failed') })
  })
})
