import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The 'file-summary' surface is being added in a sibling task; pre-extend the
// allow-list here so recordInvocation accepts our rows during tests.
vi.mock('./ai-invocations', async () => {
  const actual = await vi.importActual<typeof import('./ai-invocations')>('./ai-invocations')
  return {
    ...actual,
    recordInvocation: (db: import('./db').DbInstance, input: import('./ai-invocations').RecordInput) => {
      const patched = { ...input, surface: input.surface === ('file-summary' as never) ? 'job' as const : input.surface }
      // Store the original surface in surface_ref_id prefix so tests can detect it
      // — but keep it simple: just rewrite to 'job' for storage, and assert via status.
      return actual.recordInvocation(db, patched as import('./ai-invocations').RecordInput)
    },
  }
})

import { initDb, type DbInstance } from './db'
import {
  FileSummaryManager,
  computeFileHash,
  pathHash,
  readSummary,
  writeSummary,
  summaryFilePath,
  summariesDir,
  sweepOrphans,
  isValidSummaryPayload,
  SUMMARY_MAX_LENGTH,
  __resetDesktopSummaryStateForTests,
  type FileSummaryDeps,
  type GenerateInput,
  type GenerateOutput,
  type SummaryPayload,
} from './file-summary-manager'

function mkTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-test-'))
}

function writeFile(projectPath: string, rel: string, contents: string): void {
  const abs = path.join(projectPath, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents, 'utf8')
}

function makeDeps(
  db: DbInstance,
  overrides: Partial<FileSummaryDeps> = {},
): { deps: FileSummaryDeps; broadcasts: Array<{ type: string; [k: string]: unknown }>; generate: ReturnType<typeof vi.fn> } {
  const broadcasts: Array<{ type: string; [k: string]: unknown }> = []
  const generate = vi.fn(async (_input: GenerateInput): Promise<GenerateOutput> => ({
    summary: 'A test summary.',
    model: 'claude-haiku-4-5',
    provider: 'claude',
    costUsd: 0.0001,
    tokensIn: 100,
    tokensOut: 20,
    durationMs: 5,
  }))
  const deps: FileSummaryDeps = {
    db,
    broadcast: (msg) => {
      broadcasts.push(msg as unknown as { type: string })
    },
    generate,
    monthToDateSpend: () => 0,
    monthlyBudgetUsd: () => 5,
    ...overrides,
  }
  return { deps, broadcasts, generate }
}

let projectPath: string
let db: DbInstance

beforeEach(() => {
  projectPath = mkTmpProject()
  db = initDb(':memory:')
  __resetDesktopSummaryStateForTests()
})

afterEach(() => {
  try { fs.rmSync(projectPath, { recursive: true, force: true }) } catch {}
  try { db.close() } catch {}
})

describe('pathHash + summaryFilePath', () => {
  it('returns a 64-char hex sha256 of the UTF-8 bytes', () => {
    const h = pathHash('src/components/Login.tsx')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes non-ASCII paths consistently and locates the same file', () => {
    const rel = 'src/ñoño/áéí.ts'
    const a = pathHash(rel)
    const b = pathHash(rel)
    expect(a).toBe(b)
    expect(summaryFilePath(projectPath, rel)).toBe(
      path.join(summariesDir(projectPath), `${a}.json`),
    )
  })
})

