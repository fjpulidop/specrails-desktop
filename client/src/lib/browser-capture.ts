import { getApiBase } from './api'
import { WS_URL } from './ws-url'
import { getDesktopTokenProtocol } from './auth'
import type { Attachment } from '../types'
import type { AnnotationSet } from './annotations'

// ─── Feature flag ─────────────────────────────────────────────────────────────

/**
 * "Add Spec from browser" client gate. Default ON; set
 * `VITE_FEATURE_BROWSER_CAPTURE=false` at build time to hide the entry point.
 * The server gates independently via SPECRAILS_BROWSER_CAPTURE.
 */
export function isBrowserCaptureEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_BROWSER_CAPTURE
  if (typeof override === 'string') return override !== 'false'
  return true
}

// ─── Types (mirror server/browser-capture-types.ts) ──────────────────────────

export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CapturedNode {
  tag: string
  role: string | null
  text: string | null
  rect: CaptureRect
  attributes: Record<string, string>
  styles: Record<string, string>
}

export interface TokenSet {
  color?: string
  backgroundColor?: string
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
  padding?: string
  margin?: string
  border?: string
  borderRadius?: string
  boxShadow?: string
}

export interface CapturedDesignTokens {
  contractVersion: number
  anchor: TokenSet
  byTag: Record<string, TokenSet>
  palette: string[]
  fonts: string[]
}

export interface CapturedNetworkRequest {
  method: string
  url: string
  status: number | null
  resourceType: string
  mimeType: string | null
  requestBodyShape?: string | null
  responseShape?: string | null
  durationMs: number | null
  startedAt: number
  failed?: boolean
  errorText?: string
}

export interface CapturedDom {
  url: string
  title: string
  viewport: { width: number; height: number }
  rect: CaptureRect
  html: string
  htmlTruncated: boolean
  css: string
  cssTruncated: boolean
  nodes: CapturedNode[]
  /** Exact computed design tokens for the selection (optional; absent on
   *  captures taken before this feature). */
  designTokens?: CapturedDesignTokens
  /** XHR/fetch requests the page made around capture time (optional). */
  networkRequests?: CapturedNetworkRequest[]
  capturedAt: string
}

export interface BreadcrumbSegment {
  label: string
  selector: string
}

export interface ElementProbe {
  rect: CaptureRect
  tag: string
  selector: string
  path: BreadcrumbSegment[]
}

export interface BrowserSessionMeta {
  id: string
  projectId: string
  url: string | null
  title: string | null
  viewportWidth: number
  viewportHeight: number
  createdAt: number
}

export type BrowserInputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'resize'; width: number; height: number }

export interface BreakpointCapture {
  attachment: Attachment
  dataUrl: string
  viewport: { width: number; height: number }
}

export interface CaptureResult {
  screenshot: Attachment
  domAttachment: Attachment
  dom: CapturedDom
  /** Inline data URL of the screenshot for a thumbnail (avoids an unauthenticated
   *  <img src> to the attachment endpoint). */
  screenshotDataUrl: string
  /** Present only for a multi-breakpoint capture: the same element at each size. */
  breakpoints?: Record<string, BreakpointCapture>
  /** Present when the user annotated the capture: the original (pre-markup) image,
   *  so it can be cleaned up; `screenshot`/`screenshotDataUrl` point at the
   *  flattened, annotated image that the spec uses. */
  rawScreenshot?: Attachment
  /** Structured annotation objects (metadata; the image already carries them). */
  annotations?: AnnotationSet
}

/** Default device sizes for "capture at all sizes". Sent in the request body so
 *  the server has a single source of truth (no drift with this constant). */
export const BREAKPOINT_DIMS: Record<'desktop' | 'tablet' | 'mobile', { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
}

export class BrowserSessionLimitError extends Error {}
export class BrowserLaunchFailedError extends Error {}

// ─── REST helpers ─────────────────────────────────────────────────────────────

