import { describe, expect, it } from 'vitest'
import { recordJobInvocations, type JobAccountingInput, type JobInvocation } from '..'

const input: JobAccountingInput = {
  jobId: 'job', provider: 'codex', status: 'failed', startedAt: '2026-01-01T00:00:00Z',
  finishedAt: null, ticketIds: [1, 2, 3], estimated: true,
  result: { tokens_in: 5, tokens_out: 7, num_turns: 2, total_cost_usd: 0.3, duration_ms: 99 },
}
function recorder() {
  const rows: JobInvocation[] = []
  return { rows, ports: { newId: () => String(rows.length), write: (row: JobInvocation) => { rows.push(row) } } }
}
describe('job accounting application port', () => {
  it('preserves integer totals, missing measurements and replay identities across tickets', () => {
    const { rows, ports } = recorder()
    expect(recordJobInvocations('project', input, ports)).toEqual(['job#t1', 'job#t2', 'job#t3'])
    expect(rows.reduce((sum, row) => sum + row.tokens_in!, 0)).toBe(5)
    expect(rows.reduce((sum, row) => sum + row.tokens_out!, 0)).toBe(7)
    expect(rows.reduce((sum, row) => sum + row.num_turns!, 0)).toBe(2)
    expect(rows.reduce((sum, row) => sum + row.total_cost_usd!, 0)).toBeCloseTo(0.3)
    for (const row of rows) {
      expect(row.tokens_cache_read).toBeUndefined()
      expect(row).toMatchObject({ project_id: 'project', status: 'failed', total_cost_usd_estimated: true })
    }
  })
  it('preserves the plain job reference for zero or one ticket and keeps projects separate', () => {
    const { rows, ports } = recorder()
    expect(recordJobInvocations('a', { ...input, ticketIds: [] }, ports)).toEqual(['job'])
    expect(recordJobInvocations('b', { ...input, ticketIds: [2] }, ports)).toEqual(['job'])
    expect(rows.map(row => [row.project_id, row.ticket_id, row.total_cost_usd])).toEqual([
      ['a', null, 0.3], ['b', 2, 0.3],
    ])
  })
  it('propagates write failure to the existing settlement transaction without continuing', () => {
    const refs: string[] = []
    expect(() => recordJobInvocations('project', input, {
      newId: () => 'id',
      write: row => { refs.push(row.surface_ref_id); if (refs.length === 2) throw new Error('write failed') },
    })).toThrow('write failed')
    expect(refs).toEqual(['job#t1', 'job#t2'])
  })
})
