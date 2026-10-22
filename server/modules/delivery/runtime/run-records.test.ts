import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  baselineCapabilities, buildBaselineSection, buildRequirementsDemonstrated, hasClarificationContent,
  parseBaselineRecord, parseClarificationsRecord, parseSpecTraceReport, readBaseline, readClarifications,
  readRunRecordText, readSpecTrace, type RunRecordFs,
} from './run-records'

function memoryFs(files: Record<string, string>, mtimes: Record<string, number> = {}): RunRecordFs {
  return {
    readFile: (file) => { if (!(file in files)) throw new Error('ENOENT'); return files[file] },
    listDir: (dir) => [...new Set(Object.keys(files).filter((file) => path.dirname(path.dirname(file)) === dir).map((file) => path.basename(path.dirname(file))))],
    fileExists: (file) => file in files,
    fileMtimeMs: (file) => mtimes[file] ?? 0,
  }
}

const TRACE = {
  schemaVersion: 1, generatedAt: '2026-10-22T10:00:00Z', changes: ['add-search'], evidence: 'receipt', receiptId: 'r1',
  requirements: 4,
  demonstrated: [{ id: 'search/finds-by-title', name: 'Finds by title', tests: [{ repositoryId: 'primary', file: 'src/search.test.ts', line: 4 }] },
    { id: 'search/empty-query', name: 'Empty query', tests: [] }],
  undemonstrated: [{ id: 'search/archived-projects', name: 'Archived projects', reason: 'no-test', tests: [] }, { id: 'bad', reason: 'weird' }, 'junk'],
  untagged: [{ tag: 'search/old-name', repositoryId: 'primary', file: 'src/old.test.ts', line: 9, form: 'title' }, { tag: 'x' }],
  touched: ['search/archived-projects', 'search/finds-by-title'], touchedUndemonstrated: ['search/archived-projects'], scannedFiles: 12,
}

describe('spec-trace report', () => {
  it('parses the schema-1 report, bounding and dropping malformed entries', () => {
    const trace = parseSpecTraceReport(TRACE)!
    expect(trace).toMatchObject({ evidence: 'receipt', receiptId: 'r1', requirements: 4, touched: ['search/archived-projects', 'search/finds-by-title'] })
    expect(trace.demonstrated).toEqual([
      { id: 'search/finds-by-title', name: 'Finds by title', tests: [{ file: 'src/search.test.ts', line: 4 }] },
      { id: 'search/empty-query', name: 'Empty query', tests: [] },
    ])
    expect(trace.undemonstrated).toEqual([
      { id: 'search/archived-projects', name: 'Archived projects', reason: 'no-test', tests: [] },
      { id: 'bad', name: 'bad', reason: 'no-test', tests: [] },
    ])
    expect(trace.untagged).toEqual([{ tag: 'search/old-name', file: 'src/old.test.ts', line: 9 }])
  })

  it('rejects unknown schemas and never reports fewer requirements than listed', () => {
    expect(parseSpecTraceReport({ ...TRACE, schemaVersion: 2 })).toBeNull()
    expect(parseSpecTraceReport(null)).toBeNull()
    expect(parseSpecTraceReport({ ...TRACE, requirements: 1, evidence: 'mystery' })).toMatchObject({ requirements: 4, evidence: 'none' })
  })

  it('reads the run dir first, then the newest engine-2 implementation dir', () => {
    const root = '/ws/.specrails/pipeline'
    const direct = memoryFs({ [`${root}/run-1/spec-trace.json`]: JSON.stringify(TRACE) })
    expect(readSpecTrace(`${root}/run-1`, direct)?.requirements).toBe(4)
    const engine2 = memoryFs({
      [`${root}/run-1-impl-aaa/spec-trace.json`]: JSON.stringify({ ...TRACE, requirements: 7 }),
      [`${root}/run-1-impl-bbb/spec-trace.json`]: JSON.stringify({ ...TRACE, requirements: 9 }),
      [`${root}/other-impl-ccc/spec-trace.json`]: JSON.stringify({ ...TRACE, requirements: 99 }),
    }, { [`${root}/run-1-impl-aaa/spec-trace.json`]: 2, [`${root}/run-1-impl-bbb/spec-trace.json`]: 1 })
    expect(readSpecTrace(`${root}/run-1`, engine2)?.requirements).toBe(7)
    expect(readSpecTrace(`${root}/missing`, engine2)).toBeNull()
    expect(readRunRecordText(`${root}/run-1`, 'spec-trace.json', memoryFs({ [`${root}/run-1/spec-trace.json`]: 'x'.repeat(1024 * 1024 + 1) }))).toBeNull()
    expect(readSpecTrace(`${root}/run-1`, memoryFs({ [`${root}/run-1/spec-trace.json`]: '{oops' }))).toBeNull()
  })

  it('builds the packet section across units, touched gaps first', () => {
    const trace = parseSpecTraceReport(TRACE)!
    const section = buildRequirementsDemonstrated([{ ticketId: 1, specTrace: trace }, { ticketId: 2, specTrace: { ...trace, evidence: 'none', touched: [], touchedUndemonstrated: [] } }, { ticketId: 3 }])!
    expect(section).toMatchObject({ demonstrated: 4, total: 8, touched: 2, touchedDemonstrated: 1, withoutReceipt: true })
    expect(section.undemonstratedList[0]).toMatchObject({ id: 'search/archived-projects', touched: true, ticketId: 1 })
    expect(buildRequirementsDemonstrated([{ ticketId: 1 }])).toBeNull()
  })
})

