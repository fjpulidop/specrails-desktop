// Isolated rendering regression + local diagnostics. Uses generated content and
// temporary Chromium contexts; never reads a Specrails DB/profile or an external
// website. Run: node scripts/smoke-browser-rendering.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(path.join(os.tmpdir(), 'specrails-browser-rendering-'))

function jpegSize(buffer) {
  for (let offset = 2; offset < buffer.length;) {
    assert.equal(buffer[offset], 0xff, 'JPEG marker')
    const marker = buffer[offset + 1]
    if (marker === 0xc0 || marker === 0xc2) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    offset += 2 + buffer.readUInt16BE(offset + 2)
  }
  throw new Error('No JPEG dimensions')
}
function pngSize(buffer) { return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } }
const html = `<style>
  body { margin: 0; height: 3000px; background: white; font: 16px system-ui; }
  #target { position: fixed; left: 600px; top: 300px; width: 100px; height: 50px; }
  #crop { position: fixed; left: 100px; top: 120px; width: 50px; height: 40px; background: rgb(255,0,0); }
  #detail { position: fixed; left: 200px; top: 200px; width: 50px; height: 20px; background: repeating-linear-gradient(90deg,#000 0px,#000 .5px,#fff .5px,#fff 1px); }
  #diagonal { position: fixed; left: 200px; top: 240px; width: 50px; height: 50px; background: linear-gradient(45deg,black 49%,white 49.5%); }
  #detail-text { position: fixed; left: 200px; top: 300px; font: 12px sans-serif; }
  #motion { position: fixed; top: 500px; width: 100px; height: 100px; background: linear-gradient(45deg,blue,cyan); animation: slide 1s infinite alternate; }
  .edge { position: fixed; width: 48px; height: 48px; z-index: 9999; }
  #top-left { left: 0; top: 0; background: rgb(255,0,0); }
  #top-right { right: 0; top: 0; background: rgb(0,255,0); }
  #bottom-left { left: 0; bottom: 0; background: rgb(0,0,255); }
  #bottom-right { right: 0; bottom: 0; background: rgb(255,255,0); }
  @keyframes slide { to { transform: translateX(700px) rotate(180deg); } }
</style><h1>Specrails rendering probe</h1><p>Retina text 0123456789</p><input id="target"><div id="crop"></div><div id="motion"></div>
<div id="detail"></div><div id="diagonal"></div><div id="detail-text">Sharp text</div>
<div class="edge" id="top-left"></div><div class="edge" id="top-right"></div><div class="edge" id="bottom-left"></div><div class="edge" id="bottom-right"></div>
<script>window.addEventListener('wheel',event=>{window.lastWheel={x:event.clientX,y:event.clientY,deltaY:event.deltaY}})</script>`

