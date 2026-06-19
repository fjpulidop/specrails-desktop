import path from 'path'
import fs from 'fs'
import { FSWatcher } from 'chokidar'
import type { WsMessage, LocalTicket } from './types'
import { resolveProjectExecution } from './workspace-resolution'

const TICKET_FILE = '.specrails/local-tickets.json'
const DEBOUNCE_MS = 150

interface TicketFileData {
  schema_version: string
  revision: number
  last_updated: string
  next_id: number
  tickets: Record<string, LocalTicket>
}

/**
 * Watches `.specrails/local-tickets.json` for external changes and broadcasts
 * ticket_updated via WebSocket. One instance per project context.
 */
export class TicketWatcher {
  private _watcher: FSWatcher | null = null
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null
  private _projectPath: string
  private _projectId: string
  private _broadcast: (msg: WsMessage) => void
  private _lastRevision: number | null = null
  private _closed = false

  constructor(
    projectPath: string,
    projectId: string,
    broadcast: (msg: WsMessage) => void,
  ) {
    this._projectPath = projectPath
    this._projectId = projectId
    this._broadcast = broadcast
  }

  /**
   * Start watching the ticket file. Safe to call if file doesn't exist yet —
   * chokidar will detect when it's created.
   */
  start(): void {
    if (this._closed) return

    // Relocate-artifacts gate: watch the workspace ticket file when relocated,
    // else the repo-relative file (byte-identical for existing projects).
    const exec = resolveProjectExecution({ path: this._projectPath })
    const filePath = exec.relocated ? exec.ticketsPath : path.join(this._projectPath, TICKET_FILE)

    // Seed initial revision so we can detect external changes
    this._lastRevision = this._readRevision(filePath)

    this._watcher = new FSWatcher({
      persistent: false, // don't keep the process alive
      ignoreInitial: true,
      // awaitWriteFinish helps with rapid writes from CLI agents
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 50,
      },
    })

    this._watcher.add(filePath)

    this._watcher.on('change', () => this._onFileChange(filePath))
    this._watcher.on('add', () => this._onFileChange(filePath))

    this._watcher.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ticket-watcher] error for project ${this._projectId}:`, msg)
    })
  }

  /**
   * Stop watching and clean up. Safe to call multiple times.
   */
  async close(): Promise<void> {
    this._closed = true
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    if (this._watcher) {
      await this._watcher.close()
      this._watcher = null
    }
  }

  /**
   * Notify the watcher that the app itself just wrote to the file,
   * so the next file-change event should be skipped (avoids echo).
   * Call this from ticket API mutation handlers.
   */
  notifyDesktopWrite(newRevision: number): void {
    this._lastRevision = newRevision
  }

  private _onFileChange(filePath: string): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null
      this._handleChange(filePath)
    }, DEBOUNCE_MS)
  }

  private _handleChange(filePath: string): void {
    const revision = this._readRevision(filePath)
    if (revision === null) return // file unreadable or malformed

    // Skip if revision hasn't changed (app's own write)
    if (this._lastRevision !== null && revision === this._lastRevision) return
    this._lastRevision = revision

    // Broadcast a generic ticket_updated with the full ticket set so the
    // client can diff. We use a synthetic ticket with id 0 to signal
    // "full refresh" — this is simpler than diffing individual tickets
    // and the client will refetch via API anyway.
    this._broadcast({
      type: 'ticket_updated',
      projectId: this._projectId,
      ticket: { id: 0 } as LocalTicket,
      timestamp: new Date().toISOString(),
    })
  }

  private _readRevision(filePath: string): number | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data: TicketFileData = JSON.parse(raw)
      return typeof data.revision === 'number' ? data.revision : null
    } catch {
      return null
    }
  }
}
