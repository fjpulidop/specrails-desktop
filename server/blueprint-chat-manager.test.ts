import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { premiumSpec } from './blueprint-spec-fixtures'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing anything that spawns (mirrors
// agent-chat-manager.test.ts — spawnCli calls child_process.spawn on POSIX).
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./builder-cwd-manager', () => ({
  ensureBuilderCwd: vi.fn(() => '/tmp/builder-cwd-test'),
}))

import { spawn as mockSpawn } from 'child_process'
import treeKill from 'tree-kill'
import { BlueprintChatManager } from './blueprint-chat-manager'
import { initDesktopDb } from './desktop-db'
import {
  createBlueprintConversation,
  getBlueprintConversation,
  listBlueprintMessages,
  updateBlueprintConversation,
} from './blueprint-store'
import type { DbInstance } from './db'

beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
})

function createMockChildProcess(): any {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 52000
  child.kill = vi.fn()
  return child
}

function primeTurn(lines: string[], code = 0): void {
  ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
    const child = createMockChildProcess()
    setImmediate(() => {
      for (const l of lines) child.stdout.push(l + '\n')
      child.stdout.push(null)
      setImmediate(() => child.emit('close', code))
    })
    return child
  })
}

function assistantLine(text: string, usage?: Record<string, number>, model = 'claude-sonnet-4'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model, content: [{ type: 'text', text }], ...(usage ? { usage } : {}) },
  })
}

function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', ...fields })
}

function broadcastsOfType(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((m) => m.type === type)
}

const SNAPSHOT = {
  blueprintVersion: 1,
  product: { name: 'Recipely', pitch: 'p', audience: 'a' },
  coreFlow: 'flow',
  platform: 'web',
  stack: { language: 'ts', framework: 'next', db: 'sqlite' },
  assumptions: [],
  milestones: [],
  m1Specs: [],
}

