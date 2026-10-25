// Flow apps: a mission conversation with an ACTIVE Flow starts its dev server
// through `specrails_jobs background_start` and it runs in the Flow worktree
// (a real `git worktree`), tagged with the Flow, admitted below the Autonomous
// level, and stopped with the Flow. Real processes, real tier wrapper; only
// the project catalog and the Flow lookup are fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { initDesktopDb, type DbInstance } from '../../desktop-db'
import type { ProjectContext, ProjectRegistry } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { AGENT_CAPABILITY_HEADER, type AgentTierLevel } from '../../modules/missions/runtime/agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from '../agent-capability'
import {
  awaitBackgroundProcessesStopped, getBackgroundProcess, killBackgroundProcessesForChat, stopBackgroundProcessesForFlow, type BackgroundProcess,
} from '../../transient-children'
import { activeFlowWorkspace, jobsTools } from './jobs'
import { registerTieredTool, type McpToolContext, type ToolHandlerExtra } from './types'

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
type ToolCb = (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<ToolResult>

const CHAT = 'flow-chat'
const PROJECT = 'flow-project'
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Flow Test', '-c', 'user.email=flow@test.local', ...args], { cwd, stdio: 'pipe' })

async function waitFor<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeout = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.skipIf(process.platform === 'win32')('Flow background processes', () => {
  let root: string
  let repo: string
  let worktree: string
  let db: DbInstance
  let flowState: 'active' | 'paused'
  let call: ToolCb
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'specrails-flow-apps-')))
    repo = path.join(root, 'repo')
    worktree = path.join(root, 'worktrees', 'flow-1', 'ticket-7')
    execFileSync('mkdir', ['-p', repo])
    git(repo, 'init', '-q', '-b', 'main')
    // The app lives only on the Flow branch: proof that the process runs in the worktree.
    writeFileSync(path.join(repo, 'README.md'), 'main checkout\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/7-idea', worktree)
    writeFileSync(path.join(worktree, 'server.cjs'), `const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => res.end('served from ' + process.cwd()));
server.listen(0, '127.0.0.1', () => {
  console.log('  Local:   http://localhost:' + server.address().port + '/');
  fs.writeFileSync('started.txt', 'yes');
});
`)
    db = initDesktopDb(':memory:')
    flowState = 'active'
    broadcast = vi.fn()
    const projectContext = {
      project: { id: PROJECT, name: 'Arkanoid', slug: 'arkanoid', path: repo },
      broadcast,
      flow: {
        getByConversation: (conversationId: string) => conversationId === CHAT
          ? { id: 'flow-1', conversationId: CHAT, state: flowState, step: null, worktreePath: worktree } as never
          : null,
      },
    } as unknown as ProjectContext
    const ctx: McpToolContext = {
      desktopDb: db, desktopPort: 4200, broadcast, eventBus: new MobileEventBus(),
      registry: { getContext: (id: string) => id === PROJECT ? projectContext : undefined } as ProjectRegistry,
    }
    const server = { registerTool: (_name: string, _cfg: unknown, cb: ToolCb) => { call = cb } } as unknown as McpServer
    registerTieredTool(server, ctx, jobsTools()[0])
  })

  afterEach(async () => {
    try {
      killBackgroundProcessesForChat(CHAT)
      await awaitBackgroundProcessesStopped(6000)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  const as = (tierLevel: AgentTierLevel): ToolHandlerExtra => ({
    requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: mintAgentCapability({ conversationId: CHAT, projectId: PROJECT, tierLevel }) } },
  })
  const json = <T>(result: ToolResult): T => {
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text) as T
  }
  const startApp = (tierLevel: AgentTierLevel, args: Record<string, unknown> = {}) => call({
    action: 'background_start', command: `${quote(process.execPath)} server.cjs`, confirmed: true, ...args,
  }, as(tierLevel))

  it('runs the app in the Flow worktree, tagged with the Flow, at the Edit level, and serves its URL', async () => {
    const started = json<{ flowId: string; cwd: string; process: BackgroundProcess; hint: string }>(await startApp(1, { repositoryId: 'ignored-in-flow' }))
    expect(started).toMatchObject({ flowId: 'flow-1', cwd: worktree, process: { cwd: worktree, flowId: 'flow-1', chatId: CHAT, projectId: PROJECT } })
    expect(started.process.repositoryId).toBeUndefined()
    expect(started.hint).toContain('Flow worktree')
    const { pid, processId } = started.process

    // The agent reads the logs for the address; appUrls come from the app's own output.
    const logs = await waitFor(async () => {
      const result = json<{ appUrls?: { local: string[] } }>(await call({ action: 'background_logs', pid, processId }, as(1)))
      return result.appUrls?.local.length ? result : null
    })
    const url = logs.appUrls!.local[0]!
    expect(url).toMatch(/^http:\/\/localhost:\d+\/$/)
    expect(await (await fetch(url)).text()).toBe(`served from ${worktree}`)
    // The main checkout was never touched.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')

    // The Flow's own process can be stopped from the Flow below Autonomous.
    const killed = json<{ ok: boolean }>(await call({ action: 'background_kill', pid, processId }, as(1)))
    expect(killed.ok).toBe(true)
    await waitFor(() => ['exited', 'killed'].includes(getBackgroundProcess(pid, processId)?.status ?? ''))
  })

  it('keeps cwd inside the worktree', async () => {
    const outside = await startApp(1, { cwd: repo })
    expect(outside.isError).toBe(true)
    expect(outside.content[0]!.text).toMatch(/cwd must stay within the Flow worktree/)
  })

  it('applies the exception only inside an active Flow and only with explicit confirmation', async () => {
    // Unconfirmed: the ladder decides (Edit cannot run destructive actions).
    const unconfirmed = await startApp(1, { confirmed: false })
    expect(unconfirmed.content[0]!.text).toMatch(/requires the "Destructive" permission tier/)
    // Outside an active Flow the normal tier rule stays.
    flowState = 'paused'
    const paused = await startApp(1)
    expect(paused.content[0]!.text).toMatch(/requires the "Destructive" permission tier/)
    // At Autonomous, outside Flow, the app runs in the project checkout as before.
    const normal = json<{ process: BackgroundProcess; repositoryId: string }>(await startApp(3))
    expect(normal.process.cwd).toBe(repo)
    expect(normal.process.flowId).toBeUndefined()
    expect(activeFlowWorkspace({ flow: undefined }, CHAT)).toBeNull()
  })

  it('does not let a Flow stop processes that are not its own below Autonomous', async () => {
    flowState = 'paused'
    const foreign = json<{ process: BackgroundProcess }>(await startApp(3)).process
    flowState = 'active'
    const refused = await call({ action: 'background_kill', pid: foreign.pid, processId: foreign.processId }, as(1))
    expect(refused.content[0]!.text).toMatch(/requires the "Destructive" permission tier/)
  })

  it('stops only the Flow processes when the Flow pauses, ends or is handed off', async () => {
    const flowApp = json<{ process: BackgroundProcess }>(await startApp(1)).process
    flowState = 'paused'
    // Outside the Flow the app runs in the main checkout, so it needs a long-lived server there too
    // (otherwise it exits at once and is 'failed' before the assertion on slow runners).
    writeFileSync(path.join(repo, 'server.cjs'), "require('node:http').createServer((q, r) => r.end('main')).listen(0, '127.0.0.1')\n")
    const other = json<{ process: BackgroundProcess }>(await startApp(3)).process
    await waitFor(() => getBackgroundProcess(flowApp.pid, flowApp.processId)?.status === 'running')
    const result = await stopBackgroundProcessesForFlow('flow-1', PROJECT, 6000)
    expect(result).toEqual({ stopped: 1, unresolved: [] })
    expect(['exited', 'killed']).toContain(getBackgroundProcess(flowApp.pid, flowApp.processId)?.status)
    expect(getBackgroundProcess(other.pid, other.processId)?.status).toBe('running')
    // Idempotent: nothing left to stop.
    await expect(stopBackgroundProcessesForFlow('flow-1', PROJECT)).resolves.toEqual({ stopped: 0, unresolved: [] })
    // Clients learn about it through the usual process events.
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background_process.exited', process: expect.objectContaining({ flowId: 'flow-1' }) }))
  })
})
