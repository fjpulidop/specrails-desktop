import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('./util/cli-prompt', () => ({
  spawnClaude: vi.fn(),
  spawnAiCli: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

import { spawnAiCli } from './util/cli-prompt'

// Backwards-compat alias: tests refer to `mockSpawnClaude` even after the
// manager migrated onto `spawnAiCli`. Both point at the same mock function
// so the test bodies stay readable.
const mockSpawnClaude = spawnAiCli
import treeKill from 'tree-kill'
import { initDb, type DbInstance } from './db'
import { AgentRefineManager, validateAgentBody, buildFirstTurnPrompt } from './agent-refine-manager'
import { getRefineSession } from './agent-refine-db'
import { mirrorProjectEntry as regMirror, workspaceLayout as regLayout, resolveHome as regResolveHome } from './artifact-registry'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 99999
  child.kill = vi.fn()
  return child
}

function pushLine(child: MockChild, line: string): void {
  child.stdout.push(line + '\n')
}

function close(child: MockChild, code: number): Promise<void> {
  return new Promise((resolve) => {
    child.stdout.push(null)
    setImmediate(() => {
      child.emit('close', code)
      // Give the manager a tick to settle DB updates before resolving.
      setImmediate(resolve)
    })
  })
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })
}

function systemInit(sessionId: string): string {
  return JSON.stringify({ type: 'system', session_id: sessionId })
}

// A complete, valid agent body ready to apply.
const VALID_BODY = `---
name: custom-foo
description: "test agent"
model: sonnet
color: blue
memory: project
---

# Identity

I am a refined custom-foo.
`

