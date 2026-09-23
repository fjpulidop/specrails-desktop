import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../../../test-utils'
import { ConnectionStatusPill, pillStateFor } from '../ConnectionStatusPill'

describe('pillStateFor', () => {
  it('folds statuses into the five states', () => {
    expect(pillStateFor(undefined)).toBe('untested')
    expect(pillStateFor(undefined, true)).toBe('probing')
    expect(pillStateFor({ authState: 'unknown' })).toBe('untested')
    expect(pillStateFor({ reachable: false, authState: 'unknown' })).toBe('unreachable')
    expect(pillStateFor({ installed: false, authState: 'unknown' })).toBe('unreachable')
    expect(pillStateFor({ reachable: true, authState: 'unauthenticated' })).toBe('unauthorized')
    expect(pillStateFor({ installed: true, authState: 'authenticated' })).toBe('reachable')
  })
  it('renders latency only when reachable', () => {
    const { rerender } = render(<ConnectionStatusPill state="reachable" latencyMs={12} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Reachable.*12 ms/)
    rerender(<ConnectionStatusPill state="unreachable" latencyMs={12} />)
    expect(screen.getByRole('status')).toHaveTextContent('Unreachable')
    expect(screen.getByRole('status')).not.toHaveTextContent('12 ms')
  })
})