let browser
try {
  const bundle = path.join(temp, 'browser-playwright.cjs')
  await build({ entryPoints: [path.join(root, 'server/browser-playwright.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle, logLevel: 'silent' })
  const { PlaywrightPageHandle, chromiumLaunchArgs, screencastParams } = require(bundle)
  const report = []
  for (const disableGpu of [false, true]) {
    const launchAt = performance.now()
    browser = await chromium.launch({
      executablePath: process.env.SPECRAILS_SMOKE_CHROMIUM ?? chromium.executablePath(),
      headless: true,
      args: chromiumLaunchArgs(disableGpu ? { SPECRAILS_BROWSER_DISABLE_GPU: 'true' } : {}),
    })
    const launchMs = Math.round(performance.now() - launchAt)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    // The fixture is entirely local, including when an accidental request is made.
    await context.route('**/*', (route) => route.abort())
    await page.setContent(html)
    const handle = new PlaywrightPageHandle(page)
    for (const configuration of [
      { width: 1280, height: 800, deviceScaleFactor: 1 },
      { width: 1280, height: 800, deviceScaleFactor: 2 },
      { width: 900, height: 650, deviceScaleFactor: 2 },
      { width: 2000, height: 1100, deviceScaleFactor: 2, effectiveScale: 1.92 },
      { width: 1000, height: 600, deviceScaleFactor: 1 },
    ]) {
      const { effectiveScale = configuration.deviceScaleFactor, ...viewport } = configuration
      await handle.setViewport(viewport.width, viewport.height, viewport.deviceScaleFactor)
      let received = 0, bytes = 0, firstFrameMs = null, lastSize, lastFrame
      const started = performance.now()
      let resolveFrame
      const firstFrame = new Promise((resolve) => { resolveFrame = resolve })
      await handle.startScreencast((frame) => {
        received++
        bytes += frame.data.length
        lastFrame = frame.data
        lastSize = jpegSize(frame.data)
        if (firstFrameMs === null) { firstFrameMs = performance.now() - started; resolveFrame() }
      })
      let deadline
      try {
        await Promise.race([firstFrame, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('No screencast frame in 5 seconds')), 5000) })])
      } finally { clearTimeout(deadline) }
      const interactionAt = performance.now()
      await handle.dispatchInput({ type: 'mouse', action: 'move', x: 650, y: 325 })
      await handle.dispatchInput({ type: 'mouse', action: 'down', x: 650, y: 325 })
      await handle.dispatchInput({ type: 'mouse', action: 'up', x: 650, y: 325 })
      await handle.dispatchInput({ type: 'key', action: 'down', key: 'a', text: 'a' })
      assert.equal(await page.inputValue('#target'), 'a', 'CSS input coordinates remain correct at each DPR')
      const inputMs = Math.round(performance.now() - interactionAt)
      await page.fill('#target', '')
      const scrollBefore = await page.evaluate(() => scrollY)
      await handle.dispatchInput({ type: 'wheel', x: 800, y: 400, deltaX: 0, deltaY: 120 })
      await page.waitForFunction(before => Math.abs(scrollY - before - 120) < 1, scrollBefore)
      assert.deepEqual(await page.evaluate(() => window.lastWheel), { x: 800, y: 400, deltaY: 120 }, 'DOM wheel units and native scrolling both remain CSS pixels')
      await page.evaluate(() => window.scrollTo(0, 400))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const elapsedMs = performance.now() - started
      await handle.stopScreencast()
      assert.deepEqual(lastSize, { width: viewport.width, height: viewport.height })
      // A large JPEG alone says nothing about whether its page fills the frame.
      // This checks the actual decoded screencast after scrolling and resizing.
      const edgePixels = await page.evaluate(async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${base64}`)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
        const inset = 12
        return [[inset, inset], [bitmap.width - inset, inset], [inset, bitmap.height - inset], [bitmap.width - inset, bitmap.height - inset]]
          .map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data])
      }, lastFrame.toString('base64'))
      const expectedEdges = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]
      edgePixels.forEach((pixel, corner) => pixel.forEach((channel, i) => {
        assert.ok(Math.abs(channel - expectedEdges[corner][i]) <= 8,
          `Screencast must fill corner ${corner} at DPR ${viewport.deviceScaleFactor}: ${JSON.stringify(edgePixels)}`)
      }))
      if (process.env.SPECRAILS_SMOKE_FRAME && !disableGpu && viewport.width === 1280 && viewport.deviceScaleFactor === 2) {
        await writeFile(process.env.SPECRAILS_SMOKE_FRAME, lastFrame)
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, zoom: visualViewport.scale }))
      assert.deepEqual({ width: layout.width, height: layout.height, zoom: layout.zoom }, { width: viewport.width, height: viewport.height, zoom: 1 })
      assert.equal(layout.deviceScaleFactor, 1, 'Capture density must not change the interactive page DPR or input units')
      const crop = await handle.screenshotClip({ x: 100, y: 120, width: 50, height: 40 })
      assert.deepEqual(pngSize(crop), { width: Math.round(50 * effectiveScale), height: Math.round(40 * effectiveScale) })
      const cropPixel = await page.evaluate(async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
        return [...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data]
      }, crop.toString('base64'))
      assert.deepEqual(cropPixel, [255, 0, 0, 255], 'Screenshot crop uses CSS viewport coordinates after scrolling')
      if (viewport.width === 1280 && viewport.deviceScaleFactor === 2) {
        const detailRect = { x: 200, y: 200, width: 50, height: 140 }
        await handle.setViewport(viewport.width, viewport.height, 1)
        const one = await handle.screenshotClip(detailRect)
        await handle.setViewport(viewport.width, viewport.height, 2)
        const two = await handle.screenshotClip(detailRect)
        const detail = await page.evaluate(async (pngs) => {
          const images = await Promise.all(pngs.map(async (base64) => {
            const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode(); return img
          }))
          const samples = images.map((img) => {
            const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 280
            const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, 100, 280)
            const row = [...ctx.getImageData(10, 10, 80, 1).data].filter((_, index) => index % 4 === 0)
            return { contrast: Math.max(...row) - Math.min(...row), rest: ctx.getImageData(0, 80, 100, 200).data }
          })
          let different = 0
          for (let i = 0; i < samples[0].rest.length; i++) if (samples[0].rest[i] !== samples[1].rest[i]) different++
          return { upscaledContrast: samples[0].contrast, nativeContrast: samples[1].contrast, different }
        }, [one.toString('base64'), two.toString('base64')])
        assert.ok(detail.nativeContrast >= 240 && detail.upscaledContrast <= 10, '2× PNG resolves half-pixel detail absent from interpolated 1× PNG')
        assert.ok(detail.different > 100, 'Diagonal and text are re-rasterized instead of stretching a 1× bitmap')
      }
      report.push({ disableGpu, ...viewport, effectiveScale, launchMs, firstFrameMs: Math.round(firstFrameMs), inputMs, fpsReceived: Math.round(received * 1000 / elapsedMs), averageFrameBytes: Math.round(bytes / received), raster: `${lastSize.width}×${lastSize.height}` })
    }
    // DPR alone is insufficient for CDP. Keep this diagnostic reproducible so a
    // future refactor does not silently remove physical-surface configuration.
    const baselineContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    const baselinePage = await baselineContext.newPage()
    await baselinePage.setContent('<p>CSS-sized CDP baseline</p>')
    const cdp = await baselineContext.newCDPSession(baselinePage)
    const baseline = new Promise((resolve) => cdp.once('Page.screencastFrame', (frame) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      resolve(jpegSize(Buffer.from(frame.data, 'base64')))
    }))
    await cdp.send('Page.startScreencast', screencastParams())
    let baselineDeadline
    try {
      const size = await Promise.race([baseline, new Promise((_, reject) => {
        baselineDeadline = setTimeout(() => reject(new Error('No baseline screencast frame in 5 seconds')), 5000)
      })])
      console.log(`DPR-only CDP baseline (software rendering ${disableGpu}): ${size.width}×${size.height} for CSS 1280×800 at DPR 2`)
    } finally { clearTimeout(baselineDeadline) }
    await baselineContext.close()
    await handle.close()
    await browser.close()
    browser = null
  }
  console.table(report)
  console.log('PASS: complete CSS-sized JPEGs at all four edges, correct wheel/input/layout/zoom, resize, real-detail Retina PNG crops, software-rendering opt-out. Timings are local diagnostics, not a cross-browser benchmark.')
} finally {
  await browser?.close().catch(() => {})
  await rm(temp, { recursive: true, force: true })
}
