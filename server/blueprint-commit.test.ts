import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { classifyGhCreateError, createBlueprintCommitRunner, renderReadme, type BlueprintCommitIO } from './blueprint-commit'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry } from './project-registry'
import type { WsMessage } from './types'
import type { Blueprint } from './blueprint-types'
import { mutateStore, readStore } from './ticket-store'
import { writeBlueprintPair } from './blueprint-render'
import { parseBlueprintDraftBlocks } from './blueprint-draft-parser'

function richDescription(readme = false): string {
  return [
    '## Problem Statement',
    `Cooks need a reliable end-to-end workflow.${readme ? ' The repository already contains a README.' : ''}`,
    '', '## Proposed Solution', 'Build the complete workflow with TypeScript, Next.js, and SQLite using explicit boundaries.',
    '', '## Out of Scope', '- Social collaboration', '- Advanced personalization',
    '', '## Technical Considerations', '- Keep persistence independently testable', '- Cover loading, empty, success, and failure states',
    '', '## Estimated Complexity', 'Medium — the work crosses UI and persistence boundaries.',
  ].join('\n')
}

function richSpec(index: number) {
  const titles = ['Scaffold', 'Upload', 'Suggest', 'Review', 'Verify']
  return {
    kind: index === 0 ? 'scaffold' as const : index === 4 ? 'verification' as const : 'feature' as const,
    title: titles[index],
    shortSummary: `Deliver the ${titles[index].toLowerCase()} slice.`,
    description: richDescription(index === 0),
    acceptanceCriteria: [
      'The primary happy path completes successfully.',
      'Invalid input produces an actionable error.',
      'An empty state is rendered deliberately.',
      'Automated tests cover success and failure behavior.',
    ],
    priority: index === 1 ? 'high' as const : 'medium' as const,
    labels: ['M1', index === 0 ? 'foundation' : 'workflow'],
    ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
  }
}

function blueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'cooks' },
    coreFlow: 'photo → recipes',
    platform: 'web',
    stack: { language: 'TypeScript', framework: 'Next.js', db: 'SQLite' },
    assumptions: [],
    milestones: [
      { id: 'm1', title: 'Walking skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] },
      { id: 'm2', title: 'Accounts', goal: 'auth', status: 'planned', plannedSpecs: ['login'] },
    ],
    specsComplete: true,
    m1Specs: Array.from({ length: 5 }, (_, index) => richSpec(index)),
    ...overrides,
  }
}

interface Harness {
  runner: ReturnType<typeof createBlueprintCommitRunner>
  messages: WsMessage[]
  io: BlueprintCommitIO
  registered: unknown[]
  tmp: string
  workspace: string
}

function makeHarness(ioOverrides: Partial<BlueprintCommitIO> = {}): Harness {
  const db = initDesktopDb(':memory:')
  const messages: WsMessage[] = []
  const registered: unknown[] = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-commit-'))
  const workspace = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(workspace, '.specrails'), { recursive: true })

  const io: BlueprintCommitIO = {
    hasCore: () => true,
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    exec: vi.fn(async () => ({ code: 0, stderr: '' })),
    assemble: vi.fn(async () => { /* workspace pre-created above */ }),
    writePair: (ws, bp) => writeBlueprintPair(ws, bp),
    mutateTickets: (filePath, fn) => { mutateStore(filePath, fn) },
    registerProject: (opts) => { registered.push(opts) },
    ...ioOverrides,
  }
  const registry = { desktopDb: db } as unknown as ProjectRegistry
  const runner = createBlueprintCommitRunner({ registry, broadcast: (m) => messages.push(m), io })
  return { runner, messages, io, registered, tmp, workspace }
}

// The default writePair/mutateTickets target workspacePathFor(slug) — point the
// registry HOME into the tmp dir so nothing touches the real ~/.specrails.
let priorHome: string | undefined
let homeDir: string
beforeEach(() => {
  priorHome = process.env.SPECRAILS_REGISTRY_HOME
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-home-'))
  process.env.SPECRAILS_REGISTRY_HOME = homeDir
})
afterEach(() => {
  if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = priorHome
  fs.rmSync(homeDir, { recursive: true, force: true })
})

function validInput(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blueprint: blueprint(),
    name: 'Recipely',
    location: path.join(h.tmp, 'repo'),
    providers: ['claude'],
    ...extra,
  }
}

async function waitSettled(h: Harness): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (h.messages.some((m) => m.type === 'blueprint.commit_done' || m.type === 'blueprint.commit_failed')) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('commit never settled')
}

