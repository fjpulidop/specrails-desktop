import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  initDb,
  createConversation,
  updateConversation,
  type DbInstance,
} from './db'
import {
  beginProjectProcessQuiescence,
  resetProcessAdmissionForTests,
} from './process-admission'

const SCOPE_OPT_IN = { specrails: true, openspec: false, full: true, mcp: false, contractRefine: true }
import {
  prepareContractRefineSpawn,
  applyContractLayerToTicket,
  runContractRefine,
  runContractRefineForQuick,
  readRefineChildOutput,
} from './contract-refine-runner'
import {
  CONTRACT_LAYER_SEPARATOR,
  type ContractLayer,
} from './explore-contract-refine'
import { mutateStore, resolveTicketStoragePath, type TicketStore, CURRENT_SCHEMA_VERSION } from './ticket-store'
import { mirrorProjectEntry, workspaceLayout, resolveHome } from './artifact-registry'

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
    // mimic claude finishing: after stdout drains, emit close
    setTimeout(() => c.emit('close', exitCode), delay)
    return c as unknown as ChildProcess
  }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']
}

function tmpProjectPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-'))
}

function seedTicketFile(
  filePath: string,
  id: number,
  description = 'user-authored body',
  title = 'test',
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // Initialise empty store via mutateStore (creates the file if missing).
  mutateStore(filePath, (s) => {
    s.schema_version = CURRENT_SCHEMA_VERSION
    s.next_id = id + 1
    s.tickets[String(id)] = {
      id,
      title,
      description,
      status: 'todo',
      priority: 'medium',
      labels: [],
      assignee: null,
      prerequisites: [],
      metadata: {},
      comments: [],
      origin_conversation_id: 'conv-1',
      is_epic: false,
      parent_epic_id: null,
      execution_order: null,
      short_summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'test',
      source: 'propose-spec',
    }
  })
}

function seedTicket(projectPath: string, id: number, description = 'user-authored body'): void {
  seedTicketFile(resolveTicketStoragePath(projectPath), id, description)
}

function setupRelocatedProject(slug: string): {
  repo: string
  workspace: string
  ticketsPath: string
  restore: () => void
} {
  const previousHome = process.env.SPECRAILS_REGISTRY_HOME
  const previousLegacyCwd = process.env.SPECRAILS_EXPLORE_LEGACY_CWD
  const registryHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-recovery-home-')))
  fs.mkdirSync(path.join(registryHome, '.specrails'), { recursive: true })
  process.env.SPECRAILS_REGISTRY_HOME = registryHome
  delete process.env.SPECRAILS_EXPLORE_LEGACY_CWD

  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-recovery-repo-')))
  mirrorProjectEntry({ repoPath: repo, slug, providers: ['claude'] }, registryHome)
  const workspace = workspaceLayout(resolveHome(registryHome), slug, repo).workspaceDir
  const ticketsPath = path.join(workspace, '.specrails', 'local-tickets.json')
  fs.mkdirSync(path.dirname(ticketsPath), { recursive: true })
  fs.writeFileSync(path.join(workspace, '.specrails', 'specrails-version'), '4.10.0\n')

  return {
    repo,
    workspace,
    ticketsPath,
    restore: () => {
      if (previousHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = previousHome
      else delete process.env.SPECRAILS_REGISTRY_HOME
      if (previousLegacyCwd !== undefined) process.env.SPECRAILS_EXPLORE_LEGACY_CWD = previousLegacyCwd
      else delete process.env.SPECRAILS_EXPLORE_LEGACY_CWD
      fs.rmSync(registryHome, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    },
  }
}

function validContractBlock(): string {
  return [
    'preface text from the model',
    '```contract-layer',
    JSON.stringify({
      contractVersion: 1,
      namingContract: { enums: [], fields: [], functions: [], files: [] },
      dataShapes: [],
      stateMachine: 'A -> B',
      invariants: ['no nulls'],
      fileTouchList: [{ path: 'x.ts', action: 'extend', reason: 'r' }],
    }),
    '```',
  ].join('\n')
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
      total_cost_usd: 0.001,
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'claude-haiku-4-5',
    }),
  ]
}

/**
 * BUG-PARSER-04: stream lines whose final `result` event carries an error /
 * truncation marker (the model never finished emitting the contract block) but
 * the process still exits 0.
 */
