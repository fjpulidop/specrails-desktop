import { describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { BrowserCaptureManager } from './browser-capture-manager'
import {
  BrowserLaunchError,
  BrowserLimitExceededError,
  BrowserNavigationRejectedError,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type BrowserSessionOwner,
  type ScreencastFrame,
} from './browser-capture-types'

// Minimal page fake: records navigations and exposes the installed request
// guard so tests can probe what a device-owned page would load.
class GuardPage implements BrowserPageHandle {
  url = 'about:blank'
  calls: string[] = []
  inputs: unknown[] = []
  guard: ((url: string) => boolean) | null = null
  closed = false
  popupCb: ((p: BrowserPageHandle) => void) | null = null
  setRequestGuard?: (allow: (url: string) => boolean) => Promise<void>
  constructor(withGuard = true) {
    if (withGuard) this.setRequestGuard = async (allow) => { this.guard = allow }
  }
  async goto(url: string) {
    this.calls.push(`goto:${url}`)
    if (this.guard && !this.guard(url)) throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    this.url = url
    return { url, title: 'T' }
  }
  async goBack() { return { url: this.url, title: 'T' } }
  async goForward() { return { url: this.url, title: 'T' } }
  async reload() { return { url: this.url, title: 'T' } }
  currentUrl() { return this.url }
  async currentTitle() { return 'T' }
  async setViewport() { /* noop */ }
  async dispatchInput(e: unknown) { this.inputs.push(e) }
  async startScreencast(_cb: (f: ScreencastFrame) => void) { /* noop */ }
  async stopScreencast() { /* noop */ }
  async screenshotClip() { return Buffer.from('') }
  async extractDom(): Promise<never> { throw new Error('unused') }
  async probeElementAt() { return null }
  onPopup(cb: (p: BrowserPageHandle) => void) { this.popupCb = cb }
  async close() { this.closed = true }
}

class Ctx implements BrowserContextHandle {
  pages: GuardPage[] = []
  constructor(private readonly withGuard = true) {}
  async newPage() { const p = new GuardPage(this.withGuard); this.pages.push(p); return p }
  async close() { /* noop */ }
}

const phone = (deviceId = 'dev-1'): BrowserSessionOwner => ({ kind: 'device', deviceId, deviceName: `Phone ${deviceId}` })

function setup(opts: { origins?: Set<string>; withGuard?: boolean } = {}) {
  const db = initDb(':memory:')
  const ctx = new Ctx(opts.withGuard ?? true)
  const origins = opts.origins ?? new Set(['http://localhost:5173'])
  const mgr = new BrowserCaptureManager({
    projectId: 'proj-1', projectSlug: 'proj', db, broadcast: vi.fn(), launcher: async () => ctx,
    profileDir: '/tmp/profile', previewOrigins: () => origins,
  })
  return { mgr, ctx, db, origins }
}

describe('BrowserCaptureManager device preview sessions', () => {
  it('opens an announced origin with an installed guard and the device owner', async () => {
    const { mgr, ctx } = setup()
    const meta = await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/', viewport: { width: 390, height: 844, deviceScaleFactor: 3 } })
    expect(meta.owner).toEqual(phone())
    const page = ctx.pages[0]
    expect(page.guard).not.toBeNull()
    expect(page.inputs[0]).toMatchObject({ type: 'resize' })
    await vi.waitFor(() => expect(page.calls).toContain('goto:http://localhost:5173/'))
  })

  it('rejects an unannounced or public initial URL without creating a page', async () => {
    const { mgr, ctx } = setup()
    await expect(mgr.create({ owner: phone(), initialUrl: 'http://localhost:4200/' })).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    await expect(mgr.create({ owner: phone(), initialUrl: 'https://example.com/' })).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    await expect(mgr.create({ owner: phone() })).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    expect(ctx.pages).toHaveLength(0)
  })

  it('guards documents and subresources: announced loopback and public pass, other loopback fails', async () => {
    const { mgr, ctx } = setup()
    await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })
    const allow = ctx.pages[0].guard!
    expect(allow('http://localhost:5173/src/main.tsx')).toBe(true)
    expect(allow('http://127.0.0.1:5173/@vite/client')).toBe(true)
    expect(allow('https://fonts.googleapis.com/css2')).toBe(true)
    expect(allow('http://localhost:4200/')).toBe(false)
    expect(allow('http://192.168.1.10:8080/')).toBe(false)
    expect(allow('file:///etc/hosts')).toBe(false)
  })

  it('stops allowing an origin once its process no longer announces it', async () => {
    let now = 0
    const db = initDb(':memory:')
    const ctx = new Ctx()
    const origins = new Set(['http://localhost:5173'])
    const mgr = new BrowserCaptureManager({ projectId: 'p', projectSlug: 'p', db, launcher: async () => ctx, profileDir: '/tmp/x', previewOrigins: () => origins, now: () => now })
    await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })
    const allow = ctx.pages[0].guard!
    expect(allow('http://localhost:5173/')).toBe(true)
    origins.clear()
    now += 2000
    expect(allow('http://localhost:5173/')).toBe(false)
    await mgr.shutdown()
  })

  it('fails closed when the page cannot install a request guard', async () => {
    const { mgr, ctx } = setup({ withGuard: false })
    await expect(mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })).rejects.toBeInstanceOf(BrowserLaunchError)
    expect(ctx.pages[0].closed).toBe(true)
    expect(mgr.sessionCount()).toBe(0)
  })

  it('keeps the regular desktop guard unchanged (no request guard on desktop pages)', async () => {
    const { mgr, ctx } = setup()
    await mgr.create({ initialUrl: 'https://example.com/' })
    expect(ctx.pages[0].guard).toBeNull()
  })

  it('does not count device sessions against the desktop budget', async () => {
    const { mgr } = setup()
    for (let i = 0; i < 4; i++) await mgr.create({ initialUrl: 'https://example.com/' })
    await expect(mgr.create({ initialUrl: 'https://example.com/' })).rejects.toBeInstanceOf(BrowserLimitExceededError)
    const meta = await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })
    expect(meta.owner.kind).toBe('device')
  })

  it('replaces the previous session of the same device and caps devices per project', async () => {
    const { mgr } = setup()
    const first = await mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:5173/' })
    const second = await mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:5173/admin' })
    expect(mgr.getSession(first.id)).toBeUndefined()
    expect(mgr.sessionOwner(second.id)).toEqual(phone('a'))
    await mgr.create({ owner: phone('b'), initialUrl: 'http://localhost:5173/' })
    await expect(mgr.create({ owner: phone('c'), initialUrl: 'http://localhost:5173/' })).rejects.toMatchObject({ limit: 2 })
  })

  it('keeps the current preview when a replacement request is rejected', async () => {
    const { mgr } = setup()
    const first = await mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:5173/' })
    await expect(mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:9999/' })).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    expect(mgr.getSession(first.id)).toBeDefined()
  })

  it('restricts manual navigation to the owner and to announced origins', async () => {
    const { mgr, ctx } = setup()
    const meta = await mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:5173/' })
    expect(await mgr.navigateAsDevice(meta.id, 'other', 'reload')).toBeNull()
    await expect(mgr.navigateAsDevice(meta.id, 'a', 'goto', 'https://example.com/')).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    await expect(mgr.navigateAsDevice(meta.id, 'a', 'goto', 'http://localhost:4200/')).rejects.toBeInstanceOf(BrowserNavigationRejectedError)
    await expect(mgr.navigateAsDevice(meta.id, 'a', 'goto', 'http://localhost:5173/settings')).resolves.toMatchObject({ url: 'http://localhost:5173/settings' })
    expect(ctx.pages[0].calls).toContain('goto:http://localhost:5173/settings')
    const desktop = await mgr.create({ initialUrl: 'https://example.com/' })
    expect(await mgr.navigateAsDevice(desktop.id, 'a', 'reload')).toBeNull()
  })

  it('never stores a device URL as the Desktop last URL', async () => {
    const { mgr } = setup()
    const meta = await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })
    await mgr.navigateAsDevice(meta.id, 'dev-1', 'goto', 'http://localhost:5173/x')
    expect(mgr.getLastUrl()).toBeNull()
  })

  it('guards popups of a device page and closes one opened on a forbidden URL', async () => {
    const { mgr, ctx } = setup()
    await mgr.create({ owner: phone(), initialUrl: 'http://localhost:5173/' })
    const root = ctx.pages[0]
    const ok = new GuardPage()
    ok.url = 'https://accounts.example.com/login'
    root.popupCb!(ok)
    await vi.waitFor(() => expect(ok.guard).not.toBeNull())
    expect(ok.closed).toBe(false)
    const bad = new GuardPage()
    bad.url = 'http://localhost:4200/'
    root.popupCb!(bad)
    await vi.waitFor(() => expect(bad.closed).toBe(true))
  })

  it('kills only the sessions of a revoked device', async () => {
    const { mgr } = setup()
    const a = await mgr.create({ owner: phone('a'), initialUrl: 'http://localhost:5173/' })
    const b = await mgr.create({ owner: phone('b'), initialUrl: 'http://localhost:5173/' })
    const desk = await mgr.create({ initialUrl: 'https://example.com/' })
    expect(await mgr.killDeviceSessions('a')).toBe(1)
    expect(mgr.getSession(a.id)).toBeUndefined()
    expect(mgr.getSession(b.id)).toBeDefined()
    expect(mgr.getSession(desk.id)).toBeDefined()
  })
})
