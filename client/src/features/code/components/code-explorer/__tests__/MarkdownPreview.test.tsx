import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MarkdownPreview } from '../MarkdownPreview'

describe('MarkdownPreview', () => {
  it('renders markdown headings and emphasis', () => {
    render(<MarkdownPreview content={'# Title\n\nHello **world**.'} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument()
  })

  it('renders GFM tables via remarkGfm', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    render(<MarkdownPreview content={md} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})
