import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UiModeProvider, useUiMode } from '../UiModeContext'

const STORAGE_KEY = 'specrails-desktop:uiMode'
function Probe({ name }: { name: string }) {
  const { uiMode, setUiMode, toggleUiMode } = useUiMode()
  return <section aria-label={name}>
    <output>{uiMode}</output>
    <button onClick={() => setUiMode('agent')}>Agent</button>
    <button onClick={() => setUiMode('kanban')}>Board</button>
    <button onClick={toggleUiMode}>Toggle</button>
  </section>
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe.each(['MacIntel', 'Win32'])('mission UI mode isolation (%s frontend)', platform => {
  beforeEach(() => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform) })

  it('starts a detached mission in agent mode while main remains in its saved board mode', () => {
    localStorage.setItem(STORAGE_KEY, 'kanban')
    render(<>
      <UiModeProvider><Probe name="Main" /></UiModeProvider>
      <UiModeProvider initialMode="agent" persist={false}><Probe name="Mission" /></UiModeProvider>
    </>)
    expect(within(screen.getByRole('region', { name: 'Main' })).getByRole('status')).toHaveTextContent('kanban')
    expect(within(screen.getByRole('region', { name: 'Mission' })).getByRole('status')).toHaveTextContent('agent')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('kanban')
  })

  it('does not persist secondary mode setters or toggles into the main window preference', () => {
    localStorage.setItem(STORAGE_KEY, 'agent')
    render(<UiModeProvider initialMode="agent" persist={false}><Probe name="Mission" /></UiModeProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(screen.getByRole('status')).toHaveTextContent('kanban')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('agent')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(screen.getByRole('status')).toHaveTextContent('agent')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(screen.getByRole('status')).toHaveTextContent('kanban')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('agent')
  })

  it('lets main persist a change without repinning the separate mission renderer', () => {
    localStorage.setItem(STORAGE_KEY, 'kanban')
    render(<>
      <UiModeProvider><Probe name="Main" /></UiModeProvider>
      <UiModeProvider initialMode="agent" persist={false}><Probe name="Mission" /></UiModeProvider>
    </>)
    const main = within(screen.getByRole('region', { name: 'Main' }))
    const mission = within(screen.getByRole('region', { name: 'Mission' }))
    fireEvent.click(main.getByRole('button', { name: 'Agent' }))
    expect(localStorage.getItem(STORAGE_KEY)).toBe('agent')
    fireEvent.click(main.getByRole('button', { name: 'Board' }))
    expect(localStorage.getItem(STORAGE_KEY)).toBe('kanban')
    expect(mission.getByRole('status')).toHaveTextContent('agent')
  })
})
