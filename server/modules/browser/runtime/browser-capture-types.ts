// Shared types for the browser-capture feature ("Add Spec from browser").
//
// The manager (`browser-capture-manager.ts`) depends only on these types plus an
// injected `ContextLauncher`, so it is fully unit-testable with a fake launcher —
// no real Chromium. The real Playwright/CDP implementation lives in
// `browser-playwright.ts` and is the ONLY module that imports `playwright`.

/** Public, serialisable session metadata returned over REST. */
export interface BrowserSessionMeta {
  id: string
  projectId: string
  url: string | null
  title: string | null
  viewportWidth: number
  viewportHeight: number
  createdAt: number
}

/** A selection rectangle in CSS pixels relative to the page viewport. */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/** One DOM element inside (or intersecting) the selection rectangle. */
export interface CapturedNode {
  /** Lowercase tag name, e.g. "button". */
  tag: string
  /** Resolved ARIA role (explicit role attr or implicit by tag), else null. */
  role: string | null
  /** Trimmed, length-capped text content, else null. */
  text: string | null
  /** Bounding box in CSS px relative to the viewport. */
  rect: CaptureRect
  /** Selected attributes (id, class, name, href, src, aria-*, data-*). */
  attributes: Record<string, string>
  /** A small set of computed styles relevant to layout/typography/colour. */
  styles: Record<string, string>
}

/** A digest of computed design tokens for a single element. Values are raw
 *  computed-style strings (e.g. "16px", "rgb(59, 130, 246)"); empty/default
 *  values (transparent colour, 0px spacing, no border, "normal" line-height) are
 *  omitted so the digest stays small. */
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

/** Exact design tokens derived from the selection's computed styles so a
 *  "clone this UI" spec carries precise values instead of guesses. A
 *  deterministic byproduct of the styles already collected — no extra CDP work. */
export interface CapturedDesignTokens {
  /** Schema version of this digest, for forward-compatible parsing. */
  contractVersion: number
  /** Tokens of the container/anchor element covering the selection. */
  anchor: TokenSet
  /** Deduped tokens for the most frequent tags inside the selection (cap ~8). */
  byTag: Record<string, TokenSet>
  /** Deduped non-transparent colours (text + background), cap ~12. */
  palette: string[]
  /** Deduped font-family stacks used inside the selection (cap ~6). */
  fonts: string[]
}

/** One XHR/fetch (or document) request the page made around capture time. Bodies
 *  are NEVER stored raw — only a structural shape sketch (key names), so captured
 *  pages can't leak tokens/PII into a ticket. */
export interface CapturedNetworkRequest {
  method: string
  url: string
  status: number | null
  /** CDP resource type (e.g. "Fetch", "XHR", "Document"). */
  resourceType: string
  mimeType: string | null
  /** Sketch of the request body shape (JSON key names), never raw values. */
  requestBodyShape?: string | null
  /** Sketch of the response JSON shape (top-level keys / array element keys). */
  responseShape?: string | null
  durationMs: number | null
  /** Wall-clock ms when the request started (for windowed capture). */
  startedAt: number
  failed?: boolean
  errorText?: string
}

/** The rich DOM payload captured for a selection. Serialised to JSON and stored
 *  as an attachment (mime application/json) so it flows through the existing
 *  attachment → prompt pipeline for both Quick and Explore. */
export interface CapturedDom {
  url: string
  title: string
  viewport: { width: number; height: number }
  rect: CaptureRect
  /** Pretty-ish outerHTML of the smallest element covering the selection. */
  html: string
  /** True when `html` was truncated at the size cap. */
  htmlTruncated: boolean
  /** CSS rules actually applied to the selected elements (+ :root design tokens). */
  css: string
  /** True when `css` was truncated at the size cap. */
  cssTruncated: boolean
  nodes: CapturedNode[]
  /** Exact computed design tokens for the selection. Optional — absent on
   *  captures taken before this feature, so old serialised JSON still parses. */
  designTokens?: CapturedDesignTokens
  /** XHR/fetch requests the page made around capture time. Optional — absent on
   *  old captures or when network capture is disabled for the spec. */
  networkRequests?: CapturedNetworkRequest[]
  capturedAt: string
}

/** Pointer / wheel / key input forwarded from the client canvas to the page. */
export type BrowserInputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'resize'; width: number; height: number; deviceScaleFactor?: number }

/** A screencast frame emitted by the page handle. `data` is raw JPEG bytes. */
export interface ScreencastFrame {
  data: Buffer
  width: number
  height: number
}

/** One node in the hovered element's ancestor breadcrumb. */
export interface BreadcrumbSegment {
  /** Short human label, e.g. "div.container" or "button#cta". */
  label: string
  /** Stable-ish CSS selector to re-resolve this node (for up/down navigation). */
  selector: string
}

/** The element under a point (or re-resolved by selector), for hover-to-select
 *  highlighting + DevTools-style breadcrumb navigation. */
