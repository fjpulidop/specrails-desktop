import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { UiModeProvider, useUiMode } from '../UiModeContext'

// FEATURE_AGENT_MODE resolves ON by default (no VITE_FEATURE_AGENT_MODE=false).

function Probe() {
  const { uiMode, setUiMode, toggleUiMode } = useUiMode()
  return (
    <div>
      <span data-testid="mode">{uiMode}</span>
      <button onClick={() => setUiMode('agent')}>set-agent</button>
      <button onClick={() => setUiMode('kanban')}>set-kanban</button>
      <button onClick={toggleUiMode}>toggle</button>
    </div>
  )
}

describe('UiModeContext', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to agent when no stored value', () => {
    render(<UiModeProvider><Probe /></UiModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('agent')
  })

  it('reads persisted kanban mode from localStorage (last explicit pick wins)', () => {
    localStorage.setItem('specrails-desktop:uiMode', 'kanban')
    render(<UiModeProvider><Probe /></UiModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('kanban')
  })

  it('reads persisted agent mode from localStorage', () => {
    localStorage.setItem('specrails-desktop:uiMode', 'agent')
    render(<UiModeProvider><Probe /></UiModeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('agent')
  })

  it('setUiMode persists to localStorage', () => {
    render(<UiModeProvider><Probe /></UiModeProvider>)
    act(() => { screen.getByText('set-kanban').click() })
    expect(screen.getByTestId('mode').textContent).toBe('kanban')
    expect(localStorage.getItem('specrails-desktop:uiMode')).toBe('kanban')
  })

  it('toggle flips agent <-> kanban and persists', () => {
    render(<UiModeProvider><Probe /></UiModeProvider>)
    act(() => { screen.getByText('toggle').click() })
    expect(screen.getByTestId('mode').textContent).toBe('kanban')
    expect(localStorage.getItem('specrails-desktop:uiMode')).toBe('kanban')
    act(() => { screen.getByText('toggle').click() })
    expect(screen.getByTestId('mode').textContent).toBe('agent')
    expect(localStorage.getItem('specrails-desktop:uiMode')).toBe('agent')
  })

  it('useUiMode outside provider returns kanban + no-op setter', () => {
    render(<Probe />)
    expect(screen.getByTestId('mode').textContent).toBe('kanban')
    act(() => { screen.getByText('set-agent').click() })
    // No provider → NOOP, stays kanban.
    expect(screen.getByTestId('mode').textContent).toBe('kanban')
  })
})
