import { describe, it, expect, afterEach } from 'vitest'
import { isUrlSafeForDelivery, isPrivateHost, canonicalizeIpv4Literal } from './ssrf-guard'

// Injected DNS resolver — tests never hit the network.
function fakeLookup(map: Record<string, string[]>) {
  return async (hostname: string) => {
    const addrs = map[hostname]
    if (!addrs) {
      const err: NodeJS.ErrnoException = new Error('ENOTFOUND')
      err.code = 'ENOTFOUND'
      throw err
    }
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

afterEach(() => {
  delete process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS
})

describe('canonicalizeIpv4Literal', () => {
  it('canonicalizes decimal / octal / hex IPv4 literals to dotted quads', () => {
    expect(canonicalizeIpv4Literal('2130706433')).toBe('127.0.0.1') // decimal
    expect(canonicalizeIpv4Literal('0x7f000001')).toBe('127.0.0.1') // single hex
    expect(canonicalizeIpv4Literal('0177.0.0.1')).toBe('127.0.0.1') // dotted octal
    expect(canonicalizeIpv4Literal('0x7f.0.0.1')).toBe('127.0.0.1') // dotted hex
  })
  it('returns null for real hostnames and out-of-range values', () => {
    expect(canonicalizeIpv4Literal('example.com')).toBeNull()
    expect(canonicalizeIpv4Literal('999.0.0.1')).toBeNull()
    expect(canonicalizeIpv4Literal('99999999999')).toBeNull()
  })
})

describe('isPrivateHost', () => {
  it('flags loopback / private / link-local literals', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1']) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })
  it('flags alternate IPv4 encodings + IPv4-mapped IPv6 (hex + dotted)', () => {
    expect(isPrivateHost('2130706433')).toBe(true) // decimal 127.0.0.1
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true) // hex-mapped 127.0.0.1
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true) // dotted-mapped
  })
  it('treats public IPs and unknown hostnames as non-private', () => {
    expect(isPrivateHost('93.184.216.34')).toBe(false)
    expect(isPrivateHost('example.com')).toBe(false) // a name is not itself a private literal
  })
})

describe('isUrlSafeForDelivery', () => {
  it('blocks literal private/loopback targets (incl. alternate encodings)', async () => {
    for (const url of ['http://127.0.0.1/x', 'https://10.0.0.5/x', 'http://169.254.169.254/latest', 'https://2130706433/x', 'https://[::ffff:7f00:1]/x']) {
      expect(await isUrlSafeForDelivery(url, fakeLookup({}))).toBe(false)
    }
  })
  it('allows a public IP literal', async () => {
    expect(await isUrlSafeForDelivery('https://93.184.216.34/x', fakeLookup({}))).toBe(true)
  })
  it('blocks a DNS name that resolves to a private address (DNS-rebinding)', async () => {
    const lookup = fakeLookup({ 'rebind.evil': ['203.0.113.5', '127.0.0.1'] })
    expect(await isUrlSafeForDelivery('https://rebind.evil/x', lookup)).toBe(false)
  })
  it('allows a DNS name that resolves only to public addresses', async () => {
    const lookup = fakeLookup({ 'safe.example': ['93.184.216.34'] })
    expect(await isUrlSafeForDelivery('https://safe.example/x', lookup)).toBe(true)
  })
  it('fails closed for an unresolvable host', async () => {
    expect(await isUrlSafeForDelivery('https://nx.invalid/x', fakeLookup({}))).toBe(false)
  })
  it('rejects non-http(s) and malformed URLs', async () => {
    expect(await isUrlSafeForDelivery('file:///etc/passwd', fakeLookup({}))).toBe(false)
    expect(await isUrlSafeForDelivery('not a url', fakeLookup({}))).toBe(false)
  })
  it('honours the SPECRAILS_ALLOW_LOCAL_WEBHOOKS dev opt-in', async () => {
    process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS = '1'
    expect(await isUrlSafeForDelivery('http://127.0.0.1/x', fakeLookup({}))).toBe(true)
  })
})