describe('validate', () => {
  it('rejects missing name / location / providers', () => {
    const h = makeHarness()
    expect(h.runner.validate({})).toMatchObject({ ok: false, error: 'invalid_name' })
    expect(h.runner.validate({ name: 'x' })).toMatchObject({ ok: false, error: 'invalid_location' })
    expect(h.runner.validate({ name: 'x', location: '/tmp/x', providers: [] })).toMatchObject({ ok: false, error: 'providers_required' })
  })

  it('rejects unknown provider', () => {
    const h = makeHarness()
    const v = h.runner.validate(validInput(h, { providers: ['claude', 'bogus'] }))
    expect(v).toMatchObject({ ok: false, error: 'unknown_provider', detail: 'bogus' })
  })

  it('rejects invalid blueprint and empty m1Specs', () => {
    const h = makeHarness()
    expect(h.runner.validate(validInput(h, { blueprint: { nope: 1 } }))).toMatchObject({ ok: false, error: 'invalid_blueprint' })
    expect(h.runner.validate(validInput(h, { blueprint: blueprint({ m1Specs: [] }) }))).toMatchObject({ ok: false, error: 'm1_specs_required' })
  })

  it('rejects m1Specs over the cap', () => {
    const h = makeHarness()
    const specs = Array.from({ length: 12 }, (_, i) => ({ ...richSpec(i % 5), title: `S${i}` }))
    const v = h.runner.validate(validInput(h, { blueprint: blueprint({ m1Specs: specs }) }))
    expect(v).toMatchObject({ ok: false, error: 'm1_specs_over_cap' })
  })

  it('rejects a shallow or incomplete M1 batch before any IO', () => {
    const h = makeHarness()
    const value = blueprint({
      specsComplete: false,
      m1Specs: Array.from({ length: 5 }, (_, index) => ({
        kind: index === 0 ? 'scaffold' : 'feature',
        title: `Spec ${index}`,
        shortSummary: '',
        description: 'Build it.',
        acceptanceCriteria: [],
        priority: 'medium',
        labels: ['M1'],
        ...(index === 0 ? { dependsOnIndex: 0 } : {}),
      })),
    })
    expect(h.runner.validate(validInput(h, { blueprint: value }))).toMatchObject({
      ok: false,
      error: 'm1_spec_quality_invalid',
      detail: 'generation is not marked complete',
    })
  })

  it('rejects the exact model payload before compatibility coercion can hide invalid fields', () => {
    const h = makeHarness()
    const raw = JSON.parse(JSON.stringify(blueprint())) as Record<string, unknown> & {
      m1Specs: Array<Record<string, unknown>>
    }
    raw.m1Specs[1].priority = 'urgent'
    raw.m1Specs[1].dependsOnIndex = -1
    const parsed = parseBlueprintDraftBlocks(
      `\`\`\`blueprint-draft\n${JSON.stringify(raw)}\n\`\`\``,
    )
    expect(parsed.blueprint?.m1Specs[1]).toMatchObject({ priority: 'medium' })
    expect(parsed.blueprint?.m1Specs[1].dependsOnIndex).toBeUndefined()
    expect(h.runner.validate(validInput(h, { blueprint: parsed.blueprint })).ok).toBe(true)
    expect(h.runner.validate(validInput(h, { blueprint: parsed.rawBlueprint }))).toMatchObject({
      ok: false,
      error: 'm1_spec_quality_invalid',
      detail: 'spec 2 priority must be critical, high, medium, or low',
    })
  })

  it('rejects when the bundled framework is missing', () => {
    const h = makeHarness({ hasCore: () => false })
    expect(h.runner.validate(validInput(h))).toMatchObject({ ok: false, error: 'bundled_framework_missing' })
  })

  it('rejects a non-empty target directory', () => {
    const h = makeHarness()
    const target = path.join(h.tmp, 'dirty')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'file.txt'), 'x')
    expect(h.runner.validate(validInput(h, { location: target }))).toMatchObject({ ok: false, error: 'location_not_empty' })
  })

  it('accepts an absent or empty target', () => {
    const h = makeHarness()
    expect(h.runner.validate(validInput(h)).ok).toBe(true)
    const empty = path.join(h.tmp, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    expect(h.runner.validate(validInput(h, { location: empty })).ok).toBe(true)
  })
})