describe('baseline record', () => {
  const RECORD = { schemaVersion: 1, change: 'add-search', status: 'passed', recordedAt: 't', detection: { blastRadius: ['a'], covered: ['b'], uncovered: ['src/search/index.ts'], skipped: [] }, tests: ['src/search/search.characterization.test.ts', { file: 'src/x.test.ts' }], receiptId: 'r2' }

  it('parses statuses, tests and detection', () => {
    expect(parseBaselineRecord(RECORD)).toMatchObject({ status: 'passed', uncovered: ['src/search/index.ts'], covered: 1, tests: ['src/search/search.characterization.test.ts', 'src/x.test.ts'], receiptId: 'r2', capabilities: [], cost: null })
    expect(parseBaselineRecord({ ...RECORD, status: 'unknown' })).toBeNull()
    expect(parseBaselineRecord({ ...RECORD, schemaVersion: 3 })).toBeNull()
    expect(readBaseline('/p/run', memoryFs({ '/p/run/baseline.json': JSON.stringify({ ...RECORD, status: 'failed', reason: 'search.test failed on base' }) }))).toMatchObject({ status: 'failed', reason: 'search.test failed on base' })
  })

  it('counts as-built requirements per capability from the trace and skips not-needed units', () => {
    const trace = parseSpecTraceReport(TRACE)!
    expect(baselineCapabilities(trace)).toEqual([{ capability: 'search', requirements: 2, demonstrated: 1 }])
    expect(baselineCapabilities(null)).toEqual([])
    const passed = parseBaselineRecord(RECORD)!
    const notNeeded = parseBaselineRecord({ ...RECORD, status: 'not-needed' })!
    expect(buildBaselineSection([{ ticketId: 1, baseline: passed }, { ticketId: 2, baseline: notNeeded }])).toEqual([{ ...passed, ticketId: 1 }])
    expect(buildBaselineSection([{ ticketId: 2, baseline: notNeeded }])).toBeNull()
  })
})

describe('clarifications record', () => {
  const PAUSED = { schemaVersion: 1, change: 'c', policy: 'ask-on-high', status: 'awaiting-answers', recordedAt: 't', clarifications: [{ question: 'Archived too?', impact: 'high', default: null }, { question: 'Page size?', impact: 'low', default: '25' }, { question: 'bad', impact: 'huge' }], blocking: [{ question: 'Archived too?', impact: 'high', default: null }], answers: [], assumptions: [] }

  it('parses questions, blocking ones and assumptions', () => {
    const record = parseClarificationsRecord(PAUSED)!
    expect(record.clarifications).toHaveLength(2)
    expect(record.blocking).toEqual([{ question: 'Archived too?', impact: 'high', default: null }])
    expect(hasClarificationContent(record)).toBe(true)
    expect(parseClarificationsRecord({ ...PAUSED, status: 'done' })).toBeNull()
    const proceeded = parseClarificationsRecord({ ...PAUSED, status: 'proceeded', clarifications: [], blocking: [], assumptions: ['- Page size is 25'] })!
    expect(proceeded.assumptions).toEqual(['- Page size is 25'])
    expect(hasClarificationContent({ ...proceeded, assumptions: [] })).toBe(false)
    expect(readClarifications('/p/r', memoryFs({ '/p/r/clarifications.json': JSON.stringify(PAUSED) }))?.status).toBe('awaiting-answers')
  })
})
