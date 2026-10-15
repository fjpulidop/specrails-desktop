import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, addProject } from '../desktop-db'
import type { DbInstance } from '../db'
import { createAgentConversation } from '../modules/agents/runtime/agent-store'
import { createDevice, hashToken, setAllowedProjects, _resetAclColumnCacheForTests } from './mobile-devices'
import { BrowserLimitExceededError, BrowserNavigationRejectedError, type BrowserSessionOwner } from '../modules/browser/runtime/browser-capture-types'
import type { BrowserWsClient } from '../modules/browser/runtime/browser-capture-manager'
import { MobilePreviewService, createMobilePreviewRouter, type PreviewBrowser } from './mobile-preview'
import type { PreviewChannelLike } from './mobile-preview-channel'
import { createMobileMissionsRouter } from './mobile-missions'

class FakeChannel implements PreviewChannelLike {
  readyState = 'connecting'
  bufferedAmount = 0
  sent: Array<string | Buffer> = []
  closed = false
  private open: Array<() => void> = []
  private message: Array<(d: string | Buffer) => void> = []
  private close_: Array<() => void> = []
  constructor(readonly label: string) {}
  send(data: string | Buffer) { this.sent.push(data) }
  close() { if (this.closed) return; this.closed = true; this.readyState = 'closed'; this.close_.forEach((cb) => cb()) }
  onOpen(cb: () => void) { this.open.push(cb) }
  onMessage(cb: (d: string | Buffer) => void) { this.message.push(cb) }
  onClose(cb: () => void) { this.close_.push(cb) }
  emitOpen() { this.readyState = 'open'; this.open.forEach((cb) => cb()) }
  emitMessage(data: unknown) { this.message.forEach((cb) => cb(JSON.stringify(data))) }
}

function fakeBrowser() {
  const owners = new Map<string, BrowserSessionOwner>()
  let n = 0
  const browser = {
    owners,
    attached: [] as Array<{ id: string; client: BrowserWsClient }>,
    detached: [] as string[],
    inputs: [] as unknown[],
    navigations: [] as unknown[],
    killed: [] as string[],
    createError: null as Error | null,
    async create(opts: { initialUrl: string; owner: BrowserSessionOwner }) {
      if (browser.createError) throw browser.createError
      const id = `s${++n}`
      owners.set(id, opts.owner)
      return { id, projectId: 'p1', url: opts.initialUrl, title: null, viewportWidth: 390, viewportHeight: 844, createdAt: 0, owner: opts.owner }
    },
    sessionOwner: (id: string) => owners.get(id) ?? null,
    listSessions: () => [...owners].map(([id, owner]) => ({ id, projectId: 'p1', url: 'http://localhost:5173/', title: 'App', viewportWidth: 390, viewportHeight: 844, createdAt: Number(id.slice(1)) || 0, owner })),
    async attach(id: string, client: BrowserWsClient) {
      browser.attached.push({ id, client })
      return owners.has(id) ? { id } as never : null
    },
    detach: (id: string) => { browser.detached.push(id) },
    async handleInput(_id: string, event: unknown) { browser.inputs.push(event) },
    async navigateAsDevice(id: string, deviceId: string, action: string, url?: string) {
      browser.navigations.push({ id, deviceId, action, url })
      if (url?.includes('4200')) throw new BrowserNavigationRejectedError()
      return { url: url ?? 'http://localhost:5173/', title: 'App' }
    },
    async kill(id: string) { browser.killed.push(id); return owners.delete(id) },
    async killDeviceSessions(deviceId: string) {
      let k = 0
      for (const [id, o] of owners) if (o.kind === 'device' && o.deviceId === deviceId) { owners.delete(id); k++ }
      return k
    },
  }
  return browser
}