describe('BlueprintChatManager', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: BlueprintChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new BlueprintChatManager(broadcast, db)
  })

  function invocationRows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
  }

  it('streams deltas, strips the blueprint block, persists messages and broadcasts the snapshot', async () => {
    const conv = createBlueprintConversation(db)
    const fenced = '```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'
    primeTurn([
      assistantLine('Here is the plan.\n' + fenced, { input_tokens: 10, output_tokens: 5 }),
      resultLine({ session_id: 'sess-1', total_cost_usd: 0.01 }),
    ])

    await mgr.sendMessage(conv.id, 'an app for recipes')

    const streams = broadcastsOfType(broadcast, 'blueprint.stream')
    expect(streams.length).toBeGreaterThan(0)
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].fullText).not.toContain('blueprint-draft')
    expect((done[0].blueprint as { product: { name: string } }).product.name).toBe('Recipely')
    expect((done[0].rawBlueprint as { product: { name: string } }).product.name).toBe('Recipely')

    const messages = listBlueprintMessages(db, conv.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toBe('Here is the plan.')

    const fresh = getBlueprintConversation(db, conv.id)
    expect(fresh?.session_id).toBe('sess-1')
    // deterministic auto-title from the first user prompt
    expect(fresh?.title).toBeTruthy()

    const rows = invocationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].project_id).toBeNull()
    expect(rows[0].status).toBe('success')
  })

  it('a decision-card turn persists its intent on the user row', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('Proposal.'), resultLine({ session_id: 'i-1' })])
    await mgr.sendMessage(conv.id, 'Surprise me', { intent: 'surprise' })
    primeTurn([assistantLine('Generating.'), resultLine({ session_id: 'i-1' })])
    await mgr.sendMessage(conv.id, 'Approved', { intent: 'approve' })
    primeTurn([assistantLine('Sure.'), resultLine({ session_id: 'i-1' })])
    await mgr.sendMessage(conv.id, 'typed')
    expect(listBlueprintMessages(db, conv.id).filter((m) => m.role === 'user').map((m) => m.intent)).toEqual(['surprise', 'approve', null])
  })

  it('forwards a valid effort to the provider spawn and drops an invalid one', async () => {
    const valid = createBlueprintConversation(db)
    primeTurn([assistantLine('High-effort answer'), resultLine({ session_id: 'effort-session' })])
    await mgr.sendMessage(valid.id, 'think carefully', { reasoningEffort: 'high' })

    const validArgs = vi.mocked(mockSpawn).mock.calls[0]?.[1] as string[]
    const effortIndex = validArgs.indexOf('--effort')
    expect(effortIndex).toBeGreaterThanOrEqual(0)
    expect(validArgs[effortIndex + 1]).toBe('high')

    const invalid = createBlueprintConversation(db)
    primeTurn([assistantLine('Default-effort answer'), resultLine({ session_id: 'default-session' })])
    await mgr.sendMessage(invalid.id, 'ignore invalid effort', { reasoningEffort: 'turbo' })

    const invalidArgs = vi.mocked(mockSpawn).mock.calls[1]?.[1] as string[]
    expect(invalidArgs).not.toContain('--effort')
  })

  it('rejects Kimi before persistence or spawn when no pure-output policy exists', async () => {
    const conv = createBlueprintConversation(db, { provider: 'kimi', model: 'k3' })
    await mgr.sendMessage(conv.id, 'first request')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listBlueprintMessages(db, conv.id)).toEqual([])
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toEqual([
      expect.objectContaining({
        error: 'provider_tool_policy_unsupported:kimi:pure-output',
      }),
    ])
  })

  it('unknown conversation emits blueprint.error', async () => {
    await mgr.sendMessage('nope', 'hi')
    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Unknown conversation/)
  })

  it('spawn failure surfaces a launch error and records a failed row', async () => {
    const conv = createBlueprintConversation(db)
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => child.emit('error', new Error('ENOENT')))
      return child
    })

    await mgr.sendMessage(conv.id, 'hi')

    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/Failed to launch/)
    expect(invocationRows()[0].status).toBe('failed')
  })

  it('empty output surfaces the exit-code reason and resets the session', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: null })
    primeTurn([], 1)

    await mgr.sendMessage(conv.id, 'hi')

    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(invocationRows()[0].status).toBe('failed')
    expect(getBlueprintConversation(db, conv.id)?.session_id).toBeNull()
  })

  it('auto-heals a stale resume: no-text resume retries fresh once', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: 'stale-sess' })
    primeTurn([], 0) // resume yields nothing
    primeTurn([assistantLine('Fresh answer'), resultLine({ session_id: 'new-sess' })])

    await mgr.sendMessage(conv.id, 'hi')

    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].fullText).toBe('Fresh answer')
    expect(getBlueprintConversation(db, conv.id)?.session_id).toBe('new-sess')
    // one settled row for the turn (the retry outcome is what's recorded)
    expect(invocationRows()).toHaveLength(1)
    expect(invocationRows()[0].status).toBe('success')
  })

  it('abort mid-turn keeps partial text, records aborted, never errors', async () => {
    const conv = createBlueprintConversation(db)
    let child: any
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('Partial thought') + '\n')
        // abort while streaming, then the killed child closes
        setImmediate(() => {
          mgr.abort(conv.id)
          child.stdout.push(null)
          setImmediate(() => child.emit('close', null))
        })
      })
      return child
    })

    await mgr.sendMessage(conv.id, 'hi')

    expect(vi.mocked(treeKill)).toHaveBeenCalled()
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    const rows = invocationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('aborted')
    const messages = listBlueprintMessages(db, conv.id)
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('Partial thought'))).toBe(true)
  })

  it('busy conversation rejects a second concurrent send with blueprint.error', async () => {
    const conv = createBlueprintConversation(db)
    let release: () => void = () => {}
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('working') + '\n')
        release = () => {
          child.stdout.push(null)
          setImmediate(() => child.emit('close', 0))
        }
      })
      return child
    })

    const first = mgr.sendMessage(conv.id, 'one')
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.isStreaming(conv.id)).toBe(true)
    await mgr.sendMessage(conv.id, 'two')
    const errors = broadcastsOfType(broadcast, 'blueprint.error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/already streaming/)
    release()
    await first
  })

  it('shutdown kills live children and gates further sends', async () => {
    const conv = createBlueprintConversation(db)
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('never settles') + '\n')
      })
      return child
    })
    const pending = mgr.sendMessage(conv.id, 'hi')
    await new Promise((r) => setTimeout(r, 20))
    mgr.shutdown()
    await pending
    expect(vi.mocked(treeKill)).toHaveBeenCalled()
    await mgr.sendMessage(conv.id, 'after shutdown') // no throw, no broadcast
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
  })
})

// ─── Snapshot repair loop + durable snapshots (harden-project-builder-snapshots)

function completeSnapshot() {
  return {
    ...SNAPSHOT,
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: true,
    m1Specs: Array.from({ length: 5 }, (_, index) => premiumSpec(index)),
  }
}

