import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

const saveBinaryFile = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/save-text-file', () => ({ saveBinaryFile }))
const toast = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const notifyError = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/notify-error', () => ({ notifyError }))

import { ReportProblemDialog } from '../ReportProblemDialog'

const preview = {
  id: 'r1',
  createdAtMs: 0,
  fileName: 'specrails-report-20261118-093005.zip',
  files: [
    { name: 'README.txt', description: 'What this report is.', content: 'Specrails problem report', bytes: 24 },
    { name: 'server.log', description: 'Output of the server.', content: 'token=[REDACTED] at ~/code', bytes: 2048 },
  ],
}
const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4])

function mockServer({ zipStatus = 200 }: { zipStatus?: number } = {}) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/diagnostics/report') && init?.method === 'POST') return new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/api/diagnostics/report/r1/zip')) {
      return zipStatus === 200
        ? new Response(zipBytes, { status: 200, headers: { 'content-type': 'application/zip' } })
        : new Response(JSON.stringify({ message: 'expired' }), { status: zipStatus, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }) }

afterEach(() => { vi.clearAllMocks() })

describe('ReportProblemDialog', () => {
  it('previews every file of the report before saving', async () => {
    mockServer()
    render(<ReportProblemDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Collecting logs')
    await flush()
    const list = screen.getByRole('list', { name: 'Files in the report' })
    expect(within(list).getAllByRole('button').map(b => b.querySelector('.font-mono')?.textContent)).toEqual(['README.txt', 'server.log'])
    expect(screen.getByTestId('report-file-content')).toHaveTextContent('Specrails problem report')
    fireEvent.click(within(list).getByText('server.log'))
    expect(screen.getByTestId('report-file-content')).toHaveTextContent('token=[REDACTED] at ~/code')
    expect(screen.getByText(/replaced with \*\*\* or \[REDACTED\]/)).toBeInTheDocument()
  })

  it('saves exactly the previewed ZIP and closes', async () => {
    mockServer()
    saveBinaryFile.mockResolvedValue('saved')
    const onOpenChange = vi.fn()
    render(<ReportProblemDialog open onOpenChange={onOpenChange} />)
    await flush()
    fireEvent.click(screen.getByTestId('report-problem-save'))
    await flush()
    expect(saveBinaryFile).toHaveBeenCalledWith(preview.fileName, zipBytes, 'application/zip')
    expect(toast.success).toHaveBeenCalledWith('Report saved', expect.objectContaining({ description: expect.stringContaining(preview.fileName) }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('stays open when the save dialog is dismissed', async () => {
    mockServer()
    saveBinaryFile.mockResolvedValue('cancelled')
    const onOpenChange = vi.fn()
    render(<ReportProblemDialog open onOpenChange={onOpenChange} />)
    await flush()
    fireEvent.click(screen.getByTestId('report-problem-save'))
    await flush()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('asks to rebuild an expired preview', async () => {
    mockServer({ zipStatus: 404 })
    render(<ReportProblemDialog open onOpenChange={() => {}} />)
    await flush()
    fireEvent.click(screen.getByTestId('report-problem-save'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('This preview expired')
    expect(saveBinaryFile).not.toHaveBeenCalled()
  })

  it('reports a failed build with a retry', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'report_failed', message: 'disk full' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch
    render(<ReportProblemDialog open onOpenChange={() => {}} />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('The report could not be built')
    mockServer()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(screen.getByRole('list', { name: 'Files in the report' })).toBeInTheDocument()
  })
})
