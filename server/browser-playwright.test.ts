import { describe, it, expect, afterEach, vi } from 'vitest'
import { isNavigableUrl, normalizeUrl, chromiumLaunchArgs } from './browser-playwright'

// Pure-helper tests for the navigation SSRF/scheme guard (BUG-BROWSER-01) and the
// platform-gated sandbox args (BUG-BROWSER-04). The Playwright/CDP wiring itself
// needs a live Chromium and is excluded from coverage (see vitest.config.ts), but
// these exported helpers are deterministic and fully unit-testable.

describe('isNavigableUrl', () => {
  it('allows plain http(s) hosts', () => {
    expect(isNavigableUrl('https://example.com')).toBe(true)
    expect(isNavigableUrl('http://example.com/path?q=1')).toBe(true)
    expect(isNavigableUrl('https://sub.example.co.uk:8443/x')).toBe(true)
  })

  it('allows about:blank but no other about: target', () => {
    expect(isNavigableUrl('about:blank')).toBe(true)
    expect(isNavigableUrl('about:config')).toBe(false)
  })

  it('rejects the file:// scheme (regression: file:///etc/passwd)', () => {
    expect(isNavigableUrl('file:///etc/passwd')).toBe(false)
    expect(isNavigableUrl('FILE:///etc/passwd')).toBe(false)
  })

  it('rejects non-http(s) schemes', () => {
    expect(isNavigableUrl('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false)
    expect(isNavigableUrl('chrome://settings')).toBe(false)
    expect(isNavigableUrl('ftp://example.com/x')).toBe(false)
  })

  it('blocks loopback hosts', () => {
    expect(isNavigableUrl('http://localhost/x')).toBe(false)
    expect(isNavigableUrl('http://app.localhost/x')).toBe(false)
    expect(isNavigableUrl('http://127.0.0.1/x')).toBe(false)
    expect(isNavigableUrl('http://127.5.6.7:9000/x')).toBe(false)
    expect(isNavigableUrl('http://[::1]/x')).toBe(false)
  })

  it('blocks link-local 169.254.0.0/16 (cloud metadata)', () => {
    expect(isNavigableUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isNavigableUrl('http://169.254.0.1/x')).toBe(false)
  })

  it('blocks RFC1918 private ranges', () => {
    expect(isNavigableUrl('http://10.0.0.5/x')).toBe(false)
    expect(isNavigableUrl('http://172.16.0.1/x')).toBe(false)
    expect(isNavigableUrl('http://172.31.255.255/x')).toBe(false)
    expect(isNavigableUrl('http://192.168.1.1/x')).toBe(false)
    expect(isNavigableUrl('http://0.0.0.0/x')).toBe(false)
  })

  it('does NOT block a public IP that merely starts with private-looking octets', () => {
    expect(isNavigableUrl('http://172.32.0.1/x')).toBe(true) // 172.32 is public
    expect(isNavigableUrl('http://11.0.0.1/x')).toBe(true) // 11.x is public
  })

  it('blocks IPv6 unique-local and link-local', () => {
    expect(isNavigableUrl('http://[fc00::1]/x')).toBe(false)
    expect(isNavigableUrl('http://[fd12:3456::1]/x')).toBe(false)
    expect(isNavigableUrl('http://[fe80::1]/x')).toBe(false)
  })

  it('blocks IPv4-mapped IPv6 loopback/private', () => {
    expect(isNavigableUrl('http://[::ffff:127.0.0.1]/x')).toBe(false)
    expect(isNavigableUrl('http://[::ffff:10.0.0.1]/x')).toBe(false)
  })

  it('rejects empty / garbage input', () => {
    expect(isNavigableUrl('')).toBe(false)
    expect(isNavigableUrl('   ')).toBe(false)
    expect(isNavigableUrl('not a url')).toBe(false)
    // @ts-expect-error — exercising the runtime null guard
    expect(isNavigableUrl(null)).toBe(false)
  })
})

describe('normalizeUrl', () => {
  it('upgrades a bare host to https', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
  })

  it('returns about:blank for empty input', () => {
    expect(normalizeUrl('')).toBe('about:blank')
    expect(normalizeUrl('   ')).toBe('about:blank')
  })

  it('passes through a valid http(s) URL untouched', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  it('collapses a blocked URL to about:blank instead of forwarding it to Chromium', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBe('about:blank')
    expect(normalizeUrl('http://169.254.169.254/latest/')).toBe('about:blank')
    expect(normalizeUrl('http://127.0.0.1:9000/admin')).toBe('about:blank')
    expect(normalizeUrl('javascript:alert(1)')).toBe('about:blank')
  })

  it('still allows about:blank passthrough', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
})

describe('chromiumLaunchArgs (BUG-BROWSER-04)', () => {
  const original = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original })
    vi.restoreAllMocks()
  })

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p })
  }

  it('keeps the sandbox enabled on macOS (no --no-sandbox)', () => {
    setPlatform('darwin')
    const args = chromiumLaunchArgs()
    expect(args).not.toContain('--no-sandbox')
    expect(args).toContain('--disable-dev-shm-usage')
  })

  it('keeps the sandbox enabled on Windows (no --no-sandbox)', () => {
    setPlatform('win32')
    expect(chromiumLaunchArgs()).not.toContain('--no-sandbox')
  })

  it('falls back to --no-sandbox on Linux only', () => {
    setPlatform('linux')
    expect(chromiumLaunchArgs()).toContain('--no-sandbox')
  })
})
