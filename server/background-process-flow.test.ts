import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express, { Router } from 'express'
import request from 'supertest'
import { initDb } from './db'
import { jobsTools } from './mcp/tools/jobs'
import type { McpToolContext } from './mcp/tools/types'
import type { ProjectContext } from './project-registry'
import { registerBackgroundProcessRoutes } from './project-router-background-processes'
import { getBackgroundProcess, killBackgroundProcessesForChat, awaitBackgroundProcessesStopped, initializeBackgroundProcessPersistence, closeBackgroundProcessPersistence, type BackgroundProcess } from './transient-children'

// Real process + real registry + MCP launch + HTTP logs/stop. Only the project
// catalog is a fixture. The child is a disposable local HTTP application.
const roots: string[] = []
const databases: ReturnType<typeof initDb>[] = []
afterEach(async () => {
  try {
    killBackgroundProcessesForChat('process-flow-fixture')
    await awaitBackgroundProcessesStopped(6000)
  } finally {
    try { closeBackgroundProcessPersistence() } finally {
      for (const db of databases.splice(0)) db.close()
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    }
  }
})
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

describe.skipIf(process.platform === 'win32')('mission application process flow', () => {
  it('exposes partial startup logs and stops a real app through the scoped chip endpoint', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specrails process flow ')); roots.push(root)
    initializeBackgroundProcessPersistence(path.join(root, 'background.sqlite'))
    const script = path.join(root, 'app.cjs')
    writeFileSync(script, `const http = require('node:http');
const server = http.createServer((req,res) => res.end('fixture ready'));
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('URL=http://127.0.0.1:' + server.address().port);
  process.stderr.write('diagnostic without newline');
});
process.on('SIGTERM', () => {});
`)
    const db = initDb(':memory:'); databases.push(db)
    const broadcast = vi.fn()
    const project = { id: 'process-flow-project', name: 'Fixture application', path: root }
    const projectContext = { db, project, broadcast } as unknown as ProjectContext
    const ctx = { firstPartyAgent: true, originConversationId: 'process-flow-fixture', requestProjectId: project.id,
      broadcast, registry: { getContext: (id: string) => id === project.id ? projectContext : undefined } } as unknown as McpToolContext
    const launched = await jobsTools()[0].handler(ctx, { action: 'background_start', confirmed: true,
      command: `${quote(process.execPath)} ${quote(script)}` }) as { process: BackgroundProcess }
    expect(launched.process.processId).toBeTruthy()
    expect(launched.process.repositoryId).toBe(`primary-${project.id}`)
    const app = express()
    const router = Router()
    registerBackgroundProcessRoutes({ router, ctx: () => projectContext } as Parameters<typeof registerBackgroundProcessRoutes>[0])
    app.use('/api/projects', router)
    const endpoint = `/api/projects/${project.id}/background-processes/${launched.process.pid}`
    const owner = { chatId: 'process-flow-fixture', processId: launched.process.processId }
    let url = ''
    await vi.waitFor(async () => {
      const logs = await request(app).get(`${endpoint}/logs`).query(owner)
      expect(logs.status).toBe(200)
      const output = logs.body.lines.find((line: { source: string }) => line.source === 'stdout')?.line ?? ''
      url = /URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? ''
      expect(url).not.toBe('')
      expect(logs.body.lines).toContainEqual(expect.objectContaining({ source: 'stderr', line: 'diagnostic without newline', partial: true }))
    }, { timeout: 4000, interval: 50 })
    expect(await (await fetch(url)).text()).toBe('fixture ready')
    // A stale execution token must not stop this app even with the right PID.
    expect((await request(app).delete(endpoint).query({ ...owner, processId: 'older-execution' })).status).toBe(404)
    expect(await (await fetch(url)).text()).toBe('fixture ready')
    const stopping = await request(app).delete(endpoint).query(owner)
    expect(stopping.status).toBe(202)
    expect(stopping.body.process.status).toBe('stopping')
    await vi.waitFor(() => expect(getBackgroundProcess(launched.process.pid)?.status).toBe('killed'), { timeout: 6500, interval: 50 })
    // Prove the application released its listening port, not just its shell.
    const port = Number(new URL(url).port)
    const rebound = createServer()
    await new Promise<void>((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve) })
    await new Promise<void>(resolve => rebound.close(() => resolve()))
    const finalLogs = await request(app).get(`${endpoint}/logs`).query(owner)
    expect(finalLogs.status).toBe(200)
    expect(finalLogs.body.process).toMatchObject({ processId: launched.process.processId, status: 'killed' })
    expect(finalLogs.body.lines.length).toBeGreaterThan(0)
    const again = await request(app).delete(endpoint).query(owner)
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('killed')
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background_process.updated', process: expect.objectContaining({ status: 'stopping' }) }))
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background_process.exited', process: expect.objectContaining({ status: 'killed' }) }))
  }, 15_000)

  it('reads a failed application through REST and MCP after its owning server process exits', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specrails persisted process ')); roots.push(root)
    const file = path.join(root, 'background.sqlite')
    const worker = path.join(root, 'server-worker.ts')
    const appScript = path.join(root, 'failing-app.cjs')
    writeFileSync(appScript, "process.stderr.write('Backend failed: missing configuration'); process.exitCode = 7")
    const command = `${quote(process.execPath)} ${quote(appScript)}`
    writeFileSync(worker, `import { initializeBackgroundProcessPersistence, startBackgroundProcess, getBackgroundProcess, closeBackgroundProcessPersistence } from ${JSON.stringify(path.resolve('server/transient-children.ts'))};
async function run() {
  initializeBackgroundProcessPersistence(${JSON.stringify(file)});
  const process = startBackgroundProcess(${JSON.stringify(command)}, ${JSON.stringify(root)}, 'process-flow-fixture', 'persisted-project');
  const deadline = Date.now() + 6000;
  while (getBackgroundProcess(process.pid)?.status !== 'failed') {
    if (Date.now() > deadline) throw new Error('Fixture app did not fail');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  closeBackgroundProcessPersistence();
  console.log(JSON.stringify(getBackgroundProcess(process.pid)));
}
run().catch(error => { console.error(error); process.exitCode = 1 });
`)
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', worker], { cwd: path.resolve('.'), timeout: 10_000 })
    const execution = JSON.parse(stdout.trim()) as BackgroundProcess
    // This process never owned the child or its in-memory log ring. Every read
    // below is recovered from the file written by the now-exited worker.
    initializeBackgroundProcessPersistence(file)
    const db = initDb(':memory:'); databases.push(db)
    const project = { id: 'persisted-project', name: 'Persisted fixture', path: root }
    const projectContext = { db, project, broadcast: vi.fn() } as unknown as ProjectContext
    const router = Router(); const app = express()
    registerBackgroundProcessRoutes({ router, ctx: () => projectContext } as Parameters<typeof registerBackgroundProcessRoutes>[0])
    app.use('/api/projects', router)
    const owner = { chatId: 'process-flow-fixture', processId: execution.processId }
    const response = await request(app).get(`/api/projects/${project.id}/background-processes/${execution.pid}/logs`).query(owner)
    expect(response.status).toBe(200)
    expect(response.body.process).toMatchObject({ status: 'failed', exitCode: 7, processId: execution.processId })
    expect(response.body.lines).toContainEqual(expect.objectContaining({ source: 'stderr', line: 'Backend failed: missing configuration' }))
    const ctx = { firstPartyAgent: true, originConversationId: owner.chatId, requestProjectId: project.id,
      registry: { getContext: (id: string) => id === project.id ? projectContext : undefined } } as unknown as McpToolContext
    const logs = await jobsTools()[0].handler(ctx, { action: 'background_logs', pid: execution.pid, processId: execution.processId })
    expect(logs).toMatchObject({ ok: true, process: { status: 'failed', exitCode: 7 } })
    const other = await request(app).get(`/api/projects/${project.id}/background-processes/${execution.pid}/logs`).query({ ...owner, chatId: 'foreign-chat' })
    expect(other.status).toBe(404)
  }, 15_000)
})
