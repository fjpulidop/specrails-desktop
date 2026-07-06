import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
}))

const openTicketDetailInProject = vi.fn()
vi.mock('../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({
    openTicketDetail: vi.fn(),
    openTicketDetailInProject,
    closeTicketDetail: vi.fn(),
    enterSplit: vi.fn(),
    setComparedTicket: vi.fn(),
    exitSplit: vi.fn(),
    setSplitRatio: vi.fn(),
    state: { leftId: null, rightId: null, originSide: null, splitRatio: 0.5 },
  }),
}))

vi.mock('../../lib/tauri-shell', () => ({ openExternalUrl: vi.fn() }))

import { toast } from 'sonner'
import { openExternalUrl } from '../../lib/tauri-shell'
import { useAgentRefActions } from '../useAgentRefActions'
import type { AgentRefTarget } from '../../lib/agent-refs'

const UUID = '85d6ab14-1111-4222-8333-444455556666'

function Harness({ projectId, target }: { projectId: string; target: AgentRefTarget }) {
  const { openRef, jobRef, closeJobRef } = useAgentRefActions()
  return (
    <div>
      <button onClick={() => void openRef(projectId, target)}>go</button>
      <button onClick={closeJobRef}>close</button>
      {jobRef && <div data-testid="job-ref">{jobRef.projectId}:{jobRef.jobId}</div>}
    </div>
  )
}

const res = (status: number, body: Record<string, unknown> = {}) => ({
  ok: status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('useAgentRefActions', () => {
  it('verified ticket ref → openTicketDetailInProject with the OWNING project', async () => {
    const fetchMock = vi.fn(async () => res(200))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness projectId="p2" target={{ kind: 'ticket', ticketId: 5 }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p2', 5))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/tickets/5')
  })

  it('404 ticket → subtle not-found toast, no modal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404)))
    render(<Harness projectId="p2" target={{ kind: 'ticket', ticketId: 5 }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('pull request ref with URL opens externally and does not query specs', async () => {
    const fetchMock = vi.fn(async () => res(200))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness projectId="p2" target={{ kind: 'pull-request', prNumber: 2147, prUrl: 'https://github.com/org/repo/pull/2147' }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/org/repo/pull/2147'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('bare pull request ref resolves the PR URL from the owning project before opening', async () => {
    const fetchMock = vi.fn(async () => res(200, { url: 'https://github.com/org/repo/pull/2147' }))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness projectId="p2" target={{ kind: 'pull-request', prNumber: 2147 }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/org/repo/pull/2147'))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/git/pull-requests/2147')
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('bare pull request ref not found shows a PR not-found toast and does not open a spec', async () => {
    const fetchMock = vi.fn(async () => res(404))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness projectId="p2" target={{ kind: 'pull-request', prNumber: 2147 }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('verified job ref → jobRef state for the JobDetailModal mount', async () => {
    const fetchMock = vi.fn(async () => res(200))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness projectId="p3" target={{ kind: 'job', jobId: UUID }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('job-ref').textContent).toBe(`p3:${UUID}`))
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/p3/jobs/${UUID}`)
  })

  it('404 job → subtle not-found toast, no modal state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404)))
    render(<Harness projectId="p3" target={{ kind: 'job', jobId: UUID }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(screen.queryByTestId('job-ref')).toBeNull()
  })

  it('network failure → lookup-failed toast, nothing opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<Harness projectId="p2" target={{ kind: 'ticket', ticketId: 5 }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('closeJobRef unmounts the job modal state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200)))
    render(<Harness projectId="p3" target={{ kind: 'job', jobId: UUID }} />)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('job-ref')).toBeInTheDocument())
    fireEvent.click(screen.getByText('close'))
    expect(screen.queryByTestId('job-ref')).toBeNull()
  })
})
