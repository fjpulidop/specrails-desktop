// Pure rules for the Companion app preview: which local URLs a background
// process announces, how loopback origins are normalised, and which
// navigations a device-owned preview session may perform. No I/O here — the
// runtime feeds log lines and the announced-origin set in.

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// Host alternatives a dev server prints for "this machine". Bracketed IPv6
// forms are matched literally; the wildcard binds are rewritten to localhost.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s'"<>)\]`]*)?/gi
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

/** A loopback host as dev servers print it (wildcard binds included). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' ||
    host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * The comparable origin of `raw`, with every loopback spelling collapsed to
 * `localhost` (so `http://127.0.0.1:5173` and `http://[::1]:5173` match an
 * announced `http://localhost:5173`). Null for unparsable or non-http(s) URLs.
 */
export function previewOrigin(raw: string): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = isLoopbackHost(url.hostname) ? 'localhost' : url.hostname.toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//${host}:${port}`
}

/** Normalise an announced URL: loopback host → `localhost`, explicit path kept. */
function normalizeAnnouncedUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw.replace(TRAILING_PUNCTUATION, '')) } catch { return null }
  if (!isLoopbackHost(url.hostname)) return null
  const port = url.port ? Number(url.port) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  url.hostname = 'localhost'
  url.hash = ''
  return url.toString()
}

/**
 * Local URLs a log line announces (`➜  Local:   http://localhost:5173/`,
 * `ready on http://0.0.0.0:3000`), normalised and de-duplicated by origin in
 * order of appearance. URLs without an explicit port are ignored: a dev server
 * always prints one, while bare `http://localhost` mentions are usually docs.
 */
export function extractPreviewUrls(line: string): string[] {
  const text = line.replace(ANSI, '')
  const found: string[] = []
  const origins = new Set<string>()
  for (const match of text.matchAll(LOCAL_URL)) {
    const url = normalizeAnnouncedUrl(match[0])
    const origin = url && previewOrigin(url)
    if (!url || !origin || origins.has(origin)) continue
    origins.add(origin)
    found.push(url)
  }
  return found
}

/**
 * Latest-first, origin-unique targets from a process's log lines (oldest first).
 * A re-announced origin moves to the front with its newest URL.
 */
export function previewTargetsFromLines(lines: readonly string[]): string[] {
  const byOrigin = new Map<string, string>()
  for (const line of lines) {
    for (const url of extractPreviewUrls(line)) {
      const origin = previewOrigin(url)!
      byOrigin.delete(origin)
      byOrigin.set(origin, url)
    }
  }
  return [...byOrigin.values()].reverse()
}

/**
 * Drop announced URLs on Specrails' own loopback ports (Desktop API, mobile
 * gateway). Any process can print any URL, and the preview browser runs on
 * loopback, so an "announced" Desktop port would expose loopback-only routes.
 */
export function withoutReservedPorts(urls: readonly string[], reserved: ReadonlySet<number>): string[] {
  if (reserved.size === 0) return [...urls]
  return urls.filter((url) => {
    const origin = previewOrigin(url)
    return origin !== null && !reserved.has(Number(origin.slice(origin.lastIndexOf(':') + 1)))
  })
}

/**
 * Whether a device-owned preview session may load `url` (a navigation or a
 * subresource request). Announced origins of the project are allowed even
 * though they are loopback; everything else must pass the regular server-side
 * guard (`fallback`, i.e. `isNavigableUrl`), which rejects loopback/private
 * hosts and non-http(s) schemes.
 */
export function isPreviewRequestAllowed(
  url: string,
  announcedOrigins: ReadonlySet<string>,
  fallback: (url: string) => boolean,
): boolean {
  const origin = previewOrigin(url)
  if (origin && announcedOrigins.has(origin)) return true
  return fallback(url)
}

/**
 * Whether a device may *type* `url` (create or manual navigate). Stricter than
 * the request guard: only paths on announced origins, never an arbitrary
 * public URL — Desktop must not become a general browser proxy for the phone.
 */
export function isManualPreviewUrlAllowed(url: string, announcedOrigins: ReadonlySet<string>): boolean {
  const origin = previewOrigin(url)
  return origin !== null && announcedOrigins.has(origin)
}
