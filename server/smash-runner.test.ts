import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { initDb, type DbInstance } from './db'
import {
  checkSmashEligibility,
  applySmashToStore,
  applySmashUndo,
  applyDeleteEpicChildren,
  prepareSmashSpawn,
  readSmashChildOutput,
  runSmash,
  runSmashUndo,
} from './smash-runner'
import {
  mutateStore,
  readStore,
  resolveTicketStoragePath,
  CURRENT_SCHEMA_VERSION,
  type Ticket,
  type TicketStore,
} from './ticket-store'

// ─── Fake child ──────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout: Readable
  stderr: Readable | null = null
  pid = 12345
  killed = false
  constructor(stdoutLines: string[]) {
    super()
    this.stdout = Readable.from(stdoutLines.map((l) => l + '\n'))
  }
  kill(_signal?: string): boolean {
    this.killed = true
    return true
  }
}

function fakeSpawn(lines: string[], exitCode: number | null = 0, delay = 5): typeof import('./util/cli-prompt')['spawnAiCli'] {
  return ((_bin: string, _args: string[]) => {
    const c = new FakeChild(lines)
    setTimeout(() => c.emit('close', exitCode), delay)
    return c as unknown as ChildProcess
  }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']
}

function tmpProjectPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smash-runner-'))
}

function streamLines(text: string): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 0.002,
      duration_ms: 200,
      duration_api_ms: 150,
      num_turns: 1,
      usage: { input_tokens: 20, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'claude-sonnet-4-6',
    }),
  ]
}

function validSmashBlock(count = 4): string {
  return [
    '```smash',
    JSON.stringify({
      smashVersion: 1,
      children: Array.from({ length: count }, (_, i) => ({
        title: `Child ${i + 1}`,
        description: `Description of child ${i + 1}`,
        priority: 'medium',
        executionOrder: i + 1,
        rationale: `rationale ${i + 1}`,
      })),
    }),
    '```',
  ].join('\n')
}

function seedTicket(projectPath: string, opts: {
  id: number
  description?: string
  status?: Ticket['status']
  isEpic?: boolean
  parentEpicId?: number | null
} = { id: 1 }): void {
  const filePath = resolveTicketStoragePath(projectPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  mutateStore(filePath, (s) => {
    s.schema_version = CURRENT_SCHEMA_VERSION
    if (s.next_id <= opts.id) s.next_id = opts.id + 1
    s.tickets[String(opts.id)] = {
      id: opts.id,
      title: 'Parent spec',
      description: opts.description ?? 'Body\n\n## Contract Layer\n\nstuff',
      status: opts.status ?? 'todo',
      priority: 'medium',
      labels: [],
      assignee: null,
      prerequisites: [],
      metadata: {},
      comments: [],
      origin_conversation_id: null,
      is_epic: opts.isEpic ?? false,
      parent_epic_id: opts.parentEpicId ?? null,
      execution_order: null,
      short_summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'test',
      source: 'propose-spec',
    }
  })
}

let db: DbInstance
let projectPath: string

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = tmpProjectPath()
})

// ─── checkSmashEligibility ───────────────────────────────────────────────────

