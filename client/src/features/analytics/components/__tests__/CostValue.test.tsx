import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { CostValue } from '../CostValue'

describe('CostValue', () => {
  it('renders a billed amount without the estimate marker', () => {
    render(<CostValue usd={1.5} />)
    const el = screen.getByText('$1.50')
    expect(el).not.toHaveAttribute('title')
  })

  it('marks an estimate with ~, the estimate tooltip and sr-only "estimated"', () => {
    render(<CostValue usd={1.5} estimated />)
    const el = screen.getByText('$1.50', { exact: false })
    expect(el.textContent).toMatch(/^~\$1\.50\s*estimated$/)
    expect(el).toHaveAttribute('title')
    expect(el.querySelector('.sr-only')?.textContent).toMatch(/estimated/)
  })

  it('renders the placeholder when unavailable or missing', () => {
    const { rerender } = render(<CostValue usd={2} unavailable />)
    expect(screen.getByText('—')).toBeInTheDocument()
    rerender(<CostValue usd={null} placeholder="n/a" />)
    expect(screen.getByText('n/a')).toBeInTheDocument()
  })
})
