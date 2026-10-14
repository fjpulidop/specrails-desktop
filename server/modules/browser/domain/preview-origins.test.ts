import { describe, expect, it } from 'vitest'
import {
  extractPreviewUrls,
  isLoopbackHost,
  isManualPreviewUrlAllowed,
  isPreviewRequestAllowed,
  previewOrigin,
  previewTargetsFromLines,
} from './preview-origins'

describe('extractPreviewUrls', () => {
  it.each([
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    ['\u001b[32m  ➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m', 'http://localhost:5173/'],
    ['   - Local:        http://localhost:3000', 'http://localhost:3000/'],
    ['ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000', 'http://localhost:3000/'],
    ['  Local:            http://127.0.0.1:8080/app/', 'http://localhost:8080/app/'],
    ['┃ Local    http://localhost:4321/', 'http://localhost:4321/'],
    ['** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **', 'http://localhost:4200/'],
    ['Listening on http://[::1]:9000.', 'http://localhost:9000/'],
    ['Server running at https://localhost:8443/', 'https://localhost:8443/'],
  ])('detects %j', (line, expected) => {
    expect(extractPreviewUrls(line)).toEqual([expected])
  })

  it('ignores public hosts, LAN addresses and port-less mentions', () => {
    expect(extractPreviewUrls('  ➜  Network: http://192.168.1.20:5173/')).toEqual([])
    expect(extractPreviewUrls('see https://vitejs.dev/config and http://localhost for docs')).toEqual([])
    expect(extractPreviewUrls('npm WARN deprecated left-pad@1.0.0')).toEqual([])
  })

  it('keeps one URL per origin from a single line', () => {
    expect(extractPreviewUrls('http://localhost:3000 and http://127.0.0.1:3000/x and http://localhost:3001'))
      .toEqual(['http://localhost:3000/', 'http://localhost:3001/'])
  })

  it('rejects invalid ports', () => {
    expect(extractPreviewUrls('http://localhost:0/ http://localhost:70000/')).toEqual([])
  })
})

describe('previewTargetsFromLines', () => {
  it('lists the most recently announced origin first and refreshes re-announced URLs', () => {
    expect(previewTargetsFromLines([
      'Local: http://localhost:5173/',
      'api on http://localhost:8787',
      'restarted. Local: http://localhost:5173/admin',
    ])).toEqual(['http://localhost:5173/admin', 'http://localhost:8787/'])
  })
})

describe('origins', () => {
  it('collapses loopback spellings', () => {
    expect(previewOrigin('http://127.0.0.1:5173/a?b')).toBe('http://localhost:5173')
    expect(previewOrigin('http://[::1]:5173/')).toBe('http://localhost:5173')
    expect(previewOrigin('https://Example.com/')).toBe('https://example.com:443')
    expect(previewOrigin('file:///etc/passwd')).toBeNull()
    expect(previewOrigin('not a url')).toBeNull()
  })

  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('127.4.5.6')).toBe(true)
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
  })
})

describe('preview navigation policy', () => {
  const announced = new Set(['http://localhost:5173'])
  const guard = (url: string) => url.startsWith('https://')

  it('allows announced loopback origins and defers everything else to the guard', () => {
    expect(isPreviewRequestAllowed('http://localhost:5173/settings', announced, guard)).toBe(true)
    expect(isPreviewRequestAllowed('http://127.0.0.1:5173/@vite/client', announced, guard)).toBe(true)
    expect(isPreviewRequestAllowed('http://localhost:4200/', announced, guard)).toBe(false)
    expect(isPreviewRequestAllowed('https://accounts.example.com/oauth', announced, guard)).toBe(true)
    expect(isPreviewRequestAllowed('data:text/html,hi', announced, guard)).toBe(false)
  })

  it('accepts only announced origins for manual navigation', () => {
    expect(isManualPreviewUrlAllowed('http://localhost:5173/admin', announced)).toBe(true)
    expect(isManualPreviewUrlAllowed('https://example.com/', announced)).toBe(false)
    expect(isManualPreviewUrlAllowed('http://localhost:4200/', announced)).toBe(false)
    expect(isManualPreviewUrlAllowed('javascript:alert(1)', announced)).toBe(false)
  })
})
