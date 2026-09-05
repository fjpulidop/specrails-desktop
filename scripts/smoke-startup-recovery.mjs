/**
 * Browser regression for startup and sidecar reconnection. Runs the real auth,
 * WebSocket and project providers against an isolated loopback fixture; never
 * opens the user's databases or the installed app. Requires a Playwright browser
 * (or SPECRAILS_SMOKE_BROWSER pointing to a Chromium executable).
 *
 * Run: node scripts/smoke-startup-recovery.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = path.join(root, 'client')
const project = (id) => ({
  id, slug: id, name: id, path: `/fixture/${id}`, db_path: `/fixture/${id}.sqlite`,
  provider: 'claude', added_at: '2026-01-01', last_seen_at: '2026-01-01',
})

const { outputFiles } = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { initAuth, installFetchInterceptor } from './src/lib/auth';
      import { SharedWebSocketProvider, useSharedWebSocket } from './src/hooks/useSharedWebSocket';
      import { DesktopProvider, useDesktop } from './src/hooks/useDesktop';
      function Probe() {
        const { projects, isLoading, activeProjectId } = useDesktop();
        const { connectionStatus } = useSharedWebSocket();
        return <pre id="probe">{JSON.stringify({
          projects: projects.map(p => p.id), isLoading, activeProjectId, connectionStatus
        })}</pre>;
      }
      await initAuth();
      installFetchInterceptor();
      createRoot(document.getElementById('root')).render(
        <React.StrictMode>
          <SharedWebSocketProvider url={location.origin.replace('http:', 'ws:') + '/ws'}>
            <DesktopProvider><Probe /></DesktopProvider>
          </SharedWebSocketProvider>
        </React.StrictMode>
      );
    `,
    resolveDir: client,
    loader: 'tsx',
  },
  write: false,
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  // Locale messages do not participate in transport recovery. Avoid loading
  // the Vite-only import.meta.glob locale registry in this esbuild fixture.
  plugins: [{
    name: 'fixture-locale',
    setup(plugin) {
      plugin.onResolve({ filter: /\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }))
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: 'export default { t: (key) => key }', loader: 'js',
      }))
    },
  }],
})
const bundle = outputFiles[0].text
let readyAt = Infinity
let token = 'fixture-token-1'
let projects = [project('saved-project')]
let tokenRequests = 0
let projectFailures = 1
let invalidSocketAttempts = 0
let stalledProjects = false
let staleSnapshotSent = false
const timers = new Set()
const later = (fn, ms) => {
  const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
  timers.add(timer)
}
const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle)
    return
  }
  if (!req.url.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      '<div id="root"></div><script type="module" src="/fixture.js"></script>',
    )
    return
  }
  if (Date.now() < readyAt) { sendJson(res, 503, { error: 'Starting' }); return }
  if (req.url === '/api/token') {
    tokenRequests++
    sendJson(res, 200, { token })
    return
  }
  if (req.headers['x-desktop-token'] !== token) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  if (req.url === '/api/projects') {
    if (projectFailures-- > 0) { sendJson(res, 503, { error: 'Retry later' }); return }
    if (stalledProjects) {
      // The REST response was captured before a fresher WebSocket catalog.
      later(() => { staleSnapshotSent = true; sendJson(res, 200, { projects: [] }) }, 1_500)
    } else {
      sendJson(res, 200, { projects })
    }
    return
  }
  sendJson(res, 200, {})
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return }
  const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim())
  if (Date.now() < readyAt || !protocols.includes(`desktop-token.${token}`)) {
    invalidSocketAttempts++
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
    // Give REST time to start, as happens while a context hydrates.
    later(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'desktop.projects', projects }))
    }, 100)
  })
})

let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SPECRAILS_SMOKE_BROWSER ? { executablePath: process.env.SPECRAILS_SMOKE_BROWSER } : {}),
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('specrails-desktop:activeProjectId', 'saved-project'))
  const url = `http://127.0.0.1:${server.address().port}`
  const waitForCatalog = async (expected) => {
    await page.waitForFunction(id => {
      const el = document.getElementById('probe')
      if (!el) return false
      const state = JSON.parse(el.textContent)
      return !state.isLoading && state.connectionStatus === 'connected' && state.projects.includes(id)
    }, expected, { timeout: 25_000 })
  }

  // The old bootstrap permanently cached null after only six seconds.
  readyAt = Date.now() + 8_000
  await page.goto(url)
  await waitForCatalog('saved-project')
  assert.equal(await page.locator('#probe').evaluate(el => JSON.parse(el.textContent).activeProjectId), 'saved-project')
  console.log('PASS: slow first start recovers authentication, projects and saved selection')

  // A replacement sidecar may issue a fresh credential while the page survives.
  token = 'fixture-token-2'
  projects = [project('saved-project'), project('after-restart')]
  readyAt = Date.now() + 2_000
  for (const ws of wss.clients) ws.close(1012, 'Service restart')
  await waitForCatalog('after-restart')
  assert.ok(tokenRequests >= 2, 'reconnection must refresh the desktop token')
  console.log('PASS: sidecar restart refreshes the token and catalog without reloading')

  // A delayed older REST result must not wipe the restored WebSocket catalog.
  stalledProjects = true
  await page.reload()
  await waitForCatalog('after-restart')
  // Let the deliberately delayed REST response arrive and React commit it.
  await new Promise(resolve => later(resolve, 2_000))
  assert.ok(staleSnapshotSent)
  const state = JSON.parse(await page.locator('#probe').textContent())
  assert.ok(state.projects.includes('after-restart'), 'stale REST must not replace the WebSocket catalog')
  assert.deepEqual(pageErrors, [])
  console.log('PASS: delayed REST cannot erase a newer WebSocket project catalog')
  console.log(`Startup smoke passed (${tokenRequests} token fetches, ${invalidSocketAttempts} rejected pre-ready sockets).`)
} finally {
  for (const timer of timers) clearTimeout(timer)
  await browser?.close()
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
