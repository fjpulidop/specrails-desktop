import path from 'path'
import { describe, expect, it } from 'vitest'
import { BrowseUsageError, DEFAULT_VIEWPORTS, leasedPorts, parseBrowseArgs, refusedUrl, runRoots, type UrlPolicy } from './browse-policy'

describe('parseBrowseArgs', () => {
  it('defaults to a desktop and a narrow viewport and keeps actions in order', () => {
    const options = parseBrowseArgs(['--url', 'file:///repo/index.html', '--wait', '#board', '--click', '#start', '--type', '#name=Ada', '--press', 'Space', '--eval', 'window.state', '--sleep', '250'])
    expect(options.viewports).toEqual(DEFAULT_VIEWPORTS)
    expect(options.actions).toEqual([
      { kind: 'wait', selector: '#board' }, { kind: 'click', selector: '#start' }, { kind: 'type', selector: '#name', text: 'Ada' },
      { kind: 'press', key: 'Space' }, { kind: 'eval', script: 'window.state' }, { kind: 'sleep', ms: 250 },
    ])
  })
  it('accepts --start without --url and explicit viewports', () => {
    expect(parseBrowseArgs(['--start', 'npm run dev', '--viewport', '390x844'])).toMatchObject({ url: null, start: 'npm run dev', viewports: [{ width: 390, height: 844 }] })
  })
  it('refuses unusable arguments with a message an agent can act on', () => {
    expect(() => parseBrowseArgs([])).toThrow(BrowseUsageError)
    expect(() => parseBrowseArgs(['--url', 'x', '--viewport', '10x10'])).toThrow(/WIDTHxHEIGHT/)
    expect(() => parseBrowseArgs(['--url', 'x', '--type', 'novalue'])).toThrow(/selector/)
    expect(() => parseBrowseArgs(['--url'])).toThrow(/needs a value/)
    expect(() => parseBrowseArgs(['--bogus'])).toThrow(/Unknown argument/)
    expect(parseBrowseArgs(['--help']).help).toBe(true)
  })
})

describe('refusedUrl', () => {
  const root = path.resolve('/runs/r1/ticket-1')
  const policy: UrlPolicy = { ports: leasedPorts({ PORT: '30100', SPECRAILS_RUN_PORT_RANGE_START: '30100', SPECRAILS_RUN_PORT_RANGE_END: '30109' }), roots: [root], realpath: file => file }
  it('opens loopback only on the run\'s own leased ports', () => {
    expect(refusedUrl('http://127.0.0.1:30100/', policy)).toBeNull()
    expect(refusedUrl('http://localhost:30109/game', policy)).toBeNull()
    // The Specrails server, another run's dev server, a default port: refused.
    expect(refusedUrl('http://127.0.0.1:4200/api/state', policy)).toMatch(/leased ports/)
    expect(refusedUrl('http://localhost:30110/', policy)).toMatch(/leased ports/)
    expect(refusedUrl('http://[::1]:3000/', policy)).toMatch(/leased ports/)
    expect(refusedUrl('http://127.0.0.1:30100/', { ...policy, ports: new Set() })).toMatch(/none in this environment/)
  })
  it('refuses private network hosts and odd schemes, allows public sites', () => {
    for (const url of ['http://192.168.1.10/', 'http://10.0.0.2:30100/', 'http://172.20.1.1/', 'http://169.254.169.254/latest', 'http://printer.local/']) expect(refusedUrl(url, policy), url).toMatch(/private/)
    expect(refusedUrl('ftp://example.com/', policy)).toMatch(/not allowed/)
    expect(refusedUrl('https://example.com/docs', policy)).toBeNull()
    expect(refusedUrl('data:text/html,hi', policy)).toBeNull()
  })
  it('opens files only inside the run\'s repositories, after resolving links', () => {
    expect(refusedUrl(`file://${root}/index.html`, policy)).toBeNull()
    expect(refusedUrl('file:///etc/hosts', policy)).toMatch(/outside/)
    expect(refusedUrl(`file://${root}/link.html`, { ...policy, realpath: () => '/etc/passwd' })).toMatch(/outside/)
  })
  it('reads the run roots from the cwd, the repo dir and the declared repositories', () => {
    expect(runRoots('/w', { SPECRAILS_REPO_DIR: '/repo', SPECRAILS_REPOSITORIES: JSON.stringify([{ id: 'a', path: '/a' }, { id: 'b' }]) })).toEqual(['/w', '/repo', '/a'])
    expect(runRoots('/w', { SPECRAILS_REPOSITORIES: 'not json' })).toEqual(['/w'])
  })
})