function spawnArgsOf(call: number): string[] {
  return (mockSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[call]?.[1] as string[]
}

describe('BlueprintChatManager snapshot repair + persistence', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: BlueprintChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new BlueprintChatManager(broadcast, db)
  })

  function invocationRows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC, rowid ASC').all() as Array<Record<string, unknown>>
  }

  it('persists an accepted snapshot pair + the unstripped raw reply, and reports status accepted', async () => {
    const conv = createBlueprintConversation(db)
    const fenced = '```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'
    primeTurn([assistantLine('Plan.\n' + fenced), resultLine({ session_id: 'sess-1' })])
    await mgr.sendMessage(conv.id, 'an app')

    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'accepted', repaired: false, claimsComplete: false }))
    const row = getBlueprintConversation(db, conv.id)!
    expect(JSON.parse(row.raw_blueprint_json!)).toEqual(SNAPSHOT)
    expect(JSON.parse(row.blueprint_json!).product.name).toBe('Recipely')
    expect(row.snapshot_updated_at).toBeTruthy()
    const assistant = listBlueprintMessages(db, conv.id).find((m) => m.role === 'assistant')!
    expect(assistant.content).toBe('Plan.')
    expect(assistant.raw_content).toContain('```blueprint-draft')
  })

  it('a snapshot the model wrapped in a ```json fence is accepted like a blueprint-draft block', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('¿Aprobamos?\n\n```json\n' + JSON.stringify(SNAPSHOT, null, 2) + '\n```'), resultLine({ session_id: 'sess-j' })])
    await mgr.sendMessage(conv.id, 'sorpréndeme')
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'accepted' }))
    expect((done[0].blueprint as { product: { name: string } }).product.name).toBe('Recipely')
    expect(done[0].fullText).toBe('¿Aprobamos?')
    const messages = listBlueprintMessages(db, conv.id)
    expect(messages[1].content).toBe('¿Aprobamos?')
    expect(messages[1].raw_content).toContain('```json')
    expect(getBlueprintConversation(db, conv.id)!.raw_blueprint_json).not.toBeNull()
  })

  it('a block-only reply persists an empty transcript row whose raw payload survives', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'), resultLine({ session_id: 's' })])
    await mgr.sendMessage(conv.id, 'go')
    const assistant = listBlueprintMessages(db, conv.id).find((m) => m.role === 'assistant')!
    expect(assistant.content).toBe('')
    expect(assistant.raw_content).toContain('"blueprintVersion"')
    expect(broadcastsOfType(broadcast, 'blueprint.done')[0].fullText).toBe('')
  })

  it('invalid JSON block → ONE automatic repair turn on the same session → accepted + repaired', async () => {
    const conv = createBlueprintConversation(db)
    const broken = '```blueprint-draft\n{"blueprintVersion": 1, "product": {"name": "A" "pitch": "p"}}\n```'
    primeTurn([assistantLine('Here is the plan.\n' + broken), resultLine({ session_id: 'sess-1' })])
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'), resultLine({ session_id: 'sess-1' })])

    await mgr.sendMessage(conv.id, 'an app')

    expect(mockSpawn).toHaveBeenCalledTimes(2)
    const repairArgs = spawnArgsOf(1)
    expect(repairArgs).toContain('--resume')
    expect(repairArgs).toContain('sess-1')
    expect(repairArgs.join(' ')).toMatch(/APP CHECK: your last blueprint-draft block was REJECTED/)

    const repairing = broadcastsOfType(broadcast, 'blueprint.repairing')
    expect(repairing).toEqual([expect.objectContaining({ kind: 'invalid_json', attempt: 1, manual: false })])
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].fullText).toBe('Here is the plan.')
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'accepted', repaired: true, repairAttempted: true }))
    expect((done[0].blueprint as { product: { name: string } }).product.name).toBe('Recipely')
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    // Both spawns billed.
    expect(invocationRows().map((r) => r.status)).toEqual(['success', 'success'])
    // Rejection cleared once accepted.
    expect(getBlueprintConversation(db, conv.id)!.snapshot_issue_json).toBeNull()
  })

  it('cut-off block → truncated repair prompt (tighten) → accepted', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('Generating.\n```blueprint-draft\n{"blueprintVersion": 1, "m1Specs": [{"title": "a"}, {"title'), resultLine({ session_id: 's1' })])
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'), resultLine({ session_id: 's1' })])
    await mgr.sendMessage(conv.id, 'generate')
    expect(spawnArgsOf(1).join(' ')).toMatch(/CUT OFF before its closing fence/)
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')[0].kind).toBe('truncated')
    const done = broadcastsOfType(broadcast, 'blueprint.done')[0]
    expect(done.fullText).toBe('Generating.')
    expect(done.snapshot).toEqual(expect.objectContaining({ status: 'accepted', repaired: true }))
    // The partial JSON never reached the transcript.
    const assistant = listBlueprintMessages(db, conv.id).filter((m) => m.role === 'assistant')
    expect(assistant[0].content).toBe('Generating.')
  })

  it('repair still unusable → done reports rejected + repairAttempted, persists the issue, never errors', async () => {
    const conv = createBlueprintConversation(db)
    const broken = '```blueprint-draft\n{"blueprintVersion": 1, "product": {"name": "A" "pitch": "p"}}\n```'
    primeTurn([assistantLine('Plan.\n' + broken), resultLine({ session_id: 'sess-1' })])
    primeTurn([assistantLine('Still broken.\n' + broken), resultLine({ session_id: 'sess-1' })])
    await mgr.sendMessage(conv.id, 'an app')
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'rejected', reason: 'invalid_json', repairAttempted: true }))
    expect(done[0].fullText).toBe('Plan.\n\nStill broken.')
    expect(done[0].blueprint).toBeNull()
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    const issue = JSON.parse(getBlueprintConversation(db, conv.id)!.snapshot_issue_json!)
    expect(issue.reason).toBe('invalid_json')
  })

  it('claimed complete but the audit disagrees → quality repair turn listing the issues → fixed snapshot accepted', async () => {
    const conv = createBlueprintConversation(db)
    const flawed = completeSnapshot()
    flawed.m1Specs[2].acceptanceCriteria = ['Works.']
    primeTurn([assistantLine('Backlog ready.\n```blueprint-draft\n' + JSON.stringify(flawed) + '\n```'), resultLine({ session_id: 's' })])
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(completeSnapshot()) + '\n```'), resultLine({ session_id: 's' })])
    await mgr.sendMessage(conv.id, 'yes')
    const prompt = spawnArgsOf(1).join(' ')
    expect(prompt).toMatch(/deterministic audit rejected/)
    expect(prompt).toMatch(/spec 3 acceptanceCriteria requires 6-10 items/)
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')[0].kind).toBe('quality')
    const done = broadcastsOfType(broadcast, 'blueprint.done')[0]
    expect(done.snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true, repairAttempted: true }))
    expect((done.snapshot as { qualityIssues?: unknown[] }).qualityIssues).toBeUndefined()
  })

  it('quality repair that still fails delivers the snapshot WITH the localized-ready issues', async () => {
    const conv = createBlueprintConversation(db)
    const flawed = completeSnapshot()
    flawed.m1Specs[2].acceptanceCriteria = ['Works.']
    const block = '```blueprint-draft\n' + JSON.stringify(flawed) + '\n```'
    primeTurn([assistantLine('Backlog ready.\n' + block), resultLine({ session_id: 's' })])
    primeTurn([assistantLine(block), resultLine({ session_id: 's' })])
    await mgr.sendMessage(conv.id, 'yes')
    const done = broadcastsOfType(broadcast, 'blueprint.done')[0]
    const snapshot = done.snapshot as { status: string; qualityIssues?: Array<{ code: string; params?: Record<string, unknown> }> }
    expect(snapshot.status).toBe('accepted')
    expect(snapshot.qualityIssues?.some((i) => i.code === 'criteria_count' && i.params?.n === 3)).toBe(true)
    expect(done.blueprint).not.toBeNull()
  })

  it('a complete valid batch never triggers a repair turn', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('Done.\n```blueprint-draft\n' + JSON.stringify(completeSnapshot()) + '\n```'), resultLine({ session_id: 's' })])
    await mgr.sendMessage(conv.id, 'yes')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')).toHaveLength(0)
    expect(broadcastsOfType(broadcast, 'blueprint.done')[0].snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true, repairAttempted: false }))
  })

  it('without a session id the rejection is reported without an automatic repair', async () => {
    const conv = createBlueprintConversation(db)
    const broken = '```blueprint-draft\n{"blueprintVersion": 1, "product": {"name": "A" "pitch": "p"}}\n```'
    primeTurn([assistantLine('Plan.\n' + broken), resultLine({})])
    await mgr.sendMessage(conv.id, 'an app')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(broadcastsOfType(broadcast, 'blueprint.done')[0].snapshot).toEqual(expect.objectContaining({ status: 'rejected', repairAttempted: false }))
  })

  it('a failed repair spawn leaves the original outcome standing (no blueprint.error)', async () => {
    const conv = createBlueprintConversation(db)
    const broken = '```blueprint-draft\n{"blueprintVersion": 1, "product": {"name": "A" "pitch": "p"}}\n```'
    primeTurn([assistantLine('Plan.\n' + broken), resultLine({ session_id: 's' })])
    primeTurn([], 1)
    await mgr.sendMessage(conv.id, 'an app')
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'rejected', repairAttempted: true }))
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    expect(invocationRows().map((r) => r.status)).toEqual(['success', 'failed'])
  })

  describe('repairSnapshot (manual)', () => {
    it('refuses unknown / streaming / nothing-to-repair / no-session', async () => {
      expect(await mgr.repairSnapshot('nope')).toEqual({ ok: false, reason: 'unknown_conversation' })
      const conv = createBlueprintConversation(db)
      expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: false, reason: 'nothing_to_repair' })
      const { saveBlueprintSnapshotIssue } = await import('./blueprint-store')
      saveBlueprintSnapshotIssue(db, conv.id, { reason: 'invalid_json', detail: 'x', at: 'now' })
      expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: false, reason: 'no_session' })
    })

    it('runs ONE repair turn from the persisted rejection and accepts the re-emitted block', async () => {
      const conv = createBlueprintConversation(db)
      const { saveBlueprintSnapshotIssue } = await import('./blueprint-store')
      updateBlueprintConversation(db, conv.id, { session_id: 'sess-9' })
      saveBlueprintSnapshotIssue(db, conv.id, { reason: 'truncated', detail: 'cut after 3 specs', at: 'now' })
      primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(SNAPSHOT) + '\n```'), resultLine({ session_id: 'sess-9' })])

      const outcome = await mgr.repairSnapshot(conv.id)
      expect(outcome).toEqual({ ok: true, kind: 'truncated' })
      await vi.waitFor(() => expect(broadcastsOfType(broadcast, 'blueprint.done')).toHaveLength(1))

      expect(spawnArgsOf(0)).toContain('--resume')
      expect(broadcastsOfType(broadcast, 'blueprint.repairing')[0]).toEqual(expect.objectContaining({ kind: 'truncated', manual: true }))
      const done = broadcastsOfType(broadcast, 'blueprint.done')[0]
      expect(done.snapshot).toEqual(expect.objectContaining({ status: 'accepted', repaired: true, repairAttempted: true }))
      // No user message row was added for the app-issued prompt.
      expect(listBlueprintMessages(db, conv.id).filter((m) => m.role === 'user')).toHaveLength(0)
      expect(getBlueprintConversation(db, conv.id)!.snapshot_issue_json).toBeNull()
    })

    it('asks for audit fixes when the persisted snapshot claims completion but fails the gate', async () => {
      const conv = createBlueprintConversation(db)
      const { saveBlueprintSnapshot } = await import('./blueprint-store')
      const flawed = completeSnapshot()
      flawed.m1Specs[1].labels = ['M1']
      updateBlueprintConversation(db, conv.id, { session_id: 'sess-9' })
      saveBlueprintSnapshot(db, conv.id, { blueprint: flawed as never, rawBlueprint: flawed })
      primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(completeSnapshot()) + '\n```'), resultLine({ session_id: 'sess-9' })])
      expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: true, kind: 'quality' })
      await vi.waitFor(() => expect(broadcastsOfType(broadcast, 'blueprint.done')).toHaveLength(1))
      expect(spawnArgsOf(0).join(' ')).toMatch(/spec 2 requires at least one domain label/)
    })
  })
})

