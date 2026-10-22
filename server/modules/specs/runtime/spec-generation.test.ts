import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }))
const { mockRefine } = vi.hoisted(() => ({ mockRefine: vi.fn() }))
vi.mock('./contract-refine-runner', () => ({ runContractRefineForQuick: mockRefine }))

import { spawn as mockSpawn } from 'child_process'
import { initDb, type DbInstance } from '../../../db'
import { readStore } from './ticket-store'
import {
  buildSpecGenerationPrompts, generateSpecFromText, resolveSpecGenerationToolPolicy,
  SpecGenerationToolPolicyError, type SpecGenerationDeps,
} from './spec-generation'
import { parseGeneratedSpec } from './generated-spec-parser'
import type { ContextScope } from '../../conversations/runtime/context-scope'

const SPEC = [
  '## Spec Title', 'Dark Mode Toggle', '',
  '## Labels', 'UI, settings', '',
  '## Problem Statement', 'Too bright.', '',
  '## Acceptance Criteria', '1. A toggle exists', '',
  '## Estimated Complexity', 'High because themes', '',
  '## Short Summary', 'Adds a dark mode toggle.',
].join('\n')

const scope: ContextScope = { specrails: false, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: false }

function mockChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => void }
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 4242
  child.kill = vi.fn()
  vi.mocked(mockSpawn).mockReturnValue(child as never)
  return child
}

