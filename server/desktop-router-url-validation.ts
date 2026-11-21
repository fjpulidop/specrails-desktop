/**
 * Registration-time URL validation for app-level settings and webhooks.
 *
 * Owns the loopback/private-address checks (including alternate IPv4
 * encodings and IPv4-mapped IPv6) and the DNS-rebinding gate used when a
 * webhook is created or edited. Delivery-time SSRF protection is separate
 * (`ssrf-guard.ts`).
 */
import net from 'net'
import dns from 'dns'

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
}

// BUG-WEBHOOK-01: alternate IPv4 encodings (decimal `2130706433`, octal
// `0177.0.0.1`, hex `0x7f.0.0.1` or a single `0x7f000001`) all resolve to the
// same address as `127.0.0.1` but evade the dotted-quad-only `isPrivateIpv4`.
// Canonicalize any whole-number / non-dotted-decimal form to a dotted quad so
// the private-range check sees the real address. Returns null when the input is
// not an unambiguous IPv4 literal (e.g. a real DNS name) so callers fall back to
// DNS resolution.
function canonicalizeIpv4Literal(host: string): string | null {
  const u32ToDotted = (n: number): string =>
    `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
  // Single integer form (decimal / 0x-hex / 0-octal): https://2130706433/
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/.test(host)) {
    let n: number
    if (host.startsWith('0x')) n = Number.parseInt(host.slice(2), 16)
    else if (host.startsWith('0') && host !== '0') n = Number.parseInt(host, 8)
    else n = Number.parseInt(host, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return u32ToDotted(n >>> 0)
  }
  // Dotted form where one or more octets are octal/hex: 0177.0.0.1 / 0x7f.0.0.1
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

function isPrivateIp(hostname: string): boolean {
  // Strip IPv6 brackets that URL.hostname can include (else net.isIP returns 0
  // and an IPv6 literal would slip through as "not an IP").
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // IPv4-mapped IPv6 — both the dotted-decimal embedding (`::ffff:127.0.0.1`)
  // and the hex embedding (`::ffff:7f00:1`) must be unwrapped to their v4 form.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isPrivateIpv4(v4)
  }
  // Alternate IPv4 encodings (decimal / octal / hex) → canonicalize then check.
  const canon = canonicalizeIpv4Literal(host)
  if (canon) return isPrivateIpv4(canon)
  const ipVersion = net.isIP(host)
  if (ipVersion === 0) return false
  if (ipVersion === 6) {
    return host === '::1' || host === '::' ||
      host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  }
  return isPrivateIpv4(host)
}

// BUG-WEBHOOK-01 (DNS-rebinding SSRF): `isPrivateIp` only inspects IP literals,
// so a public DNS name that resolves to a loopback/private/link-local address
// slips through. Resolve ALL addresses for the host and reject if ANY of them
// is private. Returns true ⇒ the host is safe to target; false ⇒ blocked.
// Tolerant of resolution failure: an unresolvable host can't be a confirmed
// SSRF target, so it is allowed through (delivery will simply fail).
export async function resolvesToPublicOnly(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '')
  // Literal IPs are already handled synchronously by isPrivateIp; skip lookup.
  if (net.isIP(host) !== 0 || canonicalizeIpv4Literal(host.toLowerCase())) return true
  let addrs: dns.LookupAddress[]
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    return true
  }
  return !addrs.some((a) => isPrivateIp(a.address))
}

export function validateHttpUrl(raw: string, opts: { allowLoopback: boolean; requireHttps: boolean }): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (opts.requireHttps && parsed.protocol !== 'https:') {
    if (!opts.allowLoopback || !isLoopbackHost(parsed.hostname)) return null
  }
  if (!opts.allowLoopback && (isLoopbackHost(parsed.hostname) || isPrivateIp(parsed.hostname))) return null
  return parsed.toString().replace(/\/$/, '')
}
