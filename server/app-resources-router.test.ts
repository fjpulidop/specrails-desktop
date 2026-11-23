import { describe, expect, it, vi, beforeEach } from 'vitest'
import express, { Router } from 'express'
import request from 'supertest'
import type { ProcessSample } from './modules/terminals/domain/mission-resources'

const mocks = vi.hoisted(() => ({
  agent: { activeConversationIds: vi.fn(() => ['m1']), getProcessPids: vi.fn((): number[] => [210]) },
  background: vi.fn(() => [
    { processId: 'bp1', pid: 300, command: 'npm run dev', status: 'running', chatId: 'm1', projectId: 'p1' },
    { processId: 'bp2', pid: 301, command: 'old', status: 'exited', chatId: 'm1', projectId: 'p1' },
  ]),
  terminals: vi.fn(() => [{ id: 't1', projectId: 'p1', name: 'zsh', pid: 400 }]),
}))
vi.mock('./modules/missions/runtime/agent-chat-registry', () => ({ getAgentChatManager: () => mocks.agent }))
vi.mock('./transient-children', () => ({ listBackgroundProcesses: mocks.background }))
vi.mock('./modules/terminals/runtime/terminal-manager', () => ({ getTerminalManager: () => ({ listProcessRoots: mocks.terminals }) }))

import { listAppResourceRoots, registerAppResourceRoutes } from './app-resources-router'

const SERVER = 100
const MB = 1024 * 1024
const table: ProcessSample[] = [
  { pid: SERVER, ppid: 1, cpuPercent: 4, rssBytes: 150 * MB, command: 'node server' },
  { pid: 200, ppid: SERVER, cpuPercent: 10, rssBytes: 300 * MB, command: 'claude -p' },
  { pid: 210, ppid: SERVER, cpuPercent: 1, rssBytes: 100 * MB, command: 'codex exec' },
  { pid: 300, ppid: SERVER, cpuPercent: 2, rssBytes: 80 * MB, command: 'npm run dev' },
  { pid: 400, ppid: SERVER, cpuPercent: 0, rssBytes: 5 * MB, command: '/bin/zsh' },
  { pid: 500, ppid: SERVER, cpuPercent: 0, rssBytes: 20 * MB, command: 'git fetch' },
  // A rail's Core definition runtime and the provider CLI it runs.
  { pid: 220, ppid: SERVER, cpuPercent: 1, rssBytes: 60 * MB, command: 'node /core/dist/runtime.js run' },
  { pid: 221, ppid: 220, cpuPercent: 30, rssBytes: 400 * MB, command: 'claude -p' },
  // A queued job's CLI.
  { pid: 230, ppid: SERVER, cpuPercent: 5, rssBytes: 200 * MB, command: 'codex exec' },
]

const desktopDb = { prepare: () => ({ get: () => ({ title: 'Desktop mission', pinned_project_id: 'p1' }) }) }
const projectDb = { prepare: () => ({ get: () => ({ title: 'Project chat' }) }) }
const registry = {
  desktopDb,
  getProjectRow: (id: string) => (id === 'p1' ? { id: 'p1', name: 'Web app' } : undefined),
  listContexts: () => [{
    project: { id: 'p1', name: 'Web app' },
    db: projectDb,
    chatManager: { activeConversationIds: () => ['c1'], getProcessPids: () => [200] },
    loopRunManager: { listProcessRoots: () => [{ runId: 'r1', pid: 220, label: 'Rail 1 · Implement · #12' }] },
    queueManager: { listProcessRoots: () => [{ jobId: 'j1', pid: 230, label: '/specrails:implement #7' }] },
  }],
} as never

describe('listAppResourceRoots', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists agent sessions, live background processes and terminals with owners', () => {
    const roots = listAppResourceRoots(registry, table)
    expect(roots).toEqual([
      { category: 'missions', label: 'Desktop mission', pid: 210, chatId: 'm1', projectId: 'p1', projectName: 'Web app' },
      { category: 'missions', label: 'Project chat', pid: 200, chatId: 'c1', projectId: 'p1', projectName: 'Web app' },
      { category: 'rails', label: 'Rail 1 · Implement · #12', pid: 220, projectId: 'p1', projectName: 'Web app', runId: 'r1' },
      { category: 'rails', label: '/specrails:implement #7', pid: 230, projectId: 'p1', projectName: 'Web app', runId: 'j1' },
      { category: 'background', label: 'npm run dev', pid: 300, chatId: 'm1', projectId: 'p1', projectName: 'Web app' },
      { category: 'terminals', label: 'zsh', pid: 400, projectId: 'p1', projectName: 'Web app' },
    ])
    expect(mocks.agent.getProcessPids).toHaveBeenCalledWith('m1', table)
  })
})

describe('GET /api/resources', () => {
  it('returns totals, categories and history from one table read', async () => {
    const read = vi.fn(async () => table)
    const router = Router()
    registerAppResourceRoutes(router, registry, { readProcessTable: read, serverPid: SERVER })
    const app = express().use('/api', router)

    const res = await request(app).get('/api/resources').expect(200)
    expect(read).toHaveBeenCalledTimes(1)
    expect(res.body).toMatchObject({
      supported: true,
      totals: { processCount: 9, memoryBytes: 1315 * MB, cpuPercent: 53 },
      history: [expect.objectContaining({ processCount: 9 })],
    })
    expect(res.body.categories.map((c: { id: string }) => c.id)).toEqual(['missions', 'rails', 'background', 'terminals', 'git', 'server'])
    const rails = res.body.categories[1]
    expect(rails).toMatchObject({ processCount: 3, memoryBytes: 660 * MB, cpuPercent: 36 })
    expect(rails.items).toEqual([
      { label: 'Rail 1 · Implement · #12', projectId: 'p1', projectName: 'Web app', runId: 'r1', cpuPercent: 31, memoryBytes: 460 * MB, processCount: 2 },
      { label: '/specrails:implement #7', projectId: 'p1', projectName: 'Web app', runId: 'j1', cpuPercent: 5, memoryBytes: 200 * MB, processCount: 1 },
    ])
    expect(res.body.categories[0].items.map((i: { label: string }) => i.label)).toEqual(['Project chat', 'Desktop mission'])
    expect(typeof res.body.measuredAt).toBe('number')
  })

  it('answers 500 when sampling throws', async () => {
    const router = Router()
    registerAppResourceRoutes(router, registry, { readProcessTable: async () => { throw new Error('boom') }, serverPid: SERVER })
    const res = await request(express().use('/api', router)).get('/api/resources').expect(500)
    expect(res.body).toEqual({ error: 'boom' })
  })
})