async function finish(child: ReturnType<typeof mockChild>, text: string | null, code = 0): Promise<void> {
  if (text !== null) {
    child.stdout.push(JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text }] } }) + '\n')
  }
  child.stdout.push(JSON.stringify({ type: 'result', subtype: code === 0 ? 'success' : 'error', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
  child.stdout.push(null)
  await new Promise<void>((r) => setImmediate(r))
  child.emit('close', code)
}

describe('spec generation use case', () => {
  let db: DbInstance
  let tmp: string
  let storePath: string
  let deps: SpecGenerationDeps

  beforeEach(() => {
    vi.mocked(mockSpawn).mockReset()
    mockRefine.mockReset().mockResolvedValue({ ok: true })
    db = initDb(':memory:')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gen-'))
    storePath = path.join(tmp, 'local-tickets.json')
    fs.writeFileSync(storePath, JSON.stringify({
      schema_version: '1.1', next_id: 2, revision: 1,
      tickets: {
        '1': {
          id: 1, title: 'Draft', description: 'provisional', status: 'in_progress', priority: 'low',
          labels: ['flow'], comments: [{ id: 'c1', body: 'keep me' }], metadata: { flow: { state: 'active' } },
          short_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
          created_by: 'user', source: 'manual', attachments: [{ id: 'a1' }],
        },
      },
    }))
    deps = {
      db,
      project: { id: 'proj-sg', slug: `spec-gen-test-${process.pid}`, name: 'P', path: tmp },
      ticketStorePath: storePath,
      ticketWatcher: { notifyDesktopWrite: vi.fn() },
      broadcast: vi.fn(),
      admission: { isCurrent: () => true },
    }
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('parses the generated markdown into ticket fields', () => {
    expect(parseGeneratedSpec(SPEC, 'fallback')).toEqual({
      title: 'Dark Mode Toggle',
      priority: 'high',
      labels: ['spec-proposal', 'ui', 'settings'],
      shortSummary: 'Adds a dark mode toggle.',
      description: '## Problem Statement\nToo bright.\n\n## Acceptance Criteria\n1. A toggle exists',
    })
    expect(parseGeneratedSpec('no headings', 'fallback')).toMatchObject({ title: 'fallback', priority: 'medium', labels: ['spec-proposal'] })
  })

  it('builds the spec-gen system prompt with the required format and scope rules', () => {
    const plain = buildSpecGenerationPrompts({ project: deps.project, text: '  idea  ', scope })
    expect(plain.userPrompt).toBe('Generate a spec for the following idea:\n\nidea')
    expect(plain.systemPrompt).toContain('## Spec Title')
    expect(plain.systemPrompt).toContain('Do NOT read any files')
    const attached = buildSpecGenerationPrompts({ project: deps.project, text: 'idea', scope: { ...scope, full: true }, attachments: { textBlocks: ['<user-attachment>x</user-attachment>'], imageFlags: [], imagePaths: [] } })
    expect(attached.hasAttachments).toBe(true)
    expect(attached.userPrompt).toContain('## Attached Resources')
    expect(attached.systemPrompt).toContain('You MAY use Read, Grep, and Glob')
  })

  it('creates a new propose-spec ticket and records quick-spec accounting', async () => {
    const child = mockChild()
    const onPersisted = vi.fn()
    const onDelta = vi.fn()
    const done = generateSpecFromText(deps, { text: 'dark mode', provider: 'claude', model: 'sonnet', scope, requestId: 'req-1', hooks: { onPersisted, onDelta } })
    expect(vi.mocked(mockSpawn).mock.calls[0][1]).toEqual(expect.arrayContaining(['--max-turns', '1']))
    await finish(child, SPEC)
    const outcome = await done
    expect(outcome).toMatchObject({ ok: true, kind: 'created', ticket: { id: 2, title: 'Dark Mode Toggle', source: 'propose-spec', status: 'todo' } })
    expect(onDelta).toHaveBeenCalledWith(SPEC)
    expect(onPersisted).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'created')
    expect(readStore(storePath).tickets['2'].labels).toEqual(['spec-proposal', 'ui', 'settings'])
    expect(deps.ticketWatcher.notifyDesktopWrite).toHaveBeenCalled()
    const row = db.prepare('SELECT surface, status, ticket_id, surface_ref_id FROM ai_invocations').get()
    expect(row).toEqual({ surface: 'quick-spec', status: 'success', ticket_id: 2, surface_ref_id: 'req-1' })
    expect(deps.broadcast).toHaveBeenCalledWith({ type: 'spending.invalidated', projectId: 'proj-sg' })
    expect(mockRefine).not.toHaveBeenCalled()
  })

  it('rewrites an existing ticket in place, keeping its id and ownership fields, then applies the Contract Layer', async () => {
    const child = mockChild()
    const done = generateSpecFromText(deps, {
      text: 'derived proposal', provider: 'claude', model: 'sonnet', scope, ticketId: 1,
      contractRefine: { model: 'opus' },
    })
    await finish(child, SPEC)
    const outcome = await done
    expect(outcome).toMatchObject({ ok: true, kind: 'rewritten', ticket: { id: 1 } })
    const store = readStore(storePath)
    expect(store.next_id).toBe(2)
    expect(store.tickets['1']).toMatchObject({
      id: 1, title: 'Dark Mode Toggle', priority: 'high', labels: ['spec-proposal', 'ui', 'settings'],
      short_summary: 'Adds a dark mode toggle.',
      description: '## Problem Statement\nToo bright.\n\n## Acceptance Criteria\n1. A toggle exists',
      status: 'in_progress', source: 'manual', created_by: 'user', created_at: '2026-01-01T00:00:00.000Z',
      metadata: { flow: { state: 'active' } }, comments: [{ id: 'c1', body: 'keep me' }], attachments: [{ id: 'a1' }],
    })
    expect(store.tickets['1'].updated_at).not.toBe('2026-01-01T00:00:00.000Z')
    await new Promise<void>((r) => process.nextTick(r))
    expect(mockRefine).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-sg', providerId: 'claude' }),
      1, 'Dark Mode Toggle', store.tickets['1'].description, 'opus',
    )
  })

  it('fails without writing when the ticket to rewrite is missing', async () => {
    const child = mockChild()
    const onError = vi.fn()
    const done = generateSpecFromText(deps, { text: 'x', provider: 'claude', model: 'sonnet', scope, ticketId: 99, hooks: { onError } })
    await finish(child, SPEC)
    expect(await done).toMatchObject({ ok: false, error: 'Failed to rewrite ticket' })
    expect(onError).toHaveBeenCalledWith('Failed to rewrite ticket')
    expect(Object.keys(readStore(storePath).tickets)).toEqual(['1'])
    expect(db.prepare('SELECT status FROM ai_invocations').get()).toEqual({ status: 'failed' })
  })

  it('reports empty/failed output and honours an aborting onPersisted hook', async () => {
    const empty = mockChild()
    const onError = vi.fn()
    const emptyDone = generateSpecFromText(deps, { text: 'x', provider: 'claude', model: 'sonnet', scope, hooks: { onError } })
    await finish(empty, null)
    expect(await emptyDone).toMatchObject({ ok: false, error: 'Empty response from AI' })

    const failed = mockChild()
    const failedDone = generateSpecFromText(deps, { text: 'x', provider: 'claude', model: 'sonnet', scope })
    await finish(failed, 'partial', 2)
    expect(await failedDone).toMatchObject({ ok: false, error: 'Process exited with code 2' })

    const aborted = mockChild()
    const abortedDone = generateSpecFromText(deps, {
      text: 'x', provider: 'claude', model: 'sonnet', scope, contractRefine: { model: null },
      hooks: { onPersisted: () => 'abort' },
    })
    await finish(aborted, SPEC)
    expect(await abortedDone).toMatchObject({ ok: true, kind: 'created' })
    await new Promise<void>((r) => process.nextTick(r))
    expect(mockRefine).not.toHaveBeenCalled()
    // Only the two failures were accounted; the aborted run records nothing.
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 2 })
  })

  it('resolves the spec-gen tool policy from the scope', () => {
    expect(resolveSpecGenerationToolPolicy('claude', { full: true })).toBe('read-only')
    expect(resolveSpecGenerationToolPolicy('claude', { full: false })).not.toBeNull()
    const err = new SpecGenerationToolPolicyError('x', 'read-only')
    expect(err.code).toBe('provider_tool_policy_unsupported')
  })
})
