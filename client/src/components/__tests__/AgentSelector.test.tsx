import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../test-utils'
import { AgentSelector, ALL_AGENTS, CORE_AGENTS, DEFAULT_SELECTED } from '../AgentSelector'

// specrails-core v5 ships exactly the core trio — the selector is a read-only
// team panel, never a choice.
describe('AgentSelector', () => {
  it('the shipped set IS the core trio', () => {
    expect(ALL_AGENTS.map((a) => a.id)).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
    expect([...CORE_AGENTS].sort()).toEqual(ALL_AGENTS.map((a) => a.id).sort())
    expect([...DEFAULT_SELECTED].sort()).toEqual(ALL_AGENTS.map((a) => a.id).sort())
  })

  it('renders the three core agents with their ids and the core badge', () => {
    render(<AgentSelector />)
    expect(screen.getByText('Architect')).toBeInTheDocument()
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('sr-architect')).toBeInTheDocument()
    expect(screen.getByText('sr-developer')).toBeInTheDocument()
    expect(screen.getByText('sr-reviewer')).toBeInTheDocument()
    expect(screen.getAllByText('core')).toHaveLength(3)
  })

  it('explains that the team is fixed and extensible via profiles', () => {
    render(<AgentSelector />)
    expect(screen.getByText(/always installed/i)).toBeInTheDocument()
    expect(screen.getByText(/custom-\*/)).toBeInTheDocument()
  })

  it('renders no checkboxes or buttons — nothing is selectable', () => {
    render(<AgentSelector />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