describe('Companion app preview gateway', () => {
  let db: DbInstance
  let app: express.Express
  let deviceId: string
  let cid: string
  let browser: ReturnType<typeof fakeBrowser>
  let channels: FakeChannel[]
  let peerConnected: boolean
  let enabled: boolean
  let service: MobilePreviewService
  let changes: number
  const targets = () => [{ processId: 'proc1', chatId: cid, urls: ['http://localhost:5173/'] }]

  beforeEach(() => {
    _resetAclColumnCacheForTests()
    db = initDesktopDb(':memory:')
    addProject(db, { id: 'p1', name: 'App', slug: 'preview-test', path: '/tmp/preview-no-project' })
    deviceId = createDevice(db, { name: 'Javi iPhone', platform: 'ios', tokenHash: hashToken('t'), certFingerprint: 'fp' }).id
    cid = createAgentConversation(db, { pinnedProjectId: 'p1' }).id
    browser = fakeBrowser()
    channels = []
    peerConnected = true
    enabled = true
    changes = 0
    service = new MobilePreviewService({
      onChange: () => { changes += 1 },
      enabled: () => enabled,
      browserFor: (pid) => pid === 'p1' ? browser as unknown as PreviewBrowser : null,
      allBrowsers: () => [browser as unknown as PreviewBrowser],
      targets: {
        list: () => targets(),
        forProcess: (_pid, processId) => targets().find((t) => t.processId === processId) ?? null,
      },
      openChannel: (_device, label) => {
        if (!peerConnected) return null
        const channel = new FakeChannel(label)
        channels.push(channel)
        return channel
      },
    })
    app = express(); app.use(express.json())
    app.use((req, _res, next) => { Object.assign(req, { mobileDevice: { id: deviceId, name: 'Javi iPhone' } }); next() })
    app.use('/v1', createMobileMissionsRouter({ db, upstream: vi.fn(), appPreview: () => service.available() }))
    app.use('/v1', createMobilePreviewRouter({ db, preview: service }))
  })
  afterEach(() => db.close())

  const open = (body: Record<string, unknown> = {}) => request(app).post('/v1/projects/p1/preview-sessions')
    .send({ missionId: cid, processId: 'proc1', url: 'http://localhost:5173/', viewport: { width: 390, height: 844, deviceScaleFactor: 3 }, ...body })

  it('advertises the capability only with browser capture and the mission grant', async () => {
    expect((await request(app).get('/v1/capabilities')).body.features.appPreview).toBe(true)
    enabled = false
    expect((await request(app).get('/v1/capabilities')).body.features.appPreview).toBe(false)
    enabled = true
    setAllowedProjects(db, deviceId, ['p1'])
    expect((await request(app).get('/v1/capabilities')).body.features.appPreview).toBe(false)
  })

  it('lists a mission’s targets without leaking other fields', async () => {
    const res = await request(app).get(`/v1/projects/p1/missions/${cid}/preview-targets`)
    expect(res.body).toEqual({ targets: [{ processId: 'proc1', urls: ['http://localhost:5173/'] }] })
    expect((await request(app).get('/v1/projects/p1/missions/unknown/preview-targets')).status).toBe(404)
  })

  it('rejects restricted devices and disabled Desktop', async () => {
    setAllowedProjects(db, deviceId, ['p1'])
    expect((await request(app).get(`/v1/projects/p1/missions/${cid}/preview-targets`)).status).toBe(403)
    expect((await open()).status).toBe(403)
    setAllowedProjects(db, deviceId, [])
    enabled = false
    expect((await open()).body.code).toBe('preview_unavailable')
  })

  it('opens a device-owned session and streams it once the channel opens', async () => {
    const res = await open()
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ sessionId: 's1', channel: 'preview:s1', url: 'http://localhost:5173/' })
    expect(browser.owners.get('s1')).toEqual({ kind: 'device', deviceId, deviceName: 'Javi iPhone' })
    expect(browser.attached).toHaveLength(0)
    channels[0].emitOpen()
    await vi.waitFor(() => expect(browser.attached.map((a) => a.id)).toEqual(['s1']))
  })

  it('only previews URLs the process announced', async () => {
    expect((await open({ url: 'http://localhost:4200/' })).body.code).toBe('preview_url_not_announced')
    expect((await open({ url: 'https://example.com/' })).body.code).toBe('preview_url_not_announced')
    expect((await open({ processId: 'gone' })).body.code).toBe('preview_target_gone')
    expect(browser.owners.size).toBe(0)
  })

  it('maps limit errors to a recoverable message', async () => {
    browser.createError = new BrowserLimitExceededError(2)
    const res = await open()
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('preview_limit')
  })

  it('kills the session when no WebRTC peer can carry it', async () => {
    peerConnected = false
    const res = await open()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('preview_requires_webrtc')
    expect(browser.killed).toEqual(['s1'])
  })

  it('forwards validated input and navigation from the channel', async () => {
    await open()
    const channel = channels[0]
    channel.emitOpen()
    channel.emitMessage({ type: 'input', event: { type: 'mouse', action: 'down', x: 5, y: 6, button: 'left' } })
    channel.emitMessage({ type: 'input', event: { type: 'mouse', action: 'down', x: -5, y: 6 } })
    channel.emitMessage({ type: 'navigate', action: 'goto', url: 'http://localhost:4200/' })
    await vi.waitFor(() => expect(channel.sent).toContain('{"type":"nav_rejected"}'))
    expect(browser.inputs).toEqual([{ type: 'mouse', action: 'down', x: 5, y: 6, button: 'left' }])
  })

  it('re-attaches on a new channel and closes the old one', async () => {
    await open()
    const first = channels[0]
    const res = await request(app).post('/v1/projects/p1/preview-sessions/s1/attach')
    expect(res.body).toEqual({ sessionId: 's1', channel: 'preview:s1' })
    expect(first.closed).toBe(true)
    expect(browser.detached).toEqual(['s1'])
    expect(channels).toHaveLength(2)
  })

  it('hides sessions owned by Desktop or another device', async () => {
    browser.owners.set('desk', { kind: 'desktop' })
    browser.owners.set('other', { kind: 'device', deviceId: 'someone-else', deviceName: 'X' })
    for (const sid of ['desk', 'other', 'missing']) {
      expect((await request(app).post(`/v1/projects/p1/preview-sessions/${sid}/attach`)).status).toBe(404)
      expect((await request(app).delete(`/v1/projects/p1/preview-sessions/${sid}`)).status).toBe(404)
      expect((await request(app).post(`/v1/projects/p1/preview-sessions/${sid}/navigate`).send({ action: 'reload' })).status).toBe(404)
    }
    expect(browser.killed).toEqual([])
  })

  it('navigates and closes the device’s own session', async () => {
    await open()
    const nav = await request(app).post('/v1/projects/p1/preview-sessions/s1/navigate').send({ action: 'goto', url: 'http://localhost:5173/admin' })
    expect(nav.body).toEqual({ url: 'http://localhost:5173/admin', title: 'App' })
    expect((await request(app).post('/v1/projects/p1/preview-sessions/s1/navigate').send({ action: 'goto', url: 'http://localhost:4200/' })).body.code).toBe('preview_url_not_announced')
    expect((await request(app).post('/v1/projects/p1/preview-sessions/s1/navigate').send({ action: 'eval' })).status).toBe(400)
    expect((await request(app).delete('/v1/projects/p1/preview-sessions/s1')).body).toEqual({ ok: true })
    expect(browser.killed).toEqual(['s1'])
    expect(channels[0].closed).toBe(true)
  })

  it('ends every preview of a revoked device', async () => {
    await open()
    await service.closeForDevice(deviceId)
    expect(browser.owners.size).toBe(0)
    expect(channels[0].closed).toBe(true)
  })

  it('lists device sessions for Desktop, ends them from Desktop and notifies each change', async () => {
    await open()
    expect(changes).toBe(1)
    browser.owners.set('desk', { kind: 'desktop' })
    expect(service.listDeviceSessions()).toEqual([
      { projectId: 'p1', sessionId: 's1', deviceId, deviceName: 'Javi iPhone', url: 'http://localhost:5173/', title: 'App', createdAt: 1 },
    ])
    expect(await service.endFromDesktop('p1', 'desk')).toBe(false)
    expect(await service.endFromDesktop('p1', 's1')).toBe(true)
    expect(channels[0].closed).toBe(true)
    expect(service.listDeviceSessions()).toEqual([])
    expect(changes).toBe(2)
    enabled = false
    expect(service.listDeviceSessions()).toEqual([])
  })
})
