// SSRF guard for outbound webhook delivery (BUG-WEBHOOK-01, delivery-time half).
//
// `desktop-router` validates a webhook URL at registration time, but a host that
// resolved to a public address then can be DNS-rebound to a loopback/private
// address before the (long-lived) webhook fires. This module re-resolves the
// destination at DELIVERY time and blocks any host that resolves to an internal
// address — closing the TOCTOU window. It is a standalone module (not a re-use of
// desktop-router's private helpers) to avoid a circular import: desktop-router
// imports WebhookManager, so webhook-manager must not import desktop-router.

import dns from 'dns'
import net from 'net'

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  return false
}

/**
 * Canonicalize alternate IPv4 literal encodings (decimal `2130706433`,
 * octal `0177.0.0.1`, hex `0x7f.0.0.1` / `0x7f000001`) to a dotted quad so the
 * private-range check sees the real address. Returns null for anything that is
 * not an unambiguous IPv4 literal (e.g. a real DNS name).
 */
export function canonicalizeIpv4Literal(host: string): string | null {
  const u32ToDotted = (n: number): string =>
    `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/.test(host)) {
    let n: number
    if (host.startsWith('0x')) n = Number.parseInt(host.slice(2), 16)
    else if (host.startsWith('0') && host !== '0') n = Number.parseInt(host, 8)
    else n = Number.parseInt(host, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return u32ToDotted(n >>> 0)
  }
  if (/^[0-9a-fx.]+$/.test(host) && host.includes('.')) {
    const segs = host.split('.')
    if (segs.length !== 4) return null
    const nums: number[] = []
    for (const seg of segs) {
      if (seg === '') return null
      let v: number
      if (/^0x[0-9a-f]+$/.test(seg)) v = Number.parseInt(seg.slice(2), 16)
      else if (/^0[0-7]+$/.test(seg)) v = Number.parseInt(seg, 8)
      else if (/^[0-9]+$/.test(seg)) v = Number.parseInt(seg, 10)
      else return null
      if (!Number.isFinite(v) || v < 0 || v > 255) return null
      nums.push(v)
    }
    return nums.join('.')
  }
  return null
}

/** True when a hostname/IP literal points at a loopback/private/link-local target. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }
  const canon = canonicalizeIpv4Literal(host)
  if (canon) return isPrivateIpv4(canon)
  const version = net.isIP(host)
  if (version === 0) return false
  if (version === 6) return host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')
  return isPrivateIpv4(host)
}

type LookupFn = (hostname: string, opts: { all: true; verbatim: true }) => Promise<dns.LookupAddress[]>

/**
 * Re-resolve a webhook URL at delivery time and report whether it is safe to
 * POST to. Blocks any URL that resolves to a private/loopback/link-local address
 * (DNS-rebinding defence). Honours `SPECRAILS_ALLOW_LOCAL_WEBHOOKS=1` (dev opt-in)
 * and `lookup` is injectable for tests. An unresolvable host is treated as unsafe
 * (fail-closed) — unlike registration, a confirmed-bad delivery should not fire.
 */
export async function isUrlSafeForDelivery(
  rawUrl: string,
  lookup: LookupFn = (h, o) => dns.promises.lookup(h, o),
): Promise<boolean> {
  if (process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1') return true
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  // Literal / alternate-encoding IPs: decide synchronously.
  if (net.isIP(host) !== 0 || canonicalizeIpv4Literal(host.toLowerCase())) {
    return !isPrivateHost(host)
  }
  let addrs: dns.LookupAddress[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch {
    return false
  }
  if (addrs.length === 0) return false
  return !addrs.some((a) => isPrivateHost(a.address))
}
