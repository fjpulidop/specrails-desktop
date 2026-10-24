import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import AgentsPage from '../AgentsPage'
import { OPEN_APP_SETTINGS_EVENT, type OpenAppSettingsDetail } from '../../../../lib/app-settings-events'

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api/projects/project-1',
}))

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'project-1' }),
}))

vi.mock('../../../missions/context/MinimizedChatsContext', () => ({
  useMinimizedChats: () => ({ pendingRestores: [] }),
}))

vi.mock('../../components/ProfilesTab', () => ({ ProfilesTab: () => <div data-testid="profiles-tab" /> }))
vi.mock('../../components/AgentsCatalogTab', () => ({ AgentsCatalogTab: () => <div /> }))
vi.mock('../../components/ProfileAnalyticsCard', () => ({ ProfileAnalyticsCard: () => <div /> }))

function mockCoreVersion(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response))
}

describe('AgentsPage core upgrade banner', () => {
  beforeEach(() => {
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('points an outdated workspace at the Core update channel instead of a CLI command', async () => {
    mockCoreVersion({ version: '4.0.2', required: '4.1.0', profileAware: false })
    render(<AgentsPage />)

    const button = await screen.findByRole('button', { name: 'Open Core updates' })
    expect(screen.getByText(/requires specrails-core 4\.1\.0\+/)).toBeInTheDocument()
    expect(screen.getByText('4.0.2')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/npx specrails-core/)

    const seen: OpenAppSettingsDetail[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent<OpenAppSettingsDetail>).detail)
    window.addEventListener(OPEN_APP_SETTINGS_EVENT, listener)
    try {
      await userEvent.click(button)
    } finally {
      window.removeEventListener(OPEN_APP_SETTINGS_EVENT, listener)
    }
    expect(seen).toEqual([{ section: 'updates' }])
  })

  it('exposes the sections as a keyboard-navigable tablist', async () => {
    mockCoreVersion({ version: '6.6.5', required: '4.1.0', profileAware: true })
    render(<AgentsPage />)
    const tablist = await screen.findByRole('tablist')
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[0].id)
    tabs[0].focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true')
    expect(tablist).toBeInTheDocument()
  })

  it('shows no banner when the workspace is profile-aware', async () => {
    mockCoreVersion({ version: '6.6.5', required: '4.1.0', profileAware: true })
    render(<AgentsPage />)
    expect(await screen.findByTestId('profiles-tab')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('button', { name: 'Open Core updates' })).not.toBeInTheDocument()
  })
})
