import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { browseToolDir, ensureBrowseTool, renderBrowseLauncher, resetBrowseToolForTests, resolvePlaywrightDir, runBrowseToolEnv } from './run-browse-tool'
import { BROWSE_TOOL_SOURCE, BROWSE_TOOL_VERSION } from '../tool/browse-tool-bundle.generated'

const homes: string[] = []
afterEach(() => { resetBrowseToolForTests(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })
const tempHome = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tool-')); homes.push(home); return home }

describe('run browser tool installation', () => {
  it('writes the bundled script and a launcher that sets the tool environment only for itself', () => {
    const home = tempHome()
    const launcher = ensureBrowseTool({ specrailsHome: home, playwrightDir: '/pw', node: '/bin/node', chromium: null, platform: 'darwin' })
    expect(launcher).toBe(path.join(browseToolDir(home), 'specrails-browse'))
    const script = path.join(browseToolDir(home), `specrails-browse-${BROWSE_TOOL_VERSION}.cjs`)
    expect(fs.readFileSync(script, 'utf8')).toBe(BROWSE_TOOL_SOURCE)
    const text = fs.readFileSync(launcher!, 'utf8')
    expect(text).toContain(`PLAYWRIGHT_BROWSERS_PATH='${path.join(home, '.specrails', 'browsers')}'`)
    expect(text).toContain(`exec '/bin/node' '${script}' "$@"`)
    expect(fs.statSync(launcher!).mode & 0o100).toBeTruthy()
    // Runs receive only the launcher; Playwright's cache variable never leaks into project checks.
    expect(runBrowseToolEnv()).toEqual({ SPECRAILS_BROWSE: launcher })
  })
  it('replaces a superseded script and quotes paths for the shell and for cmd', () => {
    const home = tempHome(), dir = browseToolDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'specrails-browse-000000000000.cjs'), 'old')
    ensureBrowseTool({ specrailsHome: home, playwrightDir: '/pw', node: '/bin/node' })
    expect(fs.existsSync(path.join(dir, 'specrails-browse-000000000000.cjs'))).toBe(false)
    expect(renderBrowseLauncher({ node: "/o'brien/node", script: '/s.cjs', playwrightDir: '/pw', browsersDir: '/b', chromium: '/c' }, 'linux')).toContain(`'/o'\\''brien/node'`)
    const cmd = renderBrowseLauncher({ node: 'C:\\node.exe', script: 'C:\\s.cjs', playwrightDir: 'C:\\pw', browsersDir: 'C:\\b', chromium: null }, 'win32')
    expect(cmd).toContain('"C:\\node.exe" "C:\\s.cjs" %*')
    expect(cmd).toContain('set "SPECRAILS_BROWSE_CHROMIUM="')
  })
  it('offers nothing when Playwright is unavailable', () => {
    expect(ensureBrowseTool({ specrailsHome: tempHome(), playwrightDir: null })).toBeNull()
    expect(runBrowseToolEnv()).toEqual({})
  })
  it('finds the Playwright package the app itself uses', () => {
    expect(resolvePlaywrightDir({})).toMatch(/node_modules[/\\]playwright$/)
    expect(resolvePlaywrightDir({}, '/snapshot/server')).not.toMatch(/^\/snapshot/)
  })
  it('keeps the bundle in sync with its source', () => {
    execFileSync(process.execPath, ['scripts/build-browse-tool.mjs', '--check'], { cwd: path.resolve(__dirname, '../../../..'), stdio: 'pipe' })
  })
})

/** A Playwright Chromium already on this machine (never downloaded by the test suite). */
function installedBrowsers(): string | null {
  const candidates = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), '.specrails-dev-implfix', '.specrails', 'browsers')].filter((value): value is string => !!value)
  return candidates.find((dir) => { try { return fs.readdirSync(dir).some((name) => name.startsWith('chromium_headless_shell-')) } catch { return false } }) ?? null
}
const browsers = installedBrowsers()

describe.skipIf(!browsers || process.platform === 'win32')('run browser tool against a page on a leased port', () => {
  it('screenshots both viewports, runs actions, reports console errors and refuses other local ports', async () => {
    const home = tempHome(), site = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-site-')); homes.push(site)
    fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>Board</title><h1 id="t">Ready</h1><button id="go" onclick="t.textContent=\'Tetris!\'">go</button><script>console.error("nearly full")</script>')
    const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(path.join(site, 'index.html'))) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const launcher = ensureBrowseTool({ specrailsHome: home, browsersDir: browsers! })!
      const out = path.join(home, 'out')
      const env = { ...process.env, PORT: String(port), SPECRAILS_RUN_PORT_RANGE_START: String(port), SPECRAILS_RUN_PORT_RANGE_END: String(port) }
      const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(launcher, args, { cwd: site, env })
        let stdout = '', stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('exit', (code) => resolve({ code, stdout, stderr }))
      })
      const result = await run(['--url', `http://127.0.0.1:${port}/`, '--click', '#go', '--eval', 'document.getElementById("t").textContent', '--out', out])
      expect(result.stderr).not.toMatch(/could not start/)
      expect(result.code).toBe(1) // loaded fine, but the page logged an error
      for (const name of ['1440x900.png', '390x844.png', '1440x900.txt', 'report.json']) expect(fs.existsSync(path.join(out, name)), name).toBe(true)
      expect(fs.readFileSync(path.join(out, '1440x900.png')).subarray(1, 4).toString()).toBe('PNG')
      expect(result.stdout).toContain('=> "Tetris!"')
      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
      expect(report.viewports[0]).toMatchObject({ title: 'Board', status: 200, consoleErrors: ['nearly full'] })
      const refused = await run(['--url', 'http://127.0.0.1:4200/'])
      expect(refused.code).toBe(2)
      expect(refused.stderr).toMatch(/not one of this run's leased ports/)
    } finally { server.close() }
  }, 120_000)
})
