import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
const saveTextFile = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/save-text-file', () => ({ saveTextFile }))
const writeClipboardText = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/tauri-clipboard', () => ({ writeClipboardText }))
vi.mock('../../../../lib/launch-forecast', () => ({
  fetchUsageSnapshot: () => ({ fresh: { providers: [{ providerId: 'codex', availability: 'available', plan: 'pro', windows: [] }] }, load: async () => null }),
  planProviderIds: () => ['codex'],
}))

import { copyPrDescription, exportHandoff, fetchHandoff } from '../spec-handoff-actions'

const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`) as never
const doc = (over: Record<string, unknown> = {}) => ({ format: 'md', filename: 'spec-7-handoff.md', contentType: 'text/markdown', body: '# Hand-off', redactions: 0, locale: 'en', ...over })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => doc() }) as Response)
  vi.stubGlobal('fetch', fetchMock)
})

describe('hand-off actions', () => {
  it('asks for the UI language and the plan-billed providers', async () => {
    await fetchHandoff(7, 'html')
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://x')
    expect(url.pathname).toBe('/api/projects/p1/tickets/7/handoff')
    expect(url.searchParams.get('format')).toBe('html')
    expect(url.searchParams.get('planProviders')).toBe('codex')
    expect(url.searchParams.get('locale')).toBeTruthy()
  })

  it('saves the export and reports a redaction count', async () => {
    saveTextFile.mockResolvedValue('saved')
    fetchMock.mockResolvedValue({ ok: true, json: async () => doc({ redactions: 2 }) } as Response)
    await exportHandoff(7, 'md', t)
    expect(saveTextFile).toHaveBeenCalledWith('spec-7-handoff.md', '# Hand-off', 'text/markdown')
    expect(toast.success).toHaveBeenCalledWith('timeline.export.saved{"id":7}', { description: 'timeline.export.redacted{"count":2}' })
  })

  it('stays quiet when the save dialog is dismissed and errors when saving or building fails', async () => {
    saveTextFile.mockResolvedValue('cancelled')
    await exportHandoff(7, 'md', t)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    saveTextFile.mockResolvedValue('failed')
    await exportHandoff(7, 'md', t)
    expect(toast.error).toHaveBeenCalledWith('timeline.export.failed')
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response)
    await exportHandoff(7, 'html', t)
    expect(toast.error).toHaveBeenCalledTimes(2)
  })

  it('copies the concise PR description to the clipboard with a toast', async () => {
    writeClipboardText.mockResolvedValue(true)
    fetchMock.mockResolvedValue({ ok: true, json: async () => doc({ format: 'pr', body: '## Summary' }) } as Response)
    await copyPrDescription(7, t)
    expect(new URL(String(fetchMock.mock.calls[0]![0]), 'http://x').searchParams.get('format')).toBe('pr')
    expect(writeClipboardText).toHaveBeenCalledWith('## Summary')
    expect(toast.success).toHaveBeenCalledWith('timeline.export.copied{"id":7}', { description: undefined })
  })

  it('reports a failed copy and a failed build', async () => {
    writeClipboardText.mockResolvedValue(false)
    await copyPrDescription(7, t)
    expect(toast.error).toHaveBeenCalledWith('timeline.export.copyFailed')
    fetchMock.mockRejectedValue(new Error('offline'))
    await copyPrDescription(7, t)
    expect(toast.error).toHaveBeenCalledWith('timeline.export.failed')
  })
})
