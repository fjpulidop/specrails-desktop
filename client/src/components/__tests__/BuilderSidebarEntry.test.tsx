import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { BuilderSidebarEntry, deriveMilestoneRows } from '../project-builder/BuilderSidebarEntry'
import type { Blueprint } from '../../lib/blueprint-draft'

vi.mock('../project-builder/MilestoneGenerateShell', async () => {
  const ReactModule = await import('react')
  return {
    MilestoneGenerateShell: (props: { onCommitted?: () => void; onClose: () => void }) => ReactModule.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'mock-milestone-committed',
        onClick: () => { props.onCommitted?.(); props.onClose() },
      },
      'finish milestone',
    ),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

let mockActiveProjectId: string | null = 'proj-1'
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: mockActiveProjectId,
    projects: [],
    setActiveProjectId: vi.fn(),
  }),
}))

// getApiBase throws with no active project set in the module store — stub it.
vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

function blueprint(): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'p', audience: 'a' },
    coreFlow: 'flow',
    platform: 'web',
    stack: { language: 'ts', framework: 'next', db: 'sqlite' },
    assumptions: [],
    milestones: [
      { id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'committed', plannedSpecs: [] },
      { id: 'm2', title: 'Accounts', goal: 'auth', status: 'planned', plannedSpecs: ['login'] },
    ],
    specsComplete: false,
    m1Specs: [],
  }
}

const boardTickets = [
  { id: 1, status: 'done', labels: ['M1'] },
  { id: 2, status: 'todo', labels: ['M1'] },
  { id: 3, status: 'todo', labels: ['M2'] },
]

function mockFetch(routes: Record<string, { status: number; body: unknown }>) {
  global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [fragment, res] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return { ok: res.status < 300, status: res.status, json: async () => res.body }
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveProjectId = 'proj-1'
})

describe('deriveMilestoneRows', () => {
  it('derives per-milestone progress from board tickets by label', () => {
    const rows = deriveMilestoneRows(blueprint(), boardTickets)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ n: 1, done: 1, total: 2 })
    expect(rows[1]).toMatchObject({ n: 2, done: 0, total: 1 })
  })
})

describe('BuilderSidebarEntry', () => {
  it('renders nothing when the project has no blueprint (404)', async () => {
    mockFetch({})
    render(<BuilderSidebarEntry expanded />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('builder-sidebar-entry')).not.toBeInTheDocument()
  })

  it('renders the entry and opens the milestone panel with live progress + actions', async () => {
    mockFetch({
      '/blueprint': { status: 200, body: { blueprint: blueprint() } },
      '/tickets': { status: 200, body: { tickets: boardTickets } },
    })
    const user = userEvent.setup()
    render(<BuilderSidebarEntry expanded />)
    await waitFor(() => expect(screen.getByTestId('builder-sidebar-entry')).toBeInTheDocument())
    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    await waitFor(() => expect(screen.getByTestId('builder-sidebar-panel')).toBeInTheDocument())
    expect(screen.getByText('Skeleton')).toBeInTheDocument()
    expect(screen.getByText('1/2 done')).toBeInTheDocument()
    // M1 still has a todo ticket → launchable; M2 is the next planned milestone
    expect(screen.getByTestId('sidebar-launch-m1')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-generate-next')).toHaveTextContent('Generate M2')
  })

  it('hides Launch M1 when no M1 todo tickets remain', async () => {
    mockFetch({
      '/blueprint': { status: 200, body: { blueprint: blueprint() } },
      '/tickets': { status: 200, body: { tickets: [{ id: 1, status: 'done', labels: ['M1'] }] } },
    })
    const user = userEvent.setup()
    render(<BuilderSidebarEntry expanded />)
    await waitFor(() => expect(screen.getByTestId('builder-sidebar-entry')).toBeInTheDocument())
    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    await waitFor(() => expect(screen.getByTestId('builder-sidebar-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('sidebar-launch-m1')).not.toBeInTheDocument()
  })

  it('refetches the blueprint after M2 commit and advances generation to M3', async () => {
    const initial = blueprint()
    initial.milestones.push({ id: 'm3', title: 'Sharing', goal: 'collaboration', status: 'planned', plannedSpecs: ['share'] })
    const committed = JSON.parse(JSON.stringify(initial)) as Blueprint
    committed.milestones[1].status = 'committed'
    committed.milestones[1].ticketIds = [9]
    let blueprintReads = 0
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/blueprint')) {
        blueprintReads += 1
        return { ok: true, status: 200, json: async () => ({ blueprint: blueprintReads === 1 ? initial : committed }) }
      }
      if (url.includes('/tickets')) return { ok: true, status: 200, json: async () => ({ tickets: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const user = userEvent.setup()
    render(<BuilderSidebarEntry expanded />)
    await waitFor(() => expect(screen.getByTestId('builder-sidebar-entry')).toBeInTheDocument())
    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    await user.click(await screen.findByTestId('sidebar-generate-next'))
    expect(screen.getByTestId('mock-milestone-committed')).toBeInTheDocument()
    await user.click(screen.getByTestId('mock-milestone-committed'))
    await waitFor(() => expect(blueprintReads).toBe(2))

    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    expect(await screen.findByTestId('sidebar-generate-next')).toHaveTextContent('Generate M3')
  })
})
