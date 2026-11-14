import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Router } from 'express'
import request from 'supertest'
import { startMissionResourceRecording, registerMissionResourceRoutes } from './project-router-mission-resources'
import type { ProjectContext } from './project-registry'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { listBackgroundProcesses } from './transient-children'
import type { ProcessTableReader } from './modules/terminals/runtime/resource-sampler'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, archiveAgentConversation, softDeleteAgentConversation } from './modules/agents/runtime/agent-store'
import { createMissionResourceHistoryStore } from './modules/terminals/runtime/mission-resource-history'

const tableReader = vi.hoisted(() => vi.fn())
const agentManager = vi.hoisted(() => ({ activeConversationIds: vi.fn(), getProcessPids: vi.fn() }))
vi.mock('./transient-children', () => ({ listBackgroundProcesses: vi.fn() }))
vi.mock('./modules/missions/runtime/agent-chat-registry', () => ({ getAgentChatManager: () => agentManager }))
vi.mock('./modules/terminals/runtime/resource-sampler', async (orig) => ({
  ...(await orig<typeof import('./modules/terminals/runtime/resource-sampler')>()),
  createProcessTableReader: () => (() => tableReader()) as ProcessTableReader,
  readDiskUsage: vi.fn(async () => 4096),
}))

function app(worktreePath: string | null, db = initDb(':memory:')) {
  const a = express()
  const router = Router()
  const ctx = () => ({
    project: { id: 'p1' },
    db,
    chatManager: { getProcessPids: (id: string) => (id === 'chat-1' ? [10] : []) },
    flow: { getByConversation: (id: string) => (id === 'chat-1' && worktreePath ? { worktreePath } : null) },
  })
  registerMissionResourceRoutes({ router, ctx } as unknown as ProjectRoutesDeps)
  a.use('/api/projects', router)
  return a
}

beforeEach(() => {
  agentManager.activeConversationIds.mockReset().mockReturnValue([])
  agentManager.getProcessPids.mockReset().mockReturnValue([])
  vi.mocked(listBackgroundProcesses).mockReset().mockReturnValue([
    { processId: 'e1', pid: 11, command: 'npm run dev', chatId: 'chat-1', projectId: 'p1' } as never,
  ])
  tableReader.mockReset().mockResolvedValue([
    { pid: 10, ppid: 1, cpuPercent: 5, rssBytes: 1000, command: 'claude' },
    { pid: 11, ppid: 1, cpuPercent: 10, rssBytes: 2000, command: 'node' },
    { pid: 99, ppid: 1, cpuPercent: 50, rssBytes: 9999, command: 'unrelated' },
  ])
})

describe('mission resources routes', () => {
  it('lists only what the mission owns and reports disk as not scanned', async () => {
    const res = await request(app('/tmp/wt')).get('/api/projects/p1/missions/chat-1/resources')
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['agent-session', 'background-process'])
    expect(res.body.totals).toEqual({ cpuPercent: 15, memoryBytes: 3000, processCount: 2 })
    expect(res.body.worktree).toEqual({ path: '/tmp/wt', disk: { status: 'not-scanned' } })
  })

  it('returns the recorded history of the mission, oldest first, and nothing for others', async () => {
    const db = initDb(':memory:')
    db.prepare("INSERT INTO chat_conversations (id) VALUES ('chat-1'), ('chat-2')").run()
    const store = createMissionResourceHistoryStore(db)
    store.append('chat-1', { at: 2000, cpuPercent: 7, memoryBytes: 70, processCount: 2 })
    store.append('chat-1', { at: 1000, cpuPercent: 3, memoryBytes: 30, processCount: 1 })
    store.append('chat-2', { at: 1500, cpuPercent: 9, memoryBytes: 90, processCount: 1 })
    const res = await request(app('/tmp/wt', db)).get('/api/projects/p1/missions/chat-1/resources')
    expect(res.body.history.map((h: { at: number }) => h.at)).toEqual([1000, 2000])
    expect(res.body.history[1]).toEqual({ at: 2000, cpuPercent: 7, memoryBytes: 70, processCount: 2 })
  })

  it('shows nothing for another mission', async () => {
    vi.mocked(listBackgroundProcesses).mockReturnValue([])
    const res = await request(app(null)).get('/api/projects/p1/missions/chat-2/resources')
    expect(res.body.entries).toEqual([])
    expect(res.body.worktree).toBeNull()
  })

  it('scans the worktree on demand without blocking, and refuses without a worktree', async () => {
    const a = app('/tmp/wt')
    const started = await request(a).post('/api/projects/p1/missions/chat-1/resources/worktree-scan')
    expect(started.status).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    const res = await request(a).get('/api/projects/p1/missions/chat-1/resources')
    expect(res.body.worktree.disk).toMatchObject({ status: 'done', bytes: 4096 })
    expect((await request(app(null)).post('/api/projects/p1/missions/chat-1/resources/worktree-scan')).status).toBe(404)
  })
})


