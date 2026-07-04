import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  computeDiffStats,
  excerptPatch,
  recordProvenanceForJob,
  STORY_EXCERPT_MAX_BYTES,
  type DiffEntry,
  type StoredPatch,
} from './file-provenance'
import {
  recordLoopRunProvenance,
  getFileStory,
  getContribution,
  setContributionSummary,
} from './file-story'

const SAMPLE_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  '-const a = 1',
  '+const a = 2',
  '+const b = 3',
  ' const keep = true',
  '',
].join('\n')

let db: DbInstance

beforeEach(() => {
  db = initDb(':memory:')
  delete process.env.SPECRAILS_CODE_EXPLORER
})

afterEach(() => {
  db.close()
  delete process.env.SPECRAILS_CODE_EXPLORER
})

describe('computeDiffStats', () => {
  it('counts added/removed content lines, skipping +++/--- headers', () => {
    expect(computeDiffStats(SAMPLE_PATCH)).toEqual({ added: 2, removed: 1 })
  })

  it('returns zeros for an empty patch', () => {
    expect(computeDiffStats('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('excerptPatch', () => {
  it('returns short patches untouched', () => {
    expect(excerptPatch(SAMPLE_PATCH)).toBe(SAMPLE_PATCH)
  })

  it('caps long patches on a line boundary with a truncation marker', () => {
    const long = Array.from({ length: 500 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n')
    const out = excerptPatch(long)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(STORY_EXCERPT_MAX_BYTES + 64)
    expect(out).toContain('excerpt truncated')
    // No partially-cut line before the marker.
    const lines = out.split('\n')
    expect(lines[lines.length - 3]).toMatch(/^\+line \d+ x+$/)
  })
})

describe('recordProvenanceForJob → file_story_contributions', () => {
  it('writes stats + excerpt for rows that have a patch, in the same transaction', () => {
    const diff: DiffEntry[] = [
      { path: 'src/app.ts', status: 'M' },
      { path: 'src/no-patch.ts', status: 'M' },
    ]
    const patches = new Map<string, StoredPatch>([
      ['src/app.ts', { patch: SAMPLE_PATCH, truncated: false }],
    ])
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 7, diff, 1000, patches)
    expect(rows).toHaveLength(2)

    const withPatch = rows.find((r) => r.file_path === 'src/app.ts')!
    const contribution = getContribution(db, withPatch.id)
    expect(contribution).not.toBeNull()
    expect(contribution!.added_lines).toBe(2)
    expect(contribution!.removed_lines).toBe(1)
    expect(contribution!.patch_excerpt).toBe(SAMPLE_PATCH)
    expect(contribution!.summary).toBeNull()

    const withoutPatch = rows.find((r) => r.file_path === 'src/no-patch.ts')!
    expect(getContribution(db, withoutPatch.id)).toBeNull()
  })
})

describe('recordLoopRunProvenance', () => {
  const baseInput = () => ({
    db,
    projectId: 'p1',
    runId: 'run-1',
    ticketId: 42,
    repoDir: '/tmp/nowhere',
    snapshot: { ref: '', untracked: [], headSha: 'abc123' },
    broadcast: vi.fn(),
  })

  it('records provenance rows + contributions and broadcasts per row', () => {
    const input = baseInput()
    const diff = vi.fn(() => [{ path: 'src/app.ts', status: 'M' as const }])
    const patches = vi.fn(() => new Map([['src/app.ts', { patch: SAMPLE_PATCH, truncated: false }]]))
    const n = recordLoopRunProvenance(input, { diff, patches })
    expect(n).toBe(1)
    expect(diff).toHaveBeenCalledWith('/tmp/nowhere', '', [], 'abc123')

    const row = db.prepare(`SELECT * FROM file_provenance WHERE job_id = 'run-1'`).get() as {
      id: number; file_path: string; ticket_id: number; kind: string
    }
    expect(row.file_path).toBe('src/app.ts')
    expect(row.ticket_id).toBe(42)
    expect(row.kind).toBe('modified')
    expect(getContribution(db, row.id)?.added_lines).toBe(2)

    expect(input.broadcast).toHaveBeenCalledTimes(1)
    const msg = (input.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; projectId: string; path: string; jobId: string
    }
    expect(msg.type).toBe('file.provenance_updated')
    expect(msg.projectId).toBe('p1')
    expect(msg.jobId).toBe('run-1')
  })

  it('is a no-op when the code explorer is disabled', () => {
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    const diff = vi.fn()
    const n = recordLoopRunProvenance(baseInput(), { diff: diff as never })
    expect(n).toBe(0)
    expect(diff).not.toHaveBeenCalled()
  })

  it('is a no-op without a snapshot', () => {
    const diff = vi.fn()
    const n = recordLoopRunProvenance({ ...baseInput(), snapshot: null }, { diff: diff as never })
    expect(n).toBe(0)
    expect(diff).not.toHaveBeenCalled()
  })

  it('returns 0 for an empty diff and never throws on a diff failure', () => {
    expect(recordLoopRunProvenance(baseInput(), { diff: () => [] })).toBe(0)
    expect(recordLoopRunProvenance(baseInput(), {
      diff: () => { throw new Error('boom') },
    })).toBe(0)
  })
})

describe('getFileStory', () => {
  it('returns interventions oldest-first with stats, summary, and ticket enrichment', () => {
    const patches = new Map([['src/app.ts', { patch: SAMPLE_PATCH, truncated: false }]])
    const first = recordProvenanceForJob(db, 'p1', 'job-1', 7, [{ path: 'src/app.ts', status: 'A' }], 1000, patches)
    recordProvenanceForJob(db, 'p1', 'job-2', 9, [{ path: 'src/app.ts', status: 'M' }], 2000)
    setContributionSummary(db, first[0].id, 'It laid the foundation.', 'haiku', '2026-07-01T00:00:00.000Z')

    const getTicketSpec = vi.fn((id: number) =>
      id === 7 ? { id, title: 'Login screen', status: 'done' } : undefined)
    const story = getFileStory(db, 'src/app.ts', getTicketSpec)

    expect(story).toHaveLength(2)
    expect(story[0].kind).toBe('created')
    expect(story[0].ticketId).toBe(7)
    expect(story[0].ticket).toEqual({ id: 7, title: 'Login screen', status: 'done' })
    expect(story[0].addedLines).toBe(2)
    expect(story[0].removedLines).toBe(1)
    expect(story[0].hasPatch).toBe(true)
    expect(story[0].summary).toBe('It laid the foundation.')
    expect(story[0].summaryModel).toBe('haiku')

    expect(story[1].kind).toBe('modified')
    expect(story[1].ticket).toBeNull() // unknown ticket → honest null
    expect(story[1].addedLines).toBeNull()
    expect(story[1].hasPatch).toBe(false)
    expect(story[1].summary).toBeNull()
  })

  it('returns [] for an untouched file', () => {
    expect(getFileStory(db, 'never-touched.ts')).toEqual([])
  })

  it('tolerates a throwing ticket lookup', () => {
    recordProvenanceForJob(db, 'p1', 'job-1', 7, [{ path: 'a.ts', status: 'M' }], 1000)
    const story = getFileStory(db, 'a.ts', () => { throw new Error('store unreadable') })
    expect(story).toHaveLength(1)
    expect(story[0].ticket).toBeNull()
  })
})

describe('setContributionSummary', () => {
  it('updates an existing stats row', () => {
    const patches = new Map([['a.ts', { patch: SAMPLE_PATCH, truncated: false }]])
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 1, [{ path: 'a.ts', status: 'M' }], 1000, patches)
    expect(setContributionSummary(db, rows[0].id, 'Did a thing.', 'haiku')).toBe(true)
    const c = getContribution(db, rows[0].id)!
    expect(c.summary).toBe('Did a thing.')
    expect(c.summary_model).toBe('haiku')
    expect(c.added_lines).toBe(2) // stats preserved
  })

  it('inserts a summary-only row for a patchless historical intervention', () => {
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 1, [{ path: 'a.ts', status: 'M' }], 1000)
    expect(getContribution(db, rows[0].id)).toBeNull()
    expect(setContributionSummary(db, rows[0].id, 'Explained anyway.', 'haiku')).toBe(true)
    const c = getContribution(db, rows[0].id)!
    expect(c.summary).toBe('Explained anyway.')
    expect(c.added_lines).toBe(0)
    expect(c.patch_excerpt).toBeNull()
  })

  it('returns false for an unknown provenance id', () => {
    expect(setContributionSummary(db, 9999, 'x', 'haiku')).toBe(false)
  })
})
