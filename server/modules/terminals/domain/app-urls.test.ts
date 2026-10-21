import { describe, expect, it } from 'vitest'
import { appUrlsFromLines, isPrivateIPv4 } from './app-urls'

describe('appUrlsFromLines', () => {
  it('splits a Vite --host banner into local and network URLs', () => {
    const lines = [
      '  VITE v8.3.3  ready in 413 ms',
      '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m',
      '  ➜  Network: http://192.168.1.20:5173/',
      '  ➜  Network: http://100.101.1.2:5173/',
    ]
    expect(appUrlsFromLines(lines, [])).toEqual({
      local: ['http://localhost:5173/'],
      network: ['http://100.101.1.2:5173/', 'http://192.168.1.20:5173/'],
    })
  })

  it('has no network URL when the server only listens on this computer', () => {
    expect(appUrlsFromLines(['  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose'], ['192.168.1.20']))
      .toEqual({ local: ['http://localhost:5173/'], network: [] })
  })

  it('expands a wildcard bind to this machine\'s LAN addresses', () => {
    expect(appUrlsFromLines(['ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000'], ['192.168.1.20', '10.0.0.5']))
      .toEqual({ local: ['http://localhost:3000/'], network: ['http://10.0.0.5:3000/', 'http://192.168.1.20:3000/'] })
  })

  it('normalises loopback spellings and keeps the newest address per origin first', () => {
    const lines = ['Local: http://127.0.0.1:5173/', 'restart Local: http://[::1]:5173/admin', 'Local: http://localhost:5174/']
    expect(appUrlsFromLines(lines, []).local).toEqual(['http://localhost:5174/', 'http://localhost:5173/admin'])
  })

  it('ignores docs links, portless hosts, public addresses and invalid ports', () => {
    const lines = [
      'see https://vitejs.dev/config and http://localhost for docs',
      'cdn http://8.8.8.8:80/ and http://localhost:0/ and http://localhost:70000/',
    ]
    expect(appUrlsFromLines(lines, ['192.168.1.20'])).toEqual({ local: [], network: [] })
  })

  it('accepts mDNS hostnames as network addresses and trims trailing punctuation', () => {
    expect(appUrlsFromLines(['Listening on http://my-mac.local:8080.'], []).network).toEqual(['http://my-mac.local:8080/'])
  })
})

describe('isPrivateIPv4', () => {
  it('accepts RFC 1918 and the 100.64/10 VPN range only', () => {
    for (const ok of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '100.64.0.1', '100.127.255.255']) expect(isPrivateIPv4(ok)).toBe(true)
    for (const no of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '100.128.0.1', '127.0.0.1', 'localhost', '1.2.3']) expect(isPrivateIPv4(no)).toBe(false)
  })
})
