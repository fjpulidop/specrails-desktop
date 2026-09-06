import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { initDesktopDb, type DbInstance, type ProjectRow } from '../../desktop-db'
import type { ProjectContext, ProjectRegistry } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { startBackgroundProcess } from '../../transient-children'
import { jobsTools } from './jobs'
import type { McpToolContext } from './types'

vi.mock('../../transient-children', () => ({
  startBackgroundProcess: vi.fn(), killOwnedBackgroundProcess: vi.fn(), getBackgroundProcessLogs: vi.fn(),
}))

describe('MCP background process repository scope', () => {
  let root: string
  let project: ProjectRow
  let context: McpToolContext
  let projectContext: ProjectContext
  let db: DbInstance
  const tool = jobsTools()[0]
  const start = (args: Record<string, unknown> = {}, ctx = context) => tool.handler(ctx, {
    action: 'background_start', projectId: 'project', command: 'npm run dev', confirmed: true, ...args,
  }) as Promise<{ ok: boolean; repositoryId: string; process: { cwd: string } }>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-background-repositories-'))
    for (const dir of ['primary', 'secondary', 'secondary/server', 'outside']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    db = initDesktopDb(':memory:')
    project = {
      id: 'project', name: 'Product', slug: 'product', path: path.join(root, 'primary'),
      repositories: ['primary', 'secondary'].map((id) => ({
        id, projectId: 'project', name: id, path: path.join(root, id), isPrimary: id === 'primary',
        kind: 'git', integrationBranch: null, addedAt: '',
      })),
    } as ProjectRow
    projectContext = { project } as ProjectContext
    context = {
      desktopDb: db, desktopPort: 4200, broadcast: vi.fn(), eventBus: new MobileEventBus(),
      firstPartyAgent: true, originConversationId: 'conversation', requestProjectId: project.id,
      registry: { getContext: (id: string) => id === project.id ? projectContext : undefined } as ProjectRegistry,
    }
    vi.mocked(startBackgroundProcess).mockReset().mockImplementation((command, cwd, chatId, projectId) => ({
      pid: 1234, command, cwd, chatId, projectId, startedAt: 1, status: 'running',
    }))
  })
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

  it('retains the primary default for a legacy one-folder project', async () => {
    project.repositories = undefined
    const result = await start()
    expect(result).toMatchObject({ ok: true, repositoryId: 'primary-project', process: { cwd: project.path } })
  })

  it('starts only in the explicit primary member of a multi-repository project', async () => {
    const result = await start({ repositoryId: 'primary' })
    expect(result.process.cwd).toBe(project.path)
    expect(startBackgroundProcess).toHaveBeenCalledWith('npm run dev', project.path, 'conversation', 'project', expect.any(Object), { repositoryId: 'primary', repositoryName: 'primary' })
  })

  it('resolves relative and absolute working directories inside the selected secondary', async () => {
    const server = path.join(root, 'secondary', 'server')
    expect((await start({ repositoryId: 'secondary', cwd: 'server' })).process.cwd).toBe(server)
    expect((await start({ repositoryId: 'secondary', cwd: server })).process.cwd).toBe(server)
    expect(z.object(tool.inputSchema).safeParse({ action: 'background_start', repositoryId: 'secondary', cwd: server }).success).toBe(true)
  })

  it('rejects omitted, unknown and foreign identities without starting a process', async () => {
    await expect(start()).rejects.toThrow(/repositoryId/)
    for (const repositoryId of ['missing', '', 'foreign']) {
      await expect(start({ repositoryId })).rejects.toThrow(/does not belong/)
    }
    // Even a malformed catalog cannot grant a membership owned by another project.
    project.repositories!.push({ ...project.repositories![1], id: 'foreign', projectId: 'another-project' })
    await expect(start({ repositoryId: 'foreign' })).rejects.toThrow(/does not belong/)
    expect(startBackgroundProcess).not.toHaveBeenCalled()
  })

  it('rejects traversal, another member absolute path and symlink escapes', async () => {
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'secondary', 'escape'), 'dir')
    for (const cwd of ['../primary', project.path, path.join(root, 'outside'), 'escape']) {
      await expect(start({ repositoryId: 'secondary', cwd })).rejects.toThrow(/cwd must stay within the selected repository/)
    }
    expect(startBackgroundProcess).not.toHaveBeenCalled()
  })

  it('keeps the Autonomous tier, command confirmation and authenticated conversation requirement', async () => {
    expect(typeof tool.tier === 'function' ? tool.tier({ action: 'background_start' }) : tool.tier).toBe('destructive')
    await expect(start({ repositoryId: 'secondary', confirmed: false })).rejects.toThrow(/confirmed/)
    await expect(start({ repositoryId: 'secondary' }, { ...context, firstPartyAgent: false })).rejects.toThrow(/authenticated/)
    expect(startBackgroundProcess).not.toHaveBeenCalled()
  })

  it('retains the busy guard before starting a selected secondary server', async () => {
    projectContext.queueManager = { getActiveJobId: () => 'active-job' } as ProjectContext['queueManager']
    await expect(start({ repositoryId: 'secondary' })).rejects.toThrow(/active-job/)
    expect(startBackgroundProcess).not.toHaveBeenCalled()
    expect((await start({ repositoryId: 'secondary', allowWhileBusy: true })).process.cwd).toBe(path.join(root, 'secondary'))
  })
})
