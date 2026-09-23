import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '../test-utils'
import App from '../App'

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  Toaster: () => null,
}))

vi.mock('../lib/api', () => ({
  getApiBase: () => '/api',
  setActiveProjectId: vi.fn(),
  setApiContext: vi.fn(),
}))

vi.mock('../lib/ws-url', () => ({
  WS_URL: 'ws://localhost:4200',
}))

// Mock complex child components to keep tests focused
vi.mock('../components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="setup-wizard">SetupWizard</div>,
}))

vi.mock('../components/TabBar', () => ({
  TabBar: ({ onAddProject }: { onAddProject: () => void }) => (
    <div data-testid="tab-bar">
      <button onClick={onAddProject}>Add Project</button>
    </div>
  ),
}))

vi.mock('../components/WelcomeScreen', () => ({
  WelcomeScreen: ({ onAddProject }: { onAddProject: () => void }) => (
    <div data-testid="welcome-screen">
      <button onClick={onAddProject}>Add your first project</button>
    </div>
  ),
}))

vi.mock('../features/projects/components/AddProjectDialog', () => ({
  AddProjectDialog: () => <div data-testid="add-project-dialog" />,
}))

vi.mock('../features/settings/pages/GlobalSettingsPage', () => ({
  default: () => <div data-testid="settings-dialog" />,
}))

vi.mock('../components/ProjectLayout', () => ({
  ProjectLayout: () => <div data-testid="project-layout">ProjectLayout</div>,
}))

// The DesktopProvider makes REST calls to /api/projects.
// We need to mock that too.
vi.mock('../hooks/useDesktop', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useDesktop')>('../hooks/useDesktop')
  return {
    ...actual,
    DesktopProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="desktop-provider">{children}</div>
    ),
  }
})

describe('App — desktop bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mounts DesktopProvider unconditionally', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ projects: [] }) })
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('desktop-provider')).toBeInTheDocument()
    })
  })

  it('does not probe /api/state for mode detection', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ projects: [] }) })
    global.fetch = fetchMock
    render(<App />)
    const desktopStateCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/api/state'))
    expect(desktopStateCalls).toHaveLength(0)
  })
})
