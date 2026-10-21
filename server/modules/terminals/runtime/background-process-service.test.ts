import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WsMessage } from '../../../types'
import * as children from '../../../transient-children'
import { backgroundProcessHooks } from './background-process-service'

function proc(overrides: Partial<children.BackgroundProcess> = {}): children.BackgroundProcess {
  return { processId: 'p1', pid: 100, command: 'npm run dev', cwd: '/repo', startedAt: 1, status: 'running', chatId: 'c1', projectId: 'proj', ...overrides }
}

function output(line: string, overrides: Partial<children.BackgroundProcessOutputEvent> = {}): children.BackgroundProcessOutputEvent {
  return { sequence: 1, at: 1, source: 'stdout', line, processId: 'p1', pid: 100, chatId: 'c1', projectId: 'proj', ...overrides }
}

afterEach(() => vi.restoreAllMocks())

describe('backgroundProcessHooks app URLs', () => {
  it('attaches the current app URLs to lifecycle events', () => {
    const sent: WsMessage[] = []
    const hooks = backgroundProcessHooks((msg) => sent.push(msg), (p) => ({ ...p, appUrls: { local: ['http://localhost:5173/'], network: [] } }))
    hooks.onStarted?.(proc())
    expect(sent[0]).toMatchObject({ type: 'background_process.started', projectId: 'proj', process: { appUrls: { local: ['http://localhost:5173/'] } } })
  })

  it('announces an address once, as an update, when the server prints it', () => {
    const sent: WsMessage[] = []
    let urls: children.BackgroundProcess['appUrls']
    vi.spyOn(children, 'getBackgroundProcess').mockImplementation(() => proc())
    const hooks = backgroundProcessHooks((msg) => sent.push(msg), (p) => (urls ? { ...p, appUrls: urls } : p))
    hooks.onStarted?.(proc())
    hooks.onOutput?.(output('compiling…'))
    urls = { local: ['http://localhost:5173/'], network: ['http://192.168.1.20:5173/'] }
    hooks.onOutput?.(output('  ➜  Local:   http://localhost:5173/'))
    hooks.onOutput?.(output('  ➜  Network: http://192.168.1.20:5173/'))
    expect(sent.map((msg) => msg.type)).toEqual(['background_process.started', 'background_process.updated'])
    expect(sent[1]).toMatchObject({ process: { appUrls: urls } })
  })

  it('ignores output of an unknown or foreign-project execution', () => {
    const sent: WsMessage[] = []
    const lookup = vi.spyOn(children, 'getBackgroundProcess').mockReturnValueOnce(null).mockReturnValueOnce(proc({ projectId: 'other' }))
    const hooks = backgroundProcessHooks((msg) => sent.push(msg), (p) => ({ ...p, appUrls: { local: ['http://localhost:1/'], network: [] } }))
    hooks.onOutput?.(output('http://localhost:1/'))
    hooks.onOutput?.(output('http://localhost:1/'))
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([])
  })
})
