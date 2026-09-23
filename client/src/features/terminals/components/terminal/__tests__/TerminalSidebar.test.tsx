/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { TerminalSidebar } from '../TerminalSidebar'
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

  it('activates via Enter key', () => {
    const onActivate = vi.fn()
    const s = makeSession('a', 'only')
    const { getByText } = render(
      <TerminalSidebar sessions={[s]} activeId={null} onActivate={onActivate} onRename={() => {}} onKill={() => {}} />,
    )
    fireEvent.keyDown(getByText('only').parentElement as HTMLElement, { key: 'Enter' })
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
})
