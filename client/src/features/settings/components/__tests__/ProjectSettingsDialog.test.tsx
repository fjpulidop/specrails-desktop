import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

vi.mock('../../../../hooks/useDesktop', () => ({
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
import { ProjectRepositoriesSection } from '../ProjectRepositoriesSection'

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
})

async function waitForSelfFetchingSections() {
  await waitFor(() => expect(document.getElementById('project-pre-prompt')).toBeTruthy())
  await screen.findByTestId('integration-branch-input')
  await screen.findByTestId('worktree-env-input')
  await waitFor(() => expect(screen.getByLabelText('Enable pipeline telemetry')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByTestId('project-daily-budget-summary')).toBeInTheDocument())
}

describe('ProjectSettingsDialog', () => {
  it('shows the project name in the title and the section entries', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    expect(screen.getByText('acme-api — Settings')).toBeInTheDocument()
    for (const label of ['General', 'Branch', 'Environment', 'Budget', 'Telemetry', 'Rules', 'Terminal']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    await waitForSelfFetchingSections()
  })

  it('opens on the requested section (⌘K "Open project settings")', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} initialSection="budget" />)
    expect(screen.getByRole('button', { name: 'Budget' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute('aria-current')
    await waitForSelfFetchingSections()
  })

  it('offers a Learn more link for the active section, and the budget field carries its own', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    expect(screen.queryByTestId('settings-section-help')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }))
    expect(screen.getByTestId('settings-section-help')).toContainElement(
      screen.getByRole('button', { name: 'Learn more about the project environment' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Budget' }))
    expect(screen.queryByTestId('settings-section-help')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Learn more about daily budgets' })).toBeInTheDocument()
    await waitForSelfFetchingSections()
  })

  it('falls back to General for an unknown section', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} initialSection="nope" />)
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
    await waitForSelfFetchingSections()
  })

  it('marks the active nav entry with aria-current and mentions rules in the description', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    expect(screen.getByText(/telemetry, rules and terminal/)).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Project settings sections' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(screen.getByRole('button', { name: 'Rules' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute('aria-current')
    await waitForSelfFetchingSections()
  })

  it('renders Anchoring and Rules together under the Rules section', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    const anchoring = await screen.findByTestId('project-anchoring-section')
    const rules = await screen.findByTestId('project-rules-section')
    const pane = anchoring.closest('div.space-y-5')!
    expect(pane.className).not.toContain('hidden')
    expect(pane.contains(rules)).toBe(true)
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


describe('Project code workspace settings', () => {
  it('saves a child code workspace without relocating the primary project folder', async () => {
    const repository = { id: 'primary-p1', projectId: 'p1', name: 'acme-api', path: '/acme', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '', workspacePath: '/acme/skills-studio' }
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ repositories: [repository] }) })
    render(<ProjectRepositoriesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Folder path')).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Code workspace path/), { target: { value: 'skills-studio' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/repositories/primary-p1'), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'acme-api', integrationBranch: null, workspacePath: null, workspacePaths: ['skills-studio'] }) })))
    expect(await screen.findByText('Code workspace path: /acme/skills-studio')).toBeInTheDocument()
  })
})
