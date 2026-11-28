import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackgroundProcess, getBackgroundProcessLogs, killOwnedBackgroundProcess, listBackgroundProcesses, registerObservedProcess } from './transient-children'

describe('observed background processes', () => {
  afterEach(() => { vi.useRealTimers() })

  it('[spec:mobile-device-testing/mission-processes] lists work Specrails runs elsewhere in the mission, with its log, outcome and no stop', () => {
    const hooks = { onStarted: vi.fn(), onUpdated: vi.fn(), onOutput: vi.fn(), onExited: vi.fn() }
    const handle = registerObservedProcess({ projectId: 'p-obs', chatId: 'c-obs', label: 'Test in Mobile Device · iOS · checkout', cwd: '/w' }, hooks)
    expect(hooks.onStarted).toHaveBeenCalledWith(expect.objectContaining({ observed: true, status: 'running', pid: 0, command: 'Test in Mobile Device · iOS · checkout' }))
    expect(listBackgroundProcesses({ projectId: 'p-obs', chatId: 'c-obs' }).map((p) => p.processId)).toEqual([handle.processId])
    // Another mission never sees it.
    expect(listBackgroundProcesses({ projectId: 'p-obs', chatId: 'other' })).toEqual([])

    handle.setPid(4242)
    handle.appendLine('Building the iOS app (xcode)…\n$ xcodebuild build')
    handle.appendLine('[Tapflow] device booted')
    expect(getBackgroundProcess(4242, handle.processId)).toMatchObject({ pid: 4242, status: 'running' })
    const logs = getBackgroundProcessLogs(4242, { projectId: 'p-obs', chatId: 'c-obs', processId: handle.processId })
    expect(logs?.lines.map((line) => line.line)).toEqual(['Building the iOS app (xcode)…', '$ xcodebuild build', '[Tapflow] device booted'])
    expect(hooks.onOutput).toHaveBeenCalledTimes(3)
    // Its owner controls it: the list's Stop does not reach it.
    expect(killOwnedBackgroundProcess(4242, { projectId: 'p-obs', chatId: 'c-obs', processId: handle.processId })).toBe(false)

    handle.finish('failed', 'The build failed: xcodebuild exited with 65')
    handle.appendLine('ignored after the end')
    expect(hooks.onExited).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 1, error: 'The build failed: xcodebuild exited with 65' }))
    expect(listBackgroundProcesses({ projectId: 'p-obs', chatId: 'c-obs' })).toEqual([])
    expect(listBackgroundProcesses({ projectId: 'p-obs', chatId: 'c-obs', includeFinished: true })).toEqual([expect.objectContaining({ processId: handle.processId, status: 'failed' })])
    expect(getBackgroundProcessLogs(4242, { processId: handle.processId })?.lines).toHaveLength(3)
  })
})
