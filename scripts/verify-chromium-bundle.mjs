#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { validateArchiveNames, validateChromiumArchive, validateChromiumTree } from '../server/chromium-archive.cjs'

export { validateArchiveNames }
export const validateExtractedTree = validateChromiumTree

const ARCHIVES = ['chromium.tar.gz', 'chromium.tar', 'chromium.pak']
const KEY = Buffer.from('specrails-desktop-chromium-pack-v1')
const MAX_DEPTH = 24

export function parseArguments(argv, env = process.env) {
  const options = {
    requireSignature: env.SPECRAILS_REQUIRE_CHROMIUM_SIGNATURE === '1',
    requireNotarization: env.SPECRAILS_REQUIRE_CHROMIUM_NOTARIZATION === '1',
  }
  let directory
  for (const arg of argv) {
    if (arg === '--require-signature') options.requireSignature = true
    else if (arg === '--require-notarization') options.requireNotarization = true
    else if (arg.startsWith('-') || directory) throw new Error('Usage: verify-chromium-bundle.mjs <runtimes-directory> [--require-signature] [--require-notarization]')
    else directory = arg
  }
  if (!directory) throw new Error('A bundled runtimes directory is required.')
  if (options.requireNotarization) options.requireSignature = true
  return { directory: path.resolve(directory), options }
}

export function runCommand(binary, args, { timeout = 180_000, maxBytes = 12 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', bytes = 0, failure
    const stop = error => { failure ??= error; child.kill('SIGKILL') }
    const timer = setTimeout(() => stop(new Error(`${path.basename(binary)} timed out after ${timeout}ms`)), timeout)
    const read = stream => chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) return stop(new Error(`${path.basename(binary)} exceeded its output limit`))
      if (stream === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout.on('data', read('stdout'))
    child.stderr.on('data', read('stderr'))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`${path.basename(binary)} exited ${code}: ${stderr.trim().slice(-4000)}`))
      else resolve(stdout)
    })
  })
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function discoverBrowser(root, { platform = process.platform, run = runCommand } = {}) {
  const apps = [], executables = []
  const accepted = platform === 'win32' ? ['chrome.exe', 'chromium.exe'] : ['chrome', 'chromium', 'chrome-wrapper']
  const walk = (directory, depth) => {
    assert(depth <= MAX_DEPTH, 'Chromium discovery exceeds its depth limit.')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) apps.push(file) // Never choose a nested Helper.app.
        else walk(file, depth + 1)
      } else if (entry.isFile() && accepted.includes(entry.name.toLowerCase())) executables.push(file)
    }
  }
  walk(root, 0)
  if (platform === 'darwin') {
    assert.equal(apps.length, 1, 'Expected exactly one top-level Chromium application bundle.')
    const app = apps[0]
    const executableName = (await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { timeout: 15_000 })).trim()
    assert(executableName && !/[\\/\x00-\x1f]/.test(executableName) && executableName !== '..' && executableName !== '.', 'Invalid Chromium CFBundleExecutable.')
    const executable = path.join(app, 'Contents', 'MacOS', executableName)
    assert(fs.statSync(executable).isFile(), 'Chromium main executable is missing.')
    assert(inside(fs.realpathSync(root), fs.realpathSync(executable)), 'Chromium executable escapes its bundle.')
    return { app, executable }
  }
  assert.equal(executables.length, 1, 'Expected exactly one Chromium executable.')
  return { app: null, executable: executables[0] }
}

export function browserLaunchOptions(executable, platform = process.platform) {
  // Required by Browser.getBrowserCommandLine. This enables diagnostic access;
  // it does not turn off the Chromium sandbox or its GPU sandbox.
  return { executablePath: executable, headless: true, chromiumSandbox: platform !== 'linux', args: ['--enable-automation'], timeout: 30_000 }
}

