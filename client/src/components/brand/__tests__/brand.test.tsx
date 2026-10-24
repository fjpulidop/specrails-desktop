import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '../../../test-utils'
import { RailMark } from '../RailMark'
import { RailTrack } from '../RailTrack'
import { DeliveryArrival } from '../DeliveryArrival'

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

describe('DeliveryArrival', () => {
  const mm = window.matchMedia
  afterEach(() => { window.matchMedia = mm })

  it('announces the arrival politely and links the PR number', () => {
    render(<DeliveryArrival deliveryId="d-1" prNumber={42} prUrl="https://x/pull/42" />)
    const live = screen.getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('Arrived at review — PR #42')
    expect(screen.getByTestId('delivery-arrival-link')).toHaveTextContent('#42')
    expect(screen.getByTestId('rail-mark-pill').getAttribute('class')).toContain('animate-rail-arrive')
  })
  it('does not replay on remount of the same delivery', () => {
    const { unmount } = render(<DeliveryArrival deliveryId="d-2" prNumber={1} prUrl="u" />)
    unmount()
    render(<DeliveryArrival deliveryId="d-2" prNumber={1} prUrl="u" />)
    expect(screen.getByTestId('delivery-arrival')).toHaveAttribute('data-animated', 'false')
    expect(screen.getByTestId('rail-mark-pill').getAttribute('class') ?? '').not.toContain('animate-rail-arrive')
  })
  it('has no animation class under reduced motion', () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
    render(<DeliveryArrival deliveryId="d-3" prNumber={7} prUrl="u" />)
    expect(screen.getByTestId('rail-mark-pill').getAttribute('class') ?? '').not.toContain('animate-')
    expect(document.querySelector('.u-arrive-check')).toBeNull()
  })
})
