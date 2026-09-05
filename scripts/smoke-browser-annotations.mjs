// Real React annotation editor with production CSS, generated Retina imagery,
// and local-only HTTP. Run after `cd client && npm run build`.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builtIndex = await readFile(path.join(root, 'client/dist/index.html'), 'utf8')
const cssPath = builtIndex.match(/href="(\/assets\/index-[^"]+\.css)"/)?.[1]
assert.ok(cssPath, 'Build the client before running this smoke')
const css = await readFile(path.join(root, 'client/dist', cssPath), 'utf8')
const { outputFiles } = await build({
  stdin: {
    resolveDir: path.join(root, 'client'), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import i18n from 'i18next';
      import { initReactI18next } from 'react-i18next';
      import browser from './src/locales/en/browser.json';
      import common from './src/locales/en/common.json';
      import { ImageAnnotationEditor } from './src/components/browser-capture/AnnotationEditor';
      i18n.use(initReactI18next).init({ lng:'en', resources:{ en:{ browser, common } }, interpolation:{ escapeValue:false } });
      const portrait = new URLSearchParams(location.search).has('portrait');
      const canvas = document.createElement('canvas'); canvas.width = portrait ? 1600 : 2560; canvas.height = portrait ? 2560 : 1600;
      const nw=canvas.width,nh=canvas.height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f8f7f3'; ctx.fillRect(0,0,nw,nh);
      ctx.fillStyle='#14222e'; ctx.font='600 64px system-ui'; ctx.fillText('Retina capture · '+nw+' × '+nh,100,160);
      ctx.font='32px system-ui'; ctx.fillText('Generated local fixture — no user data',100,220);
      for(let x=nw*.25;x<nw*.7;x+=4) {ctx.fillStyle=(x%8===0)?'#000000':'#ffffff';ctx.fillRect(x,nh*.25,4,nh*.4);}
      ctx.fillStyle='#122a3c';ctx.font='42px system-ui';ctx.fillText('Markup keeps the original pixel resolution.',100,nh*.85);
      const source = canvas.toDataURL('image/png');
      window.fixture = { source, confirmed: [], version:0, width:nw,height:nh };
      function Fixture() {
        const [key,setKey]=useState(0);
        window.fixture.reset=()=>flushSync(()=>{window.fixture.confirmed=[];setKey(k=>k+1)});
        return <div className="fixed inset-0 bg-background-deep">
          <div role="dialog" className="absolute inset-x-[4%] inset-y-[3.5%] flex flex-col border border-border/70 rounded-2xl bg-background-deep overflow-hidden shadow-2xl">
            <ImageAnnotationEditor key={key} screenshotDataUrl={source} confirmLabel="Add to mission"
              onConfirm={image=>{window.fixture.confirmed.push(image)}} onReselect={()=>{}} onCancel={()=>{}} />
          </div>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  bundle: true, write: false, format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(outputFiles[0].text); return }
  if (req.url === '/fixture.css') { res.writeHead(200, { 'Content-Type': 'text/css' }).end(css); return }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>')
})

let browser
const failures = []
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  const engines = process.env.SPECRAILS_SMOKE_ENGINE ? [process.env.SPECRAILS_SMOKE_ENGINE] : ['chromium', 'webkit']
  for (const engine of engines) {
    assert.ok(['chromium', 'webkit'].includes(engine))
    browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true })
    for (const fixture of [{ width: 1280, height: 800 }, { width: 1000, height: 650 }, { width:1280,height:800,portrait:true }]) {
      const viewport={ width:fixture.width,height:fixture.height }
      const name = `${engine} ${viewport.width}×${viewport.height}${fixture.portrait?' portrait':''}`
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
      const errors = []
      page.on('pageerror', (err) => errors.push(err.message))
      await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort())
      await page.goto(fixture.portrait ? `${base}/?portrait=1` : base)
      await page.getByAltText('Captured selection').waitFor()
      await page.waitForFunction(() => {
        const img=document.querySelector('img')
        return img?.naturalWidth === window.fixture.width && img.getBoundingClientRect().width > 100
      })
      if (viewport.width===1280 && !fixture.portrait) {
        // Browser-native replaced-element sizing is not modeled by jsdom. This
        // isolates the fallback canvas CSS contract from the annotation editor.
        const canvasRects=await page.evaluate(()=>[ { width:1200,height:800 }, { width:300,height:500 } ].map(size=>{
          const container=document.createElement('div')
          container.style.cssText=`position:fixed;display:flex;align-items:center;justify-content:center;width:${size.width}px;height:${size.height}px`
          const canvas=document.createElement('canvas');canvas.width=750;canvas.height=1334
          canvas.style.cssText='max-width:min(100%, 375px);max-height:min(100%, 667px);width:auto;height:auto'
          container.append(canvas);document.body.append(container)
          const rect=canvas.getBoundingClientRect();container.remove()
          return { width:rect.width,height:rect.height }
        }))
        assert.deepEqual(canvasRects[0],{ width:375,height:667 })
        assert.ok(canvasRects[1].width<=300 && canvasRects[1].height<=500)
        assert.ok(Math.abs(canvasRects[1].width/canvasRects[1].height-375/667)<.001)
        console.log(`PASS: ${engine} fallback canvas Retina CSS`,JSON.stringify(canvasRects))
      }
      const layout = await page.evaluate(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height } }
        return { dialog:rect(document.querySelector('[role=dialog]')), image:rect(document.querySelector('img')), toolbar:rect(document.querySelector('[aria-label="Arrow (A)"]').parentElement), footer:rect(document.querySelector('[data-testid="annotation-confirm"]').parentElement), viewport:{ width:innerWidth,height:innerHeight } }
      })
      console.log(`${name} layout`, JSON.stringify(layout))
      const screenshotPath = path.join(os.tmpdir(), `specrails-browser-annotations-${engine}-${viewport.width}${fixture.portrait?'-portrait':''}.png`)
      await page.screenshot({ path:screenshotPath })
      console.log(`Screenshot: ${screenshotPath}`)
      let layoutFailed = false
      for (const part of ['image', 'toolbar', 'footer']) {
        const element = layout[part], dialog = layout.dialog
        if (!(element.left >= dialog.left && element.top >= dialog.top && element.right <= dialog.right && element.bottom <= dialog.bottom)) {
          failures.push(`${name}: ${part} exceeds dialog bounds`)
          layoutFailed = true
        }
      }
      if (layoutFailed) { await page.close(); continue }
      const draw = async (tool, from, to) => {
        await page.getByRole('button', { name:tool, exact:true }).click()
        const image = await page.getByAltText('Captured selection').boundingBox()
        await page.mouse.move(image.x + image.width*from.x, image.y + image.height*from.y)
        await page.mouse.down()
        await page.mouse.move(image.x + image.width*to.x, image.y + image.height*to.y, { steps: 5 })
        await page.mouse.up()
      }
      await draw('Box (R)', { x:.1,y:.15 }, { x:.2,y:.25 })
      await draw(/\(B\)$/, { x:.3,y:.3 }, { x:.5,y:.5 })
      await page.screenshot({ path:screenshotPath })
      await page.getByTestId('annotation-confirm').click()
      await page.waitForFunction(() => window.fixture.confirmed.length === 1)
      const result = await page.evaluate(async () => {
        const output = window.fixture.confirmed[0]
        const decode = async (url) => { const img=new Image();img.src=url;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return { ctx,width:canvas.width,height:canvas.height } }
        const original=await decode(window.fixture.source), rendered=await decode(output.screenshotDataUrl)
        const x=Math.round(rendered.width*.4),y=Math.round(rendered.height*.4)
        const samples=(ctx)=>[...ctx.getImageData(x,y,1,1).data,...ctx.getImageData(x+4,y,1,1).data]
        return { width:rendered.width,height:rendered.height,annotations:output.annotations,originalPixels:samples(original.ctx),redactedPixels:samples(rendered.ctx),boxPixel:[...rendered.ctx.getImageData(Math.round(rendered.width*.1),Math.round(rendered.height*.2),1,1).data] }
      })
      assert.equal(result.width,fixture.portrait?1600:2560);assert.equal(result.height,fixture.portrait?2560:1600)
      assert.deepEqual(result.annotations.objects.map(o=>o.kind),['box','blur'])
      assert.notDeepEqual(result.redactedPixels,result.originalPixels,'Redaction must replace the original black/white detail')
      assert.ok(Math.abs(result.redactedPixels[0]-result.redactedPixels[4])<Math.abs(result.originalPixels[0]-result.originalPixels[4]),'Redaction removes original high-contrast detail')
      assert.deepEqual(result.boxPixel,[239,68,68,255],'Flattened box stays at original pixel coordinates')
      // Encoding failures retain edits and never call onConfirm with the source.
      await page.evaluate(() => { window.savedEncoder=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=()=>{throw new Error('Injected encoder failure')} })
      await page.getByTestId('annotation-confirm').click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.evaluate(() => window.fixture.confirmed.length),1,'Failed flatten never sends the original image')
      await page.evaluate(() => {HTMLCanvasElement.prototype.toDataURL=window.savedEncoder})
      await page.getByTestId('annotation-confirm').click()
      await page.waitForFunction(() => window.fixture.confirmed.length===2)
      assert.deepEqual(errors,[])
      console.log(`PASS: ${name}, toolbar/footer, Retina box/redaction flatten, encoding error and retry`)
      await page.close()
    }
    await browser.close();browser=null
  }
  assert.deepEqual(failures,[])
} finally {
  await browser?.close().catch(()=>{})
  await new Promise(resolve=>server.close(resolve))
}
