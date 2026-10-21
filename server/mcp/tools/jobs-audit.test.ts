import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initDesktopDb } from '../../desktop-db'
import { initDb, type DbInstance } from '../../db'
import { createAgentConversation } from '../../modules/agents/runtime/agent-store'
import { registerJobsRoutes } from '../../project-router-jobs'
import type { ProjectRoutesDeps } from '../../project-router-helpers'
import type { ProjectContext, ProjectRegistry } from '../../project-registry'
import { registerTieredTool, setActiveProject, type McpToolContext, type ToolHandlerExtra } from './types'
import { jobsTools } from './jobs'
import { AGENT_CAPABILITY_HEADER } from '../../modules/missions/runtime/agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from '../agent-capability'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { createProjectAgentAudit, type ProjectAgentAudit } from '../../modules/audit/adapters/runtime'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// specrails_jobs(audit) through the REAL jobs route + the mission MCP wrapper rows.
describe('MCP specrails_jobs audit + mission wrapper rows', () => {
  let desktopDb: DbInstance
  let projectDb: DbInstance
  let audit: ProjectAgentAudit
  let server: Server
  let call: (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

  beforeEach(async () => {
    desktopDb = initDesktopDb(':memory:')
    projectDb = initDb(':memory:')
    _resetAgentCapabilitiesForTest()
    audit = createProjectAgentAudit(projectDb, { retentionDays: () => 30, autoStartRetention: false })
    const project = { id: 'p1', slug: 's1', name: 'P1', path: '/repo', provider: 'claude' }
    const projectCtx = { project, db: projectDb, agentAudit: audit } as unknown as ProjectContext
    const app = express()
    const router = express.Router()
    registerJobsRoutes({ router, registry: {} as ProjectRegistry, ctx: () => projectCtx, ticketPath: () => '/unused' } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const registry = { desktopDb, listContexts: () => [projectCtx], getContext: (id: string) => (id === 'p1' ? projectCtx : undefined) } as unknown as ProjectRegistry
    const ctx: McpToolContext = { registry, desktopDb, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: (server.address() as AddressInfo).port }
    setActiveProject(null)
    const fakeServer = { registerTool: (_n: string, _c: unknown, cb: typeof call) => { call = cb } } as unknown as McpServer
    registerTieredTool(fakeServer, ctx, jobsTools()[0])
  })

  afterEach(async () => {
    setActiveProject(null)
    audit.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    projectDb.close()
    desktopDb.close()
  })

  const missionExtra = (conversationId: string): ToolHandlerExtra => ({
    requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: mintAgentCapability({ conversationId, projectId: 'p1', tierLevel: 0 }) } },
  })

  it('exports a run as JSONL or CSV (read tier) and records the mission call itself as an mcp row', async () => {
    audit.recorder.record([
      { runId: 'run-1', jobId: 'run-1', role: 'developer', kind: 'read', target: 'src/a.ts', source: 'claude-stream' },
      { runId: 'run-1', jobId: 'run-1', role: 'developer', kind: 'exec', target: 'npm test', source: 'claude-stream' },
    ])
    const conv = createAgentConversation(desktopDb, { provider: 'claude' })
    const jsonl = await call({ action: 'audit', projectId: 'p1', jobId: 'run-1' }, missionExtra(conv.id))
    expect(jsonl.isError).toBeFalsy()
    const body = JSON.parse(jsonl.content[0].text) as { format: string; rows: number; data: string }
    expect(body).toMatchObject({ format: 'jsonl', rows: 2 })
    expect(body.data.trim().split('\n').map(line => JSON.parse(line).target)).toEqual(['src/a.ts', 'npm test'])

    const csv = JSON.parse((await call({ action: 'audit', projectId: 'p1', jobId: 'run-1', format: 'csv' }, missionExtra(conv.id))).content[0].text) as { rows: number; data: string }
    expect(csv.rows).toBe(2)
    expect(csv.data.split('\n')[0]).toBe('id,ts,run_id,job_id,role,kind,target,hash,source')

    const mission = audit.service.exportRun(conv.id, 'jsonl').body.trim().split('\n').map(line => JSON.parse(line))
    expect(mission).toEqual([
      expect.objectContaining({ run_id: conv.id, job_id: null, role: 'mission', kind: 'mcp', target: 'specrails_jobs:audit', source: 'mcp-wrapper' }),
      expect.objectContaining({ run_id: conv.id, role: 'mission', kind: 'mcp', target: 'specrails_jobs:audit' }),
    ])
    // Arguments never reach the audit row.
    expect(JSON.stringify(mission)).not.toContain('run-1')
  })

  it('project-wide export honours the window and external clients leave no mission rows', async () => {
    audit.recorder.record([
      { runId: 'a', kind: 'read', target: 'old.ts', source: 's', ts: '2026-01-01T00:00:00.000Z' },
      { runId: 'b', kind: 'write', target: 'new.ts', source: 's', ts: '2026-10-01T00:00:00.000Z' },
    ])
    const result = await call({ action: 'audit', projectId: 'p1', from: '2026-06-01T00:00:00Z' }, { requestInfo: { headers: {} } })
    const body = JSON.parse(result.content[0].text) as { rows: number; data: string }
    expect(body.rows).toBe(1)
    expect(JSON.parse(body.data.trim()).target).toBe('new.ts')
    expect(audit.service.exportWindow({}, 'jsonl').body.trim().split('\n')).toHaveLength(2)
  })
})
