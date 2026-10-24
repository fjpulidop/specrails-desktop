/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import { TerminalSidebar } from '../TerminalSidebar'
import { ingestMark, disposeSession } from '../../../../../lib/command-mark-store'
import type { TerminalRef } from '../../../context/TerminalsContext'

function makeSession(id: string, name = 'zsh'): TerminalRef {
  return { id, projectId: 'p', name, cols: 80, rows: 24, createdAt: 1 }
}

describe('TerminalSidebar', () => {
  it('renders each session name', () => {
    const s1 = makeSession('a', 'build')
    const s2 = makeSession('b', 'zsh')
    const { getByText } = render(
      <TerminalSidebar sessions={[s1, s2]} activeId="a" onActivate={() => {}} onRename={() => {}} onKill={() => {}} />,
    )
    expect(getByText('build')).toBeDefined()
    expect(getByText('zsh')).toBeDefined()
  })

  it('activates on click', () => {
    const onActivate = vi.fn()
    const s1 = makeSession('a'), s2 = makeSession('b', 'second')
    const { getByText } = render(
      <TerminalSidebar sessions={[s1, s2]} activeId="a" onActivate={onActivate} onRename={() => {}} onKill={() => {}} />,
    )
    fireEvent.click(getByText('second'))
    expect(onActivate).toHaveBeenCalledWith('b')
  })

  it('activates from a real session button (keyboard-native), with sibling actions', () => {
    const onActivate = vi.fn()
    const s = makeSession('a', 'only')
    const { getByText, getByRole } = render(
      <TerminalSidebar sessions={[s]} activeId="a" onActivate={onActivate} onRename={() => {}} onKill={() => {}} />,
    )
    const button = getByText('only').closest('button') as HTMLElement
    expect(button).toHaveAttribute('aria-current', 'true')
    expect(button.querySelector('button')).toBeNull()
    expect(getByRole('complementary', { name: 'Terminal sessions' })).toBeInTheDocument()
    fireEvent.click(button)
    expect(onActivate).toHaveBeenCalledWith('a')
  })

  it('enters rename on double click and commits on Enter', () => {
    const onRename = vi.fn()
    const s = makeSession('a', 'old')
    const { getByText, getByDisplayValue } = render(
      <TerminalSidebar sessions={[s]} activeId="a" onActivate={() => {}} onRename={onRename} onKill={() => {}} />,
    )
    fireEvent.doubleClick(getByText('old'))
    const input = getByDisplayValue('old') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'new name' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('a', 'new name')
  })

  it('enters rename when rename button is clicked', () => {
    const onRename = vi.fn()
    const s = makeSession('a', 'build')
    const { getByLabelText, getByDisplayValue } = render(
      <TerminalSidebar sessions={[s]} activeId="a" onActivate={() => {}} onRename={onRename} onKill={() => {}} />,
    )
    fireEvent.click(getByLabelText(/rename build/i))
    expect(getByDisplayValue('build')).toBeDefined()
  })

  it('cancels rename on Escape', () => {
    const onRename = vi.fn()
    const s = makeSession('a', 'keep')
    const { getByText, getByDisplayValue } = render(
      <TerminalSidebar sessions={[s]} activeId="a" onActivate={() => {}} onRename={onRename} onKill={() => {}} />,
    )
    fireEvent.doubleClick(getByText('keep'))
    const input = getByDisplayValue('keep') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abandoned' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
  })

  it('kills session via ✕ button', () => {
    const onKill = vi.fn()
    const s = makeSession('a', 'target')
    const { getByLabelText } = render(
      <TerminalSidebar sessions={[s]} activeId="a" onActivate={() => {}} onRename={() => {}} onKill={onKill} />,
    )
    fireEvent.click(getByLabelText(/close target/i))
    expect(onKill).toHaveBeenCalledWith('a')
  })

  it('asks for confirmation before closing a session with a running command', () => {
    const onKill = vi.fn()
    const s = makeSession('busy', 'server')
    ingestMark('busy', { kind: 'pre-exec', ts: Date.now() })
    try {
      const { getByLabelText, getByRole } = render(
        <TerminalSidebar sessions={[s]} activeId="busy" onActivate={() => {}} onRename={() => {}} onKill={onKill} />,
      )
      fireEvent.click(getByLabelText(/close server/i))
      expect(onKill).not.toHaveBeenCalled()
      const dialog = getByRole('dialog')
      expect(dialog).toHaveTextContent('server')
      // The footer confirm (not the dialog's own X, whose label is sr-only).
      const confirm = within(dialog).getAllByRole('button', { name: 'Close' }).find((b) => !b.querySelector('.sr-only'))!
      fireEvent.click(confirm)
      expect(onKill).toHaveBeenCalledWith('busy')
    } finally {
      disposeSession('busy')
    }
  })
})
