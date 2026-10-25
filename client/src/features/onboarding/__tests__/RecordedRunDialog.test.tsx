import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, render, screen } from '../../../test-utils'
import { RecordedRunDialog } from '../components/RecordedRunDialog'
import { RECORDED_LINES, RECORDED_LINE_INTERVAL_MS } from '../lib/recorded-run'

afterEach(() => { vi.useRealTimers() })

describe('RecordedRunDialog', () => {
  it('replays the recorded log line by line, labels it a recording and ends at a Review packet', () => {
    vi.useFakeTimers()
    render(<RecordedRunDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId('recording-badge')).toHaveTextContent(/nothing is running and nothing is charged/i)
    expect(screen.getByTestId('recording-log').children).toHaveLength(0)
    expect(screen.queryByTestId('recording-packet')).not.toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(RECORDED_LINE_INTERVAL_MS * 3) })
    expect(screen.getByTestId('recording-log').children).toHaveLength(3)

    act(() => { vi.advanceTimersByTime(RECORDED_LINE_INTERVAL_MS * RECORDED_LINES.length) })
    expect(screen.getByTestId('recording-log').children).toHaveLength(RECORDED_LINES.length)
    expect(screen.getByTestId('recording-packet')).toHaveTextContent(/Review packet \(recorded\)/)
    expect(screen.getByTestId('recording-packet')).toHaveTextContent('logic.test.js')
  })

  it('shows the whole recording at once under reduced motion', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia
    try {
      render(<RecordedRunDialog open onOpenChange={vi.fn()} />)
      expect(screen.getByTestId('recording-log').children).toHaveLength(RECORDED_LINES.length)
      expect(screen.getByTestId('recording-packet')).toBeInTheDocument()
    } finally { window.matchMedia = original }
  })
})
