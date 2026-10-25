import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../test-utils'
import { KeyboardShortcutsCheatsheet } from '../KeyboardShortcutsCheatsheet'
import { OPEN_DOCS_EVENT, type OpenDocsDetail } from '../../lib/docs-events'

describe('KeyboardShortcutsCheatsheet', () => {
  it('renders the cheatsheet when open', () => {
    render(
      <KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />,
    )
    expect(screen.getByTestId('shortcuts-cheatsheet')).toBeInTheDocument()
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('does not render content when closed', () => {
    render(
      <KeyboardShortcutsCheatsheet open={false} onOpenChange={vi.fn()} />,
    )
    expect(screen.queryByTestId('shortcuts-cheatsheet')).not.toBeInTheDocument()
  })

  it('displays all shortcut categories', () => {
    render(
      <KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />,
    )
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Actions')).toBeInTheDocument()
  })

  it('lists the board multi-select shortcuts (x, click, ⌘A, Esc)', () => {
    render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText('Board: select / deselect the focused spec')).toBeInTheDocument()
    expect(screen.getByText('Board: click toggles a spec, Shift+click selects a range')).toBeInTheDocument()
    expect(screen.getByText('Board: select every spec in the column')).toBeInTheDocument()
    expect(screen.getByText('Board: clear the selection')).toBeInTheDocument()
  })

  it('displays navigation shortcut descriptions', () => {
    render(
      <KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />,
    )
    expect(
      screen.getByText('Navigate to project page (Dashboard/Jobs/Analytics/Agents/Settings)'),
    ).toBeInTheDocument()
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Go to Analytics')).toBeInTheDocument()
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
  })

  it('lists the mission run strip shortcuts (conversation-scoped, Flow letters only inside the strip)', () => {
    render(
      <KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />,
    )
    expect(screen.getByText('Missions')).toBeInTheDocument()
    expect(screen.getByText("Jump to the mission's run strip (press again to show or hide details)")).toBeInTheDocument()
    expect(screen.getByText('Previous / next run in the run strip (outside text fields)')).toBeInTheDocument()
    expect(screen.getByText('Pause or resume the Flow (run strip focused)')).toBeInTheDocument()
    expect(screen.getByText('Hand off the Flow (run strip focused)')).toBeInTheDocument()
  })

  it('headings stay neutral (the lamp colour is for state) and keys use the shared Kbd chip', () => {
    render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
    const heading = screen.getAllByRole('heading', { level: 3 })[0]
    expect(heading.className).toContain('text-muted-foreground')
    expect(heading.className).not.toContain('text-accent-primary')
    const key = screen.getAllByText('?', { selector: 'kbd' })[0]
    expect(key.className).toContain('rounded-control')
    expect(key.className).not.toContain('font-mono')
  })

  it('lists the inbox chord of the keyboard family (Ctrl+Shift+I is DevTools off macOS)', () => {
    const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
    try {
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      const win = render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      expect(screen.getByText('Ctrl+Alt+I')).toBeInTheDocument()
      expect(screen.queryByText('⌘⇧I')).not.toBeInTheDocument()
      win.unmount()
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
      render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      expect(screen.getByText('⌘⇧I')).toBeInTheDocument()
      expect(screen.queryByText('Ctrl+Alt+I')).not.toBeInTheDocument()
    } finally {
      if (platform) Object.defineProperty(navigator, 'platform', platform)
    }
  })

  it('lists Back / Forward with the keyboard family of the platform', () => {
    const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
    try {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
      const { unmount } = render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      expect(screen.getAllByText('Go back / forward to the previous place')).toHaveLength(1)
      expect(screen.getByText('⌘[')).toBeInTheDocument()
      expect(screen.queryByText('Alt+←')).not.toBeInTheDocument()
      unmount()

      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      expect(screen.getAllByText('Go back / forward to the previous place')).toHaveLength(2)
      expect(screen.getByText('Ctrl+[')).toBeInTheDocument()
      expect(screen.getByText('Alt+←')).toBeInTheDocument()
    } finally {
      if (platform) Object.defineProperty(navigator, 'platform', platform)
    }
  })

  describe('search', () => {
    afterEach(() => { (global.fetch as ReturnType<typeof vi.fn>).mockReset() })

    function mockGuide(results: unknown[]) {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ results }) })
    }

    it('filters the shortcuts by description and keys', async () => {
      mockGuide([])
      render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      await userEvent.type(screen.getByTestId('shortcuts-search'), 'analytics')
      expect(screen.getByText('Go to Analytics')).toBeInTheDocument()
      expect(screen.queryByText('Go to Dashboard')).not.toBeInTheDocument()
      expect(screen.queryByText('Navigation')).toBeInTheDocument()
      expect(screen.queryByText('Missions')).not.toBeInTheDocument()
    })

    it('says so when no shortcut matches and no guide does either', async () => {
      mockGuide([])
      render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      await userEvent.type(screen.getByTestId('shortcuts-search'), 'zzzqq')
      expect(screen.getByTestId('shortcuts-no-match')).toHaveTextContent('No shortcut matches “zzzqq”.')
      expect(await screen.findByText('No guide matches “zzzqq”.')).toBeInTheDocument()
    })

    it('lists matching guide pages in the current language and opens one at its section', async () => {
      mockGuide([
        { category: 'insights', categoryName: 'Insights', slug: 'analytics-and-cost-tracking', title: 'Analytics & cost tracking', heading: 'Daily budgets', anchor: 'daily-budget' },
        { category: 'pipeline', categoryName: 'Pipeline', slug: 'rails-and-jobs', title: 'Rails & jobs', heading: null, anchor: null },
      ])
      const onOpenChange = vi.fn()
      const seen: OpenDocsDetail[] = []
      const handler = (event: Event) => seen.push((event as CustomEvent<OpenDocsDetail>).detail)
      window.addEventListener(OPEN_DOCS_EVENT, handler)
      try {
        render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={onOpenChange} />)
        await userEvent.type(screen.getByTestId('shortcuts-search'), 'budget')
        const entry = await screen.findByRole('button', { name: 'Open guide: Analytics & cost tracking › Daily budgets' })
        expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/\/api\/docs\/search\?lang=en&q=budget$/)
        expect(screen.getByText('From the guide')).toBeInTheDocument()
        await userEvent.click(entry)
        expect(onOpenChange).toHaveBeenCalledWith(false)
        expect(seen).toEqual([{ target: { category: 'insights', slug: 'analytics-and-cost-tracking', anchor: 'daily-budget', heading: 'Daily budgets' } }])
      } finally {
        window.removeEventListener(OPEN_DOCS_EVENT, handler)
      }
    })

    it('does not search the guide for a single character or an empty query', async () => {
      mockGuide([])
      render(<KeyboardShortcutsCheatsheet open={true} onOpenChange={vi.fn()} />)
      await userEvent.type(screen.getByTestId('shortcuts-search'), 'a')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(global.fetch).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByTestId('shortcuts-guides')).toBeNull())
    })
  })
})