describe('checkSmashEligibility', () => {
  function loadStore(): TicketStore {
    return readStore(resolveTicketStoragePath(projectPath))
  }

  it('approves a committed ticket with Contract Layer', () => {
    seedTicket(projectPath, { id: 1 })
    const r = checkSmashEligibility(loadStore(), 1)
    expect(r.ok).toBe(true)
  })

  it('rejects missing ticket', () => {
    seedTicket(projectPath, { id: 1 })
    const r = checkSmashEligibility(loadStore(), 999)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('ticket-not-found')
  })

  it('rejects draft ticket', () => {
    seedTicket(projectPath, { id: 1, status: 'draft' })
    const r = checkSmashEligibility(loadStore(), 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('is-draft')
  })

  it('rejects ticket without Contract Layer', () => {
    seedTicket(projectPath, { id: 1, description: 'body only' })
    const r = checkSmashEligibility(loadStore(), 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-contract-layer')
  })

  it('rejects child of épica', () => {
    seedTicket(projectPath, { id: 1, isEpic: true })
    seedTicket(projectPath, { id: 2, parentEpicId: 1 })
    const r = checkSmashEligibility(loadStore(), 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('is-child')
  })

  it('rejects épica with existing children (must delete first for re-SMASH)', () => {
    seedTicket(projectPath, { id: 1, isEpic: true })
    seedTicket(projectPath, { id: 2, parentEpicId: 1 })
    const r = checkSmashEligibility(loadStore(), 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('has-children')
  })

  it('approves épica with no children (allow re-SMASH after delete-children)', () => {
    seedTicket(projectPath, { id: 1, isEpic: true })
    const r = checkSmashEligibility(loadStore(), 1)
    expect(r.ok).toBe(true)
  })
})

// ─── applySmashToStore + undo + delete-children ──────────────────────────────

describe('applySmashToStore', () => {
  it('flips épica and inserts ordered children atomically', () => {
    seedTicket(projectPath, { id: 1 })
    const filePath = resolveTicketStoragePath(projectPath)
    const result = applySmashToStore(
      filePath,
      1,
      [
        { title: 'A', description: 'da', priority: 'high', executionOrder: 1, rationale: 'r1' },
        { title: 'B', description: 'db', priority: 'medium', executionOrder: 2, rationale: 'r2' },
        { title: 'C', description: 'dc', priority: 'low', executionOrder: 3, rationale: 'r3' },
      ],
      '2026-05-16T12:00:00Z',
      'sr-specs-smash',
    )
    expect(result.epic.is_epic).toBe(true)
    expect(result.epic.status).toBe('done')
    expect(result.children).toHaveLength(3)
    expect(result.children[0].parent_epic_id).toBe(1)
    expect(result.children[0].execution_order).toBe(1)
    expect(result.children[0].source).toBe('specs-smash')
    expect(result.children[1].title).toBe('B')

    // Verify disk reflects both changes.
    const store = readStore(filePath)
    expect(store.tickets['1'].is_epic).toBe(true)
    expect(store.tickets['1'].status).toBe('done')
    expect((store.tickets['1'].metadata as { pre_smash_status?: string }).pre_smash_status).toBe('todo')
    expect(Object.keys(store.tickets)).toHaveLength(4)
  })

  it('throws when ticket disappears between gate and mutation', () => {
    const filePath = resolveTicketStoragePath(projectPath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    expect(() =>
      applySmashToStore(filePath, 999, [
        { title: 'A', description: 'd', priority: 'high', executionOrder: 1, rationale: 'r' },
      ], '2026-05-16T12:00:00Z', 'sr-specs-smash'),
    ).toThrow()
  })
})

describe('applySmashUndo', () => {
  it('deletes children created at or after smashedAt and clears is_epic', () => {
    seedTicket(projectPath, { id: 1 })
    const filePath = resolveTicketStoragePath(projectPath)
    const applied = applySmashToStore(
      filePath,
      1,
      [
        { title: 'A', description: 'da', priority: 'high', executionOrder: 1, rationale: 'r' },
        { title: 'B', description: 'db', priority: 'high', executionOrder: 2, rationale: 'r' },
      ],
      '2026-05-16T12:00:00Z',
      'sr-specs-smash',
    )
    expect(applied.children).toHaveLength(2)

    const undone = applySmashUndo(filePath, 1, '2026-05-16T12:00:00Z', '2026-05-16T12:00:30Z')
    expect(undone.epic?.is_epic).toBe(false)
    expect(undone.epic?.status).toBe('todo') // restored from pre_smash_status
    expect(undone.deletedChildren).toHaveLength(2)

    const store = readStore(filePath)
    expect(Object.keys(store.tickets)).toHaveLength(1)
    expect(store.tickets['1'].is_epic).toBe(false)
    expect(store.tickets['1'].status).toBe('todo')
    // pre_smash_status was consumed
    expect((store.tickets['1'].metadata as { pre_smash_status?: string }).pre_smash_status).toBeUndefined()
  })

  it('B61: restores a pre-SMASH "done" status instead of demoting to todo', () => {
    seedTicket(projectPath, { id: 1, status: 'done' })
    const filePath = resolveTicketStoragePath(projectPath)
    applySmashToStore(
      filePath,
      1,
      [{ title: 'A', description: 'da', priority: 'high', executionOrder: 1, rationale: 'r' }],
      '2026-05-16T12:00:00Z',
      'sr-specs-smash',
    )
    const undone = applySmashUndo(filePath, 1, '2026-05-16T12:00:00Z', '2026-05-16T12:00:30Z')
    expect(undone.epic?.is_epic).toBe(false)
    expect(undone.epic?.status).toBe('done') // not demoted to 'todo'
  })

  it('is a no-op when ticket is not an épica', () => {
    seedTicket(projectPath, { id: 1 })
    const filePath = resolveTicketStoragePath(projectPath)
    const r = applySmashUndo(filePath, 1, '2026-05-16T12:00:00Z', '2026-05-16T12:00:30Z')
    expect(r.epic).toBeNull()
    expect(r.deletedChildren).toEqual([])
  })

  it('preserves a child created BEFORE the smashedAt timestamp', () => {
    seedTicket(projectPath, { id: 1 })
    const filePath = resolveTicketStoragePath(projectPath)
    // manually create a pre-existing "manual" child with older timestamp
    mutateStore(filePath, (s) => {
      const id = s.next_id++
      s.tickets[String(id)] = {
        id,
        title: 'manual-pre',
        description: 'd',
        status: 'todo',
        priority: 'medium',
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        comments: [],
        origin_conversation_id: null,
        is_epic: false,
        parent_epic_id: 1,
        execution_order: null,
        short_summary: null,
        created_at: '2026-05-15T00:00:00Z',
        updated_at: '2026-05-15T00:00:00Z',
        created_by: 'manual',
        source: 'manual',
      }
      s.tickets['1'].is_epic = true
    })

    // smash adds two children at later timestamp
    applySmashToStore(filePath, 1, [
      { title: 'A', description: 'da', priority: 'high', executionOrder: 1, rationale: 'r' },
    ], '2026-05-16T12:00:00Z', 'sr-specs-smash')

    const undone = applySmashUndo(filePath, 1, '2026-05-16T12:00:00Z', '2026-05-16T12:00:30Z')
    expect(undone.deletedChildren).toHaveLength(1) // only the new one
    const store = readStore(filePath)
    // the manual pre-existing child survives (parent_epic_id remains)
    const surviving = Object.values(store.tickets).find((t) => t.title === 'manual-pre')
    expect(surviving).toBeDefined()
  })
})

describe('applyDeleteEpicChildren', () => {
  it('removes all children of an épica regardless of timestamp', () => {
    seedTicket(projectPath, { id: 1 })
    const filePath = resolveTicketStoragePath(projectPath)
    applySmashToStore(filePath, 1, [
      { title: 'A', description: 'da', priority: 'high', executionOrder: 1, rationale: 'r' },
      { title: 'B', description: 'db', priority: 'high', executionOrder: 2, rationale: 'r' },
    ], '2026-05-16T12:00:00Z', 'sr-specs-smash')

    const r = applyDeleteEpicChildren(filePath, 1)
    expect(r.deletedChildren).toHaveLength(2)
    const store = readStore(filePath)
    // Épica remains; only children removed.
    expect(Object.keys(store.tickets)).toHaveLength(1)
    expect(store.tickets['1'].is_epic).toBe(true)
    // Returns the post-write revision so the route can suppress the chokidar
    // echo (passing 0 caused a spurious full-refresh broadcast).
    expect(r.revision).toBe(store.revision)
    expect(r.revision).toBeGreaterThan(0)
  })
})

// ─── prepareSmashSpawn ───────────────────────────────────────────────────────

describe('prepareSmashSpawn', () => {
  it('produces stream-json args with system + user prompts', () => {
    seedTicket(projectPath, { id: 1 })
    const store = readStore(resolveTicketStoragePath(projectPath))
    const out = prepareSmashSpawn(
      { projectSlug: 'p', projectPath, projectName: 'P', model: 'sonnet' },
      store.tickets['1'],
    )
    expect(out.args).toContain('--output-format')
    expect(out.args).toContain('stream-json')
    expect(out.args).toContain('--max-turns')
    expect(out.args).toContain('--system-prompt')
    expect(out.args).toContain('--disallowedTools')
    expect(out.args).toContain('Read,Grep,Glob,Bash')
    expect(out.systemPrompt).toContain('SPECs SMASH')
    expect(out.userPrompt.startsWith('Parent spec\n\n')).toBe(true)
  })
})

// ─── runSmash ────────────────────────────────────────────────────────────────

describe('runSmash', () => {
  it('on success, splits cost / tokens / turns equally across child invocation rows (no parent row)', async () => {
    seedTicket(projectPath, { id: 1 })
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: () => {},
        spawn: fakeSpawn(streamLines(validSmashBlock(4))),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(true)
    const rows = db.prepare(`SELECT ticket_id, surface, total_cost_usd, num_turns FROM ai_invocations WHERE surface = 'smash'`).all() as Array<{ ticket_id: number; surface: string; total_cost_usd: number | null; num_turns: number | null }>
    // 4 children, 0 parent rows.
    expect(rows).toHaveLength(4)
    const ticketIds = rows.map((row) => row.ticket_id).sort()
    expect(ticketIds).toEqual([2, 3, 4, 5])
    // total cost across rows sums to the spawn cost (fakeSpawn returned 0.002)
    const totalCost = rows.reduce((s, row) => s + (row.total_cost_usd ?? 0), 0)
    expect(totalCost).toBeCloseTo(0.002, 5)
    // each child gets its quartile
    for (const row of rows) {
      expect(row.total_cost_usd).toBeCloseTo(0.0005, 5)
    }
  })

  it('relocate-artifacts: reads + writes the threaded ticketsPath, never the repo store', async () => {
    // Simulate a relocated project: the gated tickets store lives OUTSIDE the
    // repo. Seeding it under a separate dir and pointing `ticketsPath` there must
    // make SMASH operate on it; the repo's own (absent) store is never touched.
    const relocatedStore = path.join(tmpProjectPath(), 'workspace', '.specrails', 'local-tickets.json')
    fs.mkdirSync(path.dirname(relocatedStore), { recursive: true })
    mutateStore(relocatedStore, (s) => {
      s.schema_version = CURRENT_SCHEMA_VERSION
      s.next_id = 2
      s.tickets['1'] = {
        id: 1, title: 'Parent spec', description: 'Body\n\n## Contract Layer\n\nstuff',
        status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [],
        metadata: {}, comments: [], origin_conversation_id: null, is_epic: false,
        parent_epic_id: null, execution_order: null, short_summary: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        created_by: 'test', source: 'propose-spec',
      } as any
      return s
    })

    const r = await runSmash(
      {
        db,
        projectId: 'proj-reloc',
        projectSlug: 'proj-reloc',
        projectPath,
        projectName: 'P',
        ticketsPath: relocatedStore,
        broadcast: () => {},
        spawn: fakeSpawn(streamLines(validSmashBlock(4))),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(true)
    // The relocated store was flipped to an épica with 4 children.
    const store = readStore(relocatedStore)
    expect(store.tickets['1']!.is_epic).toBe(true)
    expect(Object.values(store.tickets).filter((t) => t.parent_epic_id === 1)).toHaveLength(4)
    // The repo's own store was never created.
    expect(fs.existsSync(resolveTicketStoragePath(projectPath))).toBe(false)
  })

  it('B60: rejects a concurrent SMASH of the same ticket (in-progress guard)', async () => {
    seedTicket(projectPath, { id: 1 })
    // BUG-PARSER-02: the in-flight early-return must broadcast smash.failed so a
    // duplicate submit (already replied 202) doesn't leave a stuck spinner.
    const events: Array<{ type?: string; reason?: string }> = []
    const deps = {
      db,
      projectId: 'proj-1',
      projectSlug: 'proj-1',
      projectPath,
      projectName: 'P',
      broadcast: (m: unknown) => events.push(m as { type?: string; reason?: string }),
      spawn: fakeSpawn(streamLines(validSmashBlock(4))),
      timeoutMs: 5000,
    }
    // p1 takes the in-flight slot synchronously (before its first await); the
    // concurrent call sees it and is rejected instead of duplicating children.
    const p1 = runSmash(deps, 1)
    const r2 = await runSmash(deps, 1)
    expect(r2.ok).toBe(false)
    expect(r2.reason).toBe('in-progress')
    // The duplicate broadcasts smash.failed with reason in-progress.
    const failed = events.find((e) => e.type === 'smash.failed' && e.reason === 'in-progress')
    expect(failed).toBeDefined()
    const r1 = await p1
    expect(r1.ok).toBe(true) // first one completes normally and releases the slot
  })

  it('completes successfully and inserts children', async () => {
    seedTicket(projectPath, { id: 1 })
    const events: unknown[] = []
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: (m) => events.push(m),
        spawn: fakeSpawn(streamLines(validSmashBlock(4))),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(true)
    expect(r.childrenIds).toHaveLength(4)
    const types = events.map((e: any) => e.type)
    expect(types).toContain('smash.started')
    expect(types).toContain('smash.completed')
    expect(types).toContain('ticket_updated')
    // 4 child created broadcasts
    expect(types.filter((t) => t === 'ticket_created')).toHaveLength(4)

    // Persisted state
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['1'].is_epic).toBe(true)
    expect(Object.keys(store.tickets)).toHaveLength(5)
  })

  it('returns disabled when kill switch is active', async () => {
    seedTicket(projectPath, { id: 1 })
    const prev = process.env.SPECRAILS_SMASH
    process.env.SPECRAILS_SMASH = '0'
    try {
      const r = await runSmash(
        {
          db,
          projectId: 'proj-1',
          projectSlug: 'proj-1',
          projectPath,
          projectName: 'P',
          broadcast: () => {},
          spawn: fakeSpawn(streamLines(validSmashBlock())),
        },
        1,
      )
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('disabled')
    } finally {
      process.env.SPECRAILS_SMASH = prev
    }
  })

  it('returns invalid-output when agent emits malformed JSON', async () => {
    seedTicket(projectPath, { id: 1 })
    const events: unknown[] = []
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: (m) => events.push(m),
        spawn: fakeSpawn(streamLines('not a smash fence at all')),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid-output')
    const failedEvent = events.find((e: any) => e.type === 'smash.failed')
    expect(failedEvent).toBeDefined()
    // Store unchanged
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['1'].is_epic).toBe(false)
  })

  it('returns invalid-output for below-min children', async () => {
    seedTicket(projectPath, { id: 1 })
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: () => {},
        spawn: fakeSpawn(streamLines(validSmashBlock(2))),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid-output')
  })

  it('returns model_error when claude exits non-zero', async () => {
    seedTicket(projectPath, { id: 1 })
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: () => {},
        spawn: fakeSpawn(streamLines(validSmashBlock()), 1),
        timeoutMs: 5000,
      },
      1,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('model_error')
  })

  it('rejects ticket without Contract Layer at pre-flight', async () => {
    seedTicket(projectPath, { id: 1, description: 'no contract here' })
    let broadcastCount = 0
    const r = await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: () => { broadcastCount += 1 },
        spawn: fakeSpawn(streamLines(validSmashBlock())),
      },
      1,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-contract-layer')
    // Pre-flight rejected before any broadcast / spawn
    expect(broadcastCount).toBe(0)
  })
})

// ─── runSmashUndo ────────────────────────────────────────────────────────────

describe('runSmashUndo', () => {
  it('reverses a prior SMASH', async () => {
    seedTicket(projectPath, { id: 1 })
    const events: unknown[] = []
    await runSmash(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: (m) => events.push(m),
        spawn: fakeSpawn(streamLines(validSmashBlock(3))),
        timeoutMs: 5000,
      },
      1,
    )
    const completed = events.find((e: any) => e.type === 'smash.completed') as any
    expect(completed).toBeDefined()
    const smashedAt = completed.smashedAt

    const undoneEvents: unknown[] = []
    const undone = await runSmashUndo(
      {
        db,
        projectId: 'proj-1',
        projectSlug: 'proj-1',
        projectPath,
        projectName: 'P',
        broadcast: (m) => undoneEvents.push(m),
      },
      1,
      smashedAt,
    )
    expect(undone.ok).toBe(true)
    expect(undone.deletedChildren).toHaveLength(3)
    const types = undoneEvents.map((e: any) => e.type)
    expect(types).toContain('smash.undone')
    expect(types.filter((t) => t === 'ticket_deleted')).toHaveLength(3)

    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(Object.keys(store.tickets)).toHaveLength(1)
    expect(store.tickets['1'].is_epic).toBe(false)
  })

  it('returns disabled when kill switch is active', async () => {
    seedTicket(projectPath, { id: 1 })
    const prev = process.env.SPECRAILS_SMASH
    process.env.SPECRAILS_SMASH = '0'
    try {
      const r = await runSmashUndo(
        {
          db,
          projectId: 'proj-1',
          projectSlug: 'proj-1',
          projectPath,
          projectName: 'P',
          broadcast: () => {},
        },
        1,
        '2026-05-16T12:00:00Z',
      )
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('disabled')
    } finally {
      process.env.SPECRAILS_SMASH = prev
    }
  })
})

describe('BUG-PARSER-01: readSmashChildOutput timeout teardown', () => {
  // A child that never emits `close` so the timeout path fires.
  class HangingChild extends EventEmitter {
    stdout: Readable
    stderr: Readable | null = null
    pid = 7777
    constructor() {
      super()
      this.stdout = new Readable({ read() { /* never pushes/ends */ } })
    }
    kill(): boolean { return true }
  }

  it('treeKills the subtree with SIGTERM and SIGKILL-escalates on timeout', async () => {
    const child = new HangingChild()
    const kills: Array<{ pid: number; signal: string }> = []
    const kill = (pid: number, signal: string, cb?: (err?: Error) => void) => {
      kills.push({ pid, signal })
      cb?.()
    }
    const result = await readSmashChildOutput(child as unknown as ChildProcess, 20, kill)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    expect(kills.some((k) => k.pid === 7777 && k.signal === 'SIGTERM')).toBe(true)
    await new Promise((r) => setTimeout(r, 2100))
    expect(kills.some((k) => k.pid === 7777 && k.signal === 'SIGKILL')).toBe(true)
  })

  it('cancels the SIGKILL escalation when the child closes within the grace window', async () => {
    const child = new HangingChild()
    const kills: Array<{ pid: number; signal: string }> = []
    const kill = (pid: number, signal: string, cb?: (err?: Error) => void) => {
      kills.push({ pid, signal })
      cb?.()
    }
    const p = readSmashChildOutput(child as unknown as ChildProcess, 20, kill)
    await new Promise((r) => setTimeout(r, 50))
    child.emit('close', 143)
    await p
    await new Promise((r) => setTimeout(r, 2100))
    expect(kills.some((k) => k.signal === 'SIGTERM')).toBe(true)
    expect(kills.some((k) => k.signal === 'SIGKILL')).toBe(false)
  })
})