describe('orchestration', () => {
  it('runs steps in order and settles commit_done', async () => {
    const h = makeHarness()
    h.runner.start(validInput(h))
    await waitSettled(h)
    const done = h.messages.find((m) => m.type === 'blueprint.commit_done')
    expect(done).toBeTruthy()
    const steps = h.messages
      .filter((m): m is Extract<WsMessage, { type: 'blueprint.commit_progress' }> => m.type === 'blueprint.commit_progress')
      .filter((m) => m.status === 'done')
      .map((m) => m.step)
    expect(steps).toEqual(['create-dir', 'git-init', 'assemble', 'blueprint', 'tickets', 'register'])
    expect(h.registered).toHaveLength(1)
    // README written into the repo
    const readme = fs.readFileSync(path.join(h.tmp, 'repo', 'README.md'), 'utf-8')
    expect(readme).toContain('# Recipely')
    expect(readme).toContain('Recipes from your pantry')
  })

  it('inserts M1 tickets in spec order with label M1, todo, prerequisites and advisory ids', async () => {
    const h = makeHarness()
    h.runner.start(validInput(h))
    await waitSettled(h)
    // default io wrote into workspacePathFor(slug) under the test HOME
    const wsTickets = path.join(homeDir, '.specrails', 'projects', 'recipely', 'workspace', '.specrails', 'local-tickets.json')
    const store = readStore(wsTickets)
    const tickets = Object.values(store.tickets)
    expect(tickets).toHaveLength(5)
    expect(tickets.map((t) => t.title)).toEqual(['Scaffold', 'Upload', 'Suggest', 'Review', 'Verify'])
    expect(tickets.every((t) => t.status === 'todo' && t.labels.includes('M1'))).toBe(true)
    expect(tickets.every((t) => t.source === 'project-builder' && t.created_by === 'project-builder')).toBe(true)
    expect(tickets[0].short_summary).toBe('Deliver the scaffold slice.')
    expect(tickets[1].priority).toBe('high')
    expect(tickets.every((t) => t.description.includes('## Acceptance Criteria'))).toBe(true)
    expect(tickets.every((t) => (t.description.match(/## Acceptance Criteria/g) ?? []).length === 1)).toBe(true)
    expect(tickets[1].prerequisites).toEqual([tickets[0].id])
    // blueprint pair re-rendered with committed M1 + advisory ids
    const bpJson = JSON.parse(fs.readFileSync(
      path.join(homeDir, '.specrails', 'projects', 'recipely', 'workspace', '.specrails', 'blueprint.json'), 'utf-8'))
    expect(bpJson.milestones[0].status).toBe('committed')
    expect(bpJson.milestones[0].ticketIds).toEqual(tickets.map((t) => t.id))
  })

  it('register-last crash posture: a failing assemble never registers the project', async () => {
    const h = makeHarness({ assemble: vi.fn(async () => { throw new Error('assemble exploded') }) })
    h.runner.start(validInput(h))
    await waitSettled(h)
    const failed = h.messages.find((m) => m.type === 'blueprint.commit_failed') as { step: string; error: string }
    expect(failed.step).toBe('assemble')
    expect(failed.error).toContain('assemble exploded')
    expect(h.registered).toHaveLength(0)
    expect(h.messages.some((m) => m.type === 'blueprint.commit_done')).toBe(false)
  })

  it('git failure aborts before assemble', async () => {
    const exec = vi.fn(async (bin: string) => (bin === 'git' ? { code: 128, stderr: 'boom' } : { code: 0, stderr: '' }))
    const h = makeHarness({ exec })
    h.runner.start(validInput(h))
    await waitSettled(h)
    const failed = h.messages.find((m) => m.type === 'blueprint.commit_failed') as { step: string }
    expect(failed.step).toBe('git-init')
    expect(h.io.assemble).not.toHaveBeenCalled()
    expect(h.registered).toHaveLength(0)
  })

  function githubWarning(h: Harness): { status: string; detail?: string; code?: string } | undefined {
    return h.messages.find(
      (m) => m.type === 'blueprint.commit_progress' && (m as { step: string }).step === 'github' && (m as { status: string }).status === 'warning',
    ) as { status: string; detail?: string; code?: string } | undefined
  }

  it('gh failure never aborts: warning step, commit still done, project registered', async () => {
    const exec = vi.fn(async (bin: string) => (bin === 'gh' ? { code: 1, stderr: 'no auth' } : { code: 0, stderr: '' }))
    const h = makeHarness({ exec })
    h.runner.start(validInput(h, { createGithubRepo: true }))
    await waitSettled(h)
    expect(h.messages.some((m) => m.type === 'blueprint.commit_done')).toBe(true)
    expect(h.registered).toHaveLength(1)
    // pre-flight `gh auth token` exits 1 → classified, repo create never spawned
    expect(githubWarning(h)?.code).toBe('gh_not_authenticated')
    const createCalls = exec.mock.calls.filter((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'repo')
    expect(createCalls).toHaveLength(0)
  })

  it('gh missing from PATH: pre-flight spawn error → gh_not_installed, no repo create', async () => {
    const exec = vi.fn(async (bin: string) =>
      bin === 'gh' ? { code: null, stderr: 'spawn gh ENOENT' } : { code: 0, stderr: '' })
    const h = makeHarness({ exec })
    h.runner.start(validInput(h, { createGithubRepo: true }))
    await waitSettled(h)
    expect(h.messages.some((m) => m.type === 'blueprint.commit_done')).toBe(true)
    expect(githubWarning(h)?.code).toBe('gh_not_installed')
    expect(exec.mock.calls.filter((c) => c[0] === 'gh')).toHaveLength(1)
  })

  it('authed pre-flight + failing repo create classifies the stderr (scope)', async () => {
    const exec = vi.fn(async (bin: string, args: string[]) => {
      if (bin !== 'gh') return { code: 0, stderr: '' }
      if (args[0] === 'auth') return { code: 0, stderr: '' }
      return { code: 1, stderr: 'GraphQL: Resource not accessible by integration (HTTP 403)' }
    })
    const h = makeHarness({ exec })
    h.runner.start(validInput(h, { createGithubRepo: true }))
    await waitSettled(h)
    const warn = githubWarning(h)
    expect(warn?.code).toBe('gh_scope')
    expect(warn?.detail).toContain('HTTP 403')
    expect(h.messages.some((m) => m.type === 'blueprint.commit_done')).toBe(true)
  })

  it('authed pre-flight + successful repo create emits done', async () => {
    const exec = vi.fn(async () => ({ code: 0, stderr: '' }))
    const h = makeHarness({ exec })
    h.runner.start(validInput(h, { createGithubRepo: true }))
    await waitSettled(h)
    expect(githubWarning(h)).toBeUndefined()
    const done = h.messages.find(
      (m) => m.type === 'blueprint.commit_progress' && (m as { step: string }).step === 'github' && (m as { status: string }).status === 'done',
    )
    expect(done).toBeTruthy()
    const createCall = exec.mock.calls.find((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'repo')
    expect(createCall).toBeTruthy()
  })

  it('no gh step when createGithubRepo is false', async () => {
    const h = makeHarness()
    h.runner.start(validInput(h))
    await waitSettled(h)
    const ghCalls = (h.io.exec as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'gh')
    expect(ghCalls).toHaveLength(0)
  })

  it('start throws on invalid input', () => {
    const h = makeHarness()
    expect(() => h.runner.start({})).toThrow(/invalid commit input/)
  })
})

describe('classifyGhCreateError', () => {
  it('maps stderr shapes to stable codes', () => {
    expect(classifyGhCreateError('To get started with GitHub CLI, please run: gh auth login')).toBe('gh_not_authenticated')
    expect(classifyGhCreateError('HTTP 401: Bad credentials')).toBe('gh_not_authenticated')
    expect(classifyGhCreateError('GraphQL: Resource not accessible (HTTP 403)')).toBe('gh_scope')
    expect(classifyGhCreateError('your token is missing the "repo" scope')).toBe('gh_scope')
    expect(classifyGhCreateError('GraphQL: Name already exists on this account (createRepository)')).toBe('gh_repo_exists')
    expect(classifyGhCreateError('dial tcp: lookup api.github.com: no such host')).toBe('gh_network')
    expect(classifyGhCreateError('error connecting to api.github.com: connection refused')).toBe('gh_network')
    expect(classifyGhCreateError('something else entirely')).toBe('gh_failed')
  })
})

describe('renderReadme', () => {
  it('renders deterministic content from the pitch', () => {
    const md = renderReadme(blueprint(), 'Recipely')
    expect(md).toContain('# Recipely')
    expect(md).toContain('**Core flow:** photo → recipes')
    expect(md).toContain('TypeScript · Next.js · SQLite')
    expect(md).toBe(renderReadme(blueprint(), 'Recipely'))
  })
})
