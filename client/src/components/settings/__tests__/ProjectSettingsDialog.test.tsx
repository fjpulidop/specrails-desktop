import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../test-utils'

vi.mock('../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [{ id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' }],
    activeProjectId: 'p1',
    setActiveProjectId: vi.fn(),
  }),
}))

// Heavy self-fetching section — its own suite covers it.
vi.mock('../TerminalSettingsSection', () => ({
  TerminalSettingsSection: () => <div data-testid="terminal-section" />,
}))

import { ProjectSettingsDialog } from '../ProjectSettingsDialog'

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
})

async function waitForSelfFetchingSections() {
  await waitFor(() => expect(document.getElementById('project-pre-prompt')).toBeTruthy())
  await screen.findByTestId('integration-branch-input')
  await screen.findByTestId('worktree-env-input')
  await waitFor(() => expect(screen.getByLabelText('Enable pipeline telemetry')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByPlaceholderText('e.g. 5.00')).toBeInTheDocument())
}

describe('ProjectSettingsDialog', () => {
  it('shows the project name in the title and the section entries', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    expect(screen.getByText('acme-api — Settings')).toBeInTheDocument()
    for (const label of ['General', 'Branch', 'Environment', 'Budget', 'Telemetry', 'Terminal']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    await waitForSelfFetchingSections()
  })

  it('starts on General (pre-prompts visible) and switches panes on nav click', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    // General pane: the pre-prompt editor is visible (after its GET settles),
    // terminal pane hidden.
    await waitFor(() => expect(document.getElementById('project-pre-prompt')).toBeTruthy())
    const generalField = document.getElementById('project-pre-prompt')!
    expect(generalField.closest('.hidden')).toBeNull()
    const terminalPane = screen.getByTestId('terminal-section').closest('div.space-y-5')!
    expect(terminalPane.className).toContain('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(screen.getByTestId('terminal-section').closest('div.space-y-5')!.className).not.toContain('hidden')
    expect(generalField.closest('.hidden')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect(screen.getByTestId('integration-branch-input').closest('div.space-y-5')!.className).not.toContain('hidden')
    expect(screen.getByTestId('terminal-section').closest('div.space-y-5')!.className).toContain('hidden')
  })

  it('closes through onOpenChange', async () => {
    const onClose = vi.fn()
    render(<ProjectSettingsDialog open onClose={onClose} />)
    await waitForSelfFetchingSections()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