export async function createBrowserSession(initialUrl?: string): Promise<BrowserSessionMeta> {
  const res = await fetch(`${getApiBase()}/browser/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initialUrl }),
  })
  if (res.status === 409) throw new BrowserSessionLimitError('Too many open browser sessions')
  if (res.status === 502) throw new BrowserLaunchFailedError('The browser failed to launch')
  if (!res.ok) throw new Error(`Failed to open browser (${res.status})`)
  const data = (await res.json()) as { session: BrowserSessionMeta }
  return data.session
}

export async function navigateBrowser(
  sessionId: string,
  action: 'goto' | 'back' | 'forward' | 'reload',
  url?: string,
): Promise<{ url: string; title: string }> {
  const res = await fetch(`${getApiBase()}/browser/sessions/${sessionId}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, url }),
  })
  if (!res.ok) throw new Error(`Navigation failed (${res.status})`)
  return (await res.json()) as { url: string; title: string }
}

export async function captureBrowserRegion(
  sessionId: string,
  rect: CaptureRect,
  pendingSpecId: string,
  opts?: { captureNetwork?: boolean },
): Promise<CaptureResult> {
  const res = await fetch(`${getApiBase()}/browser/sessions/${sessionId}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rect, pendingSpecId, captureNetwork: opts?.captureNetwork ?? true }),
  })
  if (!res.ok) throw new Error(await captureErrorMessage(res))
  return (await res.json()) as CaptureResult
}

/** Build a capture error that includes the server's reason (e.g. an invalid-rect
 *  or invalid-pendingSpecId 400) so the in-modal banner is actionable, not a bare
 *  status code. */
async function captureErrorMessage(res: Response): Promise<string> {
  const detail = await res
    .json()
    .then((b) => (b as { error?: string }).error)
    .catch(() => undefined)
  return detail ? `Capture failed (${res.status}): ${detail}` : `Capture failed (${res.status})`
}

export async function captureBrowserBreakpoints(
  sessionId: string,
  rect: CaptureRect,
  anchorPoint: { x: number; y: number },
  pendingSpecId: string,
  breakpoints: Record<string, { width: number; height: number }> = BREAKPOINT_DIMS,
): Promise<CaptureResult> {
  const res = await fetch(`${getApiBase()}/browser/sessions/${sessionId}/capture-breakpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rect, anchorPoint, pendingSpecId, breakpoints }),
  })
  if (!res.ok) throw new Error(await captureErrorMessage(res))
  return (await res.json()) as CaptureResult
}

/** Upload a flattened (annotated) capture image to the pending spec's attachment
 *  dir, reusing the generic multipart attachment endpoint. Returns the Attachment. */
export async function uploadCaptureImage(pendingSpecId: string, blob: Blob, filename: string): Promise<Attachment> {
  const form = new FormData()
  form.append('file', blob, filename)
  const res = await fetch(`${getApiBase()}/tickets/${pendingSpecId}/attachments`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const data = (await res.json()) as { attachment: Attachment }
  return data.attachment
}

/** Bridge the host clipboard to the embedded page (which can't reach the OS
 *  clipboard): copy/cut return the page's selection text; paste injects text. */
export async function browserClipboard(
  sessionId: string,
  action: 'copy' | 'paste' | 'cut',
  text?: string,
): Promise<{ text: string }> {
  const res = await fetch(`${getApiBase()}/browser/sessions/${sessionId}/clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, text }),
  })
  if (!res.ok) throw new Error(`Clipboard failed (${res.status})`)
  return (await res.json()) as { text: string }
}

/** Re-resolve an element by selector and step to parent/child/self for the
 *  DevTools-style breadcrumb. Returns null when it can't step further. */
export async function navigateBrowserElement(
  sessionId: string,
  selector: string,
  direction: 'parent' | 'child' | 'self',
): Promise<ElementProbe | null> {
  const res = await fetch(`${getApiBase()}/browser/sessions/${sessionId}/element`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selector, direction }),
  })
  if (!res.ok) throw new Error(`Element navigate failed (${res.status})`)
  const data = (await res.json()) as { probe: ElementProbe | null }
  return data.probe
}

/** Switch the viewed page between the root page and the top popup (OAuth login
 *  window). Best-effort — the server broadcasts the resulting state over WS. */
export async function setBrowserPopupView(sessionId: string, target: 'root' | 'popup'): Promise<void> {
  try {
    await fetch(`${getApiBase()}/browser/sessions/${sessionId}/popup-view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    })
  } catch {
    /* best effort */
  }
}