export interface ElementProbe {
  rect: CaptureRect
  tag: string
  /** Selector for the probed element (used to step to parent/child). */
  selector: string
  /** Ancestor chain root→element (inclusive), capped for readability. */
  path: BreadcrumbSegment[]
}

/** Minimal page abstraction the manager drives. Implemented for real over CDP in
 *  `browser-playwright.ts`; faked in tests. */
export interface BrowserPageHandle {
  goto(url: string): Promise<{ url: string; title: string }>
  goBack(): Promise<{ url: string; title: string }>
  goForward(): Promise<{ url: string; title: string }>
  reload(): Promise<{ url: string; title: string }>
  currentUrl(): string
  currentTitle(): Promise<string>
  setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void>
  dispatchInput(event: BrowserInputEvent): Promise<void>
  /** Begin streaming JPEG frames; the handle auto-acks. */
  startScreencast(onFrame: (frame: ScreencastFrame) => void): Promise<void>
  stopScreencast(): Promise<void>
  /** PNG buffer of the clipped region. */
  screenshotClip(rect: CaptureRect): Promise<Buffer>
  /** Rich DOM extraction for the selection rectangle. */
  extractDom(rect: CaptureRect, htmlByteCap: number): Promise<CapturedDom>
  /** The element at a viewport point (for hover-to-select highlighting). */
  probeElementAt(point: { x: number; y: number }): Promise<ElementProbe | null>
  /** Re-resolve an element by selector and optionally step to its parent/child,
   *  for breadcrumb navigation. Optional — unimplemented handles can't navigate. */
  navigateElement?(selector: string, direction: 'parent' | 'child' | 'self'): Promise<ElementProbe | null>
  /** Begin capturing the page's network requests (best-effort, idempotent).
   *  Optional — a handle that doesn't implement it simply captures no network. */
  enableNetwork?(): Promise<void>
  /** Buffered network requests that started at/after `sinceMs` (newest-first,
   *  capped). Optional — returns nothing when unimplemented. */
  recentNetwork?(sinceMs: number): CapturedNetworkRequest[]
  // ─── Multi-breakpoint capture (optional) ──────────────────────────────────
  /** Build a stable-ish CSS selector for the element at a viewport point. */
  resolveAnchorSelector?(point: { x: number; y: number }): Promise<string | null>
  /** Current bounding box of the element matching `selector`, or null. */
  resolveAnchorRect?(selector: string): Promise<CaptureRect | null>
  /** Wait for layout to settle after a viewport change (best-effort). */
  waitForStable?(): Promise<void>
  // ─── Clipboard bridge (optional) ──────────────────────────────────────────
  /** The page's current selection text (for copy/cut). */
  getSelectionText?(): Promise<string>
  /** Insert text at the focused element's caret (for paste). */
  insertText?(text: string): Promise<void>
  /** Delete the current selection (for cut). */
  deleteSelection?(): Promise<void>
  // ─── Popup support (optional) ─────────────────────────────────────────────
  /** Fires when this page opens a popup (window.open / target=_blank / OAuth
   *  login windows). The popup shares the browser context natively — cookies +
   *  the opener/postMessage relationship survive, which is what completes an
   *  OAuth flow. Optional — handles without it simply never surface popups. */
  onPopup?(cb: (popup: BrowserPageHandle) => void): void
  /** Fires when the page is closed by the page itself (window.close — the
   *  typical OAuth popup self-close) or externally. */
  onClose?(cb: () => void): void
  /** Fires when the page's main frame navigates (link clicks, redirects). */
  onNavigated?(cb: (url: string) => void): void
  close(): Promise<void>
}

export interface BrowserContextHandle {
  newPage(): Promise<BrowserPageHandle>
  close(): Promise<void>
  /** False once the underlying browser/context has died (crash, OOM, killed). The
   *  shared-context pool uses this to drop a dead handle and re-launch instead of
   *  handing out a corpse forever. Optional: handles that don't implement it are
   *  treated as always-alive. */
  isConnected?(): boolean
}

export interface LaunchContextOptions {
  userDataDir: string
  executablePath?: string
  viewport: { width: number; height: number }
}

export type ContextLauncher = (opts: LaunchContextOptions) => Promise<BrowserContextHandle>

/**
 * App-wide provider of ONE shared persistent Chromium context (global profile =
 * shared cookies/logins across every project). Per-project capture managers
 * `acquire()` this handle and open their own pages in it; they never close it —
 * only the pool's owner (the registry, at app shutdown) does.
 */
export interface SharedBrowserContext {
  acquire(): Promise<BrowserContextHandle>
}

// ─── Error classes (mirror terminal-manager's typed errors) ───────────────────

export class BrowserLimitExceededError extends Error {
  readonly limit: number
  constructor(limit: number) {
    super('browser_session_limit_exceeded')
    this.name = 'BrowserLimitExceededError'
    this.limit = limit
  }
}

export class BrowserLaunchError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'BrowserLaunchError'
    this.cause = cause
  }
}
