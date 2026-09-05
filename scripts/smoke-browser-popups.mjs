// Real Chromium + the production session manager; two generated HTTP origins
// resolve only to a temporary loopback server. No external requests, user
// profiles, credentials or DBs.
// Run: node scripts/smoke-browser-popups.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(path.join(os.tmpdir(), 'specrails-browser-popups-'))
let appOrigin, idpOrigin
const report = []
let browser, manager, server

async function until(predicate, label, timeout = 5000) {
  const expires = Date.now() + timeout
  while (Date.now() < expires) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${label}`)
}

function socket() {
  return {
    readyState: 1, bufferedAmount: 0, messages: [], frames: 0, closed: false,
    send(data) { if (Buffer.isBuffer(data)) this.frames++; else this.messages.push(JSON.parse(data)) },
    close(code, reason) { this.closed = true; this.reason = { code, reason } },
  }
}

function document(body, script = '') {
  return `<!doctype html><meta charset="utf-8"><style>body{font:20px system-ui}button,input{font:inherit;padding:16px;margin:12px}</style>${body}<script>${script}</script>`
}

try {
  const bundle = path.join(temp, 'browser-popups.cjs')
  await build({
    stdin: { contents: `export { PlaywrightPageHandle, chromiumLaunchArgs } from './server/browser-playwright'; export { BrowserCaptureManager } from './server/browser-capture-manager';`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent',
    plugins: [{ name: 'local-dependencies', setup(build) {
      build.onResolve({ filter: /^[^./]|^@/ }, ({ path: name }) => ({ path: require.resolve(name), external: true }))
    } }],
  })
  const { PlaywrightPageHandle, chromiumLaunchArgs, BrowserCaptureManager } = require(bundle)
  server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (![appOrigin, idpOrigin].includes(url.origin)) { response.writeHead(403).end(); return }
    let html
    const headers = { 'content-type': 'text/html' }
    if (url.pathname === '/app') {
      html = document('<h1>Fixture application</h1><button id="login">Sign in</button><button id="fast">Already signed in</button><div id="result">signed out</div><iframe id="widget" src="' + idpOrigin + '/widget"></iframe>', `
        window.received = [];
        addEventListener('message', event => { if(event.origin === location.origin && event.data === 'authenticated') { received.push(event.data); document.querySelector('#result').textContent = 'signed in'; } });
        document.querySelector('#login').onclick = () => { const child = window.open('about:blank', 'login'); setTimeout(() => child.location = '${idpOrigin}/authorize', 30); };
        document.querySelector('#fast').onclick = () => window.open('${appOrigin}/callback', '_blank');
      `)
    } else if (url.pathname === '/widget') {
      html = document('<button id="iframe-login">Widget sign in</button>', `document.querySelector('button').onclick = () => window.open('${idpOrigin}/authorize', '_blank');`)
    } else if (url.pathname === '/authorize') {
      response.writeHead(302, { location: idpOrigin + '/login' }).end()
      return
    } else if (url.pathname === '/login') {
      html = document('<h1>Fixture identity provider</h1><input id="account"><button id="approve">Approve</button><button id="chain">Second factor</button>', `
        document.querySelector('#approve').onclick = () => location = '${appOrigin}/callback';
        document.querySelector('#chain').onclick = () => window.open('${idpOrigin}/factor', '_blank');
      `)
    } else if (url.pathname === '/factor') {
      html = document('<h1>Second factor</h1><button id="close">Confirm factor</button>', `document.querySelector('button').onclick = () => { opener.postMessage('factor-ok', '${idpOrigin}'); window.close(); };`)
    } else if (url.pathname === '/callback') {
      headers['set-cookie'] = 'fixture_session=authenticated; Path=/; SameSite=Lax'
      html = document('<h1>Returning to application</h1>', `if (opener) opener.postMessage('authenticated', '${appOrigin}'); window.close();`)
    } else { response.writeHead(404).end(); return }
    response.writeHead(200, headers).end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  appOrigin = `http://app.specrails-fixture.test:${server.address().port}`
  idpOrigin = `http://idp.specrails-fixture.test:${server.address().port}`
  browser = await chromium.launch({ headless: true, args: [...chromiumLaunchArgs(), '--no-proxy-server', '--host-resolver-rules=MAP app.specrails-fixture.test 127.0.0.1, MAP idp.specrails-fixture.test 127.0.0.1, MAP * ~NOTFOUND'], executablePath: process.env.SPECRAILS_SMOKE_CHROMIUM ?? chromium.executablePath() })
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  await context.route('**/*', (route) => [appOrigin, idpOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  const roots = []
  const values = new Map()
  manager = new BrowserCaptureManager({
    projectId: 'fixture', projectSlug: 'fixture', homeDir: temp,
    db: { prepare: () => ({ get: (key) => values.has(key) ? { value: values.get(key) } : undefined, run: (key, value) => values.set(key, value) }) },
    launcher: async () => ({ newPage: async () => { const page = await context.newPage(); roots.push(page); return new PlaywrightPageHandle(page) }, close: () => context.close() }),
  })
  const session = await manager.create({ initialUrl: appOrigin + '/app' })
  const ws = socket()
  await manager.attach(session.id, ws)
  const page = roots[0]
  await page.locator('#login').waitFor()
  await until(() => ws.frames > 0, 'initial frame')
  const initialPages = context.pages().length

  await page.click('#login')
  await until(() => manager.getSession(session.id).popups.length === 1, 'blank popup adoption')
  const login = context.pages().find((candidate) => candidate !== page)
  await login.waitForURL(idpOrigin + '/login')
  await until(() => ws.messages.some((message) => message.type === 'popup' && message.url === idpOrigin + '/login'), 'redirect URL broadcast')
  await page.evaluate(() => { window.fixtureState = 'preserve opener state' })
  for (const [action, url, expectedUrl] of [
    ['goto', idpOrigin + '/login?step=2', idpOrigin + '/login?step=2'],
    ['back', undefined, idpOrigin + '/login'],
    ['forward', undefined, idpOrigin + '/login?step=2'],
    ['reload', undefined, idpOrigin + '/login?step=2'],
  ]) {
    const navigation = await manager.navigate(session.id, action, url)
    assert.equal(navigation.target, 'popup')
    assert.equal(navigation.url, expectedUrl)
    assert.equal(login.url(), expectedUrl)
    assert.equal(page.url(), appOrigin + '/app')
    assert.equal(await page.evaluate(() => window.fixtureState), 'preserve opener state', `${action} must not reload the opener`)
    assert.equal(manager.getLastUrl(), appOrigin + '/app')
  }
  report.push('goto/back/forward/reload operate the login window and preserve opener URL/state')
  await login.focus('#account')
  await manager.clipboard(session.id, 'paste', 'fixture-user')
  assert.equal(await login.inputValue('#account'), 'fixture-user')
  assert.equal(await login.evaluate(() => !!opener), true)
  await login.click('#approve')
  await until(() => manager.getSession(session.id).popups.length === 0, 'OAuth self-close')
  await page.waitForFunction(() => received.includes('authenticated'))
  assert.match(await page.evaluate(() => document.cookie), /fixture_session=authenticated/)
  await until(() => manager.getSession(session.id).screencastPage === manager.getSession(session.id).page, 'return to opener stream')
  assert.equal(ws.closed, false)
  report.push('blank popup → cross-origin redirects → input → cookie/postMessage → self-close → opener stream')

  await page.frameLocator('#widget').locator('#iframe-login').click()
  await until(() => manager.getSession(session.id).popups.length === 1, 'cross-origin iframe popup')
  const iframePopup = context.pages().find((candidate) => candidate !== page)
  await iframePopup.waitForURL(idpOrigin + '/login')
  await iframePopup.click('#chain')
  await until(() => manager.getSession(session.id).popups.length === 2, 'nested second-factor window')
  const factor = context.pages().find((candidate) => candidate !== page && candidate !== iframePopup)
  await factor.locator('#close').click()
  await until(() => manager.getSession(session.id).popups.length === 1, 'return to login after factor')
  await iframePopup.close()
  await until(() => manager.getSession(session.id).popups.length === 0, 'return to app after widget close')
  report.push('cross-origin iframe login and nested factor windows retain their opener stack')

  for (let index = 0; index < 15; index++) {
    const prior = await page.evaluate(() => received.length)
    await page.click('#fast')
    await page.waitForFunction((count) => received.length > count, prior)
    await until(() => manager.getSession(session.id).popups.length === 0 && context.pages().length === initialPages, 'instant callback cleanup')
    await until(() => manager.getSession(session.id).screencastPage === manager.getSession(session.id).page, 'instant callback stream recovery')
    assert.equal(ws.closed, false, `instant callback ${index} must not disconnect the stream`)
  }
  report.push('15 immediate OAuth callback/close cycles keep the session connected')

  const other = await manager.create({ initialUrl: appOrigin + '/app' })
  const otherWs = socket()
  await manager.attach(other.id, otherWs)
  await roots[1].locator('#login').click()
  await until(() => manager.getSession(other.id).popups.length === 1, 'second session popup')
  assert.equal(manager.getSession(session.id).popups.length, 0)
  await manager.kill(session.id)
  assert.equal(roots[1].isClosed(), false)
  assert.equal(manager.getSession(other.id).popups.length, 1)
  await manager.kill(other.id)
  assert.equal(context.pages().length, 0)
  report.push('shared context retains session ownership and closes only owned windows')

  // A chained window may already exist by the time its opener is adopted.
  // Attach the real handles after both pages exist to exercise that ordering.
  const lateRoot = await context.newPage()
  await lateRoot.goto(appOrigin + '/app')
  await lateRoot.click('#login')
  await until(() => context.pages().length === 2, 'unobserved login window')
  const lateLogin = context.pages().find((candidate) => candidate !== lateRoot)
  await lateLogin.locator('#chain').click()
  await until(() => context.pages().length === 3, 'unobserved factor window')
  const recovered = []
  const observe = (handle) => handle.onPopup((child) => { recovered.push(child); observe(child) })
  observe(new PlaywrightPageHandle(lateRoot))
  await until(() => recovered.length === 2, 'replay already-open child chain')
  assert.equal(new Set(recovered.map((handle) => handle.currentUrl())).size, 2)
  const lateHandle = new PlaywrightPageHandle(lateLogin)
  await lateLogin.close()
  let closeDelivered = 0
  lateHandle.onClose(() => closeDelivered++)
  await until(() => closeDelivered === 1, 'late close subscription')
  await Promise.all(context.pages().map((candidate) => candidate.close()))
  report.push('late subscriptions recover existing popup chains and already-closed windows')
  console.log(JSON.stringify({ passed: report }, null, 2))
} finally {
  await manager?.shutdown()
  await browser?.close()
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
