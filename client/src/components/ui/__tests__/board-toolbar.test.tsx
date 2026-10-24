import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileText } from 'lucide-react'
import {
  BoardToolbar,
  BoardToolbarRow,
  BoardToolbarSpacer,
  BoardToolbarTitle,
  ToolbarCountBadge,
  toolbarButtonClass,
} from '../board-toolbar'

describe('BoardToolbar', () => {
  it('renders the shared row heights, the title id and a count badge', () => {
    render(
      <BoardToolbar data-testid="tb">
        <BoardToolbarRow size="primary" data-testid="r1">
          <BoardToolbarTitle id="board-title" icon={FileText}>Specs</BoardToolbarTitle>
          <BoardToolbarSpacer />
          <button type="button" className={toolbarButtonClass}>
            Filters <ToolbarCountBadge count={2} tone="accent" data-testid="badge" />
          </button>
        </BoardToolbarRow>
        <BoardToolbarRow size="secondary" data-testid="r2">slice</BoardToolbarRow>
        <BoardToolbarRow size="tertiary" data-testid="r3">chips</BoardToolbarRow>
      </BoardToolbar>,
    )
    expect(screen.getByTestId('tb').tagName).toBe('HEADER')
    expect(screen.getByTestId('r1')).toHaveClass('h-12')
    expect(screen.getByTestId('r2')).toHaveClass('h-10')
    expect(screen.getByTestId('r3')).toHaveClass('min-h-9', 'flex-wrap')
    expect(screen.getByRole('heading', { name: 'Specs' })).toHaveAttribute('id', 'board-title')
    expect(screen.getByTestId('badge')).toHaveTextContent('2')
    expect(screen.getByTestId('badge')).toHaveClass('text-xs')
  })

  it('drops the title icon when asked', () => {
    const { container } = render(
      <BoardToolbarTitle id="t" icon={FileText} hideIconBelow>Rails</BoardToolbarTitle>,
    )
    expect(container.querySelector('svg')).toBeNull()
  })

  it('never uses sub-12px text in the shared control skin', () => {
    expect(toolbarButtonClass).not.toMatch(/text-\[1[01]px\]/)
    expect(toolbarButtonClass).toContain('text-xs')
  })
})
