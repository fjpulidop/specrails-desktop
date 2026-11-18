/**
 * Process entry of the bundled run browser tool (`$SPECRAILS_BROWSE`). Bundled
 * by `scripts/build-browse-tool.mjs` into one dependency-free CommonJS script;
 * never imported by the server. Playwright is loaded at run time from the
 * directory the launcher names (`SPECRAILS_BROWSE_PLAYWRIGHT`), the same copy
 * the app's own browser uses.
 *
 * Chromium: the app's bundled Chromium when the launcher names one
 * (`SPECRAILS_BROWSE_CHROMIUM`), otherwise Playwright's Chromium in the
 * Specrails-managed cache (`PLAYWRIGHT_BROWSERS_PATH`, set by the launcher for
 * this process only), installed there on first use. Never global, never sudo.
 */
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import {
  BROWSE_HELP, BrowseUsageError, leasedPorts, parseBrowseArgs, refusedUrl, runRoots,
  type BrowseAction, type BrowseOptions, type BrowseViewport, type UrlPolicy,
} from './browse-policy'

type Playwright = typeof import('playwright')
type Page = import('playwright').Page

const TEXT_LIMIT = 4000
const LIST_LIMIT = 50

function fail(message: string): never {
  process.stderr.write(`specrails-browse: ${message}\n`)
  process.exit(2)
}

function loadPlaywright(): { module: Playwright; dir: string } {
  const dir = process.env.SPECRAILS_BROWSE_PLAYWRIGHT
  const candidates = [dir, 'playwright'].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require(candidate) as Playwright
      const resolved = candidate === 'playwright' ? path.dirname(require.resolve('playwright/package.json')) : candidate
      return { module, dir: resolved }
    } catch { /* next */ }
  }
  return fail('Playwright is not available to this tool. Restart Specrails so it can reinstall the browser tool.')
}

/** One install at a time across parallel runs: a directory lock under the browsers cache. */
async function installChromium(playwrightDir: string): Promise<void> {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!cache) fail('No browser is available and no Specrails browser cache is configured.')
  fs.mkdirSync(cache, { recursive: true })
  const lock = path.join(cache, '.install-lock')
  const deadline = Date.now() + 15 * 60_000
  let waited = false
  for (;;) {
    try { fs.mkdirSync(lock); break } catch {
      let stale = false
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 15 * 60_000 } catch { /* released meanwhile */ }
      if (stale) { try { fs.rmdirSync(lock) } catch { /* raced */ } continue }
      if (Date.now() > deadline) fail('Timed out waiting for another run to install Chromium.')
      waited = true
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  // Another run finished the install while this one waited: nothing left to do.
  if (waited) { try { fs.rmdirSync(lock) } catch { /* best-effort */ } return }
  try {
    process.stderr.write(`specrails-browse: installing Chromium into ${cache} (first use only)…\n`)
    const cli = path.join(playwrightDir, 'cli.js')
    const result = childProcess.spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, timeout: 15 * 60_000 })
    if (result.status !== 0) fail(`Installing Chromium failed (exit ${result.status ?? result.signal}). Check the network and run the command again.`)
  } finally {
    try { fs.rmdirSync(lock) } catch { /* best-effort */ }
  }
}

async function launch(playwright: Playwright, playwrightDir: string) {
  const bundled = process.env.SPECRAILS_BROWSE_CHROMIUM
  const executablePath = bundled && fs.existsSync(bundled) ? bundled : undefined
  const attempt = () => playwright.chromium.launch({ headless: true, executablePath, chromiumSandbox: process.platform !== 'linux' })
  try {
    return await attempt()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (executablePath || !/Executable doesn't exist|browserType\.launch: .*(?:not found|missing)|please run the following command to download new browsers/i.test(message)) throw error
    await installChromium(playwrightDir)
    return attempt()
  }
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, { timeout: 2000 }, (response) => { response.resume(); resolve(true) })
    request.on('error', () => resolve(false))
    request.on('timeout', () => { request.destroy(); resolve(false) })
  })
}

interface StartedApp { stop: () => void; log: string }