describe('project resource recording', () => {
  it('sweeps orphan history on project open but keeps local chats, moved missions and restorable trash', () => {
    const db = initDb(':memory:')
    const desktopDb = initDesktopDb(':memory:')
    const live = createAgentConversation(desktopDb, { pinnedProjectId: 'p1' })
    const moved = createAgentConversation(desktopDb, { pinnedProjectId: 'p2' })
    const trash = createAgentConversation(desktopDb, { pinnedProjectId: 'p1' })
    archiveAgentConversation(desktopDb, trash.id)
    softDeleteAgentConversation(desktopDb, trash.id)
    db.prepare("INSERT INTO chat_conversations (id) VALUES ('local')").run()
    const store = createMissionResourceHistoryStore(db)
    for (const id of [live.id, moved.id, trash.id, 'local', 'permanently-deleted']) {
      store.append(id, { at: 1, cpuPercent: 1, memoryBytes: 10, processCount: 1 })
    }
    const context = {
      project: { id: 'p1' }, db, desktopDb,
      chatManager: { activeConversationIds: () => [] },
    } as unknown as ProjectContext
    const recorder = startMissionResourceRecording(context)
    try {
      expect(store.list('permanently-deleted')).toEqual([])
      for (const id of [live.id, moved.id, trash.id, 'local']) expect(store.list(id)).toHaveLength(1)
    } finally { recorder.stop(); db.close(); desktopDb.close() }
  })

  it('records desktop missions in their pinned project without a local chat row, alongside local chats', async () => {
    vi.useFakeTimers()
    const db1 = initDb(':memory:')
    const db2 = initDb(':memory:')
    const desktopDb = initDesktopDb(':memory:')
    const mission = createAgentConversation(desktopDb, { pinnedProjectId: 'p1' })
    db1.prepare("INSERT INTO chat_conversations (id) VALUES ('local')").run()
    agentManager.activeConversationIds.mockImplementation((projectId: string) => projectId === 'p1' ? [mission.id] : [])
    agentManager.getProcessPids.mockImplementation((id: string) => id === mission.id ? [10] : [])
    vi.mocked(listBackgroundProcesses).mockReturnValue([])
    const context = (id: string, db: ReturnType<typeof initDb>) => ({
      project: { id }, db, desktopDb,
      chatManager: {
        activeConversationIds: () => id === 'p1' ? ['local'] : [],
        getProcessPids: (chatId: string) => chatId === 'local' ? [11] : [],
      },
    }) as unknown as ProjectContext
    const first = startMissionResourceRecording(context('p1', db1))
    const second = startMissionResourceRecording(context('p2', db2))
    try {
      await vi.advanceTimersByTimeAsync(3000)
      expect(agentManager.activeConversationIds).toHaveBeenCalledWith('p1')
      expect(agentManager.activeConversationIds).toHaveBeenCalledWith('p2')
      expect(createMissionResourceHistoryStore(db1).list(mission.id)).toEqual([
        expect.objectContaining({ cpuPercent: 5, memoryBytes: 1000, processCount: 1 }),
      ])
      expect(createMissionResourceHistoryStore(db1).list('local')).toHaveLength(1)
      expect(db2.prepare('SELECT * FROM mission_resource_samples').all()).toEqual([])
      first.stop(); second.stop()
      await vi.advanceTimersByTimeAsync(6000)
      expect(createMissionResourceHistoryStore(db1).list(mission.id)).toHaveLength(1)
    } finally {
      first.stop(); second.stop()
      vi.useRealTimers()
      db1.close(); db2.close(); desktopDb.close()
    }
  })
})