function getBroadcastsByType(broadcast: ReturnType<typeof vi.fn>, type: string): Record<string, unknown>[] {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((m) => m.type === type)
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('AgentRefineManager', () => {
  let db: DbInstance
  let projectPath: string
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: AgentRefineManager

  beforeEach(() => {
    vi.resetAllMocks()
    db = initDb(':memory:')
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-refine-mgr-'))
    fs.mkdirSync(path.join(projectPath, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'agents', 'custom-foo.md'),
      `---
name: custom-foo
description: "old"
model: sonnet
color: blue
memory: project
---

# Old body
`,
      'utf8',
    )
    broadcast = vi.fn()
    mgr = new AgentRefineManager(broadcast, db, projectPath)
  })

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true })
    db.close()
    vi.restoreAllMocks()
  })

  // ─── startRefine ──────────────────────────────────────────────────────────

  describe('startRefine', () => {
    it('rejects non-custom agent ids', async () => {
      await expect(mgr.startRefine({ agentId: 'sr-developer', instruction: 'go' })).rejects.toThrow(
        'not_a_custom_agent',
      )
    })

    it('rejects when the agent file is missing', async () => {
      await expect(
        mgr.startRefine({ agentId: 'custom-missing', instruction: 'go' }),
      ).rejects.toThrow('agent_not_found')
    })

    it('persists a session row on first turn', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({
        agentId: 'custom-foo',
        instruction: 'tighten it',
        autoTest: false,
      })
      pushLine(child, systemInit('sess-001'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      const row = getRefineSession(db, refineId)!
      expect(row).toBeDefined()
      expect(row.agent_id).toBe('custom-foo')
      expect(row.status).toBe('ready')
      expect(row.session_id).toBe('sess-001')
    })

    it('spawns claude WITHOUT --resume on first turn', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      // spawnAiCli signature: (binary, args, options). Slot 1 is the argv.
      const args = vi.mocked(mockSpawnClaude).mock.calls[0][1] as string[]
      expect(args).not.toContain('--resume')
      const opts = vi.mocked(mockSpawnClaude).mock.calls[0][2]!
      expect(opts.cwd).toBe(projectPath)
      pushLine(child, systemInit('sess'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
    })

    it('emits stream + phase + ready broadcasts and stores draft_body', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({
        agentId: 'custom-foo',
        instruction: 'go',
        autoTest: false,
      })
      pushLine(child, systemInit('sess-x'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)

      const phases = getBroadcastsByType(broadcast, 'agent_refine_phase').map((m) => m.phase)
      expect(phases).toContain('reading')
      expect(phases).toContain('drafting')
      expect(phases).toContain('validating')
      expect(phases).toContain('done')

      const stream = getBroadcastsByType(broadcast, 'agent_refine_stream')
      expect(stream.length).toBeGreaterThan(0)
      expect(stream[0].refineId).toBe(refineId)

      const ready = getBroadcastsByType(broadcast, 'agent_refine_ready')
      expect(ready).toHaveLength(1)
      expect(ready[0].refineId).toBe(refineId)
      expect(ready[0].draftBody).toContain('custom-foo')

      const row = getRefineSession(db, refineId)!
      expect(row.draft_body).toContain('custom-foo')
      expect(row.phase).toBe('done')
    })

    it('marks session as error when stream finishes empty', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      // No assistant text events.
      await close(child, 0)
      const row = getRefineSession(db, refineId)!
      expect(row.status).toBe('error')
    })

    it('marks session as error and emits error event on validation failure', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      pushLine(child, systemInit('sess'))
      pushLine(child, assistantText('No frontmatter at all — just plain text.'))
      await close(child, 0)
      const row = getRefineSession(db, refineId)!
      expect(row.status).toBe('error')
      const errors = getBroadcastsByType(broadcast, 'agent_refine_error')
      expect(errors).toHaveLength(1)
      expect((errors[0].error as string).toLowerCase()).toContain('frontmatter')
    })
  })

  // ─── sendTurn ─────────────────────────────────────────────────────────────

  describe('sendTurn', () => {
    async function startReadySession(): Promise<string> {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'first', autoTest: false })
      pushLine(child, systemInit('sess-r1'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      return refineId
    }

    it('spawns claude WITH --resume <session_id> on a follow-up turn', async () => {
      const refineId = await startReadySession()
      const child2 = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child2 as never)

      await mgr.sendTurn({ refineId, instruction: 'tighter' })
      const args = vi.mocked(mockSpawnClaude).mock.calls[1][1] as string[]
      expect(args).toContain('--resume')
      const idx = args.indexOf('--resume')
      expect(args[idx + 1]).toBe('sess-r1')

      pushLine(child2, assistantText(VALID_BODY))
      await close(child2, 0)
    })

    it('throws session_not_found for unknown id', async () => {
      await expect(mgr.sendTurn({ refineId: 'missing', instruction: 'x' })).rejects.toThrow(
        'session_not_found',
      )
    })

    it('throws turn_in_progress when status=streaming', async () => {
      const refineId = await startReadySession()
      // Force streaming state.
      db.prepare(`UPDATE agent_refine_sessions SET status='streaming' WHERE id=?`).run(refineId)
      await expect(mgr.sendTurn({ refineId, instruction: 'x' })).rejects.toThrow('turn_in_progress')
    })

    it('throws no_session_id when first-turn session id was never captured', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'first', autoTest: false })
      // No system_init line emitted → no session_id captured.
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      await expect(mgr.sendTurn({ refineId, instruction: 'next' })).rejects.toThrow('no_session_id')
    })
  })

  // ─── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('kills the active spawn and broadcasts cancelled', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const startPromise = mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      const { refineId } = await startPromise

      mgr.cancel(refineId)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
      const cancelled = getBroadcastsByType(broadcast, 'agent_refine_cancelled')
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0].refineId).toBe(refineId)
      const row = getRefineSession(db, refineId)!
      expect(row.status).toBe('cancelled')

      // Drain the child to avoid open handles.
      await close(child, 1)
    })

    it('is a no-op when refineId does not exist (still emits cancelled event)', () => {
      mgr.cancel('nope')
      expect(vi.mocked(treeKill)).not.toHaveBeenCalled()
      const cancelled = getBroadcastsByType(broadcast, 'agent_refine_cancelled')
      expect(cancelled).toHaveLength(1)
    })

    // ─── BUG-LONGTAIL-01: cancel must not be clobbered by the killed child's exit ─
    it('keeps status=cancelled and emits no error when the killed child exits non-zero', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const turnPromise = mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      const { refineId } = await turnPromise

      mgr.cancel(refineId)
      // The killed child exits non-zero a moment later (SIGTERM → 143). Without
      // the cancelled-flag short-circuit this would write status='error' and
      // broadcast agent_refine_error.
      await close(child, 143)

      const row = getRefineSession(db, refineId)!
      expect(row.status).toBe('cancelled')
      // No spurious failure broadcast from the killed child's exit.
      expect(getBroadcastsByType(broadcast, 'agent_refine_error')).toHaveLength(0)
    })

    it('does NOT write an ai_invocations row for a cancelled turn', async () => {
      const projectId = 'proj-refine-cancel'
      const mgrCap = new AgentRefineManager(broadcast, db, projectPath, projectId)
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgrCap.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })

      mgrCap.cancel(refineId)
      await close(child, 143)

      const rows = db.prepare(`SELECT * FROM ai_invocations WHERE project_id = ?`).all(projectId)
      expect(rows).toHaveLength(0)
    })

    // ─── BUG-LONGTAIL-02: SIGKILL escalation after SIGTERM ─────────────────────
    it('escalates to SIGKILL ~2s after cancel when the child ignores SIGTERM', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })

      vi.useFakeTimers()
      try {
        mgr.cancel(refineId)
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
        vi.advanceTimersByTime(2000)
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
      // Drain the child to avoid open handles.
      await close(child, 143)
    })

    it('does NOT escalate to SIGKILL when the child settles before the grace window', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })

      mgr.cancel(refineId)
      // Child settles promptly; the spawn-lifecycle resolves and _runTurn clears
      // the kill timer.
      await close(child, 143)

      vi.useFakeTimers()
      try {
        vi.advanceTimersByTime(5000)
        const sigkillCalls = vi.mocked(treeKill).mock.calls.filter((c) => c[1] === 'SIGKILL')
        expect(sigkillCalls).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── shutdown (BUG-LONGTAIL-02) ─────────────────────────────────────────────

  describe('shutdown', () => {
    it('SIGTERMs active children and arms SIGKILL escalation', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      expect(mgr.isActive(refineId)).toBe(true)

      vi.useFakeTimers()
      try {
        mgr.shutdown()
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
        vi.advanceTimersByTime(2000)
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
      // Drain the orphaned child; disposed short-circuit prevents DB writes.
      await close(child, 143)
    })
  })

  // ─── apply ────────────────────────────────────────────────────────────────

  describe('apply', () => {
    async function startReady(): Promise<string> {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      pushLine(child, systemInit('sess'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      return refineId
    }

    it('writes draft to disk and bumps agent_versions', async () => {
      const refineId = await startReady()
      const result = mgr.apply({ refineId })
      expect(result.ok).toBe(true)
      expect(result.version).toBe(1)
      const onDisk = fs.readFileSync(
        path.join(projectPath, '.claude', 'agents', 'custom-foo.md'),
        'utf8',
      )
      expect(onDisk).toContain('I am a refined custom-foo')
      const row = db
        .prepare(`SELECT MAX(version) AS v FROM agent_versions WHERE agent_name = ?`)
        .get('custom-foo') as { v: number }
      expect(row.v).toBe(1)
      expect(getRefineSession(db, refineId)!.status).toBe('applied')
    })

    it('returns disk_changed when the file changed under us', async () => {
      const refineId = await startReady()
      // Mutate the file on disk to invalidate the hash guard.
      fs.writeFileSync(
        path.join(projectPath, '.claude', 'agents', 'custom-foo.md'),
        'something else entirely\n',
        'utf8',
      )
      const result = mgr.apply({ refineId })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('disk_changed')
    })

    it('force-apply ignores disk_changed', async () => {
      const refineId = await startReady()
      fs.writeFileSync(
        path.join(projectPath, '.claude', 'agents', 'custom-foo.md'),
        'something else\n',
        'utf8',
      )
      const result = mgr.apply({ refineId, force: true })
      expect(result.ok).toBe(true)
    })

    it('returns name_changed when frontmatter `name` differs from agent id', async () => {
      const refineId = await startReady()
      const renamedDraft = VALID_BODY.replace('name: custom-foo', 'name: custom-foo-v2')
      // Patch the persisted draft directly.
      db.prepare(`UPDATE agent_refine_sessions SET draft_body = ? WHERE id = ?`).run(
        renamedDraft,
        refineId,
      )
      const result = mgr.apply({ refineId })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('name_changed')
    })

    it('returns session_not_found for unknown id', () => {
      expect(mgr.apply({ refineId: 'nope' }).reason).toBe('session_not_found')
    })

    it('returns invalid_state when there is no draft_body', () => {
      // Manually create a session with no draft.
      db.prepare(
        `INSERT INTO agent_refine_sessions
         (id, agent_id, base_version, base_body_hash, history_json, phase, status, auto_test, created_at, updated_at)
         VALUES ('s-empty', 'custom-foo', 0, 'h', '[]', 'idle', 'idle', 0, ?, ?)`,
      ).run(Date.now(), Date.now())
      const result = mgr.apply({ refineId: 's-empty' })
      expect(result.reason).toBe('invalid_state')
    })
  })

  // ─── relocate-artifacts: _agentFile reads + WRITES the workspace copy ───────

  describe('relocate-artifacts (_agentFile)', () => {
    let regHome: string
    let prevHome: string | undefined
    let relMgr: AgentRefineManager
    let wsAgentFile: string

    beforeEach(() => {
      regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-refine-reloc-home-')))
      fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
      prevHome = process.env.SPECRAILS_REGISTRY_HOME
      process.env.SPECRAILS_REGISTRY_HOME = regHome
      // Mirror a relocated entry + populate the workspace (core marker + agent).
      regMirror({ repoPath: projectPath, slug: 'reloc-proj', providers: ['claude'] }, regHome)
      const ws = regLayout(regResolveHome(regHome), 'reloc-proj', projectPath).workspaceDir
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
      fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true })
      wsAgentFile = path.join(ws, '.claude', 'agents', 'custom-foo.md')
      fs.writeFileSync(wsAgentFile, `---\nname: custom-foo\ndescription: "old"\nmodel: sonnet\ncolor: blue\nmemory: project\n---\n\n# Workspace body\n`, 'utf8')
      relMgr = new AgentRefineManager(broadcast, db, projectPath)
    })

    afterEach(() => {
      if (prevHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
      else process.env.SPECRAILS_REGISTRY_HOME = prevHome
      fs.rmSync(regHome, { recursive: true, force: true })
    })

    it('reads the workspace agent and WRITES the refined agent back to the workspace, not the repo', async () => {
      const repoFileBefore = fs.readFileSync(path.join(projectPath, '.claude', 'agents', 'custom-foo.md'), 'utf8')
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await relMgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      pushLine(child, systemInit('sess'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)

      const result = relMgr.apply({ refineId })
      expect(result.ok).toBe(true)
      // The WORKSPACE copy was rewritten with the refined body.
      expect(fs.readFileSync(wsAgentFile, 'utf8')).toContain('I am a refined custom-foo')
      // The REPO copy was NOT touched (the stale repo agent is left untouched).
      expect(fs.readFileSync(path.join(projectPath, '.claude', 'agents', 'custom-foo.md'), 'utf8')).toBe(repoFileBefore)
    })
  })

  // ─── isActive ─────────────────────────────────────────────────────────────

  describe('isActive', () => {
    it('returns true while a turn is mid-stream and false once closed', async () => {
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgr.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      expect(mgr.isActive(refineId)).toBe(true)
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      expect(mgr.isActive(refineId)).toBe(false)
    })
  })

  // ─── ai_invocations capture (surface='ai-edit') ────────────────────────────

  describe('ai_invocations capture', () => {
    it('writes a success row when projectId is set and result event arrives', async () => {
      const projectId = 'proj-refine-1'
      const mgrCap = new AgentRefineManager(broadcast, db, projectPath, projectId)
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      const { refineId } = await mgrCap.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      pushLine(child, systemInit('sess-r'))
      pushLine(child, assistantText(VALID_BODY))
      pushLine(child, JSON.stringify({
        type: 'result',
        session_id: 'sess-r',
        total_cost_usd: 0.25,
        num_turns: 1,
        model: 'sonnet',
        duration_ms: 1000,
        usage: { input_tokens: 50, output_tokens: 30 },
      }))
      await close(child, 0)
      const rows = db.prepare(`SELECT * FROM ai_invocations WHERE project_id = ?`).all(projectId) as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('ai-edit')
      expect(rows[0].surface_ref_id).toBe(refineId)
      expect(rows[0].status).toBe('success')
      expect(rows[0].total_cost_usd).toBeCloseTo(0.25)
      const inv = broadcast.mock.calls.find(([m]) => (m as { type?: string }).type === 'spending.invalidated')
      expect(inv).toBeDefined()
    })

    it('writes a failed row when refine exits with empty draft', async () => {
      const projectId = 'proj-refine-2'
      const mgrCap = new AgentRefineManager(broadcast, db, projectPath, projectId)
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      await mgrCap.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      await close(child, 0)
      const rows = db.prepare(`SELECT * FROM ai_invocations WHERE project_id = ?`).all(projectId) as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('failed')
    })

    it('skips capture when projectId is not provided', async () => {
      const projectId = 'proj-refine-3'
      const mgrNo = new AgentRefineManager(broadcast, db, projectPath)
      const child = createMockChild()
      vi.mocked(mockSpawnClaude).mockReturnValue(child as never)
      await mgrNo.startRefine({ agentId: 'custom-foo', instruction: 'go', autoTest: false })
      pushLine(child, systemInit('sess'))
      pushLine(child, assistantText(VALID_BODY))
      await close(child, 0)
      const rows = db.prepare(`SELECT * FROM ai_invocations WHERE project_id = ?`).all(projectId) as Array<Record<string, unknown>>
      expect(rows).toHaveLength(0)
    })
  })
})

// ─── Pure helper unit tests ─────────────────────────────────────────────────

describe('validateAgentBody', () => {
  it('accepts well-formed frontmatter', () => {
    const r = validateAgentBody(VALID_BODY)
    expect(r.ok).toBe(true)
  })

  it('rejects body without frontmatter delimiters', () => {
    expect(validateAgentBody('plain text').ok).toBe(false)
  })

  it('rejects unterminated frontmatter', () => {
    expect(validateAgentBody('---\nname: x\nmodel: sonnet\n').ok).toBe(false)
  })

  it('rejects missing name field', () => {
    const body = `---\ndescription: "x"\nmodel: sonnet\n---\nbody`
    expect(validateAgentBody(body).ok).toBe(false)
  })

  it('rejects unknown model values', () => {
    const body = `---\nname: custom-x\ndescription: "y"\nmodel: gpt-4\n---\nbody`
    expect(validateAgentBody(body).ok).toBe(false)
  })
})

describe('buildFirstTurnPrompt', () => {
  it('embeds the locked agent id and current body', () => {
    const out = buildFirstTurnPrompt({
      agentId: 'custom-foo',
      currentBody: '<<BODY>>',
      userInstruction: 'tighten it',
    })
    expect(out).toContain('custom-foo')
    expect(out).toContain('<<BODY>>')
    expect(out).toContain('tighten it')
    expect(out).toContain('locked')
  })
})
