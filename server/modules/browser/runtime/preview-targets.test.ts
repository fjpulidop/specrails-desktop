import { describe, expect, it, vi } from 'vitest'
import type { BackgroundProcess, BackgroundProcessLogSnapshot } from '../../../transient-children'
import { createPreviewTargetSource } from './preview-targets'

function proc(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return { processId: 'p1', pid: 100, command: 'npm run dev', cwd: '/repo', startedAt: 1, status: 'running', chatId: 'c1', projectId: 'proj', ...overrides }
}

function snapshot(process: BackgroundProcess, lines: string[]): BackgroundProcessLogSnapshot {
  return {
    process,
    lines: lines.map((line, index) => ({ sequence: index + 1, at: index, source: 'stdout' as const, line })),
    nextSequence: lines.length,
    truncated: false,
    droppedLines: 0,
    maxLines: 2000,
    maxLineChars: 4000,
    retentionMs: 1,
  }
}

describe('createPreviewTargetSource', () => {
  it('lists running processes that announced a local URL', () => {
    const vite = proc()
    const quiet = proc({ processId: 'p2', pid: 101 })
    const logs: Record<string, string[]> = { p1: ['  ➜  Local:   http://localhost:5173/'], p2: ['compiling…'] }
    const source = createPreviewTargetSource({ list: () => [vite, quiet], logs: (p) => snapshot(p, logs[p.processId]) })
    expect(source.list('proj')).toEqual([{ processId: 'p1', chatId: 'c1', urls: ['http://localhost:5173/'] }])
    expect(source.announcedOrigins('proj')).toEqual(new Set(['http://localhost:5173']))
    expect(source.forProcess('proj', 'p2')).toEqual({ processId: 'p2', chatId: 'c1', urls: [] })
  })

  it('drops targets once the process is no longer running, and ignores recovered processes', () => {
    let status: BackgroundProcess['status'] = 'running'
    const source = createPreviewTargetSource({
      list: () => [proc({ status }), proc({ processId: 'old', pid: 7, status: 'interrupted' })],
      logs: (p) => snapshot(p, ['Local: http://localhost:3000']),
    })
    expect(source.announcedOrigins('proj').size).toBe(1)
    status = 'exited'
    expect(source.announcedOrigins('proj').size).toBe(0)
    expect(source.forProcess('proj', 'p1')).toBeNull()
    expect(source.forProcess('proj', 'old')).toBeNull()
  })

  it('never mixes processes of another project', () => {
    const source = createPreviewTargetSource({
      list: () => [proc({ projectId: 'other' })],
      logs: (p) => snapshot(p, ['Local: http://localhost:3000']),
    })
    expect(source.list('proj')).toEqual([])
  })

  it('reuses the parsed result while the log tail is unchanged', () => {
    const lines = ['Local: http://localhost:5173/']
    const logs = vi.fn((p: BackgroundProcess) => snapshot(p, lines))
    const source = createPreviewTargetSource({ list: () => [proc()], logs })
    expect(source.list('proj')[0].urls).toEqual(['http://localhost:5173/'])
    lines.push('restart → Local: http://localhost:5174/')
    expect(source.list('proj')[0].urls).toEqual(['http://localhost:5174/', 'http://localhost:5173/'])
    expect(logs).toHaveBeenCalledTimes(2)
  })

  it('treats reader failures as no targets', () => {
    const source = createPreviewTargetSource({ list: () => { throw new Error('db') }, logs: () => null })
    expect(source.list('proj')).toEqual([])
    const failingLogs = createPreviewTargetSource({ list: () => [proc()], logs: () => { throw new Error('read') } })
    expect(failingLogs.announcedOrigins('proj').size).toBe(0)
  })

  it('never offers Specrails\' own ports, whatever a process prints', () => {
    const lines = ['Local: http://localhost:5173/', 'echo http://127.0.0.1:4200/api/mobile', 'gateway https://localhost:4443/']
    const reader = { list: () => [proc()], logs: (p: BackgroundProcess) => snapshot(p, lines) }
    const source = createPreviewTargetSource(reader, () => [4200, 4443])
    expect(source.list('proj')).toEqual([{ processId: 'p1', chatId: 'c1', urls: ['http://localhost:5173/'] }])
    expect(source.forProcess('proj', 'p1')?.urls).toEqual(['http://localhost:5173/'])
    expect(source.announcedOrigins('proj')).toEqual(new Set(['http://localhost:5173']))
  })

  it('fails closed when the reserved ports cannot be read', () => {
    const source = createPreviewTargetSource(
      { list: () => [proc()], logs: (p) => snapshot(p, ['Local: http://localhost:5173/']) },
      () => { throw new Error('gateway db') },
    )
    expect(source.list('proj')).toEqual([])
    expect(source.announcedOrigins('proj').size).toBe(0)
  })
})
