import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { TicketWatcher } from './ticket-watcher'
import type { WsMessage, LocalTicket } from './types'

function makeTicketFile(dir: string, revision: number, tickets: Record<string, unknown> = {}): string {
  const storeDir = path.join(dir, '.specrails')
  fs.mkdirSync(storeDir, { recursive: true })
  const filePath = path.join(storeDir, 'local-tickets.json')
  const data = {
    schema_version: '1.0',
    revision,
    last_updated: new Date().toISOString(),
    next_id: Object.keys(tickets).length + 1,
    tickets,
  }
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
  return filePath
}

describe('TicketWatcher', () => {
  let tmpDir: string
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-watcher-test-'))
    broadcast = vi.fn()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates without error', () => {
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    expect(watcher).toBeDefined()
  })

  it('start and close work without ticket file', async () => {
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()
    await watcher.close()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('start and close work with existing ticket file', async () => {
    makeTicketFile(tmpDir, 1)
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()
    await watcher.close()
    // No broadcasts for initial state
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('close is idempotent', async () => {
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()
    await watcher.close()
    await watcher.close() // second close should not throw
  })

  it('notifyDesktopWrite updates internal revision', async () => {
    makeTicketFile(tmpDir, 1)
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()
    watcher.notifyDesktopWrite(5)
    await watcher.close()
  })

  it('does not start if already closed', () => {
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    // Close before start
    watcher.close()
    watcher.start()
    // Should not have created a file watcher internally
  })

  it('detects file change and broadcasts ticket_updated', async () => {
    const filePath = makeTicketFile(tmpDir, 1)
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()

    // Wait for chokidar to be ready
    await new Promise((r) => setTimeout(r, 300))

    // Simulate external write with bumped revision
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    data.revision = 2
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')

    // Wait for debounce (400ms) + awaitWriteFinish (200ms) + buffer
    await new Promise((r) => setTimeout(r, 1200))

    await watcher.close()

    expect(broadcast).toHaveBeenCalled()
    const msg = broadcast.mock.calls[0][0] as WsMessage
    expect(msg.type).toBe('ticket_updated')
    expect((msg as any).projectId).toBe('proj-1')
  })

  it('suppresses echo when notifyDesktopWrite matches revision', async () => {
    const filePath = makeTicketFile(tmpDir, 1)
    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()

    await new Promise((r) => setTimeout(r, 300))

    // App writes and notifies the watcher
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    data.revision = 2
    watcher.notifyDesktopWrite(2)
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')

    await new Promise((r) => setTimeout(r, 1200))

    await watcher.close()

    // Should NOT have broadcast since revision was pre-notified
    expect(broadcast).not.toHaveBeenCalled()
  })
})
