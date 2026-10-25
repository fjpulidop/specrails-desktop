import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import GlobalSettingsPage from '../../pages/GlobalSettingsPage'
import { ProjectSettingsDialog } from '../../components/ProjectSettingsDialog'
import { PROJECT_PANE_ANCHORS, PROJECT_SETTINGS_SECTIONS } from '../../components/project-settings-sections'
import { SETTINGS_REGISTRY, isAppSettingsSection } from '../settings-registry'
import { PROJECT_SETTINGS_SECTION_IDS } from '../project-settings-section-ids'
import { findSettingAnchor, focusSettingAnchor } from '../setting-anchor'

// The ⌘K `/` scope trusts this registry: every entry must resolve to a mounted
// `data-setting-id` in the dialog it names, and no anchor may be unlisted.

vi.mock('sonner', () => ({ toast: { promise: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  SharedWebSocketContext: React.createContext(null),
  useSharedWebSocket: () => ({ registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' }),
}))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [{ id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' }],
    activeProjectId: 'p1',
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

function anchorIds(): string[] {
  return Array.from(document.querySelectorAll('[data-setting-id]')).map((el) => el.getAttribute('data-setting-id') as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const body = String(url).includes('/api/webhooks') ? { webhooks: [] } : String(url).includes('/api/budget') ? { desktopDailyBudgetUsd: null, costToday: 0, budgetUtilizationPct: null } : {}
    return Promise.resolve({ ok: true, json: async () => body })
  })
})

describe('settings registry', () => {
  it('has unique ids and valid sections', () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.scope === 'app') expect(isAppSettingsSection(entry.section), `${entry.id} -> ${entry.section}`).toBe(true)
      else expect((PROJECT_SETTINGS_SECTION_IDS as readonly string[]).includes(entry.section), `${entry.id} -> ${entry.section}`).toBe(true)
    }
  })

  it('every project entry resolves to a mounted anchor inside its own section, and every project anchor is registered', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} />)
    const project = SETTINGS_REGISTRY.filter((e) => e.scope === 'project')
    await waitFor(() => {
      for (const entry of project) expect(document.querySelector(`[data-setting-id="${entry.id}"]`), `dead id: ${entry.id}`).toBeTruthy()
    })
    // Telemetry and the other conditional panes are mounted too: the anchors are exactly the registry's.
    expect(anchorIds().sort()).toEqual(project.map((e) => e.id).sort())
    // The anchor lives in the pane of the section the entry names.
    const paneOf = new Map<string, string>()
    for (const section of PROJECT_SETTINGS_SECTIONS) for (const Pane of section.panes) {
      const anchor = PROJECT_PANE_ANCHORS.get(Pane)
      if (anchor) paneOf.set(anchor, section.id)
    }
    for (const entry of project) expect(paneOf.get(entry.id), entry.id).toBe(entry.section)
  })

  it('every app entry resolves to a mounted anchor inside its own section pane, and every app anchor is registered', async () => {
    render(<GlobalSettingsPage open onClose={vi.fn()} />)
    const app = SETTINGS_REGISTRY.filter((e) => e.scope === 'app')
    await waitFor(() => {
      for (const entry of app) expect(document.querySelector(`[data-setting-id="${entry.id}"]`), `dead id: ${entry.id}`).toBeTruthy()
    })
    expect(anchorIds().sort()).toEqual(app.map((e) => e.id).sort())
    // Each anchor sits in the pane whose nav entry matches `section`: opening that section shows it.
    for (const entry of app) {
      const nav = screen.getByRole('button', { name: new RegExp(`^${navLabel(entry.section)}$`) })
      nav.click()
      await waitFor(() => expect(findSettingAnchor(entry.id), `${entry.id} not visible in ${entry.section}`).toBeTruthy())
    }
  })

  it('lands on the project setting: switches nothing else, flashes the block and focuses its control', async () => {
    render(<ProjectSettingsDialog open onClose={vi.fn()} initialSection="budget" initialSettingId="projectBudget" />)
    await waitFor(() => {
      const el = document.querySelector('[data-setting-id="projectBudget"]') as HTMLElement
      expect(el).toHaveAttribute('data-setting-flash', 'true')
      expect(el.contains(document.activeElement)).toBe(true)
    })
  })

  it('lands on an app setting inside the open section', async () => {
    render(<GlobalSettingsPage open onClose={vi.fn()} initialSection="advanced" initialSettingId="budgetAlerts" />)
    await waitFor(() => {
      const el = document.querySelector('[data-setting-id="budgetAlerts"]') as HTMLElement
      expect(el).toHaveAttribute('data-setting-flash', 'true')
      expect(el.contains(document.activeElement)).toBe(true)
    })
  })
})

describe('focusSettingAnchor', () => {
  it('ignores anchors inside a hidden pane, keeps polling and can be cancelled', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = '<div class="hidden"><div data-setting-id="x"><input id="in" /></div></div>'
      const cancel = focusSettingAnchor('x')
      expect(findSettingAnchor('x')).toBeNull()
      document.querySelector('.hidden')!.classList.remove('hidden')
      await vi.advanceTimersByTimeAsync(200)
      expect(document.querySelector('[data-setting-id="x"]')).toHaveAttribute('data-setting-flash', 'true')
      expect(document.activeElement?.id).toBe('in')
      await vi.advanceTimersByTimeAsync(2000)
      expect(document.querySelector('[data-setting-id="x"]')).not.toHaveAttribute('data-setting-flash')

      document.body.innerHTML = '<div data-setting-id="y"></div>'
      const cancelY = focusSettingAnchor('y')
      cancelY()
      await vi.advanceTimersByTimeAsync(2000)
      expect(document.querySelector('[data-setting-id="y"]')).not.toHaveAttribute('data-setting-flash')
      cancel()
    } finally {
      vi.useRealTimers()
      document.body.innerHTML = ''
    }
  })

  it('gives up quietly when the anchor never appears', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = ''
      focusSettingAnchor('never')
      await vi.advanceTimersByTimeAsync(4000)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

const NAV_LABELS: Record<string, string> = {
  appearance: 'Appearance', effects: 'Effects', code: 'Code', terminal: 'Terminal', specrailsAgents: 'AI providers', mobile: 'Mobile',
  projects: 'Projects', advanced: 'Advanced', webhooks: 'Webhooks', updates: 'Updates', about: 'About',
}
function navLabel(section: string): string {
  return NAV_LABELS[section] ?? section
}
