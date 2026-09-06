import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_PROCESS_REQUEST_TIMEOUT_MS, backgroundProcessKey, getBackgroundProcessLogs, listBackgroundProcesses, stopBackgroundProcess } from '../background-processes-api'
import type { BackgroundProcess } from '../../types'
const process: BackgroundProcess = { processId: 'execution#1', pid: 77, projectId: 'project/a', chatId: 'chat&1', command: 'npm run dev', cwd: '/repo', startedAt: 10, status: 'running' }
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
const logs = () => ({ process, lines: [{ at: 11, sequence: 1, source: 'stdout', line: 'Starting…', partial: true }], truncated: false, droppedLines: 0, maxLines: 2000, maxLineChars: 4000, retentionMs: 120000, nextSequence: 1 })
beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('background process API', () => {
  it('includes execution and owner identity in Stop and accepts HTTP202 stopping', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: true, process: { ...process, status: 'stopping' } }, 202))
    const result = await stopBackgroundProcess(process); expect(result.process?.status).toBe('stopping')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/projects/project%2Fa/background-processes/77?chatId=chat%261&processId=execution%231'); expect(init?.method).toBe('DELETE')
  })
  it.each([403, 404, 409, 500])('surfaces Stop HTTP %s instead of falsely hiding the process', async status => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'Cannot stop this execution' }, status)); await expect(stopBackgroundProcess(process)).rejects.toThrow('Cannot stop this execution')
  })
  it('rejects false success and a response for a reused PID', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false })); await expect(stopBackgroundProcess(process)).rejects.toThrow('did not confirm')
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: true, process: { ...process, processId: 'replacement' } })); await expect(stopBackgroundProcess(process)).rejects.toThrow('another process')
  })
  it('requests a bounded full log snapshot, preserves partial lines, and passes AbortSignal', async () => {
    const controller = new AbortController(); vi.mocked(fetch).mockResolvedValueOnce(response(logs()))
    const result = await getBackgroundProcessLogs(process, { signal: controller.signal }); expect(result.lines).toEqual(logs().lines)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/77/logs?chatId=chat%261&processId=execution%231&limit=2000'); expect(String(url)).not.toContain('after='); expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
  it('bounds the optional log snapshot size', async () => {
    vi.mocked(fetch).mockResolvedValue(response(logs()))
    await getBackgroundProcessLogs(process, { limit: 99999 }); expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/limit=2000$/)
    await getBackgroundProcessLogs(process, { limit: -3 }); expect(String(vi.mocked(fetch).mock.calls[1][0])).toMatch(/limit=1$/)
    await getBackgroundProcessLogs(process, { limit: NaN }); expect(String(vi.mocked(fetch).mock.calls[2][0])).toMatch(/limit=2000$/)
  })
  it('rejects foreign logs and reports expired logs errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...logs(), process: { ...process, chatId: 'another' } })); await expect(getBackgroundProcessLogs(process)).rejects.toThrow('Invalid background process log snapshot')
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'Logs expired' }, 404)); await expect(getBackgroundProcessLogs(process)).rejects.toThrow('Logs expired')
  })
  it('hydrates recent terminal executions and rejects invalid list snapshots', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ processes: [process] })); expect(await listBackgroundProcesses(process.projectId, process.chatId)).toEqual([process])
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('?chatId=chat%261&includeFinished=true')
    vi.mocked(fetch).mockResolvedValueOnce(response({})); await expect(listBackgroundProcesses(process.projectId, process.chatId)).rejects.toThrow('Invalid background process snapshot')
  })
  it('uses HTTP status when an error response has no readable JSON body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new Error('HTML') } } as unknown as Response); await expect(stopBackgroundProcess(process)).rejects.toThrow('HTTP 503')
  })
  it('keys UUID executions independently of PID reuse and legacy executions by start time and scope', () => {
    expect(backgroundProcessKey(process)).not.toBe(backgroundProcessKey({ ...process, processId: 'new' })); expect(backgroundProcessKey(process)).not.toBe(backgroundProcessKey({ ...process, chatId: 'new' }))
    const legacy = { ...process, processId: undefined }; expect(backgroundProcessKey(legacy)).not.toBe(backgroundProcessKey({ ...legacy, startedAt: 20 })); expect(backgroundProcessKey(legacy)).toBe(backgroundProcessKey({ ...legacy, status: 'exited' }))
  })
  it.each(['stop', 'logs'] as const)('times out an unresponsive %s request and clears its timer', async action => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')))
    }))
    const pending = action === 'stop' ? stopBackgroundProcess(process) : getBackgroundProcessLogs(process)
    const assertion = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(BACKGROUND_PROCESS_REQUEST_TIMEOUT_MS)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates the caller abort and cleans the request timeout', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')))
    }))
    const pending = getBackgroundProcessLogs(process, { signal: controller.signal })
    const assertion = expect(pending).rejects.toThrow('AbortError')
    controller.abort()
    await assertion
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