export async function probeBrowser(executable, { platform = process.platform, profileDirectory, loadPlaywright = () => import('playwright') } = {}) {
  const { chromium } = await loadPlaywright()
  let context
  let timeout
  const work = async () => {
    context = await chromium.launchPersistentContext(profileDirectory, browserLaunchOptions(executable, platform))
    context.setDefaultTimeout(10_000)
    const page = await context.newPage()
    await page.setContent('<!doctype html><title>Specrails Chromium fixture</title><main id="result">waiting</main><button id="button">Run</button><canvas id="canvas" width="8" height="8"></canvas><script>document.querySelector("#button").onclick=()=>document.querySelector("#result").textContent=String(6*7)</script>')
    await page.locator('#button').click()
    assert.equal(await page.locator('#result').textContent(), '42', 'Chromium did not execute the DOM/JavaScript fixture.')
    const graphics = await page.evaluate(() => {
      const canvas = document.querySelector('#canvas')
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 8)
      const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data)
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')
      const extension = gl?.getExtension('WEBGL_debug_renderer_info')
      return { pixel, webgl: Boolean(gl), renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null, vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null }
    })
    assert.deepEqual(graphics.pixel, [255, 0, 0, 255], 'Chromium canvas rendering failed.')
    const png = await page.screenshot()
    assert(png.length > 100 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Chromium screenshot is not a PNG.')
    const session = await context.browser().newBrowserCDPSession()
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine')
    if (platform !== 'linux') assert(!args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox'].includes(arg)), 'The Chromium smoke unexpectedly disabled a sandbox.')
    const gpu = await session.send('SystemInfo.getInfo')
    const processes = await session.send('SystemInfo.getProcessInfo')
    const gpuProcessObserved = (processes.processInfo ?? []).some(process => process.type.toLowerCase() === 'gpu')
    const limitations = []
    if (!graphics.webgl) limitations.push('WebGL is unavailable; this run does not establish GPU/WebGL compatibility.')
    if (!gpuProcessObserved) limitations.push('No GPU process was observed after the graphics fixture; GPU startup is not verified.')
    if (/swiftshader|llvmpipe|software/i.test(graphics.renderer ?? '')) limitations.push('A software renderer is in use; hardware acceleration is not verified.')
    await session.detach()
    return { version: context.browser().version(), sandboxRequested: platform !== 'linux', graphics, gpu: { processObserved: gpuProcessObserved, devices: gpu.gpu.devices, featureStatus: gpu.gpu.featureStatus }, limitations }
  }
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Chromium functional probe timed out after 60s.')), 60_000) })])
  } finally {
    clearTimeout(timeout)
    // Playwright's owned Chromium launcher closes gracefully and force-kills
    // its own process tree after its built-in 30s close deadline.
    if (context) await context.close()
  }
}

export async function verifyChromiumBundle(runtimes, options = {}) {
  const platform = options.platform ?? process.platform
  const requireNotarization = options.requireNotarization === true
  const requireSignature = options.requireSignature === true || requireNotarization
  assert(!requireSignature || platform === 'darwin', 'Apple signature/notarization checks must run on macOS.')
  const root = path.join(path.resolve(runtimes), 'chromium')
  assert(fs.statSync(root).isDirectory(), 'Bundled Chromium directory is missing.')
  const present = ARCHIVES.filter(name => fs.existsSync(path.join(root, name)))
  assert(!requireSignature || !present.includes('chromium.pak'), 'Signed releases must not contain an obfuscated chromium.pak.')
  const archiveName = present[0]
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'specrails-chromium-verify-'))
  const extracted = path.join(temporary, 'extracted')
  const run = options.run ?? runCommand
  try {
    fs.mkdirSync(extracted)
    if (archiveName) {
      let archive = path.join(root, archiveName)
      assert(fs.lstatSync(archive).isFile(), 'Chromium archive must be a regular file.')
      assert(fs.statSync(archive).size > 0 && fs.statSync(archive).size <= 3 * 1024 ** 3, 'Chromium archive is empty or exceeds 3 GiB.')
      if (archiveName === 'chromium.pak') {
        console.warn('Verifying legacy chromium.pak compatibility; this is not a signed-release artifact.')
        const decoded = path.join(temporary, 'legacy.tar.gz')
        let offset = 0
        await pipeline(fs.createReadStream(archive), new Transform({ transform(chunk, _, done) {
          const result = Buffer.allocUnsafe(chunk.length)
          for (let i = 0; i < chunk.length; i++) result[i] = chunk[i] ^ KEY[(offset + i) % KEY.length]
          offset += chunk.length; done(null, result)
        } }), fs.createWriteStream(decoded, { flags: 'wx' }))
        archive = decoded
      }
      const tar = platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
      await validateChromiumArchive(archive, { platform, run })
      const env = { ...process.env }
      delete env.TAR_OPTIONS
      delete env.COPYFILE_DISABLE
      delete env.COPY_EXTENDED_ATTRIBUTES_DISABLE
      await run(tar, ['-xf', archive, '-C', extracted, '--no-same-owner'], { env })
    } else {
      // Copy without dereferencing framework links. Never launch or modify the
      // developer's Playwright cache or an installed application's resource tree.
      if (process.platform === 'darwin') await runCommand('/usr/bin/ditto', [root, extracted])
      else fs.cpSync(root, extracted, { recursive: true, dereference: false, verbatimSymlinks: true })
    }
    validateExtractedTree(extracted)
    const browser = await discoverBrowser(extracted, { platform, run })
    if (requireSignature) {
      const verify = options.verifyApplication ?? (await import('./sign-chromium-macos.mjs')).verifyMacApplication
      await verify(browser.app, { requireNotarization })
    }
    const probe = options.probe ?? probeBrowser
    const result = await probe(browser.executable, { platform, profileDirectory: path.join(temporary, 'profile') })
    return { format: archiveName ?? 'unpacked', signatureVerified: requireSignature, notarizationVerified: requireNotarization, ...result }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { directory, options } = parseArguments(process.argv.slice(2))
    console.log(JSON.stringify(await verifyChromiumBundle(directory, options), null, 2))
  } catch (error) { console.error(`Chromium verification failed: ${error.message}`); process.exitCode = 1 }
}
