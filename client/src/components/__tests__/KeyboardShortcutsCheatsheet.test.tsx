import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../test-utils'
import { KeyboardShortcutsCheatsheet } from '../KeyboardShortcutsCheatsheet'

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
})