/** Human label for a popup's origin ("Login window — okta.example"). Falls back
 *  to an ellipsis while the popup is still on about:blank / unparseable. */
export function popupOriginLabel(url: string | null | undefined): string {
  if (!url || url === 'about:blank') return '…'
  try {
    return new URL(url).hostname || '…'
  } catch {
    return '…'
  }
}

export async function killBrowserSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${getApiBase()}/browser/sessions/${sessionId}`, { method: 'DELETE' })
  } catch {
    /* best effort */
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

export function browserWsUrl(sessionId: string, projectId: string): string {
  const wsBase =
    WS_URL ||
    (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      : 'ws://localhost:4200')
  return `${wsBase}/ws/browser/${sessionId}?projectId=${encodeURIComponent(projectId)}`
}

export function openBrowserWs(sessionId: string, projectId: string): WebSocket {
  const url = browserWsUrl(sessionId, projectId)
  const protocol = getDesktopTokenProtocol()
  const ws = protocol ? new WebSocket(url, ['specrails-desktop', protocol]) : new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  return ws
}

// ─── Input coalescing (browse mode) ───────────────────────────────────────────

export interface PointerInputCoalescer {
  /** Queue the latest pointer position — only the newest is sent per frame. */
  move(x: number, y: number): void
  /** Accumulate wheel deltas at the latest position — one wheel msg per frame. */
  wheel(x: number, y: number, deltaX: number, deltaY: number): void
  /** Synchronously send anything pending. Call before a click (down/up) so the
   *  page's virtual cursor is guaranteed to be at the click point. */
  flush(): void
  dispose(): void
}

/**
 * Coalesce high-rate pointer input onto animation frames before it crosses the
 * WS → CDP boundary. A macOS trackpad emits wheel events at 60–120 Hz and
 * pointermove up to the display rate; forwarding each one becomes 1–2 CDP
 * commands per event and floods the page's input queue — the single biggest
 * cause of laggy scrolling in the embedded browser. Batching to ≤1 move + ≤1
 * wheel per frame preserves total scroll distance (deltas are summed) and final
 * cursor position (newest-wins) with no perceptible loss.
 *
 * Injectable scheduler so the batching logic is unit-testable under jsdom.
 */
export function createPointerInputCoalescer(
  send: (e: BrowserInputEvent) => void,
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): PointerInputCoalescer {
  let pendingMove: Point | null = null
  let pendingWheel: { x: number; y: number; deltaX: number; deltaY: number } | null = null
  let scheduled: number | null = null
  let disposed = false

  const flushNow = () => {
    if (scheduled != null) {
      cancel(scheduled)
      scheduled = null
    }
    const mv = pendingMove
    const wh = pendingWheel
    pendingMove = null
    pendingWheel = null
    // A wheel already repositions the cursor to its own coordinates server-side,
    // so a standalone move to the same point would be redundant.
    if (mv && (!wh || mv.x !== wh.x || mv.y !== wh.y)) {
      send({ type: 'mouse', action: 'move', x: mv.x, y: mv.y })
    }
    if (wh) send({ type: 'wheel', x: wh.x, y: wh.y, deltaX: wh.deltaX, deltaY: wh.deltaY })
  }

  const ensureScheduled = () => {
    if (scheduled == null && !disposed) {
      scheduled = schedule(() => {
        scheduled = null
        flushNow()
      })
    }
  }

  return {
    move(x: number, y: number) {
      if (disposed) return
      pendingMove = { x, y }
      ensureScheduled()
    },
    wheel(x: number, y: number, deltaX: number, deltaY: number) {
      if (disposed) return
      if (pendingWheel) {
        pendingWheel.x = x
        pendingWheel.y = y
        pendingWheel.deltaX += deltaX
        pendingWheel.deltaY += deltaY
      } else {
        pendingWheel = { x, y, deltaX, deltaY }
      }
      ensureScheduled()
    },
    flush() {
      if (!disposed) flushNow()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (scheduled != null) {
        cancel(scheduled)
        scheduled = null
      }
      pendingMove = null
      pendingWheel = null
    },
  }
}

// ─── Pure geometry helpers (unit-tested; keep coordinate logic out of the canvas
//     component so it can be verified deterministically) ────────────────────────

export interface Point {
  x: number
  y: number
}

export interface DisplayRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a pointer position (page coords from a PointerEvent) onto the page's CSS
 * viewport coordinate space, given the displayed canvas rect and the logical
 * viewport size. Result is clamped to [0, viewport).
 */
export function mapPointToViewport(
  pointer: Point,
  canvas: DisplayRect,
  viewport: { width: number; height: number },
): Point {
  const relX = canvas.width > 0 ? (pointer.x - canvas.left) / canvas.width : 0
  const relY = canvas.height > 0 ? (pointer.y - canvas.top) / canvas.height : 0
  const x = Math.min(Math.max(relX, 0), 1) * viewport.width
  const y = Math.min(Math.max(relY, 0), 1) * viewport.height
  return { x: Math.round(x), y: Math.round(y) }
}

/** Map a viewport-space rect (e.g. a hovered element's box) back to displayed
 *  page coordinates over the canvas, for drawing a highlight overlay. */
export function mapRectToDisplay(
  rect: CaptureRect,
  canvas: DisplayRect,
  viewport: { width: number; height: number },
): DisplayRect {
  const sx = viewport.width > 0 ? canvas.width / viewport.width : 0
  const sy = viewport.height > 0 ? canvas.height / viewport.height : 0
  return {
    left: canvas.left + rect.x * sx,
    top: canvas.top + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  }
}

/** Build a normalised rect from two corner points (drag in any direction). */
export function rectFromPoints(a: Point, b: Point): CaptureRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/** True when a selection rect is large enough to be meaningful (avoids stray
 *  clicks producing 1px captures). */
export function isUsableSelection(rect: CaptureRect, minPx = 8): boolean {
  return rect.width >= minPx && rect.height >= minPx
}

/**
 * Clamp a capture rect into the page viewport so the server's `parseRect` guard
 * (which REJECTS negative or out-of-bounds coords) never 400s a legitimate
 * selection. A hovered/locked element's rect — taken from the page's own
 * getBoundingClientRect — can legitimately start above/left of the viewport
 * (x/y < 0) or extend past it; clamping keeps x,y ≥ 0 with a positive size and
 * the far edge in bounds, screenshotting the visible region. (This was the cause
 * of "Capture failed (400)" when selecting an edge element from Explore.)
 */
export function clampRectToViewport(rect: CaptureRect, viewport: { width: number; height: number }): CaptureRect {
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)
  const left = Math.max(0, Math.min(rect.x, vw - 1))
  const top = Math.max(0, Math.min(rect.y, vh - 1))
  const right = Math.min(vw, Math.max(left + 1, rect.x + rect.width))
  const bottom = Math.min(vh, Math.max(top + 1, rect.y + rect.height))
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
}

/** Count populated (non-empty) facets of a captured DOM for the panel badge. */
export function domSummary(dom: CapturedDom): { nodeCount: number; htmlBytes: number; truncated: boolean; networkCount: number } {
  return {
    nodeCount: dom.nodes.length,
    htmlBytes: dom.html.length,
    truncated: dom.htmlTruncated,
    networkCount: dom.networkRequests?.length ?? 0,
  }
}
