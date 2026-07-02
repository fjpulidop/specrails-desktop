import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useDesktop } from '../hooks/useDesktop'
import { WebViewModal } from '../components/browser-capture/WebViewModal'
import { isBrowserCaptureEnabled } from '../lib/browser-capture'

interface WebViewModalApi {
  /** Open an http(s) URL in the in-app embedded browser modal (shares the global
   *  browser profile / cookies). */
  openWebView: (url: string) => void
  /** False when the embedded browser cannot open (feature disabled or no active
   *  project) — callers keep the link's default target=_blank behaviour then. */
  canOpenWebView: boolean
}

const WebViewModalContext = createContext<WebViewModalApi | null>(null)

export function WebViewModalProvider({ children }: { children: ReactNode }) {
  const { activeProjectId } = useDesktop()
  const [url, setUrl] = useState<string | null>(null)
  const openWebView = useCallback((u: string) => setUrl(u), [])
  const enabled = isBrowserCaptureEnabled()

  return (
    <WebViewModalContext.Provider value={{ openWebView, canOpenWebView: enabled && !!activeProjectId }}>
      {children}
      {enabled && url && activeProjectId && (
        <WebViewModal open url={url} projectId={activeProjectId} onClose={() => setUrl(null)} />
      )}
    </WebViewModalContext.Provider>
  )
}

/**
 * Open links in the in-app embedded browser. Falls back to a no-op when no
 * provider is mounted (e.g. unit tests), so consumers can call it unconditionally
 * and the link keeps its default behaviour.
 */
export function useWebViewModal(): WebViewModalApi {
  return useContext(WebViewModalContext) ?? { openWebView: () => {}, canOpenWebView: false }
}
