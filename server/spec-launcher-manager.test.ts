import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing spec-launcher-manager
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

vi.mock('./command-resolver', () => ({
  resolveCommand: vi.fn(),
}))

import { spawn as mockSpawn } from 'child_process'
import treeKill from 'tree-kill'
import { resolveCommand } from './command-resolver'
import { SpecLauncherManager } from './spec-launcher-manager'
import { initDb, type DbInstance } from './db'
import type { WsMessage } from './types'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 99999
  return child
}

async function emitLinesAndFlush(readable: Readable, lines: string[]) {
  for (const line of lines) {
    readable.push(line + '\n')
  }
  // Give readline's async line-event processing a chance to fire before
  // the caller emits 'close' on the child process.
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('SpecLauncherManager', () => {
  let manager: SpecLauncherManager
  let broadcast: ReturnType<typeof vi.fn>
  const CWD = '/fake/project'

  beforeEach(() => {
    vi.resetAllMocks()
    broadcast = vi.fn()
    manager = new SpecLauncherManager(broadcast, CWD)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── isActive ─────────────────────────────────────────────────────────────

  describe('isActive', () => {
    it('returns false when no launch is running', () => {
      expect(manager.isActive('launch-1')).toBe(false)
    })

    it('returns true while a launch process is active', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create user auth spec')

      expect(manager.isActive('launch-1')).toBe(true)

      // Close the process so the promise resolves
      child.emit('close', 0)
      await launchPromise
    })

    it('returns false after a launch completes', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create user auth spec')
      child.emit('close', 0)
      await launchPromise

      expect(manager.isActive('launch-1')).toBe(false)
    })
  })

  // ─── launch ───────────────────────────────────────────────────────────────

  describe('launch', () => {
    it('broadcasts spec_launcher_error when command is not resolved', async () => {
      const rawCommand = '/opsx:ff create user auth spec'
      // resolveCommand returns the same string when command is not installed
      vi.mocked(resolveCommand).mockReturnValue(rawCommand)

      await manager.launch('launch-1', 'create user auth spec')

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_error',
          launchId: 'launch-1',
          error: expect.stringContaining('does not have the /opsx:ff command'),
        })
      )
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('spawns claude with correct args when command resolves', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt text')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create auth spec')
      child.emit('close', 0)
      await launchPromise

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '-p', 'resolved prompt text',
        ]),
        expect.objectContaining({ cwd: CWD })
      )
    })

    it('broadcasts spec_launcher_stream for assistant text blocks', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')

      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Generating spec...' }],
        },
      })
      await emitLinesAndFlush(child.stdout, [assistantEvent])
      child.emit('close', 0)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_stream',
          launchId: 'launch-1',
          delta: 'Generating spec...',
        })
      )
    })

    it('broadcasts tool_use delta for tool_use blocks', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')

      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'write_file' }],
        },
      })
      await emitLinesAndFlush(child.stdout, [assistantEvent])
      child.emit('close', 0)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_stream',
          launchId: 'launch-1',
          delta: '<!--tool:write_file-->',
        })
      )
    })

    it('skips non-JSON lines silently', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')

      await emitLinesAndFlush(child.stdout, ['not json at all', '  ', '{"bad json"'])
      child.emit('close', 0)
      await launchPromise

      // Should not have broadcast any stream events (no valid assistant events)
      const streamCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([msg]: [WsMessage]) => msg.type === 'spec_launcher_stream'
      )
      expect(streamCalls).toHaveLength(0)
    })

    it('broadcasts spec_launcher_done with changeId extracted from stream', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')

      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Created openspec/changes/my-change-id successfully' }],
        },
      })
      await emitLinesAndFlush(child.stdout, [assistantEvent])
      child.emit('close', 0)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_done',
          launchId: 'launch-1',
          changeId: 'my-change-id',
        })
      )
    })

    it('broadcasts spec_launcher_done with changeId extracted from full text on close', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')

      // Text arrives but changeId is not detected during streaming (match happens on close)
      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'openspec/changes/late-change-id done.' }],
        },
      })
      // Emit without changeId match pattern in first pass by resetting detectedChangeId
      // We simulate by sending text that matches only on full-text scan
      await emitLinesAndFlush(child.stdout, [assistantEvent])
      child.emit('close', 0)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_done',
          changeId: 'late-change-id',
        })
      )
    })

    it('broadcasts spec_launcher_done with null changeId when no change id found', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')
      child.emit('close', 0)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_done',
          launchId: 'launch-1',
          changeId: null,
        })
      )
    })

    it('broadcasts spec_launcher_error when process exits with non-zero code', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')
      child.emit('close', 1)
      await launchPromise

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_error',
          launchId: 'launch-1',
          error: 'Spec generation failed',
        })
      )
    })

    it('cleans up active process and buffer after completion', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')
      child.emit('close', 0)
      await launchPromise

      expect(manager.isActive('launch-1')).toBe(false)
    })
  })

  // ─── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('calls treeKill with SIGTERM on the active process', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      manager.launch('launch-1', 'create spec') // do not await — cancel mid-flight

      manager.cancel('launch-1')

      expect(treeKill).toHaveBeenCalledWith(99999, 'SIGTERM')
    })

    it('broadcasts spec_launcher_error with "cancelled" message', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      manager.launch('launch-1', 'create spec')
      manager.cancel('launch-1')

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_error',
          launchId: 'launch-1',
          error: 'cancelled',
        })
      )
    })

    it('removes the process from active tracking on cancel', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      manager.launch('launch-1', 'create spec')
      expect(manager.isActive('launch-1')).toBe(true)

      manager.cancel('launch-1')
      expect(manager.isActive('launch-1')).toBe(false)
    })

    it('does nothing when cancel is called for unknown launchId', () => {
      manager.cancel('nonexistent-launch')

      // Should broadcast error even for unknown (per implementation)
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spec_launcher_error',
          launchId: 'nonexistent-launch',
          error: 'cancelled',
        })
      )
      expect(treeKill).not.toHaveBeenCalled()
    })

    // ─── BUG-LONGTAIL-04: cancelled launch must not emit a follow-up done/error ─
    it('does NOT broadcast spec_launcher_done/error when the killed child closes after cancel', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')
      manager.cancel('launch-1')

      // Killed child exits non-zero a moment later.
      child.stdout.push(null)
      child.emit('close', 143)
      await launchPromise

      // Only the 'cancelled' error from cancel(); no spurious done or
      // 'Spec generation failed' from the late close.
      const errorCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls
        .map(([m]) => m as WsMessage)
        .filter((m) => m.type === 'spec_launcher_error')
      expect(errorCalls).toHaveLength(1)
      expect((errorCalls[0] as { error?: string }).error).toBe('cancelled')

      const doneCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls
        .map(([m]) => m as WsMessage)
        .filter((m) => m.type === 'spec_launcher_done')
      expect(doneCalls).toHaveLength(0)
    })

    // ─── BUG-LONGTAIL-02: SIGKILL escalation after SIGTERM ─────────────────────
    it('escalates to SIGKILL ~2s after cancel when the child ignores SIGTERM', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void manager.launch('launch-1', 'create spec')
        manager.cancel('launch-1')

        expect(treeKill).toHaveBeenCalledWith(99999, 'SIGTERM')
        vi.advanceTimersByTime(2000)
        expect(treeKill).toHaveBeenCalledWith(99999, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
    })

    it('does NOT escalate to SIGKILL when the child closes before the grace window', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void manager.launch('launch-1', 'create spec')
        manager.cancel('launch-1')
        child.stdout.push(null)
        child.emit('close', 143)

        vi.advanceTimersByTime(5000)
        const sigkillCalls = (treeKill as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[1] === 'SIGKILL',
        )
        expect(sigkillCalls).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── ai_invocations recording (COST-ACCOUNTING-AUDIT HIGH-5) ────────────────

  describe('recording (surface=spec-launcher)', () => {
    let db: DbInstance
    let dbManager: SpecLauncherManager

    function assistantLine(text: string, usage?: Record<string, number>, model = 'claude-sonnet-4-6', id = 'msg-1') {
      return JSON.stringify({
        type: 'assistant',
        message: { id, model, usage, content: [{ type: 'text', text }] },
      })
    }
    function resultLine(opts: Record<string, unknown>) {
      return JSON.stringify({ type: 'result', ...opts })
    }
    function rows() {
      return db.prepare('SELECT * FROM ai_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
    }

    beforeEach(() => {
      db = initDb(':memory:')
      dbManager = new SpecLauncherManager(broadcast, CWD, db, 'p1')
    })

    it('records a success row with native cost on clean exit', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = dbManager.launch('launch-1', 'create spec')
      await emitLinesAndFlush(child.stdout, [
        assistantLine('openspec/changes/my-change working', { input_tokens: 100, output_tokens: 50 }),
        resultLine({ total_cost_usd: 1.23, usage: { input_tokens: 100, output_tokens: 50 } }),
      ])
      child.emit('close', 0)
      await launchPromise

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].surface).toBe('spec-launcher')
      expect(r[0].surface_ref_id).toBe('launch-1')
      expect(r[0].status).toBe('success')
      expect(r[0].total_cost_usd).toBe(1.23)
      expect(r[0].total_cost_usd_estimated).toBe(0)
      expect(broadcast).toHaveBeenCalledWith({ type: 'spending.invalidated', projectId: 'p1' })
    })

    it('records an estimated-cost aborted row when cancelled mid-run', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = dbManager.launch('launch-1', 'create spec')
      await emitLinesAndFlush(child.stdout, [
        assistantLine('working', { input_tokens: 5000, output_tokens: 2000 }),
      ])
      dbManager.cancel('launch-1')
      child.stdout.push(null)
      child.emit('close', 143)
      await launchPromise

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('aborted')
      expect(r[0].total_cost_usd_estimated).toBe(1)
      expect(r[0].total_cost_usd as number).toBeGreaterThan(0)
    })

    it('records a failed row on non-zero exit', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = dbManager.launch('launch-1', 'create spec')
      child.emit('close', 1)
      await launchPromise

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('failed')
    })

    it('does NOT record when the project is being torn down (shutdown)', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = dbManager.launch('launch-1', 'create spec')
      dbManager.shutdown()
      child.stdout.push(null)
      child.emit('close', 0)
      await launchPromise

      expect(rows()).toHaveLength(0)
    })

    it('records nothing when constructed without a project DB (byte-identical)', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // `manager` (from the outer beforeEach) has no db/projectId.
      const launchPromise = manager.launch('launch-1', 'create spec')
      await emitLinesAndFlush(child.stdout, [
        resultLine({ total_cost_usd: 1.0 }),
      ])
      child.emit('close', 0)
      await launchPromise

      expect(rows()).toHaveLength(0)
    })
  })

  // ─── shutdown (BUG-LONGTAIL-02 / BUG-LONGTAIL-04) ───────────────────────────

  describe('shutdown', () => {
    it('SIGTERMs active children and arms SIGKILL escalation', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void manager.launch('launch-1', 'create spec')
        manager.shutdown()

        expect(treeKill).toHaveBeenCalledWith(99999, 'SIGTERM')
        vi.advanceTimersByTime(2000)
        expect(treeKill).toHaveBeenCalledWith(99999, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
    })

    it('does NOT broadcast spec_launcher_done/error when a child closes after shutdown', async () => {
      vi.mocked(resolveCommand).mockReturnValue('resolved prompt')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const launchPromise = manager.launch('launch-1', 'create spec')
      manager.shutdown()
      // The orphaned child closes after the project was torn down.
      child.stdout.push(null)
      child.emit('close', 0)
      await launchPromise

      const doneCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls
        .map(([m]) => m as WsMessage)
        .filter((m) => m.type === 'spec_launcher_done')
      const lateErrorCalls = (broadcast as ReturnType<typeof vi.fn>).mock.calls
        .map(([m]) => m as WsMessage)
        .filter((m) => m.type === 'spec_launcher_error')
      expect(doneCalls).toHaveLength(0)
      expect(lateErrorCalls).toHaveLength(0)
    })
  })
})