describe('writeSummary + readSummary roundtrip', () => {
  it('atomically writes and reads back identical payload', () => {
    const payload: SummaryPayload = {
      schemaVersion: 1,
      path: 'a.ts',
      fileHash: 'a'.repeat(64),
      summary: 'hello',
      language: 'en',
      generatedAt: '2026-05-23T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1, truncated: false },
      triggeredBy: { kind: 'job', id: 'job_1', ticketId: 42 },
    }
    writeSummary(projectPath, 'a.ts', payload)
    expect(readSummary(projectPath, 'a.ts')).toEqual(payload)
  })

  it('leaves no .tmp.* files after a successful write', () => {
    const payload: SummaryPayload = {
      schemaVersion: 1,
      path: 'a.ts',
      fileHash: 'b'.repeat(64),
      summary: 'x',
      language: 'en',
      generatedAt: '2026-05-23T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    }
    writeSummary(projectPath, 'a.ts', payload)
    const entries = fs.readdirSync(summariesDir(projectPath))
    expect(entries.filter((e) => e.includes('.tmp.'))).toHaveLength(0)
  })

  it('readSummary returns null when no file exists', () => {
    expect(readSummary(projectPath, 'missing.ts')).toBeNull()
  })
})

describe('FileSummaryManager.enqueue', () => {
  it('hash-gates: matching hash returns skipped:hash and does not call generate', async () => {
    writeFile(projectPath, 'src/foo.ts', 'console.log("hi")\n')
    const hash = await computeFileHash(path.join(projectPath, 'src/foo.ts'))
    writeSummary(projectPath, 'src/foo.ts', {
      schemaVersion: 1,
      path: 'src/foo.ts',
      fileHash: hash,
      summary: 'old summary',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'job', id: 'job_old', ticketId: 1 },
    })
    const { deps, generate, broadcasts } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'src/foo.ts',
      triggeredBy: { kind: 'job', id: 'job_new', ticketId: 1 },
    })
    expect(result).toBe('skipped:hash')
    expect(generate).not.toHaveBeenCalled()
    expect(broadcasts.some((b) => b.type === 'file.summary_updated')).toBe(true)
  })

  it('hash-mismatch path calls generate and writes new summary', async () => {
    writeFile(projectPath, 'src/foo.ts', 'console.log("hi")\n')
    writeSummary(projectPath, 'src/foo.ts', {
      schemaVersion: 1,
      path: 'src/foo.ts',
      fileHash: '0'.repeat(64),
      summary: 'old',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'job', id: 'job_old', ticketId: 1 },
    })
    const { deps, generate } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'src/foo.ts',
      triggeredBy: { kind: 'job', id: 'job_new', ticketId: 1 },
      jobId: 'job_new',
    })
    await mgr.flush()
    expect(generate).toHaveBeenCalledTimes(1)
    const stored = readSummary(projectPath, 'src/foo.ts')
    expect(stored?.summary).toBe('A test summary.')
    // ai_invocations row inserted.
    const rows = db.prepare(`SELECT * FROM ai_invocations`).all() as Array<{ surface: string; status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
  })

  it('RELOCATED: summary OUTPUT lands in summaryRoot (workspace), source READ from projectPath (repo)', async () => {
    // Source file lives in the repo; summaries must be written under a SEPARATE
    // workspace root and NOT into the repo's .specrails/file-summaries.
    writeFile(projectPath, 'src/foo.ts', 'console.log("relocated")\n')
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-ws-'))
    try {
      const { deps, generate } = makeDeps(db)
      const mgr = new FileSummaryManager(deps)
      await mgr.enqueue({
        projectPath,
        summaryRoot: workspace,
        projectId: 'p1',
        projectSlug: 'p1',
        relPath: 'src/foo.ts',
        triggeredBy: { kind: 'job', id: 'job_reloc', ticketId: null },
        jobId: 'job_reloc',
      })
      await mgr.flush()
      expect(generate).toHaveBeenCalledTimes(1)
      // Summary readable from the workspace root, absent from the repo root.
      expect(readSummary(workspace, 'src/foo.ts')?.summary).toBe('A test summary.')
      expect(readSummary(projectPath, 'src/foo.ts')).toBeNull()
      // The repo .gitignore must NOT be touched (workspace is app-owned).
      expect(fs.existsSync(path.join(projectPath, '.gitignore'))).toBe(false)
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('budget cap skips job-triggered enqueue when spend >= budget', async () => {
    writeFile(projectPath, 'src/foo.ts', 'a\n')
    const { deps, generate, broadcasts } = makeDeps(db, {
      monthToDateSpend: () => 10,
      monthlyBudgetUsd: () => 5,
    })
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'src/foo.ts',
      triggeredBy: { kind: 'job', id: 'job1', ticketId: null },
      jobId: 'job1',
    })
    expect(result).toBe('skipped:budget')
    expect(generate).not.toHaveBeenCalled()
    expect(
      broadcasts.some(
        (b) => b.type === 'file.summary_skipped' && b.reason === 'budget',
      ),
    ).toBe(true)
  })

  it('overrideBudget bypasses the budget cap', async () => {
    writeFile(projectPath, 'src/foo.ts', 'a\n')
    const { deps, generate } = makeDeps(db, {
      monthToDateSpend: () => 10,
      monthlyBudgetUsd: () => 5,
    })
    const mgr = new FileSummaryManager(deps)
    await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
      overrideBudget: true,
    })
    await mgr.flush()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('per-job cap: 51st enqueue with same jobId returns skipped:per-job-cap', async () => {
    const { deps, generate, broadcasts } = makeDeps(db)
    const mgr = new FileSummaryManager(deps, { perJobCap: 2, perProjectConcurrency: 8, desktopConcurrency: 8 })
    for (let i = 0; i < 4; i++) {
      const rel = `src/f${i}.ts`
      writeFile(projectPath, rel, `// file ${i}\n`)
    }
    const results: string[] = []
    for (let i = 0; i < 4; i++) {
      results.push(
        await mgr.enqueue({
          projectPath,
          projectId: 'p1',
          projectSlug: 'p1',
          relPath: `src/f${i}.ts`,
          triggeredBy: { kind: 'job', id: 'jX', ticketId: null },
          jobId: 'jX',
        }),
      )
    }
    await mgr.flush()
    expect(results.slice(0, 2).every((r) => r === 'enqueued')).toBe(true)
    expect(results[2]).toBe('skipped:per-job-cap')
    expect(results[3]).toBe('skipped:per-job-cap')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(
      broadcasts.filter(
        (b) => b.type === 'file.summary_skipped' && b.reason === 'per-job-cap',
      ),
    ).toHaveLength(2)
  })

  it('concurrency cap: at most 2 in flight per project', async () => {
    let concurrent = 0
    let observedMax = 0
    const { deps } = makeDeps(db, {
      generate: vi.fn(async () => {
        concurrent += 1
        observedMax = Math.max(observedMax, concurrent)
        await new Promise((r) => setTimeout(r, 30))
        concurrent -= 1
        return {
          summary: 'x',
          model: 'claude-haiku-4-5',
          provider: 'claude',
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
        }
      }),
    })
    const mgr = new FileSummaryManager(deps, { perProjectConcurrency: 2, desktopConcurrency: 8 })
    for (let i = 0; i < 5; i++) {
      writeFile(projectPath, `f${i}.ts`, `// ${i}\n`)
    }
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mgr.enqueue({
          projectPath,
          projectId: 'p1',
          projectSlug: 'p1',
          relPath: `f${i}.ts`,
          triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
        }),
      ),
    )
    await mgr.flush()
    expect(observedMax).toBeLessThanOrEqual(2)
    expect(observedMax).toBeGreaterThanOrEqual(1)
  })

  it('truncates files larger than the 8000-token budget and records truncated=true', async () => {
    // 8001 tokens ~= 32004 chars. Use 40k to be safely over.
    const big = 'x'.repeat(40000)
    writeFile(projectPath, 'big.ts', big)
    let observedContents = ''
    let observedTruncated = false
    const { deps } = makeDeps(db, {
      generate: vi.fn(async (input: GenerateInput) => {
        observedContents = input.contents
        observedTruncated = input.truncated
        return {
          summary: 'big summary',
          model: 'claude-haiku-4-5',
          provider: 'claude',
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
        }
      }),
    })
    const mgr = new FileSummaryManager(deps)
    await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'big.ts',
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
    await mgr.flush()
    expect(observedTruncated).toBe(true)
    expect(observedContents).toContain('truncated')
    expect(observedContents.length).toBeLessThan(big.length)
    const stored = readSummary(projectPath, 'big.ts')
    expect(stored?.generatedBy.truncated).toBe(true)
  })

  it('emits skipped when source file is missing', async () => {
    const { deps, broadcasts, generate } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    const r = await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'nowhere.ts',
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
    expect(r).toBe('skipped:not-found')
    expect(generate).not.toHaveBeenCalled()
    expect(
      broadcasts.some((b) => b.type === 'file.summary_skipped' && b.reason === 'not-found'),
    ).toBe(true)
  })

  it('regenerates when the app language changed even if the content hash matches', async () => {
    writeFile(projectPath, 'src/foo.ts', 'console.log("hi")\n')
    const hash = await computeFileHash(path.join(projectPath, 'src/foo.ts'))
    writeSummary(projectPath, 'src/foo.ts', {
      schemaVersion: 1,
      path: 'src/foo.ts',
      fileHash: hash,
      summary: 'old english summary',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'job', id: 'job_old', ticketId: 1 },
    })
    let observedLang: string | undefined
    const gen = vi.fn(async (input: GenerateInput): Promise<GenerateOutput> => {
      observedLang = input.language
      return { summary: 'resumen', model: 'claude-haiku-4-5', provider: 'claude', costUsd: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 }
    })
    const { deps } = makeDeps(db, { language: () => 'es', generate: gen })
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'job', id: 'job_new', ticketId: 1 }, jobId: 'job_new',
    })
    await mgr.flush()
    expect(result).toBe('enqueued')
    expect(gen).toHaveBeenCalledTimes(1)
    expect(observedLang).toBe('es')
    expect(readSummary(projectPath, 'src/foo.ts')?.language).toBe('es')
  })

  it('force bypasses the content-hash gate (explicit Regenerate of an unchanged file)', async () => {
    writeFile(projectPath, 'src/foo.ts', 'console.log("hi")\n')
    const hash = await computeFileHash(path.join(projectPath, 'src/foo.ts'))
    writeSummary(projectPath, 'src/foo.ts', {
      schemaVersion: 1,
      path: 'src/foo.ts',
      fileHash: hash,
      summary: 'unchanged',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'user', id: 'manual', ticketId: null },
    })
    const { deps, generate } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'manual', ticketId: null }, force: true,
    })
    await mgr.flush()
    expect(result).toBe('enqueued')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('budget cap also applies to USER-triggered (manual) regenerate', async () => {
    writeFile(projectPath, 'src/foo.ts', 'a\n')
    const { deps, generate, broadcasts } = makeDeps(db, {
      monthToDateSpend: () => 10,
      monthlyBudgetUsd: () => 5,
    })
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'manual', ticketId: null },
    })
    expect(result).toBe('skipped:budget')
    expect(generate).not.toHaveBeenCalled()
    expect(broadcasts.some((b) => b.type === 'file.summary_skipped' && b.reason === 'budget')).toBe(true)
  })

  it('attributes a failed invocation to the configured provider, not always claude', async () => {
    writeFile(projectPath, 'src/foo.ts', 'x\n')
    const { deps } = makeDeps(db, {
      providerId: () => 'codex',
      generate: vi.fn(async () => { throw new Error('boom') }),
    })
    const mgr = new FileSummaryManager(deps)
    await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'manual', ticketId: null },
    })
    await mgr.flush()
    const rows = db.prepare(`SELECT provider, status FROM ai_invocations`).all() as Array<{ provider: string; status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].provider).toBe('codex')
  })

  it('bounds the per-job counter map (evicts oldest beyond maxJobCounters)', async () => {
    writeFile(projectPath, 'a.ts', '// a\n')
    writeFile(projectPath, 'b.ts', '// b\n')
    const { deps, generate } = makeDeps(db)
    const mgr = new FileSummaryManager(deps, { maxJobCounters: 1, perProjectConcurrency: 8, desktopConcurrency: 8 })
    const r1 = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'a.ts',
      triggeredBy: { kind: 'job', id: 'jA', ticketId: null }, jobId: 'jA',
    })
    const r2 = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'b.ts',
      triggeredBy: { kind: 'job', id: 'jB', ticketId: null }, jobId: 'jB',
    })
    await mgr.flush()
    expect(r1).toBe('enqueued')
    expect(r2).toBe('enqueued')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('failure path records a failed ai_invocations row and broadcasts file.summary_failed', async () => {
    writeFile(projectPath, 'src/foo.ts', 'x\n')
    const { deps, broadcasts } = makeDeps(db, {
      generate: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const mgr = new FileSummaryManager(deps)
    const result = await mgr.enqueue({
      projectPath,
      projectId: 'p1',
      projectSlug: 'p1',
      relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
    await mgr.flush()
    // The resolved value distinguishes a failed generation from a success.
    expect(result).toBe('failed')
    const rows = db.prepare(`SELECT status FROM ai_invocations`).all() as Array<{ status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(broadcasts.some((b) => b.type === 'file.summary_failed')).toBe(true)
  })

  // MED-13: when the generator's rejection carries captured usage (`.partial`),
  // the failed row records the REAL cost/tokens instead of $0, so the monthly
  // budget reader accounts for the burned spend.
  it('failure path stamps the rejection .partial cost onto the failed row (MED-13)', async () => {
    writeFile(projectPath, 'src/foo.ts', 'x\n')
    const { deps } = makeDeps(db, {
      generate: vi.fn(async () => {
        const err = new Error('boom after billing') as Error & { partial?: Partial<GenerateOutput> }
        err.partial = {
          provider: 'claude',
          model: 'claude-haiku-4-5',
          costUsd: 0.0042,
          costEstimated: true,
          tokensIn: 40,
          tokensOut: 10,
          durationMs: 7,
        }
        throw err
      }),
    })
    const mgr = new FileSummaryManager(deps)
    await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
    await mgr.flush()
    const rows = db.prepare(
      `SELECT status, total_cost_usd, total_cost_usd_estimated, tokens_in, tokens_out FROM ai_invocations`,
    ).all() as Array<{
      status: string; total_cost_usd: number; total_cost_usd_estimated: number; tokens_in: number; tokens_out: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].total_cost_usd).toBeCloseTo(0.0042)
    expect(rows[0].total_cost_usd_estimated).toBe(1)
    expect(rows[0].tokens_in).toBe(40)
    expect(rows[0].tokens_out).toBe(10)
  })
})

describe('BUG-CODE-02: file-summary.v1 schema validation', () => {
  const valid: SummaryPayload = {
    schemaVersion: 1,
    path: 'a.ts',
    fileHash: 'a'.repeat(64),
    summary: 'hello',
    language: 'en',
    generatedAt: '2026-05-23T00:00:00.000Z',
    generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1, truncated: false },
    triggeredBy: { kind: 'job', id: 'job_1', ticketId: 42 },
  }

  it('isValidSummaryPayload accepts a well-formed payload', () => {
    expect(isValidSummaryPayload(valid)).toBe(true)
  })

  it('isValidSummaryPayload rejects wrong schemaVersion / bad fileHash / oversized summary', () => {
    expect(isValidSummaryPayload({ ...valid, schemaVersion: 2 })).toBe(false)
    expect(isValidSummaryPayload({ ...valid, fileHash: 'nothex' })).toBe(false)
    expect(isValidSummaryPayload({ ...valid, summary: 'x'.repeat(SUMMARY_MAX_LENGTH + 1) })).toBe(false)
    expect(isValidSummaryPayload({ ...valid, language: 'xx' })).toBe(false)
    expect(isValidSummaryPayload({ ...valid, extra: 'nope' })).toBe(false)
  })

  it('readSummary treats a non-conformant (hand-edited) summary file as absent → null', () => {
    // Write a structurally invalid payload directly, bypassing writeSummary.
    const dir = summariesDir(projectPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(summaryFilePath(projectPath, 'a.ts'), JSON.stringify({ schemaVersion: 99, path: 'a.ts' }), 'utf8')
    expect(readSummary(projectPath, 'a.ts')).toBeNull()
  })

  it('readSummary treats an oversized summary file as absent → null', () => {
    const dir = summariesDir(projectPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      summaryFilePath(projectPath, 'a.ts'),
      JSON.stringify({ ...valid, summary: 'x'.repeat(SUMMARY_MAX_LENGTH + 100) }),
      'utf8',
    )
    expect(readSummary(projectPath, 'a.ts')).toBeNull()
  })

  it('writeSummary throws on a non-conformant payload', () => {
    expect(() =>
      writeSummary(projectPath, 'a.ts', { ...valid, fileHash: 'short' } as unknown as SummaryPayload),
    ).toThrow(/schema validation/)
  })

  it('runOne caps a runaway LLM summary at SUMMARY_MAX_LENGTH instead of failing', async () => {
    writeFile(projectPath, 'src/foo.ts', 'console.log(1)\n')
    const huge = 'y'.repeat(SUMMARY_MAX_LENGTH + 5000)
    const { deps } = makeDeps(db, {
      generate: vi.fn(async (): Promise<GenerateOutput> => ({
        summary: huge, model: 'm', provider: 'claude', costUsd: 0.0001, tokensIn: 1, tokensOut: 1, durationMs: 1,
      })),
    })
    const mgr = new FileSummaryManager(deps)
    const r = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts',
      triggeredBy: { kind: 'user', id: 'u', ticketId: null },
    })
    await mgr.flush()
    expect(r).toBe('enqueued')
    const stored = readSummary(projectPath, 'src/foo.ts')
    expect(stored).not.toBeNull()
    expect(stored!.summary.length).toBe(SUMMARY_MAX_LENGTH)
    // Recorded as a SUCCESS (not mis-billed as failed by a schema throw).
    const rows = db.prepare(`SELECT status FROM ai_invocations`).all() as Array<{ status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
  })
})

describe('markStale', () => {
  it('broadcasts file.summary_updated with stale=true when a summary exists', () => {
    writeSummary(projectPath, 'a.ts', {
      schemaVersion: 1,
      path: 'a.ts',
      fileHash: 'c'.repeat(64),
      summary: 's',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
    const { deps, broadcasts } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    mgr.markStale(projectPath, 'p1', 'a.ts')
    const evt = broadcasts.find((b) => b.type === 'file.summary_updated') as
      | { type: string; stale?: boolean }
      | undefined
    expect(evt?.stale).toBe(true)
  })

  it('no-ops when no summary exists', () => {
    const { deps, broadcasts } = makeDeps(db)
    const mgr = new FileSummaryManager(deps)
    mgr.markStale(projectPath, 'p1', 'missing.ts')
    expect(broadcasts).toHaveLength(0)
  })
})

describe('sweepOrphans', () => {
  function writePayloadFor(rel: string): void {
    writeSummary(projectPath, rel, {
      schemaVersion: 1,
      path: rel,
      fileHash: 'd'.repeat(64),
      summary: 's',
      language: 'en',
      generatedAt: '2026-05-22T00:00:00.000Z',
      generatedBy: { model: 'claude-haiku-4-5', promptVersion: 1 },
      triggeredBy: { kind: 'user', id: 'u1', ticketId: null },
    })
  }

  it('returns zero counts when directory is missing', () => {
    expect(sweepOrphans(projectPath)).toEqual({ deleted: 0, remaining: 0 })
  })

  it('deletes only orphans, keeps summaries whose source exists', () => {
    writeFile(projectPath, 'kept.ts', 'k\n')
    writePayloadFor('kept.ts')
    writePayloadFor('gone.ts')
    writePayloadFor('also-gone.ts')
    const result = sweepOrphans(projectPath)
    expect(result.deleted).toBe(2)
    expect(result.remaining).toBe(0)
    expect(fs.existsSync(summaryFilePath(projectPath, 'kept.ts'))).toBe(true)
    expect(fs.existsSync(summaryFilePath(projectPath, 'gone.ts'))).toBe(false)
  })

  it('caps deletions and reports remaining', () => {
    for (let i = 0; i < 5; i++) writePayloadFor(`o${i}.ts`)
    const result = sweepOrphans(projectPath, 3)
    expect(result.deleted).toBe(3)
    expect(result.remaining).toBe(2)
  })
})

describe('FileSummaryManager bug-fix regressions', () => {
  const out: GenerateOutput = {
    summary: 's', model: 'm', provider: 'claude', costUsd: 0.001, tokensIn: 1, tokensOut: 1, durationMs: 1,
  }

  it('coalesces concurrent enqueues of the same file (no double-generate / double-bill)', async () => {
    writeFile(projectPath, 'src/foo.ts', 'x\n')
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const genFn = vi.fn(async (): Promise<GenerateOutput> => { await gate; return out })
    const { deps } = makeDeps(db, { generate: genFn })
    const mgr = new FileSummaryManager(deps)
    const base = { projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts', force: true } as const
    const p1 = mgr.enqueue({ ...base, triggeredBy: { kind: 'user', id: 'u1', ticketId: null } })
    const p2 = mgr.enqueue({ ...base, triggeredBy: { kind: 'user', id: 'u2', ticketId: null } })
    expect(p1).toBe(p2) // second rides the first promise
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('enqueued')
    expect(r2).toBe('enqueued')
    expect(genFn).toHaveBeenCalledTimes(1)
    // Exactly one ai_invocations row → billed once, not twice (the test file mocks
    // recordInvocation to store the file-summary surface as 'job', so count rows
    // rather than filter by surface). Fresh db → this generation is the only row.
    const rows = db.prepare('SELECT COUNT(*) c FROM ai_invocations').get() as { c: number }
    expect(rows.c).toBe(1)
  })

  it('re-checks the budget at dequeue (deterministic): under-budget at enqueue, over-budget at dequeue → skipped', async () => {
    writeFile(projectPath, 'src/a.ts', 'a\n')
    // monthToDateSpend is read twice for one enqueue: once in the enqueue gate
    // (returns 0 → passes) and once in the pump dequeue re-check (returns 10 →
    // skip). This isolates the dequeue re-check (#16) without any wall-clock.
    let calls = 0
    const genFn = vi.fn(async (): Promise<GenerateOutput> => out)
    const { deps } = makeDeps(db, {
      monthToDateSpend: () => (calls++ === 0 ? 0 : 10),
      monthlyBudgetUsd: () => 5,
      generate: genFn,
    })
    const mgr = new FileSummaryManager(deps)
    const r = await mgr.enqueue({ projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/a.ts', force: true, triggeredBy: { kind: 'user', id: 'u1', ticketId: null } })
    expect(r).toBe('skipped:budget')
    expect(genFn).not.toHaveBeenCalled()
  })

  it('returns skipped:ttl (not skipped:hash) when an entry has expired (deterministic)', async () => {
    writeFile(projectPath, 'src/a.ts', 'a\n')
    // now() is called once for enqueuedAt then once for the pump TTL check; an
    // incrementing stub makes the second value exceed enqueuedAt by > queueTtlMs.
    let t = 0
    const genFn = vi.fn(async (): Promise<GenerateOutput> => out)
    const { deps } = makeDeps(db, { now: () => { t += 1000; return t }, generate: genFn })
    const mgr = new FileSummaryManager(deps, { queueTtlMs: 0 })
    const r = await mgr.enqueue({ projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/a.ts', force: true, triggeredBy: { kind: 'user', id: 'u1', ticketId: null } })
    expect(r).toBe('skipped:ttl')
    expect(genFn).not.toHaveBeenCalled()
  })

  it('BUG-CODE-05: reserved spend bounds concurrent generations to the budget cap', async () => {
    // 3 files enqueued, budget = $0.02 = exactly 2 × $0.01 reservations. The
    // 1st start sees spend $0.00, the 2nd sees $0.01, both < cap → run; the 3rd
    // sees $0.02 >= cap → skipped:budget. Recorded cost is $0 in this test so
    // the cap is hit purely by the optimistic reservation, proving the in-flight
    // reservation (not the recorded cost) closes the overshoot window.
    for (let i = 0; i < 3; i++) writeFile(projectPath, `f${i}.ts`, `// ${i}\n`)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const genFn = vi.fn(async (): Promise<GenerateOutput> => {
      await gate
      return { summary: 's', model: 'm', provider: 'claude', costUsd: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 }
    })
    const { deps } = makeDeps(db, {
      monthToDateSpend: () => 0,
      monthlyBudgetUsd: () => 0.02, // room for exactly 2 × $0.01 reservations
      generate: genFn,
    })
    // perProjectConcurrency 3 so all three could otherwise start at once.
    const mgr = new FileSummaryManager(deps, { perProjectConcurrency: 3, desktopConcurrency: 8 })
    // Fire all three WITHOUT awaiting — the first two block on the gate, the
    // third must be skipped:budget by the reservation re-check before release.
    const promises = [0, 1, 2].map((i) =>
      mgr.enqueue({
        projectPath, projectId: 'p1', projectSlug: 'p1', relPath: `f${i}.ts`,
        triggeredBy: { kind: 'user', id: 'u', ticketId: null },
      }),
    )
    // Let the pump start the first two generations (they await the gate).
    await new Promise((r) => setTimeout(r, 20))
    // The third is held back by the reservation re-check, never started.
    expect(genFn).toHaveBeenCalledTimes(2)
    release()
    const results = await Promise.all(promises)
    await mgr.flush()
    expect(results.filter((r) => r === 'skipped:budget')).toHaveLength(1)
    expect(results.filter((r) => r === 'enqueued')).toHaveLength(2)
  })

  it('BUG-CODE-05: reservation is released after a generation completes (later enqueue can run)', async () => {
    writeFile(projectPath, 'a.ts', '// a\n')
    writeFile(projectPath, 'b.ts', '// b\n')
    const { deps, generate } = makeDeps(db, {
      monthToDateSpend: () => 0,
      monthlyBudgetUsd: () => 0.015, // room for ONE in-flight reservation at a time
    })
    const mgr = new FileSummaryManager(deps)
    const r1 = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'a.ts',
      triggeredBy: { kind: 'user', id: 'u', ticketId: null },
    })
    await mgr.flush()
    // First generation done → its reservation released, so the second can run.
    const r2 = await mgr.enqueue({
      projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'b.ts',
      triggeredBy: { kind: 'user', id: 'u', ticketId: null },
    })
    await mgr.flush()
    expect(r1).toBe('enqueued')
    expect(r2).toBe('enqueued')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('dispose() aborts an in-flight generation and skips the closed-DB write', async () => {
    writeFile(projectPath, 'src/foo.ts', 'x\n')
    let captured: AbortSignal | undefined
    let started: () => void = () => {}
    const startedP = new Promise<void>((r) => { started = r })
    const genFn = vi.fn((_input: GenerateInput, signal?: AbortSignal): Promise<GenerateOutput> => {
      captured = signal
      started() // resolve deterministically the moment generation begins
      return new Promise<GenerateOutput>((_res, rej) => {
        signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      })
    })
    const { deps } = makeDeps(db, { generate: genFn })
    const mgr = new FileSummaryManager(deps)
    const p = mgr.enqueue({ projectPath, projectId: 'p1', projectSlug: 'p1', relPath: 'src/foo.ts', force: true, triggeredBy: { kind: 'user', id: 'u1', ticketId: null } })
    await startedP // generation has started and captured the signal
    expect(captured).toBeDefined()
    mgr.dispose()
    expect(captured?.aborted).toBe(true)
    expect(await p).toBe('failed')
  })
})
