import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../test-utils'
import { RailMark } from '../RailMark'
import { RailTrack } from '../RailTrack'

describe('RailMark', () => {
  it('is decorative by default and exposes state', () => {
    render(<RailMark state="travel" />)
    const m = screen.getByTestId('rail-mark')
    expect(m).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('rail-mark-pill').getAttribute('class')).toContain('animate-rail-travel')
  })
  it('gets an accessible name when not decorative', () => {
    render(<RailMark decorative={false} />)
    expect(screen.getByRole('img', { name: 'Specrails' })).toBeInTheDocument()
  })
})

describe('RailTrack', () => {
  it('reports determinate progress', () => {
    render(<RailTrack progress={0.4} aria-label="p" />)
    expect(screen.getByRole('progressbar', { name: 'p' })).toHaveAttribute('aria-valuenow', '40')
  })
  it('travels when running without progress and lists stations', () => {
    render(<RailTrack running stations={[{ id: 'a', label: 'Spec', state: 'done' }, { id: 'b', label: 'PR', state: 'active' }]} />)
    expect(screen.getByTestId('rail-track-pill').getAttribute('class')).toContain('animate-rail-travel')
    expect(screen.getByText('PR: active')).toBeInTheDocument()
  })
})