function streamLinesWithResult(text: string, resultOverrides: Record<string, unknown>): string[] {
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
      total_cost_usd: 0.001,
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'claude-haiku-4-5',
      ...resultOverrides,
    }),
  ]
}

describe('prepareContractRefineSpawn', () => {
  it('produces deterministic pure-output argv with no tools or permission bypass', () => {
    const projectPath = tmpProjectPath()
    const out = prepareContractRefineSpawn(
      { projectSlug: 'slug', projectPath, projectName: 'proj' },
      { model: 'haiku', session_id: 'sess-1', context_scope: null },
    )
    expect(out.args).toContain('--resume')
    expect(out.args).toContain('sess-1')
    expect(out.args.slice(out.args.indexOf('--tools'), out.args.indexOf('--tools') + 2))
      .toEqual(['--tools', '__none__'])
    expect(out.args).not.toContain('--dangerously-skip-permissions')
    expect(out.args).not.toContain('--disallowedTools')
    expect(out.args).toContain('-p')
    expect(out.args[out.args.length - 1]).toMatch(/CONTRACT REFINE/)
    expect(out.systemPrompt).toMatch(/Contract Refine/)
  })

  it('uses project path when contextScope.mcp is true', () => {
    const projectPath = tmpProjectPath()
    const out = prepareContractRefineSpawn(
      { projectSlug: 'slug', projectPath, projectName: 'proj' },
      { model: 'sonnet', session_id: 'sess-1', context_scope: JSON.stringify({ mcp: true }) },
    )
    expect(out.cwd).toBe(projectPath)
  })

  it('RELOCATED + mcp: resumes from the WORKSPACE (matches the Explore mcp-on spawn cwd)', () => {
    // The Explore mcp-on turn spawns through the relocate-artifacts gate — the
    // WORKSPACE when relocated (where `.mcp.json` and `.specrails/` live; a
    // repo cwd made the model create `<repo>/.specrails/local-tickets.json`).
    // The refine `--resume`s that session, so it must use the SAME cwd or
    // claude fails with "No conversation found with session ID …".
    const prevHome = process.env.SPECRAILS_REGISTRY_HOME
    const regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reloc-home-')))
    fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
    process.env.SPECRAILS_REGISTRY_HOME = regHome
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reloc-repo-')))
    try {
      mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude'] }, regHome)
      const ws = workspaceLayout(resolveHome(regHome), 'acme', repo).workspaceDir
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.10.0\n')

      const out = prepareContractRefineSpawn(
        { projectSlug: 'acme', projectPath: repo, projectName: 'Acme' },
        { model: 'sonnet', session_id: 'sess-x', context_scope: JSON.stringify({ mcp: true }) },
      )
      expect(out.cwd).toBe(ws)     // the workspace — matches the Explore session's cwd
      expect(out.cwd).not.toBe(repo)
      expect(out.env?.SPECRAILS_REPO_DIR).toBe(repo)
      expect(out.env?.SPECRAILS_WORKSPACE_DIR).toBe(ws)
    } finally {
      if (prevHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevHome
      else delete process.env.SPECRAILS_REGISTRY_HOME
      fs.rmSync(regHome, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('RELOCATED + mcp + SPECRAILS_EXPLORE_LEGACY_CWD=1: forces project.path', () => {
    const prevHome = process.env.SPECRAILS_REGISTRY_HOME
    const prevLegacy = process.env.SPECRAILS_EXPLORE_LEGACY_CWD
    const regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reloc-home-')))
    fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
    process.env.SPECRAILS_REGISTRY_HOME = regHome
    process.env.SPECRAILS_EXPLORE_LEGACY_CWD = '1'
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reloc-repo-')))
    try {
      mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude'] }, regHome)
      const ws = workspaceLayout(resolveHome(regHome), 'acme', repo).workspaceDir
      fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.10.0\n')

      const out = prepareContractRefineSpawn(
        { projectSlug: 'acme', projectPath: repo, projectName: 'Acme' },
        { model: 'sonnet', session_id: 'sess-x', context_scope: JSON.stringify({ mcp: true }) },
      )
      expect(out.cwd).toBe(repo)
      expect(out.env).toBeUndefined()
    } finally {
      if (prevHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevHome
      else delete process.env.SPECRAILS_REGISTRY_HOME
      if (prevLegacy !== undefined) process.env.SPECRAILS_EXPLORE_LEGACY_CWD = prevLegacy
      else delete process.env.SPECRAILS_EXPLORE_LEGACY_CWD
      fs.rmSync(regHome, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('applyContractLayerToTicket', () => {
  it('appends the contract layer markdown to the description', () => {
    const projectPath = tmpProjectPath()
    seedTicket(projectPath, 42, 'original body')
    const filePath = resolveTicketStoragePath(projectPath)
    const layer: ContractLayer = {
      contractVersion: 1,
      namingContract: { enums: [], fields: [], functions: [], files: [] },
      dataShapes: [],
      stateMachine: null,
      invariants: ['inv-1'],
      fileTouchList: [],
    }
    const updated = applyContractLayerToTicket(filePath, 42, layer, '2026-05-12T00:00:00Z')
    expect(updated).not.toBeNull()
    expect(updated!.description).toContain('original body')
    expect(updated!.description).toContain(CONTRACT_LAYER_SEPARATOR)
    expect(updated!.description).toContain('### Invariants')
  })

  it('returns null when ticket id is unknown', () => {
    const projectPath = tmpProjectPath()
    const filePath = resolveTicketStoragePath(projectPath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    mutateStore(filePath, (s) => { s.schema_version = CURRENT_SCHEMA_VERSION; s.next_id = 1 })
    const layer: ContractLayer = {
      contractVersion: 1,
      namingContract: { enums: [], fields: [], functions: [], files: [] },
      dataShapes: [],
      stateMachine: null,
      invariants: [],
      fileTouchList: [],
    }
    const updated = applyContractLayerToTicket(filePath, 999, layer, '2026-05-12T00:00:00Z')
    expect(updated).toBeNull()
  })
})

describe('runContractRefine', () => {
  let db: DbInstance
  let projectPath: string
  let broadcastEvents: Array<{ type?: string; reason?: string; ticketId?: number }>
  const broadcast = (msg: unknown) => {
    broadcastEvents.push(msg as { type?: string; reason?: string; ticketId?: number })
  }

  beforeEach(() => {
    db = initDb(':memory:')
    projectPath = tmpProjectPath()
    broadcastEvents = []
  })

  afterEach(() => resetProcessAdmissionForTests())

  function makeDeps(overrides: { spawn?: ReturnType<typeof fakeSpawn> } = {}) {
    return {
      db,
      projectId: 'proj-1',
      projectSlug: 'slug',
      projectPath,
      projectName: 'proj',
      broadcast,
      spawn: overrides.spawn,
      now: () => new Date('2026-05-12T00:00:00Z'),
      timeoutMs: 5000,
    }
  }

  function makeExploreConv(id: string, opts: { optIn?: boolean } = { optIn: true }): string {
    createConversation(db, {
      id,
      model: 'sonnet',
      kind: 'explore',
      ...(opts.optIn ? { contextScope: SCOPE_OPT_IN } : {}),
    })
    updateConversation(db, id, { session_id: 'sess-1' })
    return id
  }

  function setConversationScope(id: string, scope: Record<string, unknown>): void {
    db.prepare('UPDATE chat_conversations SET context_scope = ? WHERE id = ?')
      .run(JSON.stringify(scope), id)
  }

  it('returns scope-disabled when conversation context scope is missing (legacy)', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1', { optIn: false })
    const out = await runContractRefine(makeDeps(), 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('scope-disabled')
  })

  it('returns scope-disabled when conversation context scope opted out', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1', { optIn: false })
    setConversationScope('conv-1', { specrails: true, openspec: false, full: true, mcp: false, contractRefine: false })
    let spawned = false
    const spawn = (() => {
      spawned = true
      return new FakeChild([]) as unknown as ChildProcess
    }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']

    const out = await runContractRefine(makeDeps({ spawn }), 'conv-1', 1)

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('scope-disabled')
    expect(spawned).toBe(false)
    expect(broadcastEvents).toEqual([])
    const rows = db.prepare('SELECT * FROM ai_invocations').all()
    expect(rows).toHaveLength(0)
  })

  it('runs when conversation scope opts in', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')

    const out = await runContractRefine(makeDeps({ spawn: fakeSpawn(streamLines(validContractBlock()), 0) }), 'conv-1', 1)

    expect(out.ok).toBe(true)
  })

  it('ignores conversation scope when retry path forces a fresh refine', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1', { optIn: false })
    setConversationScope('conv-1', { specrails: true, openspec: false, full: true, mcp: false, contractRefine: false })

    const out = await runContractRefine(
      { ...makeDeps({ spawn: fakeSpawn(streamLines(validContractBlock()), 0) }), ignoreConversationScope: true },
      'conv-1',
      1,
    )

    expect(out.ok).toBe(true)
  })

  it('returns not-explore when conversation kind is not explore', async () => {
    seedTicket(projectPath, 1)
    createConversation(db, { id: 'conv-1', model: 'sonnet', kind: 'sidebar' })
    updateConversation(db, 'conv-1', { session_id: 'sess-1' })
    const out = await runContractRefine(makeDeps(), 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not-explore')
  })

  it('returns no-session when conversation has not produced a session_id yet', async () => {
    seedTicket(projectPath, 1)
    createConversation(db, { id: 'conv-1', model: 'sonnet', kind: 'explore', contextScope: SCOPE_OPT_IN })
    const out = await runContractRefine(makeDeps(), 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no-session')
  })

  it('completes successfully and patches the ticket', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const deps = makeDeps({ spawn: fakeSpawn(streamLines(validContractBlock()), 0) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(true)
    const ticketUpdated = broadcastEvents.find((e) => e.type === 'ticket_updated')
    expect(ticketUpdated).toBeDefined()
    const filePath = resolveTicketStoragePath(projectPath)
    const stored: TicketStore = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(stored.tickets['1'].description).toContain('### Invariants')
  })

  it('RELOCATED stale Explore session: retries once fresh in the same workspace with ticket context', async () => {
    const relocated = setupRelocatedProject('slug')
    projectPath = relocated.repo
    seedTicketFile(
      relocated.ticketsPath,
      1,
      'Recovery description sentinel',
      'Recovery title sentinel',
    )
    makeExploreConv('conv-1')
    setConversationScope('conv-1', { ...SCOPE_OPT_IN, mcp: true })

    const missingSessionLines = [JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: sess-1'],
      session_id: 'sess-1',
    })]
    const calls: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = []
    const spawn = ((_bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: [...args], cwd: opts.cwd, env: opts.env })
      const lines = calls.length === 1
        ? missingSessionLines
        : streamLines(validContractBlock())
      const child = new FakeChild(lines)
      setTimeout(() => child.emit('close', calls.length === 1 ? 1 : 0), 5)
      return child as unknown as ChildProcess
    }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']

    try {
      const out = await runContractRefine(makeDeps({ spawn }), 'conv-1', 1)

      expect(out).toEqual({ ok: true, ticketId: 1, conversationId: 'conv-1' })
      expect(calls).toHaveLength(2)
      expect(calls[0].args).toContain('--resume')
      expect(calls[0].args).toContain('sess-1')
      expect(calls[1].args).not.toContain('--resume')
      expect(calls[1].args.slice(
        calls[1].args.indexOf('--tools'),
        calls[1].args.indexOf('--tools') + 2,
      )).toEqual(['--tools', '__none__'])
      expect(calls[0].cwd).toBe(relocated.workspace)
      expect(calls[1].cwd).toBe(relocated.workspace)
      expect(calls[1].cwd).not.toBe(relocated.repo)
      expect(calls[1].env).toBe(calls[0].env)
      expect(calls[1].env?.SPECRAILS_REPO_DIR).toBe(relocated.repo)
      expect(calls[1].env?.SPECRAILS_WORKSPACE_DIR).toBe(relocated.workspace)

      const freshSystemPrompt = calls[1].args[calls[1].args.indexOf('--system-prompt') + 1]
      expect(freshSystemPrompt).toContain('Recovery title sentinel')
      expect(freshSystemPrompt).toContain('Recovery description sentinel')

      const stored = JSON.parse(fs.readFileSync(relocated.ticketsPath, 'utf8')) as TicketStore
      expect(stored.tickets['1'].description.split(CONTRACT_LAYER_SEPARATOR)).toHaveLength(2)
      const rows = db.prepare(
        'SELECT surface, surface_ref_id, conversation_id, ticket_id, status FROM ai_invocations',
      ).all()
      expect(rows).toEqual([{
        surface: 'explore-spec',
        surface_ref_id: 'contract-refine:conv-1',
        conversation_id: 'conv-1',
        ticket_id: 1,
        status: 'success',
      }])
      expect(broadcastEvents.filter((event) => event.type === 'explore.contract_refine_started')).toHaveLength(1)
      expect(broadcastEvents.filter((event) => event.type === 'explore.contract_refine_failed')).toHaveLength(0)
    } finally {
      relocated.restore()
    }
  })

  it('does not fresh-retry a relocated resume for a different Claude error', async () => {
    const relocated = setupRelocatedProject('slug')
    projectPath = relocated.repo
    seedTicketFile(relocated.ticketsPath, 1, 'original body')
    makeExploreConv('conv-1')
    setConversationScope('conv-1', { ...SCOPE_OPT_IN, mcp: true })

    let spawnCount = 0
    const otherErrorLines = [JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Authentication failed'],
      session_id: 'sess-1',
    })]
    const spawn = ((_bin: string, _args: string[]) => {
      spawnCount++
      const child = new FakeChild(otherErrorLines)
      setTimeout(() => child.emit('close', 1), 5)
      return child as unknown as ChildProcess
    }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']

    try {
      const out = await runContractRefine(makeDeps({ spawn }), 'conv-1', 1)

      expect(out).toMatchObject({ ok: false, reason: 'model_error' })
      expect(spawnCount).toBe(1)
      const stored = JSON.parse(fs.readFileSync(relocated.ticketsPath, 'utf8')) as TicketStore
      expect(stored.tickets['1'].description).toBe('original body')
      expect(db.prepare(
        'SELECT conversation_id, status FROM ai_invocations',
      ).all()).toEqual([{ conversation_id: 'conv-1', status: 'failed' }])
    } finally {
      relocated.restore()
    }
  })

  it('does not retry the fresh compatibility pass when it also fails', async () => {
    const relocated = setupRelocatedProject('slug')
    projectPath = relocated.repo
    seedTicketFile(relocated.ticketsPath, 1, 'original body')
    makeExploreConv('conv-1')
    setConversationScope('conv-1', { ...SCOPE_OPT_IN, mcp: true })

    let spawnCount = 0
    const missingSessionLines = [JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: sess-1'],
      session_id: 'sess-1',
    })]
    const spawn = ((_bin: string, _args: string[]) => {
      spawnCount++
      const child = new FakeChild(missingSessionLines)
      setTimeout(() => child.emit('close', 1), 5)
      return child as unknown as ChildProcess
    }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']

    try {
      const out = await runContractRefine(makeDeps({ spawn }), 'conv-1', 1)

      expect(out).toMatchObject({ ok: false, reason: 'model_error' })
      expect(spawnCount).toBe(2)
      const stored = JSON.parse(fs.readFileSync(relocated.ticketsPath, 'utf8')) as TicketStore
      expect(stored.tickets['1'].description).toBe('original body')
      expect(db.prepare('SELECT conversation_id, status FROM ai_invocations').all())
        .toEqual([{ conversation_id: 'conv-1', status: 'failed' }])
    } finally {
      relocated.restore()
    }
  })

  it('emits explore.contract_refine_failed with reason=malformed for an unparseable block', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const lines = streamLines('```contract-layer\nNOT JSON\n```')
    const deps = makeDeps({ spawn: fakeSpawn(lines, 0) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('malformed')
    const fail = broadcastEvents.find((e) => e.type === 'explore.contract_refine_failed')
    expect(fail).toBeDefined()
    expect(fail!.reason).toBe('malformed')
  })

  it('BUG-PARSER-04: emits model_error (not malformed) on exit-0 result with is_error=true', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    // Exit 0, result event present, but truncated → no parseable block + is_error.
    const lines = streamLinesWithResult('partial text, no fence', { is_error: true })
    const deps = makeDeps({ spawn: fakeSpawn(lines, 0) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('model_error')
    const fail = broadcastEvents.find((e) => e.type === 'explore.contract_refine_failed')
    expect(fail!.reason).toBe('model_error')
    // Records a failed invocation, ticket not patched.
    const row = db.prepare('SELECT status FROM ai_invocations').get() as { status: string }
    expect(row.status).toBe('failed')
  })

  it('BUG-PARSER-04: emits model_error (not malformed) on exit-0 error_max_turns subtype', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const lines = streamLinesWithResult('truncated', { subtype: 'error_max_turns' })
    const deps = makeDeps({ spawn: fakeSpawn(lines, 0) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('model_error')
  })

  it('BUG-PARSER-04 (quick): emits model_error on exit-0 error_max_turns subtype', async () => {
    seedTicket(projectPath, 1)
    const lines = streamLinesWithResult('truncated', { subtype: 'error_max_turns' })
    const out = await runContractRefineForQuick(
      makeDeps({ spawn: fakeSpawn(lines, 0) }),
      1,
      'Quick title',
      'Quick description',
      'haiku',
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('model_error')
    const fail = broadcastEvents.find((e) => e.type === 'explore.contract_refine_failed')
    expect(fail!.reason).toBe('model_error')
  })

  it('emits reason=model_error when claude exits non-zero with a result event', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const lines = streamLines('') // result event present, no block
    const deps = makeDeps({ spawn: fakeSpawn(lines, 2) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('model_error')
    const fail = broadcastEvents.find((e) => e.type === 'explore.contract_refine_failed')
    expect(fail!.reason).toBe('model_error')
  })

  it('emits reason=crashed when claude exits non-zero with no result event', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const deps = makeDeps({ spawn: fakeSpawn([], 1) })
    const out = await runContractRefine(deps, 'conv-1', 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('crashed')
  })

  it('does not patch the ticket on failure', async () => {
    seedTicket(projectPath, 1, 'original body')
    makeExploreConv('conv-1')
    const lines = streamLines('```contract-layer\nNOT JSON\n```')
    const deps = makeDeps({ spawn: fakeSpawn(lines, 0) })
    await runContractRefine(deps, 'conv-1', 1)
    const filePath = resolveTicketStoragePath(projectPath)
    const stored: TicketStore = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(stored.tickets['1'].description).toBe('original body')
  })

  it('abandons a stale completion after project teardown without DB or ticket writes', async () => {
    seedTicket(projectPath, 1, 'original body')
    makeExploreConv('conv-1')
    const pending = runContractRefine(
      makeDeps({ spawn: fakeSpawn(streamLines(validContractBlock()), 0, 20) }),
      'conv-1',
      1,
    )

    beginProjectProcessQuiescence('proj-1')
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'aborted' })

    const stored: TicketStore = JSON.parse(
      fs.readFileSync(resolveTicketStoragePath(projectPath), 'utf8'),
    )
    expect(stored.tickets['1'].description).toBe('original body')
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_invocations').get())
      .toMatchObject({ count: 0 })
    expect(broadcastEvents.some((event) =>
      event.type === 'ticket_updated' || event.type === 'explore.contract_refine_failed'
    )).toBe(false)
  })

  it('records an ai_invocations row on success', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const deps = makeDeps({ spawn: fakeSpawn(streamLines(validContractBlock()), 0) })
    await runContractRefine(deps, 'conv-1', 1)
    const rows = db.prepare('SELECT * FROM ai_invocations WHERE conversation_id = ?').all('conv-1') as Array<{ status: string; ticket_id: number; surface: string; surface_ref_id: string; model: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
    expect(rows[0].ticket_id).toBe(1)
    expect(rows[0].surface).toBe('explore-spec')
    expect(rows[0].surface_ref_id).toBe('contract-refine:conv-1')
    expect(rows[0].model).toBe('claude-haiku-4-5')
    expect(broadcastEvents.some((e) => e.type === 'explore.contract_refine_started' && e.ticketId === 1)).toBe(true)
  })

  it('records an ai_invocations row with status=failed on a parse failure', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const lines = streamLines('```contract-layer\nNOT JSON\n```')
    const deps = makeDeps({ spawn: fakeSpawn(lines, 0) })
    await runContractRefine(deps, 'conv-1', 1)
    const rows = db.prepare('SELECT * FROM ai_invocations WHERE conversation_id = ?').all('conv-1') as Array<{ status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })

  it('runs Quick refine without --resume and records quick-spec invocation', async () => {
    seedTicket(projectPath, 1)
    let seenArgs: string[] = []
    const spawn = ((_bin: string, args: string[]) => {
      seenArgs = args
      const c = new FakeChild(streamLines(validContractBlock()))
      setTimeout(() => c.emit('close', 0), 5)
      return c as unknown as ChildProcess
    }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']

    const out = await runContractRefineForQuick(
      makeDeps({ spawn }),
      1,
      'Quick title',
      'Quick description',
      'haiku',
    )

    expect(out.ok).toBe(true)
    expect(seenArgs).not.toContain('--resume')
    expect(seenArgs).toContain('--system-prompt')
    expect(seenArgs.slice(seenArgs.indexOf('--tools'), seenArgs.indexOf('--tools') + 2))
      .toEqual(['--tools', '__none__'])
    expect(seenArgs).not.toContain('--dangerously-skip-permissions')
    expect(seenArgs).not.toContain('--disallowedTools')
    expect(seenArgs.join('\n')).toContain('Quick title')
    const rows = db.prepare('SELECT surface, surface_ref_id, conversation_id, ticket_id, status, model FROM ai_invocations').all() as Array<{
      surface: string
      surface_ref_id: string | null
      conversation_id: string | null
      ticket_id: number
      status: string
      model: string | null
    }>
    expect(rows).toEqual([
      { surface: 'quick-spec', surface_ref_id: 'contract-refine:1', conversation_id: null, ticket_id: 1, status: 'success', model: 'claude-haiku-4-5' },
    ])
    expect(broadcastEvents.some((e) => e.type === 'explore.contract_refine_started' && e.ticketId === 1)).toBe(true)
  })

  it('respects the kill switch env even when the toggle is ON', async () => {
    seedTicket(projectPath, 1)
    makeExploreConv('conv-1')
    const prev = process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE
    process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE = '0'
    try {
      const out = await runContractRefine(makeDeps(), 'conv-1', 1)
      expect(out.ok).toBe(false)
      expect(out.reason).toBe('disabled')
    } finally {
      if (prev === undefined) delete process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE
      else process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE = prev
    }
  })

  it('quick path (agent-authored/Quick specs) respects the kill switch: no spawn, no started broadcast', async () => {
    seedTicket(projectPath, 1)
    const prev = process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE
    process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE = 'off'
    const spawn = vi.fn()
    try {
      const out = await runContractRefineForQuick(
        makeDeps({ spawn: spawn as never }),
        1,
        'Quick title',
        'Quick description',
      )
      expect(out.ok).toBe(false)
      expect(out.reason).toBe('disabled')
      expect(spawn).not.toHaveBeenCalled()
      expect(broadcastEvents.some((e) => e.type === 'explore.contract_refine_started')).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 0 })
    } finally {
      if (prev === undefined) delete process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE
      else process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE = prev
    }
  })
})

describe('BUG-PARSER-01: readRefineChildOutput timeout teardown', () => {
  // A child that never emits `close` so the timeout path fires.
  class HangingChild extends EventEmitter {
    stdout: Readable
    stderr: Readable | null = null
    pid = 4242
    constructor() {
      super()
      // An open, never-ending stream keeps the readline interface alive.
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
    const result = await readRefineChildOutput(child as unknown as ChildProcess, 20, kill)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    expect(child.stdout.destroyed).toBe(true)
    // SIGTERM fired immediately against the whole subtree (not a bare child.kill).
    expect(kills.some((k) => k.pid === 4242 && k.signal === 'SIGTERM')).toBe(true)
    // SIGKILL escalation fires after the 2s grace window.
    await new Promise((r) => setTimeout(r, 2100))
    expect(kills.some((k) => k.pid === 4242 && k.signal === 'SIGKILL')).toBe(true)
  })

  it('cancels the SIGKILL escalation when the child closes within the grace window', async () => {
    const child = new HangingChild()
    const kills: Array<{ pid: number; signal: string }> = []
    const kill = (pid: number, signal: string, cb?: (err?: Error) => void) => {
      kills.push({ pid, signal })
      cb?.()
    }
    const p = readRefineChildOutput(child as unknown as ChildProcess, 20, kill)
    // After the timeout fires (SIGTERM sent), the CLI honours it and exits
    // before the SIGKILL escalation window elapses.
    await new Promise((r) => setTimeout(r, 50))
    child.emit('close', 143)
    await p
    await new Promise((r) => setTimeout(r, 2100))
    expect(kills.some((k) => k.signal === 'SIGTERM')).toBe(true)
    // No SIGKILL — the escalation timer was cleared on close.
    expect(kills.some((k) => k.signal === 'SIGKILL')).toBe(false)
  })
})
