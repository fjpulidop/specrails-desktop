import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing agent-generator (spawnClaude → spawn).
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

import { spawn as mockSpawn } from 'child_process'
import { generateCustomAgent, testCustomAgent, type AgentStudioRecordCtx } from './agent-generator'
import { initDb, type DbInstance } from './db'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 77000
  child.kill = vi.fn()
  return child
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function pushLine(child: any, line: string) {
  child.stdout.push(line + '\n')
}

function assistantLine(text: string, usage?: Record<string, number>, model = 'claude-sonnet-4-6', id = 'msg-1') {
  return JSON.stringify({
    type: 'assistant',
    message: { id, model, usage, content: [{ type: 'text', text }] },
  })
}

function resultLine(opts: { total_cost_usd?: number; usage?: Record<string, number> } = {}) {
  return JSON.stringify({ type: 'result', ...opts })
}

function readRows(db: DbInstance) {
  return db.prepare('SELECT * FROM ai_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
}

describe('agent-generator', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let record: AgentStudioRecordCtx

  beforeEach(() => {
    vi.resetAllMocks()
    db = initDb(':memory:')
    broadcast = vi.fn()
    record = { db, projectId: 'p1', surfaceRefId: 'ref-1', broadcast }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── LOW-14: testCustomAgent token double-count fix ────────────────────────

  describe('testCustomAgent token accounting (LOW-14)', () => {
    it('uses the result event cumulative usage as the total (not per-message + result)', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'do it' })
      // Per-assistant-event usage (100+50) followed by the terminal result's
      // CUMULATIVE usage (120+60). The old accumulator summed both → 330.
      pushLine(child, assistantLine('partial', { input_tokens: 100, output_tokens: 50 }))
      pushLine(child, resultLine({ usage: { input_tokens: 120, output_tokens: 60 } }))
      await flush()
      child.emit('close', 0)
      const res = await p

      expect(res.tokens).toBe(180)
    })

    it('falls back to summed per-message usage when no result event arrived', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'do it' })
      pushLine(child, assistantLine('a', { input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4-6', 'm1'))
      pushLine(child, assistantLine('b', { input_tokens: 30, output_tokens: 20 }, 'claude-sonnet-4-6', 'm2'))
      await flush()
      child.emit('close', 0)
      const res = await p

      expect(res.tokens).toBe(200)
    })

    it('does not trip the token ceiling prematurely from double-counting', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // Ceiling 200. Corrected running total peaks at 180 (result), so the run
      // must NOT be truncated. The old (summed) logic hit 330 → truncated.
      const p = testCustomAgent('/cwd', {
        draftBody: '---\nname: x\n---\nbody',
        sampleTask: 'do it',
        tokenCeiling: 200,
      })
      pushLine(child, assistantLine('partial', { input_tokens: 100, output_tokens: 50 }))
      pushLine(child, resultLine({ usage: { input_tokens: 120, output_tokens: 60 } }))
      await flush()
      child.emit('close', 0)
      const res = await p

      expect(res.output).not.toContain('truncated after reaching')
      expect(res.tokens).toBe(180)
    })

    it('still truncates when the corrected running total exceeds the ceiling', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', {
        draftBody: '---\nname: x\n---\nbody',
        sampleTask: 'do it',
        tokenCeiling: 100,
      })
      pushLine(child, assistantLine('a', { input_tokens: 200, output_tokens: 50 }))
      await flush()
      child.emit('close', 0)
      const res = await p

      expect(res.output).toContain('truncated after reaching')
    })
  })

  // ─── MED-3: testCustomAgent records surface='agent-studio' ─────────────────

  describe('testCustomAgent recording (MED-3)', () => {
    it('records a success row with native cost when a result event arrives', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'go', record })
      pushLine(child, assistantLine('out', { input_tokens: 10, output_tokens: 5 }))
      pushLine(child, resultLine({ total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 } }))
      await flush()
      child.emit('close', 0)
      await p

      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('agent-studio')
      expect(rows[0].surface_ref_id).toBe('ref-1')
      expect(rows[0].status).toBe('success')
      expect(rows[0].total_cost_usd).toBe(0.42)
      expect(rows[0].total_cost_usd_estimated).toBe(0)
      expect(broadcast).toHaveBeenCalledWith({ type: 'spending.invalidated', projectId: 'p1' })
    })

    it('records an estimated cost row when killed before its result event', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'go', record })
      pushLine(child, assistantLine('out', { input_tokens: 1000, output_tokens: 500 }))
      await flush()
      child.emit('close', 0)
      await p

      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('success')
      expect(rows[0].total_cost_usd_estimated).toBe(1)
      expect(rows[0].total_cost_usd as number).toBeGreaterThan(0)
    })

    it('records a failed row on non-zero exit with no output', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'go', record })
      await flush()
      child.emit('close', 1)
      await expect(p).rejects.toThrow()

      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('failed')
    })

    it('records nothing when no record context is supplied (byte-identical)', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = testCustomAgent('/cwd', { draftBody: '---\nname: x\n---\nbody', sampleTask: 'go' })
      pushLine(child, assistantLine('out', { input_tokens: 10, output_tokens: 5 }))
      pushLine(child, resultLine({ total_cost_usd: 0.42 }))
      await flush()
      child.emit('close', 0)
      await p

      expect(readRows(db)).toHaveLength(0)
    })
  })

  // ─── MED-3: generateCustomAgent records surface='agent-studio' ─────────────

  describe('generateCustomAgent recording (MED-3)', () => {
    it('records a success row on clean exit with output', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = generateCustomAgent('/cwd', { name: 'custom-x', description: 'does x', record })
      pushLine(child, assistantLine('---\nname: custom-x\n---\nbody', { input_tokens: 20, output_tokens: 10 }))
      pushLine(child, resultLine({ total_cost_usd: 0.05, usage: { input_tokens: 20, output_tokens: 10 } }))
      await flush()
      child.emit('close', 0)
      const draft = await p

      expect(draft).toContain('custom-x')
      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('agent-studio')
      expect(rows[0].status).toBe('success')
      expect(rows[0].total_cost_usd).toBe(0.05)
    })

    it('records a failed row on non-zero exit', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = generateCustomAgent('/cwd', { name: 'custom-x', description: 'does x', record })
      pushLine(child, assistantLine('partial', { input_tokens: 20, output_tokens: 10 }))
      await flush()
      child.emit('close', 1)
      await expect(p).rejects.toThrow()

      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('failed')
    })

    it('records a failed row when the clean exit produced empty output', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = generateCustomAgent('/cwd', { name: 'custom-x', description: 'does x', record })
      await flush()
      child.emit('close', 0)
      await expect(p).rejects.toThrow(/empty output/)

      const rows = readRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('failed')
    })

    it('records nothing when no record context is supplied', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = generateCustomAgent('/cwd', { name: 'custom-x', description: 'does x' })
      pushLine(child, assistantLine('---\nname: custom-x\n---\nbody'))
      await flush()
      child.emit('close', 0)
      await p

      expect(readRows(db)).toHaveLength(0)
    })
  })
})
