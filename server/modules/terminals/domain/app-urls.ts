// Pure rules for the addresses a background process (a dev server) announces in
// its output: where it can be opened on this machine (`local`) and from another
// device on the same network (`network`). No I/O — the runtime feeds log lines
// and this machine's LAN addresses in.

export interface AppUrls {
  /** Loopback addresses, openable in this machine's browser. */
  local: string[]
  /** LAN / VPN addresses, openable from a phone on the same network. */
  network: string[]
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// Host (bracketed IPv6 or plain, port included), then an optional path.
const URL_IN_TEXT = /\bhttps?:\/\/(?:\[[0-9a-f:.]+\]|[^\s'"<>()[\]`/]+)(?::\d+)?(?:\/[^\s'"<>)\]`]*)?/gi
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const MAX_URLS = 4

type HostKind = 'local' | 'wildcard' | 'network' | 'other'

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every((octet) => octet <= 255) ? octets : null
}

/**
 * Whether `address` is reachable only from a private network: RFC 1918, or the
 * 100.64/10 shared range that Tailscale-style VPNs use. Public and link-local
 * addresses are excluded.
 */
export function isPrivateIPv4(address: string): boolean {
  const o = ipv4(address)
  if (!o) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127)
}

function hostKind(hostname: string): HostKind {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return 'local'
  if (host === '0.0.0.0' || host === '::') return 'wildcard'
  if (isPrivateIPv4(host) || host.endsWith('.local')) return 'network'
  return 'other'
}

/** Parse an announced URL; only explicit ports count (bare hosts are usually docs). */
function parseAnnounced(raw: string): URL | null {
  let url: URL
  try { url = new URL(raw.replace(TRAILING_PUNCTUATION, '')) } catch { return null }
  const port = Number(url.port)
  if (!url.port || !Number.isInteger(port) || port < 1 || port > 65535) return null
  url.hash = ''
  return url
}

/**
 * The app URLs announced by a process's log lines (oldest first). Each list is
 * latest-first and unique per origin, so a restarted server's new address wins.
 * A wildcard bind (`http://0.0.0.0:3000`) is reachable both locally and on every
 * LAN address of this machine.
 */
export function appUrlsFromLines(lines: readonly string[], lanAddresses: readonly string[]): AppUrls {
  const local = new Map<string, string>()
  const network = new Map<string, string>()
  const add = (into: Map<string, string>, url: URL) => {
    into.delete(url.origin)
    into.set(url.origin, url.toString())
  }
  for (const line of lines) {
    for (const match of line.replace(ANSI, '').matchAll(URL_IN_TEXT)) {
      const url = parseAnnounced(match[0])
      if (!url) continue
      const kind = hostKind(url.hostname)
      if (kind === 'local') {
        url.hostname = 'localhost'
        add(local, url)
      } else if (kind === 'network') {
        add(network, url)
      } else if (kind === 'wildcard') {
        url.hostname = 'localhost'
        add(local, url)
        for (const address of lanAddresses) {
          url.hostname = address
          add(network, url)
        }
      }
    }
  }
  const latest = (urls: Map<string, string>) => [...urls.values()].reverse().slice(0, MAX_URLS)
  return { local: latest(local), network: latest(network) }
}
