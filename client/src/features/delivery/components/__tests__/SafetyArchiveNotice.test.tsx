import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SafetyArchiveNotice } from '../SafetyArchiveNotice'

const ARCHIVE = '/home/.specrails/projects/demo/worktrees/run/ticket-14.specrails-overlay-quarantine-3VqEp0'

function present() {
  return { projectId: 'p1', path: ARCHIVE, status: 'present', quarantine: {
    path: ARCHIVE, worktreeName: 'ticket-14', createdAt: Date.now(), fileCount: 2, bytes: 1500, truncated: false,
    files: [{ path: 'CLAUDE.md', kind: 'file', bytes: 1200 }, { path: '.claude/commands', kind: 'link', bytes: 60 }],
  } }
}

let deleted = false
let calls: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  deleted = false
  calls = []
  try { window.localStorage.clear() } catch { /* ignore */ }
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    calls.push({ url, body })
    if (url.endsWith('/worktrees/quarantines/remove')) {
      deleted = true
      return new Response(JSON.stringify({ results: [{ projectId: 'p1', path: ARCHIVE, status: 'deleted', fileCount: 2, bytes: 1500 }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ items: [deleted ? { projectId: 'p1', path: ARCHIVE, status: 'missing' } : present()] }), { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => { vi.restoreAllMocks() })

describe('SafetyArchiveNotice', () => {
  it('is short: a count title, no path until Details', async () => {
    render(<SafetyArchiveNotice projectId="p1" paths={[ARCHIVE]} />)
    const notice = await screen.findByTestId('safety-archive-notice')
    expect(notice).toHaveTextContent("2 files were kept that didn't go into the PR")
    expect(notice).not.toHaveTextContent(ARCHIVE)
    fireEvent.click(screen.getByTestId('safety-archive-details-toggle'))
    const details = screen.getByTestId('safety-archive-details')
    expect(details).toHaveTextContent(ARCHIVE)
    expect(details).toHaveTextContent('CLAUDE.md')
    expect(details).toHaveTextContent('1.2 KB')
    expect(details).toHaveTextContent('link')
    expect(screen.getByRole('button', { name: /Copy path/ })).toBeInTheDocument()
  })

  it('Delete asks first, naming the folder and file count, then the notice disappears', async () => {
    render(<SafetyArchiveNotice projectId="p1" paths={[ARCHIVE]} />)
    fireEvent.click(await screen.findByTestId('safety-archive-delete'))
    const dialog = await screen.findByTestId('safety-archive-confirm')
    expect(dialog).toHaveTextContent('ticket-14.specrails-overlay-quarantine-3VqEp0')
    expect(dialog).toHaveTextContent('2 files')
    expect(calls.some((call) => call.url.endsWith('/remove'))).toBe(false)
    fireEvent.click(screen.getByTestId('safety-archive-confirm-button'))
    await waitFor(() => expect(screen.queryByTestId('safety-archive-notice')).toBeNull())
    expect(calls.find((call) => call.url.endsWith('/remove'))?.body).toEqual({ items: [{ projectId: 'p1', path: ARCHIVE }] })
  })

  it('Dismiss hides it and keeps the files (no delete call)', async () => {
    const { unmount } = render(<SafetyArchiveNotice projectId="p1" paths={[ARCHIVE]} />)
    fireEvent.click(await screen.findByTestId('safety-archive-dismiss'))
    expect(screen.queryByTestId('safety-archive-notice')).toBeNull()
    expect(calls.some((call) => call.url.endsWith('/remove'))).toBe(false)
    unmount()
    render(<SafetyArchiveNotice projectId="p1" paths={[ARCHIVE]} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId('safety-archive-notice')).toBeNull()
  })

  it('shows nothing when the recorded archive is gone', async () => {
    deleted = true
    render(<SafetyArchiveNotice projectId="p1" paths={[ARCHIVE]} />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(screen.queryByTestId('safety-archive-notice')).toBeNull()
  })
})
