import { describe, it, expect, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { render, screen } from '../../../../test-utils'
import { CapturedDomPanel } from './CapturedDomPanel'
import type { CapturedDom, CapturedNetworkRequest } from '../../lib/browser-capture'

function makeDom(over: Partial<CapturedDom> = {}): CapturedDom {
  return {
    url: 'https://example.com/pricing',
    title: 'Pricing',
    viewport: { width: 1280, height: 800 },
    rect: { x: 0, y: 0, width: 10, height: 10 },
    html: '<button class="cta">Buy</button>',
    htmlTruncated: false,
    css: '.cta { color: red; }',
    cssTruncated: false,
    nodes: [
      { tag: 'button', role: 'button', text: 'Buy', rect: { x: 0, y: 0, width: 1, height: 1 }, attributes: {}, styles: {} },
      { tag: 'div', role: null, text: null, rect: { x: 0, y: 0, width: 1, height: 1 }, attributes: {}, styles: {} },
    ],
    capturedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  }
}

describe('CapturedDomPanel', () => {
  it('renders the title and element count, collapsed by default', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    expect(screen.getByText(/Captured page · Pricing/)).toBeInTheDocument()
    expect(screen.getByText(/2 elements/)).toBeInTheDocument()
    expect(screen.queryByTestId('captured-dom-html')).not.toBeInTheDocument()
  })

  it('expands to show the captured HTML and the url', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const pre = screen.getByTestId('captured-dom-html')
    expect(pre.textContent).toContain('<button class="cta">Buy</button>')
    expect(screen.getByText('https://example.com/pricing')).toBeInTheDocument()
  })

  it('syntax-highlights the HTML (tag spans rendered)', () => {
    const { container } = render(<CapturedDomPanel dom={makeDom()} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const pre = screen.getByTestId('captured-dom-html')
    // The full HTML text is preserved across the colored spans…
    expect(pre.textContent).toContain('<button class="cta">Buy</button>')
    // …and at least one tag-colored span exists.
    expect(container.querySelector('.text-accent-info')).toBeTruthy()
  })

  it('reveals the applied CSS in its own disclosure', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    expect(screen.queryByTestId('captured-dom-css')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Applied CSS/ }))
    expect(screen.getByTestId('captured-dom-css').textContent).toContain('.cta { color: red; }')
  })

  it('marks the element count with a CSS badge when css is present', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    expect(screen.getByText(/· CSS/)).toBeInTheDocument()
  })

  it('shows a truncated marker when the html was capped', () => {
    render(<CapturedDomPanel dom={makeDom({ htmlTruncated: true })} />)
    expect(screen.getByText(/truncated/)).toBeInTheDocument()
  })

  it('falls back to the host when there is no title', () => {
    render(<CapturedDomPanel dom={makeDom({ title: '' })} />)
    expect(screen.getByText(/Captured page · example\.com/)).toBeInTheDocument()
  })

  const tokens = {
    contractVersion: 1,
    anchor: { color: 'rgb(17, 24, 39)', backgroundColor: 'rgb(59, 130, 246)', fontFamily: 'Inter, sans-serif', fontSize: '16px', borderRadius: '8px' },
    byTag: { button: { color: 'rgb(255, 255, 255)' } },
    palette: ['rgb(17, 24, 39)', 'rgb(59, 130, 246)'],
    fonts: ['Inter, sans-serif'],
  }

  it('shows a tokens badge and the design-tokens section when designTokens are present', () => {
    render(<CapturedDomPanel dom={makeDom({ designTokens: tokens })} />)
    expect(screen.getByText(/· tokens/)).toBeInTheDocument()
    // Collapsed by default.
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    expect(screen.queryByTestId('captured-dom-tokens')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Design tokens/ }))
    const block = screen.getByTestId('captured-dom-tokens')
    expect(block.textContent).toContain('rgb(59, 130, 246)') // palette swatch + anchor value
    expect(block.textContent).toContain('borderRadius')
    expect(block.textContent).toContain('8px')
    expect(block.textContent).toContain('Inter, sans-serif') // fonts row
  })

  it('copies the tokens as JSON', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CapturedDomPanel dom={makeDom({ designTokens: tokens })} />)
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    fireEvent.click(screen.getByRole('button', { name: /Design tokens/ }))
    fireEvent.click(screen.getByRole('button', { name: /Copy as JSON/ }))
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0]).toContain('"contractVersion": 1')
  })

  it('renders no tokens section nor badge for a capture without designTokens', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    expect(screen.queryByText(/· tokens/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    expect(screen.queryByRole('button', { name: /Design tokens/ })).not.toBeInTheDocument()
  })

  const netRequests: CapturedNetworkRequest[] = [
    { method: 'GET', url: 'https://api.example.com/items?token=secret', status: 200, resourceType: 'Fetch', mimeType: 'application/json', requestBodyShape: null, responseShape: '{ items: [object] }', durationMs: 42, startedAt: 0 },
    { method: 'POST', url: 'https://api.example.com/save', status: 500, resourceType: 'Fetch', mimeType: 'application/json', durationMs: 88, startedAt: 1 },
  ]

  it('shows a request-count badge and the network section', () => {
    render(<CapturedDomPanel dom={makeDom({ networkRequests: netRequests })} />)
    expect(screen.getByText(/· 2 req/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    expect(screen.queryByTestId('captured-dom-network')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Network · 2 requests/ }))
    const net = screen.getByTestId('captured-dom-network')
    expect(net.textContent).toContain('api.example.com/items') // query dropped from the label
    expect(net.textContent).not.toContain('token=secret')
    expect(net.textContent).toContain('{ items: [object] }')
    expect(net.textContent).toContain('42ms')
    expect(net.textContent).toContain('500')
  })

  it('renders no network section nor badge without networkRequests', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    expect(screen.queryByText(/req/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Captured page/ }))
    expect(screen.queryByRole('button', { name: /Network ·/ })).not.toBeInTheDocument()
  })

  it('invokes onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn()
    render(<CapturedDomPanel dom={makeDom()} onRemove={onRemove} />)
    fireEvent.click(screen.getByLabelText('Remove captured page context'))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('omits the remove control when no handler is given', () => {
    render(<CapturedDomPanel dom={makeDom()} />)
    expect(screen.queryByLabelText('Remove captured page context')).not.toBeInTheDocument()
  })
})
