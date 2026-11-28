import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getBackgroundProcessLogs, listBackgroundProcesses } from '../../../transient-children'
import { finishMobileRun, mobileRunActivePid, plainText, mobileRunActivePids, mobileRunLine, mobileRunPid, tailFile, trackMobileRun } from '../adapters/mobile-run-process'
import { parseSimctlDevices } from '../adapters/simulator-names'

describe('a mobile test in the mission Processes', () => {
  it('follows a log from its end, line by line, and starts over when it is truncated', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-')), 'service.log')
    fs.writeFileSync(file, 'before the run\n')
    const lines: string[] = []
    const tail = tailFile(file, (line) => lines.push(line), 60_000)
    fs.appendFileSync(file, 'relay up\npartial')
    tail.read()
    expect(lines).toEqual(['relay up'])
    fs.appendFileSync(file, ' line\n')
    tail.read()
    expect(lines).toEqual(['relay up', 'partial line'])
    fs.writeFileSync(file, 'restarted\n')
    tail.read()
    expect(lines.at(-1)).toBe('restarted')
    tail.stop()
  })

  it('[spec:mobile-device-testing/mission-processes] records the run log, Tapflow lines, the build PID and the outcome', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-')), 'service.log')
    fs.writeFileSync(file, '')
    const hooks = { onStarted: vi.fn(), onExited: vi.fn() }
    trackMobileRun('run-1', { projectId: 'p-mrp', chatId: 'c-mrp', label: 'Test in Mobile Device · Android · Intent session', cwd: '/w', hooks, serviceLog: file })
    mobileRunLine('run-1', '$ ./gradlew :app:assembleDebug')
    mobileRunPid('run-1', 777)
    expect(mobileRunActivePid('run-1')).toBe(777)
    expect(mobileRunActivePids()).toEqual([{ runId: 'run-1', pid: 777 }])
    fs.appendFileSync(file, 'android agent: installed build 8\n')
    finishMobileRun('run-1', 'exited', 'Running: Android on tapflow-phone')
    expect(mobileRunActivePid('run-1')).toBe(0)
    const [entry] = listBackgroundProcesses({ projectId: 'p-mrp', chatId: 'c-mrp', includeFinished: true })
    expect(entry).toMatchObject({ status: 'exited', observed: true, pid: 0 })
    expect(getBackgroundProcessLogs(0, { processId: entry!.processId })?.lines.map((line) => line.line)).toEqual([
      '$ ./gradlew :app:assembleDebug', '[Tapflow] android agent: installed build 8', 'Running: Android on tapflow-phone',
    ])
    // A run no mission watches is a no-op.
    expect(() => { mobileRunLine('nobody', 'x'); mobileRunPid('nobody', 1); finishMobileRun('nobody', 'failed') }).not.toThrow()
  })

  it('shows Tapflow\'s terminal output as plain text', () => {
    expect(plainText('\x1b[32m✓\x1b[0m  Connecting ios agent…')).toBe('✓  Connecting ios agent…')
    expect(plainText('⠋ booting\r⠙ booting\rdevice booted   ')).toBe('device booted')
    expect(plainText('\x1b[2m\x1b[0m')).toBe('')
  })

  it('names simulators by UDID from simctl', () => {
    expect(parseSimctlDevices(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ udid: 'd656f70b-ffe8', name: 'iPhone 17 Pro' }, { name: 'no id' }] } })))
      .toEqual(new Map([['D656F70B-FFE8', 'iPhone 17 Pro']]))
    expect(parseSimctlDevices('not json').size).toBe(0)
  })
})
