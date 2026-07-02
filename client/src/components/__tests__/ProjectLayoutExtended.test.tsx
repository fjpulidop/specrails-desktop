import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'
import { ProjectLayout } from '../ProjectLayout'
import type { DesktopProject } from '../../hooks/useDesktop'

// ─── Hoisted capture points shared with vi.mock factories ────────────────────
const h = vi.hoisted(() => ({
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  wsHandler: null as null | ((raw: unknown) => void),
  ensureProject: vi.fn(),
  setVisibility: vi.fn(),
  panelVisibility: 'hidden' as 'hidden' | 'restored' | 'maximized',
}))

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => h.toastWarning(...args),
    error: (...args: unknown[]) => h.toastError(...args),
    success: vi.fn(),
  },
  Toaster: () => null,
}))

vi.mock('../../hooks/usePipeline', () => ({
  usePipeline: () => ({
    connectionStatus: 'connected',
    phases: {},
    queue: { jobs: [], activeJobId: null, paused: false },
    logs: [],
    commands: [],
    activeJobId: null,
  }),
}))

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, handler: (raw: unknown) => void) => {
      h.wsHandler = handler
    },
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

vi.mock('../../hooks/useChat', () => ({
  useChat: () => ({}),
  ChatContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}))

// Terminal panel ON, chat OFF (the existing ProjectLayout.test.tsx covers the inverse)
vi.mock('../../lib/feature-flags', () => ({
  FEATURE_CHAT_ENABLED: false,
  FEATURE_TERMINAL_PANEL: true,
}))

vi.mock('../StatusBar', () => ({
  StatusBar: ({ connectionStatus, rightSlot }: { connectionStatus: string; rightSlot?: React.ReactNode }) => (
    <div data-testid="status-bar">
      {connectionStatus}
      {rightSlot}
    </div>
  ),
}))

vi.mock('../ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}))

vi.mock('../terminal/BottomPanel', () => ({
  BottomPanel: ({ projectId }: { projectId: string }) => (
    <div data-testid="bottom-panel">{projectId}</div>
  ),
}))

vi.mock('../terminal/PanelChevronButton', () => ({
  PanelChevronButton: ({ onClick }: { isOpen: boolean; onClick: () => void }) => (
    <button data-testid="panel-chevron" onClick={onClick}>chevron</button>
  ),
}))

vi.mock('../../context/TerminalsContext', () => ({
  useTerminals: () => ({
    ensureProject: h.ensureProject,
    setVisibility: h.setVisibility,
  }),
  useProjectTerminals: () => ({
    visibility: h.panelVisibility,
    userHeight: 320,
    sessions: [],
    activeId: null,
  }),
}))

const mockProject: DesktopProject = {
  id: 'proj-1',
  slug: 'my-project',
  name: 'My Project',
  path: '/home/user/my-project',
  db_path: '/home/user/.specrails/projects/my-project/jobs.sqlite',
  provider: 'claude',
  added_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-01-02T00:00:00Z',
}

describe('ProjectLayout (extended: cost alerts + terminal panel)', () => {
  beforeEach(() => {
    h.wsHandler = null
    h.panelVisibility = 'hidden'
    h.toastWarning.mockClear()
    h.toastError.mockClear()
    h.ensureProject.mockClear()
    h.setVisibility.mockClear()
  })

  it('shows a warning toast on cost_alert messages for this project', () => {
    render(<ProjectLayout project={mockProject} />)
    expect(h.wsHandler).toBeTruthy()
    act(() => {
      h.wsHandler!({ type: 'cost_alert', projectId: 'proj-1', cost: 1.2345, threshold: 1 })
    })
    expect(h.toastWarning).toHaveBeenCalledWith(
      'Cost alert',
      expect.objectContaining({
        description: 'Job cost $1.2345 — threshold is $1.00',
      }),
    )
  })

  it('ignores messages addressed to a different project', () => {
    render(<ProjectLayout project={mockProject} />)
    act(() => {
      h.wsHandler!({ type: 'cost_alert', projectId: 'other-project', cost: 9, threshold: 1 })
      h.wsHandler!({ type: 'daily_budget_exceeded', projectId: 'other-project', dailySpend: 9, budget: 1 })
    })
    expect(h.toastWarning).not.toHaveBeenCalled()
    expect(h.toastError).not.toHaveBeenCalled()
    expect(screen.queryByText(/Daily budget exceeded/)).not.toBeInTheDocument()
  })

  it('shows an error toast and a dismissible banner on daily_budget_exceeded', () => {
    render(<ProjectLayout project={mockProject} />)
    act(() => {
      h.wsHandler!({ type: 'daily_budget_exceeded', projectId: 'proj-1', dailySpend: 12, budget: 10 })
    })
    expect(h.toastError).toHaveBeenCalledWith(
      'Daily budget exceeded',
      expect.objectContaining({
        description: 'Spent $12.00 of $10.00 today. Queue paused.',
        duration: Infinity,
      }),
    )
    // Banner with the formatted amounts
    expect(
      screen.getByText('Daily budget exceeded — spent $12.00 of $10.00. Queue is paused.'),
    ).toBeInTheDocument()

    // Dismiss removes the banner
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(
      screen.queryByText(/Daily budget exceeded — spent/),
    ).not.toBeInTheDocument()
  })

  it('shows the app-level error toast on desktop_daily_budget_exceeded (defaults applied)', () => {
    render(<ProjectLayout project={mockProject} />)
    act(() => {
      // No projectId → app-level message reaches all projects; missing amounts default to 0
      h.wsHandler!({ type: 'desktop_daily_budget_exceeded' })
    })
    expect(h.toastError).toHaveBeenCalledWith(
      'Desktop daily budget exceeded',
      expect.objectContaining({
        description: 'Total Desktop spend $0.00 of $0.00. Queue paused.',
        duration: Infinity,
      }),
    )
    // Desktop message does NOT raise the per-project banner
    expect(screen.queryByText(/Queue is paused/)).not.toBeInTheDocument()
  })

  it('no longer renders the BottomPanel/chevron (hoisted to DesktopApp, single instance for both modes)', () => {
    render(<ProjectLayout project={mockProject} />)
    // The terminal panel + StatusBar + restore chevron moved up to DesktopApp so
    // one instance serves Kanban AND Agent Mode (single-adopter invariant).
    expect(screen.queryByTestId('bottom-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('panel-chevron')).not.toBeInTheDocument()
  })

  it('does not render the ChatPanel when chat is feature-flagged off', () => {
    render(<ProjectLayout project={mockProject} />)
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })
})
