import { describe, expect, it, vi } from 'vitest'
import type { BackgroundProcess, BackgroundProcessLogSnapshot } from '../../../transient-children'
import { createAppUrlResolver } from './app-urls'

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

describe('createAppUrlResolver', () => {
  it('attaches the announced URLs of a running process without mutating it', () => {
    const resolve = createAppUrlResolver({ logs: (p) => snapshot(p, ['Local: http://localhost:5173/', 'Network: http://192.168.1.20:5173/']), lanAddresses: () => [] })
    const process = proc()
    expect(resolve(process).appUrls).toEqual({ local: ['http://localhost:5173/'], network: ['http://192.168.1.20:5173/'] })
    expect(process.appUrls).toBeUndefined()
  })

  it('returns finished, recovered and silent processes unchanged', () => {
    const logs = vi.fn((p: BackgroundProcess) => snapshot(p, ['Local: http://localhost:5173/']))
    const resolve = createAppUrlResolver({ logs, lanAddresses: () => [] })
    for (const status of ['exited', 'killed', 'failed', 'interrupted', 'stopping'] as const) {
      const process = proc({ status })
      expect(resolve(process)).toBe(process)
    }
    expect(logs).not.toHaveBeenCalled()
    const quiet = createAppUrlResolver({ logs: (p) => snapshot(p, ['compiling…']), lanAddresses: () => [] })
    expect(quiet(proc()).appUrls).toBeUndefined()
  })

  it('reparses only when the log tail or LAN addresses change', () => {
    const lines = ['listening on http://0.0.0.0:3000']
    let lan = ['192.168.1.20']
    const lanAddresses = vi.fn(() => lan)
    const resolve = createAppUrlResolver({ logs: (p) => snapshot(p, lines), lanAddresses })
    expect(resolve(proc()).appUrls?.network).toEqual(['http://192.168.1.20:3000/'])
    expect(resolve(proc()).appUrls?.network).toEqual(['http://192.168.1.20:3000/'])
    lan = ['10.0.0.5']
    expect(resolve(proc()).appUrls?.network).toEqual(['http://10.0.0.5:3000/'])
    lines.push('restarted on http://0.0.0.0:3001')
    expect(resolve(proc()).appUrls?.local).toEqual(['http://localhost:3001/', 'http://localhost:3000/'])
  })

  it('treats reader failures as no URLs', () => {
    const resolve = createAppUrlResolver({ logs: () => { throw new Error('read') }, lanAddresses: () => { throw new Error('os') } })
    const process = proc()
    expect(resolve(process)).toBe(process)
    const noLan = createAppUrlResolver({ logs: (p) => snapshot(p, ['on http://0.0.0.0:3000']), lanAddresses: () => { throw new Error('os') } })
    expect(noLan(proc()).appUrls).toEqual({ local: ['http://localhost:3000/'], network: [] })
  })
})
