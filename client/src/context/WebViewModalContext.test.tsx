import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WebViewModalProvider, useWebViewModal } from './WebViewModalContext'

vi.mock('../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../lib/browser-capture', () => ({ isBrowserCaptureEnabled: () => true }))
vi.mock('../components/browser-capture/WebViewModal', () => ({
  WebViewModal: ({ url, onClose }: { url: string; onClose: () => void }) => (
    <div data-testid="mock-webview">
      <span data-testid="webview-url">{url}</span>
      <button data-testid="webview-close" onClick={onClose}>close</button>
    </div>
  ),
}))

function Opener() {
  const { openWebView } = useWebViewModal()
  return <button data-testid="open" onClick={() => openWebView('https://example.com/page')}>open</button>
}

describe('WebViewModalProvider', () => {
  it('opens the embedded browser modal with the url, then closes it', () => {
    render(<WebViewModalProvider><Opener /></WebViewModalProvider>)
    expect(screen.queryByTestId('mock-webview')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('open'))
    expect(screen.getByTestId('mock-webview')).toBeInTheDocument()
    expect(screen.getByTestId('webview-url')).toHaveTextContent('https://example.com/page')

    fireEvent.click(screen.getByTestId('webview-close'))
    expect(screen.queryByTestId('mock-webview')).not.toBeInTheDocument()
  })

  it('useWebViewModal is a safe no-op without a provider', () => {
    function Bare() {
      const { openWebView } = useWebViewModal()
      return <button data-testid="bare" onClick={() => openWebView('https://x.com')}>bare</button>
    }
    render(<Bare />)
    expect(() => fireEvent.click(screen.getByTestId('bare'))).not.toThrow()
  })
})
