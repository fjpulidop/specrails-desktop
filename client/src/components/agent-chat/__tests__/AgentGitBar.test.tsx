import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}))

vi.mock('../../../lib/origin', () => ({ API_ORIGIN: '' }))

import { AgentGitBar } from '../AgentGitBar'
import { notifyGitChanged } from '../../../lib/git-refresh'

const INFO = {
  git: true,
  branch: 'main',
  detached: false,
  dirty: false,
  branches: ['main', 'feature', 'fix/windows-npm-shell'],
  lastCommit: { hash: 'abc1234', subject: 'fix: last commit subject', at: '2026-07-02T10:00:00Z' },
}

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => { status?: number; body: unknown }>) {
  let call = 0
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const h = handlers[Math.min(call, handlers.length - 1)]
    call++
    const { status = 200, body } = h(String(url), init)
    return Promise.resolve({ ok: status < 400, status, json: async () => body })
  }) as unknown as typeof fetch
}

async function openDropdown() {
  const trigger = await screen.findByLabelText('Branch')
  fireEvent.click(trigger)
  return trigger
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AgentGitBar', () => {
  it('ignores a previous project response after the mission changes project', async () => {
    let finishOld!: (response: unknown) => void
    global.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValue({ ok: true, json: async () => ({ ...INFO, branch: 'second-project' }) })
    const view = render(<AgentGitBar projectId="p1" />)
    view.rerender(<AgentGitBar projectId="p2" />)
    expect(await screen.findByLabelText('Branch')).toHaveTextContent('second-project')
    await act(async () => { finishOld({ ok: true, json: async () => INFO }) })
    expect(screen.getByLabelText('Branch')).toHaveTextContent('second-project')
  })

  it('ignores an old status read that settles after checkout', async () => {
    let finishOld!: (response: unknown) => void
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => INFO })
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...INFO, branch: 'feature' }) })
    render(<AgentGitBar projectId="p1" />)
    await screen.findByLabelText('Branch')
    act(() => notifyGitChanged('p1'))
    await openDropdown()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /feature/ })) })
    expect(screen.getByLabelText('Branch')).toHaveTextContent('feature')
    await act(async () => { finishOld({ ok: true, json: async () => INFO }) })
    expect(screen.getByLabelText('Branch')).toHaveTextContent('feature')
  })
  it('renders the themed branch trigger and the last commit', async () => {
    mockFetchSequence([() => ({ body: INFO })])
    render(<AgentGitBar projectId="p1" />)
    const trigger = await screen.findByLabelText('Branch')
    expect(trigger.textContent).toContain('main')
    expect(screen.getByText('abc1234')).toBeInTheDocument()
    expect(screen.getByText(/fix: last commit subject/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument()
    // Never the OS-native select — the dropdown is our own themed listbox.
    expect(document.querySelector('select')).toBeNull()
  })

  it('refreshes immediately when a git-changed notification targets its project', async () => {
    mockFetchSequence([
      () => ({ body: INFO }),
      () => ({ body: { ...INFO, branch: 'feature' } }),
    ])
    render(<AgentGitBar projectId="p1" />)
    const trigger = await screen.findByLabelText('Branch')
    await waitFor(() => expect(trigger.textContent).toContain('main'))

    // A mutation in ANOTHER project must not trigger a refetch here.
    act(() => notifyGitChanged('other-project'))
    expect(global.fetch).toHaveBeenCalledTimes(1)

    // PR-card Checkout notifies for THIS project → the strip refetches now.
    act(() => notifyGitChanged('p1'))
    await waitFor(() => expect(trigger.textContent).toContain('feature'))
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('renders nothing when the project is not a git repo', async () => {
    mockFetchSequence([() => ({ body: { ...INFO, git: false } })])
    const { container } = render(<AgentGitBar projectId="p1" />)
    await act(async () => { await Promise.resolve() })
    expect(container.firstChild).toBeNull()
  })

  it('shows the dirty dot when there are uncommitted changes', async () => {
    mockFetchSequence([() => ({ body: { ...INFO, dirty: true } })])
    render(<AgentGitBar projectId="p1" />)
    expect(await screen.findByLabelText('Uncommitted changes')).toBeInTheDocument()
  })

  it('opens the listbox, filters by search, and checks out the picked branch', async () => {
    mockFetchSequence([
      () => ({ body: INFO }),
      (url, init) => {
        expect(url).toContain('/git/checkout')
        expect(JSON.parse(String(init?.body))).toEqual({ branch: 'feature' })
        return { body: { ...INFO, branch: 'feature', lastCommit: { hash: 'def5678', subject: 'feature tip', at: '' } } }
      },
    ])
    render(<AgentGitBar projectId="p1" />)
    await openDropdown()
    // All branches listed as options with the current one marked selected.
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: /main/ })).toHaveAttribute('aria-selected', 'true')
    // Search narrows the list.
    fireEvent.change(screen.getByLabelText('Search branches…'), { target: { value: 'feat' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /feature/ })) })
    await waitFor(() => expect(screen.getByLabelText('Branch').textContent).toContain('feature'))
    expect(screen.getByText('def5678')).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('a REFUSED checkout surfaces the git reason and snaps back to the real branch', async () => {
    mockFetchSequence([
      () => ({ body: INFO }),
      () => ({ status: 409, body: { error: 'Your local changes would be overwritten by checkout' } }),
      () => ({ body: INFO }), // resync refetch after the failure
    ])
    render(<AgentGitBar projectId="p1" />)
    await openDropdown()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /feature/ })) })
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn\'t switch branch', {
      description: 'Your local changes would be overwritten by checkout',
    }))
    // Controlled by server truth — never left showing a branch we are not on.
    await waitFor(() => expect(screen.getByLabelText('Branch').textContent).toContain('main'))
    expect(global.fetch).toHaveBeenCalledTimes(3) // info + checkout + resync
  })

  it('shows the detached label when HEAD is detached', async () => {
    mockFetchSequence([() => ({ body: { ...INFO, branch: null, detached: true } })])
    render(<AgentGitBar projectId="p1" />)
    const trigger = await screen.findByLabelText('Branch')
    expect(trigger.textContent).toContain('(detached)')
  })

  it('groups worktree-bound branches: click COPIES the path, never a doomed checkout', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mockFetchSequence([() => ({
      body: {
        ...INFO,
        branches: [...INFO.branches, 'sr/ticket-7'],
        worktrees: [
          { path: '/repo', branch: 'main', head: 'a', isMain: true },
          { path: '/repo/.claude/worktrees/ticket-7', branch: 'sr/ticket-7', head: 'b', isMain: false },
        ],
      },
    })])
    render(<AgentGitBar projectId="p1" />)
    await openDropdown()
    // Worktree group visible with the branch + its path.
    expect(screen.getByText('Worktrees')).toBeInTheDocument()
    expect(screen.getByText('/repo/.claude/worktrees/ticket-7')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('sr/ticket-7')) })
    expect(writeText).toHaveBeenCalledWith('/repo/.claude/worktrees/ticket-7')
    expect(toastSuccess).toHaveBeenCalled()
    // git checkout was NEVER attempted (only the initial info fetch happened).
    expect(global.fetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('hides the worktrees group when only the main worktree exists', async () => {
    mockFetchSequence([() => ({
      body: { ...INFO, worktrees: [{ path: '/repo', branch: 'main', head: 'a', isMain: true }] },
    })])
    render(<AgentGitBar projectId="p1" />)
    await openDropdown()
    expect(screen.queryByText('Worktrees')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3) // all switchable
  })

  it('shows the empty state when the search matches nothing', async () => {
    mockFetchSequence([() => ({ body: INFO })])
    render(<AgentGitBar projectId="p1" />)
    await openDropdown()
    fireEvent.change(screen.getByLabelText('Search branches…'), { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No branches match')).toBeInTheDocument()
  })
})