// ─── App-driven batched generation (D7) ─────────────────────────────────────

function outlineSnapshot(count = 5) {
  return {
    ...SNAPSHOT,
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: false,
    m1Specs: Array.from({ length: count }, (_, index) => ({
      ...premiumSpec(index),
      description: '',
      acceptanceCriteria: [],
    })),
  }
}

function detailBlock(index: number): string {
  return '```spec-detail\n' + JSON.stringify({ index, spec: premiumSpec(index) }) + '\n```'
}

function auditBlock(fields: Record<string, unknown> = {}): string {
  return '```spec-audit\n' + JSON.stringify({ specsComplete: true, issues: [], fixes: [], ...fields }) + '\n```'
}

describe('BlueprintChatManager batched generation drive', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: BlueprintChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new BlueprintChatManager(broadcast, db)
  })

  function invocationRows() {
    return db.prepare('SELECT * FROM agent_invocations ORDER BY started_at ASC, rowid ASC').all() as Array<Record<string, unknown>>
  }

  function primeOutline() {
    primeTurn([assistantLine('Outline ready.\n```blueprint-draft\n' + JSON.stringify(outlineSnapshot()) + '\n```'), resultLine({ session_id: 'gen' })])
  }

  it('outline → detail turns (2 specs each) → audit → ONE final done with specsComplete', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine(detailBlock(0) + '\n' + detailBlock(1)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(2) + '\n' + detailBlock(3)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(auditBlock()), resultLine({ session_id: 'gen' })])

    await mgr.sendMessage(conv.id, 'approved, generate')

    // 1 outline + 3 detail + 1 audit
    expect(mockSpawn).toHaveBeenCalledTimes(5)
    const generating = broadcastsOfType(broadcast, 'blueprint.generating')
    expect(generating.map((g) => [g.phase, g.from, g.to, g.turn])).toEqual([
      ['details', 1, 2, 2],
      ['details', 3, 4, 3],
      ['details', 5, 5, 4],
      ['audit', 1, 5, 5],
    ])
    expect(generating[0].totalTurns).toBe(5)

    const done = broadcastsOfType(broadcast, 'blueprint.done')
    // outline + 3 filled ranges keep the panel live (continuing), then the final frame
    expect(done.map((d) => d.continuing === true)).toEqual([true, true, true, true, false])
    const final = done[done.length - 1]
    const raw = final.rawBlueprint as { specsComplete: boolean; m1Specs: Array<{ description: string; acceptanceCriteria: string[] }> }
    expect(raw.specsComplete).toBe(true)
    expect(raw.m1Specs.every((s) => s.description.length > 0 && s.acceptanceCriteria.length === 6)).toBe(true)
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true, repairAttempted: false }))
    expect((final.snapshot as { generation: { phase: string } }).generation.phase).toBe('audit')
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')).toHaveLength(0)

    // The prompts sent to the model name the requested indexes / audit.
    expect(spawnArgsOf(1).join(' ')).toContain('index 0')
    expect(spawnArgsOf(1).join(' ')).toContain('index 1')
    expect(spawnArgsOf(3).join(' ')).toContain('index 4')
    expect(spawnArgsOf(4).join(' ')).toContain('APP AUDIT')

    // Transcript hygiene: spec-detail fences never persist as prose; the raw reply survives.
    const messages = listBlueprintMessages(db, conv.id)
    const assistant = messages.filter((m) => m.role === 'assistant')
    expect(assistant.every((m) => !m.content.includes('spec-detail'))).toBe(true)
    expect(assistant.some((m) => (m.raw_content ?? '').includes('spec-detail'))).toBe(true)
    const stored = getBlueprintConversation(db, conv.id)
    expect((JSON.parse(stored!.raw_blueprint_json!) as { specsComplete: boolean }).specsComplete).toBe(true)
    expect(invocationRows().map((r) => r.status)).toEqual(['success', 'success', 'success', 'success', 'success'])
  })

  it('a detail turn without usable blocks gets ONE repair turn, then halts if still unfilled', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine('Sorry, here is prose only.'), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine('```spec-detail\n{"index": 0, "spec": {"kind": "scaffold" "title": "x"}}\n```'), resultLine({ session_id: 'gen' })])

    await mgr.sendMessage(conv.id, 'approved')

    expect(mockSpawn).toHaveBeenCalledTimes(3)
    const generating = broadcastsOfType(broadcast, 'blueprint.generating')
    expect(generating.map((g) => g.phase)).toEqual(['details', 'repair'])
    expect(spawnArgsOf(2).join(' ')).toContain('APP CHECK')
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    const final = done[done.length - 1]
    expect(final.continuing).toBeUndefined()
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', generationHalted: true, repairAttempted: true }))
    expect((final.rawBlueprint as { specsComplete: boolean }).specsComplete).toBe(false)
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
  })

  it('a partially-filled detail reply is repaired and the drive continues', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine(detailBlock(0)), resultLine({ session_id: 'gen' })]) // only 1 of 2
    primeTurn([assistantLine(detailBlock(1)), resultLine({ session_id: 'gen' })]) // repair fills index 1
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(auditBlock()), resultLine({ session_id: 'gen' })])

    await mgr.sendMessage(conv.id, 'approved')

    expect(mockSpawn).toHaveBeenCalledTimes(6)
    expect(broadcastsOfType(broadcast, 'blueprint.generating').map((g) => g.phase)).toEqual(['details', 'repair', 'details', 'details', 'audit'])
    const final = broadcastsOfType(broadcast, 'blueprint.done').at(-1)!
    expect((final.rawBlueprint as { specsComplete: boolean }).specsComplete).toBe(true)
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true }))
  })

  it('a failed detail spawn halts the drive with the outline kept (no blueprint.error)', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([], 1)
    await mgr.sendMessage(conv.id, 'approved')
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    const final = broadcastsOfType(broadcast, 'blueprint.done').at(-1)!
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', generationHalted: true }))
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
    expect(invocationRows().map((r) => r.status)).toEqual(['success', 'failed'])
  })

  it('audit fixes are merged into the final snapshot', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine(detailBlock(0) + detailBlock(1)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'gen' })])
    const fixed = premiumSpec(4, { title: 'Deliver the audited final slice' })
    primeTurn([assistantLine(auditBlock({ fixes: [{ index: 4, spec: fixed }] })), resultLine({ session_id: 'gen' })])

    await mgr.sendMessage(conv.id, 'approved')

    const final = broadcastsOfType(broadcast, 'blueprint.done').at(-1)!
    const raw = final.rawBlueprint as { specsComplete: boolean; m1Specs: Array<{ title: string }> }
    expect(raw.m1Specs[4].title).toBe('Deliver the audited final slice')
    expect(raw.specsComplete).toBe(true)
  })

  it('an audit that reports blocking issues gets ONE corrections turn, then the gate judges', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine(detailBlock(0) + detailBlock(1)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(auditBlock({ specsComplete: false, issues: ['spec 5: title duplicates spec 4'] })), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine('```spec-detail\n' + JSON.stringify({ index: 4, spec: premiumSpec(4, { title: 'Deliver the corrected final slice' }) }) + '\n```'), resultLine({ session_id: 'gen' })])

    await mgr.sendMessage(conv.id, 'approved')

    expect(mockSpawn).toHaveBeenCalledTimes(6)
    expect(broadcastsOfType(broadcast, 'blueprint.generating').map((g) => g.phase)).toEqual(['details', 'details', 'details', 'audit', 'repair'])
    expect(spawnArgsOf(5).join(' ')).toContain('title duplicates spec 4')
    const final = broadcastsOfType(broadcast, 'blueprint.done').at(-1)!
    const raw = final.rawBlueprint as { specsComplete: boolean; m1Specs: Array<{ title: string }> }
    expect(raw.m1Specs[4].title).toBe('Deliver the corrected final slice')
    expect(raw.specsComplete).toBe(true)
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true }))
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')).toHaveLength(0)
  })

  it('an audit reply without a spec-audit block lets the deterministic gate judge (quality repair fires on a bad spec)', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    primeTurn([assistantLine(detailBlock(0) + detailBlock(1)), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'gen' })])
    // index 4 arrives thin (criteria below the floor)
    const thin = { index: 4, spec: premiumSpec(4, { acceptanceCriteria: ['Only one criterion.'] }) }
    primeTurn([assistantLine('```spec-detail\n' + JSON.stringify(thin) + '\n```'), resultLine({ session_id: 'gen' })])
    primeTurn([assistantLine('Looks fine to me.'), resultLine({ session_id: 'gen' })]) // audit turn: no block
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'gen' })]) // quality repair as a spec-detail patch

    await mgr.sendMessage(conv.id, 'approved')

    expect(mockSpawn).toHaveBeenCalledTimes(6)
    const repairing = broadcastsOfType(broadcast, 'blueprint.repairing')
    expect(repairing).toHaveLength(1)
    expect(repairing[0].kind).toBe('quality')
    expect(spawnArgsOf(5).join(' ')).toMatch(/deterministic audit rejected/)
    const final = broadcastsOfType(broadcast, 'blueprint.done').at(-1)!
    const raw = final.rawBlueprint as { specsComplete: boolean; m1Specs: Array<{ acceptanceCriteria: string[] }> }
    expect(raw.m1Specs[4].acceptanceCriteria).toHaveLength(6)
    expect(raw.specsComplete).toBe(true)
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', repairAttempted: true, repaired: true }))
  })

  it('does not drive without a session id (outline delivered as a plain accepted snapshot)', async () => {
    const conv = createBlueprintConversation(db)
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(outlineSnapshot()) + '\n```'), resultLine({})])
    await mgr.sendMessage(conv.id, 'approved')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(broadcastsOfType(broadcast, 'blueprint.generating')).toHaveLength(0)
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].continuing).toBeUndefined()
    expect(done[0].snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: false }))
  })

  it('a non-resumable provider gets the single-response mode line and no drive', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { provider: 'gemini', model: 'gemini-2.5-pro' })
    primeTurn([JSON.stringify({ type: 'assistant', content: 'ok' }), resultLine({ session_id: 'g' })])
    await mgr.sendMessage(conv.id, 'approved')
    const args = spawnArgsOf(0)?.join(' ') ?? ''
    if (args) expect(args).toContain('GENERATION MODE: single response')
    expect(broadcastsOfType(broadcast, 'blueprint.generating')).toHaveLength(0)
  })

  it('abort during a detail turn stops the drive silently', async () => {
    const conv = createBlueprintConversation(db)
    primeOutline()
    ;(mockSpawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = createMockChildProcess()
      setImmediate(() => {
        child.stdout.push(assistantLine('half') + '\n')
        mgr.abort(conv.id)
        setImmediate(() => { child.stdout.push(null); child.emit('close', null) })
      })
      return child
    })
    await mgr.sendMessage(conv.id, 'approved')
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    expect(done).toHaveLength(1)
    expect(done[0].continuing).toBe(true)
    expect(broadcastsOfType(broadcast, 'blueprint.error')).toHaveLength(0)
  })
})