async function startApp(command: string, url: string, timeoutMs: number, out: string): Promise<StartedApp> {
  const log = path.join(out, 'app.log')
  const fd = fs.openSync(log, 'a')
  const shell = process.platform === 'win32' ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] }
  const child = childProcess.spawn(shell.file, shell.args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true })
  let exited: number | null = null
  child.on('exit', (code) => { exited = code ?? -1 })
  const stop = () => {
    if (exited !== null) return
    try {
      if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      else process.kill(-child.pid!, 'SIGTERM')
    } catch { /* already gone */ }
  }
  process.on('exit', stop)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited !== null) {
      const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-15).join('\n')
      fail(`The start command exited (code ${exited}) before ${url} answered. Last output:\n${tail}`)
    }
    if (await probe(url)) return { stop, log }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stop()
  return fail(`${url} did not answer within ${timeoutMs} ms. Make the app listen on $PORT (${process.env.PORT ?? 'unset'}). Output: ${log}`)
}

async function runAction(page: Page, action: BrowseAction, timeout: number): Promise<unknown> {
  switch (action.kind) {
    case 'wait': await page.locator(action.selector).first().waitFor({ state: 'visible', timeout }); return null
    case 'click': await page.locator(action.selector).first().click({ timeout }); return null
    case 'type': await page.locator(action.selector).first().fill(action.text, { timeout }); return null
    case 'press': await page.keyboard.press(action.key); return null
    case 'sleep': await page.waitForTimeout(action.ms); return null
    case 'eval': {
      const value = await page.evaluate((source) => {
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${source})`)()
        return Promise.resolve(result).then((settled) => { try { return JSON.parse(JSON.stringify(settled ?? null)) } catch { return String(settled) } })
      }, action.script)
      return value
    }
  }
}

interface ViewportReport {
  viewport: string
  screenshot: string | null
  text: string | null
  status: number | null
  title: string | null
  finalUrl: string | null
  actions: Array<{ action: string; ok: boolean; result?: unknown; error?: string }>
  consoleErrors: string[]
  consoleWarnings: string[]
  pageErrors: string[]
  failedRequests: string[]
  blockedRequests: string[]
  error: string | null
}

function describeAction(action: BrowseAction): string {
  switch (action.kind) {
    case 'type': return `type ${action.selector}`
    case 'eval': return `eval ${action.script.slice(0, 80)}`
    case 'sleep': return `sleep ${action.ms}`
    case 'press': return `press ${action.key}`
    default: return `${action.kind} ${action.selector}`
  }
}

async function capture(browser: import('playwright').Browser, options: BrowseOptions, url: string, viewport: BrowseViewport, policy: UrlPolicy, out: string): Promise<ViewportReport> {
  const name = `${viewport.width}x${viewport.height}`
  const report: ViewportReport = { viewport: name, screenshot: null, text: null, status: null, title: null, finalUrl: null, actions: [], consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], blockedRequests: [], error: null }
  const push = (list: string[], value: string) => { if (list.length < LIST_LIMIT) list.push(value.slice(0, 500)) }
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 })
  try {
    // Every request the page makes obeys the same rule as the page itself.
    await context.route('**/*', (route) => {
      const target = route.request().url()
      const refused = refusedUrl(target, policy)
      if (refused) { push(report.blockedRequests, `${target}: ${refused}`); return route.abort('blockedbyclient') }
      return route.continue()
    })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') push(report.consoleErrors, message.text())
      else if (message.type() === 'warning') push(report.consoleWarnings, message.text())
    })
    page.on('pageerror', (error) => push(report.pageErrors, error.stack ?? error.message))
    page.on('requestfailed', (request) => push(report.failedRequests, `${request.url()}: ${request.failure()?.errorText ?? 'failed'}`))
    const response = await page.goto(url, { waitUntil: 'load', timeout: options.timeoutMs })
    report.status = response?.status() ?? null
    for (const action of options.actions) {
      try {
        const result = await runAction(page, action, options.timeoutMs)
        report.actions.push({ action: describeAction(action), ok: true, ...(action.kind === 'eval' ? { result } : {}) })
      } catch (error) {
        report.actions.push({ action: describeAction(action), ok: false, error: (error instanceof Error ? error.message : String(error)).split('\n')[0] })
        break
      }
    }
    report.title = await page.title()
    report.finalUrl = page.url()
    report.screenshot = path.join(out, `${name}.png`)
    await page.screenshot({ path: report.screenshot, fullPage: options.fullPage })
    const text = await page.evaluate(() => document.body ? document.body.innerText : '')
    report.text = path.join(out, `${name}.txt`)
    fs.writeFileSync(report.text, [`URL: ${report.finalUrl}`, `Title: ${report.title}`, `HTTP status: ${report.status ?? 'n/a'}`, '', text.slice(0, TEXT_LIMIT)].join('\n'))
  } catch (error) {
    report.error = (error instanceof Error ? error.message : String(error)).split('\n')[0]
  } finally {
    await context.close().catch(() => undefined)
  }
  return report
}

async function main(): Promise<void> {
  let options: BrowseOptions
  try { options = parseBrowseArgs(process.argv.slice(2)) } catch (error) {
    if (error instanceof BrowseUsageError) fail(`${error.message}\n\n${BROWSE_HELP}`)
    throw error
  }
  if (options.help) { process.stdout.write(`${BROWSE_HELP}\n`); return }
  const env = process.env
  const policy: UrlPolicy = { ports: leasedPorts(env), roots: runRoots(process.cwd(), env).map((root) => { try { return fs.realpathSync(root) } catch { return path.resolve(root) } }), realpath: (file) => fs.realpathSync(file) }
  const url = options.url ?? (env.PORT ? `http://127.0.0.1:${env.PORT}/` : fail('--start without --url needs $PORT'))
  const refused = refusedUrl(url, policy)
  if (refused) fail(`refused ${url}: ${refused}`)
  const out = options.out ? path.resolve(options.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-browse-'))
  fs.mkdirSync(out, { recursive: true })
  const app = options.start ? await startApp(options.start, url, options.startTimeoutMs, out) : null
  const { module: playwright, dir } = loadPlaywright()
  let browser: import('playwright').Browser
  try { browser = await launch(playwright, dir) } catch (error) {
    app?.stop()
    return fail(`could not start Chromium: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  const reports: ViewportReport[] = []
  try {
    for (const viewport of options.viewports) reports.push(await capture(browser, options, url, viewport, policy, out))
  } finally {
    await browser.close().catch(() => undefined)
    app?.stop()
  }
  const reportFile = path.join(out, 'report.json')
  fs.writeFileSync(reportFile, JSON.stringify({ url, app: app ? { command: options.start, log: app.log } : null, viewports: reports }, null, 2))
  const lines = [`specrails-browse: ${url}`]
  for (const report of reports) {
    lines.push(`- ${report.viewport}: ${report.error ? `ERROR ${report.error}` : `HTTP ${report.status ?? 'n/a'}, title "${report.title ?? ''}"`}`)
    if (report.screenshot) lines.push(`  screenshot: ${report.screenshot}`)
    if (report.text) lines.push(`  page text:  ${report.text}`)
    for (const action of report.actions) lines.push(`  ${action.ok ? 'ok' : 'FAILED'} ${action.action}${action.error ? `: ${action.error}` : ''}${action.result !== undefined ? ` => ${JSON.stringify(action.result).slice(0, 300)}` : ''}`)
    const counts = `console errors ${report.consoleErrors.length}, page errors ${report.pageErrors.length}, failed requests ${report.failedRequests.length}, blocked requests ${report.blockedRequests.length}`
    lines.push(`  ${counts}`)
    for (const entry of [...report.pageErrors, ...report.consoleErrors].slice(0, 5)) lines.push(`    ${entry.split('\n')[0]}`)
  }
  lines.push(`report: ${reportFile}`, 'Read the PNG screenshots to see the page.')
  process.stdout.write(`${lines.join('\n')}\n`)
  const broken = reports.some((report) => report.error || report.actions.some((action) => !action.ok))
  const noisy = reports.some((report) => report.consoleErrors.length || report.pageErrors.length)
  process.exitCode = broken ? 2 : noisy ? 1 : 0
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
