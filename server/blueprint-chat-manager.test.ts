import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  const description = (readme: boolean) => [
    '## Problem Statement', `Users need a complete workflow.${readme ? ' The repository already contains a README.' : ''}`,
    '', '## Proposed Solution', 'Build the end-to-end behavior with explicit boundaries and persisted state.',
    '', '## Out of Scope', '- Collaboration', '- Advanced analytics',
    '', '## Technical Considerations', '- Cover failure states', '- Add automated tests',
    '', '## Estimated Complexity', 'Medium — the slice crosses multiple layers.',
  ].join('\n')
  return {
    ...SNAPSHOT,
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: true,
    m1Specs: Array.from({ length: 5 }, (_, index) => ({
      kind: index === 0 ? 'scaffold' : 'feature',
      title: index === 0 ? 'Scaffold the project' : `Deliver slice ${index}`,
      shortSummary: `Deliver a complete testable slice ${index}.`,
      description: description(index === 0),
      acceptanceCriteria: [
        'The happy path completes successfully.',
        'Invalid input produces an actionable error.',
        'An empty state renders deliberately.',
        'Automated tests cover failure behavior.',
      ],
      priority: 'medium',
      labels: ['M1', index === 0 ? 'foundation' : 'workflow'],
      ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
    })),
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
    expect(prompt).toMatch(/deterministic audit rejected it/)
    expect(prompt).toMatch(/spec 3 acceptanceCriteria requires 4-10 items/)
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