describe('BlueprintChatManager resume of a halted generation (manual)', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let mgr: BlueprintChatManager

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    mgr = new BlueprintChatManager(broadcast, db)
  })

  async function persistPartial(convId: string) {
    const { saveBlueprintSnapshot } = await import('./blueprint-store')
    const partial = outlineSnapshot(5)
    partial.m1Specs[0] = premiumSpec(0)
    partial.m1Specs[1] = premiumSpec(1)
    saveBlueprintSnapshot(db, convId, { blueprint: partial as never, rawBlueprint: partial })
    return partial
  }

  it('a partly written snapshot with no rejection resumes from the next unfilled range', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: 'sess-r' })
    await persistPartial(conv.id)
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'sess-r' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'sess-r' })])
    primeTurn([assistantLine(auditBlock()), resultLine({ session_id: 'sess-r' })])

    expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: true, kind: 'resume' })
    await vi.waitFor(() => expect(broadcastsOfType(broadcast, 'blueprint.done').some((d) => d.continuing !== true)).toBe(true))

    expect(mockSpawn).toHaveBeenCalledTimes(3)
    expect(spawnArgsOf(0)).toContain('--resume')
    expect(spawnArgsOf(0).join(' ')).toContain('index 2')
    expect(broadcastsOfType(broadcast, 'blueprint.repairing')).toHaveLength(0)
    const generating = broadcastsOfType(broadcast, 'blueprint.generating')
    // Turn ordinal re-derived from the 2 specs already written (outline + 1 range done).
    expect(generating.map((g) => [g.phase, g.from, g.to, g.turn])).toEqual([
      ['details', 3, 4, 3],
      ['details', 5, 5, 4],
      ['audit', 1, 5, 5],
    ])
    const done = broadcastsOfType(broadcast, 'blueprint.done')
    // The first frame re-announces the pending range (never "outline") so the panel leaves its halted state.
    expect((done[0].snapshot as { generation: { phase: string; from: number } }).generation).toEqual(expect.objectContaining({ phase: 'details', from: 3 }))
    expect(done[0].continuing).toBe(true)
    const final = done.at(-1)!
    expect((final.rawBlueprint as { specsComplete: boolean }).specsComplete).toBe(true)
    expect(final.snapshot).toEqual(expect.objectContaining({ status: 'accepted', claimsComplete: true }))
    expect(listBlueprintMessages(db, conv.id).filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('a manual retry / resume runs with the conversation model AND the composer effort', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: 'sess-r', model: 'sonnet' })
    await persistPartial(conv.id)
    primeTurn([assistantLine(detailBlock(2) + detailBlock(3)), resultLine({ session_id: 'sess-r' })])
    primeTurn([assistantLine(detailBlock(4)), resultLine({ session_id: 'sess-r' })])
    primeTurn([assistantLine(auditBlock()), resultLine({ session_id: 'sess-r' })])
    expect(await mgr.repairSnapshot(conv.id, { reasoningEffort: 'high' })).toEqual({ ok: true, kind: 'resume' })
    await vi.waitFor(() => expect(broadcastsOfType(broadcast, 'blueprint.done').some((d) => d.continuing !== true)).toBe(true))
    for (const call of [0, 1, 2]) {
      const args = spawnArgsOf(call)
      expect(args[args.indexOf('--effort') + 1]).toBe('high')
      expect(args[args.indexOf('--model') + 1]).toContain('sonnet')
    }
    // An invalid effort is dropped (provider default), never rejected.
    const conv2 = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv2.id, { session_id: 'sess-q' })
    await persistPartial(conv2.id)
    primeTurn([], 1)
    expect(await mgr.repairSnapshot(conv2.id, { reasoningEffort: 'ultra' })).toEqual({ ok: true, kind: 'resume' })
    await vi.waitFor(() => expect(spawnArgsOf(3)).toBeDefined())
    expect(spawnArgsOf(3)).not.toContain('--effort')
  })

  it('a pending rejection still wins over resume; a fully written snapshot has nothing to resume', async () => {
    const conv = createBlueprintConversation(db)
    updateBlueprintConversation(db, conv.id, { session_id: 'sess-r' })
    const { saveBlueprintSnapshot, saveBlueprintSnapshotIssue } = await import('./blueprint-store')
    saveBlueprintSnapshot(db, conv.id, { blueprint: completeSnapshot() as never, rawBlueprint: completeSnapshot() })
    expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: false, reason: 'nothing_to_repair' })
    await persistPartial(conv.id)
    saveBlueprintSnapshotIssue(db, conv.id, { reason: 'truncated', detail: 'cut', at: 'now' })
    primeTurn([assistantLine('```blueprint-draft\n' + JSON.stringify(outlineSnapshot()) + '\n```'), resultLine({ session_id: 'sess-r' })])
    expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: true, kind: 'truncated' })
    await vi.waitFor(() => expect(broadcastsOfType(broadcast, 'blueprint.done').length).toBeGreaterThan(0))
  })

  it('resume without a session id is refused', async () => {
    const conv = createBlueprintConversation(db)
    await persistPartial(conv.id)
    expect(await mgr.repairSnapshot(conv.id)).toEqual({ ok: false, reason: 'no_session' })
  })
})
