import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

// Mock command-resolver to return a resolved prompt (different from raw command)
vi.mock('./command-resolver', () => ({
  resolveCommand: vi.fn((command: string) => 'Resolved prompt for: ' + command),
}))

import { spawn as mockSpawn } from 'child_process'
import treeKill from 'tree-kill'
import { ProposalManager } from './proposal-manager'
import { initDb, createProposal, getProposal } from './db'
import type { DbInstance } from './db'
import * as workspaceResolution from './workspace-resolution'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 42000
  child.kill = vi.fn()
  return child
}

function pushLine(child: any, line: string) {
  child.stdout.push(line + '\n')
}

function finishProcess(child: any, code: number): Promise<void> {
  return new Promise((resolve) => {
    child.stdout.push(null)
    setImmediate(() => {
      child.emit('close', code)
      resolve()
    })
  })
}

function assistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })
}

function resultEvent(sessionId: string): string {
  return JSON.stringify({ type: 'result', session_id: sessionId })
}

function getBroadcastedByType(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type)
}

const TEST_PROPOSAL_ID = 'proposal-test-001'
const TEST_CWD = '/fake/project/path'

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('ProposalManager', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let pm: ProposalManager

  beforeEach(() => {
    vi.resetAllMocks()
    db = initDb(':memory:')
    broadcast = vi.fn()
    pm = new ProposalManager(broadcast, db, TEST_CWD)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setupProposal(id = TEST_PROPOSAL_ID, idea = 'Add dark mode') {
    createProposal(db, { id, idea })
    return id
  }

  // ─── startExploration ──────────────────────────────────────────────────────

  describe('startExploration', () => {
    it('spawns claude with correct args', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      await finishProcess(child, 0)
      await explorePromise

      expect(vi.mocked(mockSpawn)).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '-p',
        ]),
        expect.objectContaining({ cwd: TEST_CWD })
      )
    })

    it('materializes the installed Kimi workflow before the headless spawn', async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'proposal-kimi-skill-'))
      const skillDir = path.join(
        root,
        '.kimi-code',
        'skills',
        'specrails-propose-feature',
      )
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: specrails-propose-feature\ndescription: test\ntype: prompt\n---\nPropose: $ARGUMENTS\n',
      )
      const kimi = new ProposalManager(broadcast, db, root, undefined, 'kimi')
      expect(kimi.canStartExploration()).toBe(true)
      const proposalId = setupProposal('proposal-kimi')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = kimi.startExploration(proposalId, 'Add passkeys')
      const [binary, args] = vi.mocked(mockSpawn).mock.calls[0] as [string, string[]]
      expect(binary).toBe('kimi')
      const prompt = args[args.indexOf('-p') + 1]
      expect(prompt).toContain('Propose: Add passkeys')
      expect(prompt).toContain('<kimi-skill-loaded')
      expect(prompt).not.toContain('/skill:specrails-propose-feature')
      await finishProcess(child, 0)
      await explorePromise
      kimi.shutdown()
      rmSync(root, { recursive: true, force: true })
    })

    it('fails the provider-aware Kimi preflight when the workflow is absent', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'proposal-kimi-missing-'))
      const kimi = new ProposalManager(broadcast, db, root, undefined, 'kimi')
      expect(kimi.canStartExploration()).toBe(false)
      kimi.shutdown()
      rmSync(root, { recursive: true, force: true })
    })

    it('uses relocated Kimi skills/cwd, grants repo access, and fails on an explicit error with exit 0', async () => {
      const repo = mkdtempSync(path.join(os.tmpdir(), 'proposal-kimi-repo-'))
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'proposal-kimi-workspace-'))
      const skillDir = path.join(
        workspace,
        '.kimi-code',
        'skills',
        'specrails-propose-feature',
      )
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: specrails-propose-feature\ndescription: test\ntype: prompt\n---\nPropose: $ARGUMENTS\n',
      )
      vi.spyOn(workspaceResolution, 'resolveProjectExecution').mockReturnValue({
        relocated: true,
        cwd: workspace,
        repoDir: repo,
        workspaceDir: workspace,
        env: { SPECRAILS_REPO_DIR: repo },
      } as any)
      const kimi = new ProposalManager(broadcast, db, repo, 'p1', 'kimi', 'slug')
      expect(kimi.canStartExploration()).toBe(true)
      const proposalId = setupProposal('proposal-kimi-relocated')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = kimi.startExploration(proposalId, 'Add passkeys')
      const [binary, args, options] = vi.mocked(mockSpawn).mock.calls[0] as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv },
      ]
      expect(binary).toBe('kimi')
      expect(args[args.indexOf('-p') + 1]).toContain('<kimi-skill-loaded')
      expect(args).toEqual(expect.arrayContaining(['--add-dir', repo]))
      expect(options.cwd).toBe(workspace)
      expect(options.env.SPECRAILS_REPO_DIR).toBe(repo)

      pushLine(child, JSON.stringify({
        role: 'meta',
        type: 'system.error',
        message: 'Authentication required. Run kimi login.',
      }))
      await finishProcess(child, 0)
      await explorePromise

      expect(getProposal(db, proposalId)?.status).toBe('input')
      expect(getBroadcastedByType(broadcast, 'proposal_ready')).toHaveLength(0)
      expect(getBroadcastedByType(broadcast, 'proposal_error')).toEqual([
        expect.objectContaining({ error: 'Authentication required. Run kimi login.' }),
      ])
      kimi.shutdown()
      rmSync(repo, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    })

    it('broadcasts proposal_stream deltas as text arrives', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')

      pushLine(child, assistantEvent('## Feature Title\n'))
      pushLine(child, assistantEvent('Add Dark Mode'))
      pushLine(child, resultEvent('sess-001'))
      await finishProcess(child, 0)
      await explorePromise

      const streamMsgs = getBroadcastedByType(broadcast, 'proposal_stream')
      expect(streamMsgs.length).toBeGreaterThan(0)
      expect(streamMsgs[0].proposalId).toBe(proposalId)
      expect(streamMsgs[0].delta).toBeTruthy()
    })

    it('captures session_id from result event', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantEvent('Some content'))
      pushLine(child, resultEvent('sess-captured-001'))
      await finishProcess(child, 0)
      await explorePromise

      const row = getProposal(db, proposalId)!
      expect(row.session_id).toBe('sess-captured-001')
    })

    it('broadcasts proposal_ready with full markdown on close(0)', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantEvent('## Feature Title\nAdd Dark Mode'))
      pushLine(child, resultEvent('sess-002'))
      await finishProcess(child, 0)
      await explorePromise

      const readyMsgs = getBroadcastedByType(broadcast, 'proposal_ready')
      expect(readyMsgs).toHaveLength(1)
      expect(readyMsgs[0].proposalId).toBe(proposalId)
      expect(readyMsgs[0].markdown).toContain('Add Dark Mode')
    })

    it('updates proposal status to review on success', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantEvent('Content'))
      pushLine(child, resultEvent('sess-003'))
      await finishProcess(child, 0)
      await explorePromise

      const row = getProposal(db, proposalId)!
      expect(row.status).toBe('review')
    })

    it('broadcasts proposal_error and resets status to input on close(non-0)', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      await finishProcess(child, 1)
      await explorePromise

      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(errorMsgs[0].proposalId).toBe(proposalId)

      const row = getProposal(db, proposalId)!
      expect(row.status).toBe('input')
    })

    it('does nothing if proposal not found in DB', async () => {
      vi.mocked(mockSpawn)

      await pm.startExploration('nonexistent-id', 'some idea')

      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })
  })

  // ─── sendRefinement ────────────────────────────────────────────────────────

  describe('sendRefinement', () => {
    it('spawns with --resume <session_id>', async () => {
      const proposalId = setupProposal()
      // Set up proposal in review state with session_id
      const db2 = db
      db2.prepare("UPDATE proposals SET status = 'review', session_id = ? WHERE id = ?")
        .run('sess-existing', proposalId)

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const refinePromise = pm.sendRefinement(proposalId, 'Make it simpler')
      pushLine(child, assistantEvent('Simplified'))
      pushLine(child, resultEvent('sess-refined'))
      await finishProcess(child, 0)
      await refinePromise

      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--resume')
      expect(spawnArgs).toContain('sess-existing')
    })

    it('broadcasts proposal_refined on success', async () => {
      const proposalId = setupProposal()
      db.prepare("UPDATE proposals SET status = 'review', session_id = 'sess-r1' WHERE id = ?").run(proposalId)

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const refinePromise = pm.sendRefinement(proposalId, 'Refine this')
      pushLine(child, assistantEvent('Refined content'))
      pushLine(child, resultEvent('sess-r2'))
      await finishProcess(child, 0)
      await refinePromise

      const refinedMsgs = getBroadcastedByType(broadcast, 'proposal_refined')
      expect(refinedMsgs).toHaveLength(1)
      expect(refinedMsgs[0].proposalId).toBe(proposalId)
      expect(refinedMsgs[0].markdown).toContain('Refined content')
    })

    it('returns early and broadcasts error if session_id is null', async () => {
      const proposalId = setupProposal()
      // session_id is null by default

      await pm.sendRefinement(proposalId, 'Some feedback')

      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })
  })

  // ─── createIssue ──────────────────────────────────────────────────────────

  describe('createIssue', () => {
    it('extracts GitHub URL from response and broadcasts proposal_issue_created', async () => {
      const proposalId = setupProposal()
      db.prepare("UPDATE proposals SET status = 'review', session_id = 'sess-ci1' WHERE id = ?").run(proposalId)

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const issuePromise = pm.createIssue(proposalId)
      pushLine(child, assistantEvent('I created the issue.\nhttps://github.com/owner/repo/issues/99'))
      pushLine(child, resultEvent('sess-ci2'))
      await finishProcess(child, 0)
      await issuePromise

      const issueMsgs = getBroadcastedByType(broadcast, 'proposal_issue_created')
      expect(issueMsgs).toHaveLength(1)
      expect(issueMsgs[0].proposalId).toBe(proposalId)
      expect(issueMsgs[0].issueUrl).toBe('https://github.com/owner/repo/issues/99')
    })

    it('broadcasts proposal_error if no GitHub URL found in response', async () => {
      const proposalId = setupProposal()
      db.prepare("UPDATE proposals SET status = 'review', session_id = 'sess-ci3' WHERE id = ?").run(proposalId)

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const issuePromise = pm.createIssue(proposalId)
      pushLine(child, assistantEvent('I could not create the issue. GitHub CLI not found.'))
      pushLine(child, resultEvent('sess-ci4'))
      await finishProcess(child, 0)
      await issuePromise

      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(errorMsgs[0].proposalId).toBe(proposalId)
    })

    it('updates proposal status to created when URL found', async () => {
      const proposalId = setupProposal()
      db.prepare("UPDATE proposals SET status = 'review', session_id = 'sess-ci5' WHERE id = ?").run(proposalId)

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const issuePromise = pm.createIssue(proposalId)
      pushLine(child, assistantEvent('Done. https://github.com/owner/repo/issues/123'))
      pushLine(child, resultEvent('sess-ci6'))
      await finishProcess(child, 0)
      await issuePromise

      const row = getProposal(db, proposalId)!
      expect(row.status).toBe('created')
      expect(row.issue_url).toBe('https://github.com/owner/repo/issues/123')
    })
  })

  // ─── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('calls treeKill with SIGTERM on active process', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // Start exploration to create an active process
      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')

      pm.cancel(proposalId)

      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')

      // Let the process close to avoid open handles
      await finishProcess(child, 1)
      await explorePromise
    })

    it('updates proposal status to cancelled', () => {
      const proposalId = setupProposal()

      pm.cancel(proposalId)

      const row = getProposal(db, proposalId)!
      expect(row.status).toBe('cancelled')
    })

    it('broadcasts proposal_error with error: cancelled', () => {
      const proposalId = setupProposal()

      pm.cancel(proposalId)

      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(errorMsgs[0].error).toBe('cancelled')
    })

    it('does nothing if no active process (cancel still updates DB)', () => {
      const proposalId = setupProposal()

      pm.cancel(proposalId)

      expect(vi.mocked(treeKill)).not.toHaveBeenCalled()
      // DB update and broadcast still happen
      expect(getProposal(db, proposalId)!.status).toBe('cancelled')
    })

    // ─── BUG-LONGTAIL-01: cancel must not be clobbered by the killed child's close ─
    it('keeps status=cancelled and emits no failure when the killed child closes non-zero', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      pm.cancel(proposalId)
      // The killed child exits non-zero a moment later (SIGTERM → 143).
      await finishProcess(child, 143)
      await explorePromise

      // Status stays 'cancelled' — the close handler short-circuited rather than
      // calling onError() (which would write 'input').
      expect(getProposal(db, proposalId)!.status).toBe('cancelled')

      // Exactly one proposal_error broadcast — the 'cancelled' one from cancel();
      // no second spurious "Exploration failed".
      const errorMsgs = getBroadcastedByType(broadcast, 'proposal_error')
      expect(errorMsgs).toHaveLength(1)
      expect(errorMsgs[0].error).toBe('cancelled')
    })

    // ─── BUG-LONGTAIL-02: SIGKILL escalation after SIGTERM ─────────────────────
    it('escalates to SIGKILL ~2s after cancel when the child ignores SIGTERM', async () => {
      vi.useFakeTimers()
      try {
        const proposalId = setupProposal()
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void pm.startExploration(proposalId, 'Add dark mode')
        pm.cancel(proposalId)

        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
        // Child never closes — advance past the 2s grace window.
        vi.advanceTimersByTime(2000)
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
    })

    it('does NOT escalate to SIGKILL when the child closes before the grace window', async () => {
      vi.useFakeTimers()
      try {
        const proposalId = setupProposal()
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void pm.startExploration(proposalId, 'Add dark mode')
        pm.cancel(proposalId)
        // Child exits promptly on SIGTERM (close fires synchronously here).
        child.stdout.push(null)
        child.emit('close', 143)

        vi.advanceTimersByTime(5000)
        const sigkillCalls = vi.mocked(treeKill).mock.calls.filter((c) => c[1] === 'SIGKILL')
        expect(sigkillCalls).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── shutdown ─────────────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('SIGTERMs active children and arms SIGKILL escalation', async () => {
      vi.useFakeTimers()
      try {
        const proposalId = setupProposal()
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)

        void pm.startExploration(proposalId, 'Add dark mode')
        pm.shutdown()

        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
        vi.advanceTimersByTime(2000)
        expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── isActive ─────────────────────────────────────────────────────────────

  describe('isActive', () => {
    it('returns false before exploration starts', () => {
      const proposalId = setupProposal()
      expect(pm.isActive(proposalId)).toBe(false)
    })

    it('returns true while exploration is running', () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      pm.startExploration(proposalId, 'Add dark mode')
      expect(pm.isActive(proposalId)).toBe(true)

      // Cleanup
      child.stdout.push(null)
      child.emit('close', 0)
    })

    it('returns false after exploration completes', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const explorePromise = pm.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantEvent('Content'))
      pushLine(child, resultEvent('sess-x'))
      await finishProcess(child, 0)
      await explorePromise

      expect(pm.isActive(proposalId)).toBe(false)
    })
  })

  // ─── ai_invocations recording (COST-ACCOUNTING-AUDIT HIGH-6) ─────────────────

  describe('recording (surface=proposal)', () => {
    let pmRec: ProposalManager

    function assistantUsageEvent(text: string, usage: Record<string, number>, model = 'claude-sonnet-4-6', id = 'msg-1') {
      return JSON.stringify({
        type: 'assistant',
        message: { id, model, usage, content: [{ type: 'text', text }] },
      })
    }
    function resultCostEvent(sessionId: string, opts: Record<string, unknown>) {
      return JSON.stringify({ type: 'result', session_id: sessionId, ...opts })
    }
    function rows() {
      return db.prepare('SELECT * FROM ai_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
    }

    beforeEach(() => {
      pmRec = new ProposalManager(broadcast, db, TEST_CWD, 'p1')
    })

    it('records a success row with native cost on a completed exploration', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = pmRec.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantUsageEvent('exploring', { input_tokens: 100, output_tokens: 50 }))
      pushLine(child, resultCostEvent('sess-1', { total_cost_usd: 0.9, usage: { input_tokens: 100, output_tokens: 50 } }))
      await finishProcess(child, 0)
      await p

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].surface).toBe('proposal')
      expect(r[0].surface_ref_id).toBe(proposalId)
      expect(r[0].status).toBe('success')
      expect(r[0].total_cost_usd).toBe(0.9)
      expect(r[0].total_cost_usd_estimated).toBe(0)
      expect(getBroadcastedByType(broadcast, 'spending.invalidated')).toHaveLength(1)
    })

    it('records a distinct row per spawn (exploration + refinement)', async () => {
      const proposalId = setupProposal()
      const child1 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child1 as any)
      const explore = pmRec.startExploration(proposalId, 'Add dark mode')
      pushLine(child1, resultCostEvent('sess-1', { total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } }))
      await finishProcess(child1, 0)
      await explore

      const child2 = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child2 as any)
      const refine = pmRec.sendRefinement(proposalId, 'make it darker')
      pushLine(child2, resultCostEvent('sess-1', { total_cost_usd: 0.3, usage: { input_tokens: 8, output_tokens: 4 } }))
      await finishProcess(child2, 0)
      await refine

      const r = rows()
      expect(r).toHaveLength(2)
      expect(r.every((row) => row.surface === 'proposal')).toBe(true)
    })

    it('records an estimated-cost aborted row on cancel', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = pmRec.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantUsageEvent('working', { input_tokens: 4000, output_tokens: 2000 }))
      await new Promise<void>((resolve) => setImmediate(resolve))
      pmRec.cancel(proposalId)
      await finishProcess(child, 143)
      await p

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('aborted')
      expect(r[0].total_cost_usd_estimated).toBe(1)
      expect(r[0].total_cost_usd as number).toBeGreaterThan(0)
    })

    it('records a failed row on non-zero exit', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = pmRec.startExploration(proposalId, 'Add dark mode')
      await finishProcess(child, 1)
      await p

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('failed')
    })

    it('does NOT record when the project is being disposed', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const p = pmRec.startExploration(proposalId, 'Add dark mode')
      pushLine(child, assistantUsageEvent('working', { input_tokens: 100, output_tokens: 50 }))
      await new Promise<void>((resolve) => setImmediate(resolve))
      pmRec.shutdown()
      await finishProcess(child, 143)
      await p

      expect(rows()).toHaveLength(0)
    })

    it('records nothing when constructed without a projectId (byte-identical)', async () => {
      const proposalId = setupProposal()
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // `pm` from the outer beforeEach has no projectId.
      const p = pm.startExploration(proposalId, 'Add dark mode')
      pushLine(child, resultCostEvent('sess-1', { total_cost_usd: 0.9 }))
      await finishProcess(child, 0)
      await p

      expect(rows()).toHaveLength(0)
    })
  })
})
