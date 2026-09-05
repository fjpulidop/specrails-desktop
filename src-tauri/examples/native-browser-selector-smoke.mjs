// Real pointer hit-testing for the fixed native selector, including a cross-origin
// iframe. No Specrails backend or user data. Run from any directory with Node.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { webkit, chromium } from 'playwright'

const script = await readFile(new URL('../src/browser_capture.js', import.meta.url), 'utf8')
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const frameServer = createServer((_, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(`<body style="margin:0"><button style="width:240px;height:110px" onclick="parent.postMessage('frame-click','*')">Harmless iframe click counter</button></body>`)
})
const framePort = await listen(frameServer)
const pageServer = createServer((_, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(`<!doctype html><body style="margin:0"><button id="button" style="position:absolute;left:20px;top:20px;width:200px;height:80px" onclick="window.buttonClicks++">Main button</button><div id="shadow" style="position:absolute;left:300px;top:20px"></div><iframe id="frame" src="http://127.0.0.1:${framePort}/" style="position:absolute;left:20px;top:160px;width:280px;height:150px"></iframe><script>window.frameClicks=0;window.buttonClicks=0;window.addEventListener('message',event=>{if(event.data==='frame-click')window.frameClicks++});document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button" style="width:200px;height:80px">Shadow child</button>'</script></body>`)
})
const pagePort = await listen(pageServer)
let browser
try {
  const engines = process.env.SPECRAILS_SMOKE_ENGINE === 'chromium' ? [chromium] : [webkit]
  for (const engine of engines) {
    browser = await engine.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(`http://127.0.0.1:${pagePort}/`)
    await page.frameLocator('#frame').getByRole('button').waitFor()
    await page.evaluate(source => { window.selectorAction = (0, eval)(`(${source})`) }, script)
    const act = action => page.evaluate(action => window.selectorAction(action), action)
    await act('enable')
    await page.mouse.click(80, 200)
    await page.waitForTimeout(100)
    const frameClicks = await page.evaluate(() => window.frameClicks)
    const frameSelection = await act('selection')
    console.log(JSON.stringify({ engine: engine.name(), frameClicks, frameSelection }))
    assert.equal(frameClicks, 0, 'selecting cross-origin iframe must never execute its button')
    assert.equal(frameSelection?.selector, '#frame')
    assert.equal(frameSelection?.tagName, 'iframe')
    await act('disable')
    assert.equal((await act('capture-selection')).element.selector, '#frame')

    await act('enable')
    await page.mouse.move(80, 50)
    await page.mouse.down()
    await page.waitForTimeout(300)
    assert.equal(await act('selection'), null, 'long press must not complete before click suppression')
    await page.mouse.up()
    assert.equal((await act('selection'))?.selector, '#button')
    await act('disable')
    assert.equal(await page.evaluate(() => window.buttonClicks), 0)

    await act('enable')
    await page.mouse.click(360, 50)
    const shadow = await act('selection')
    assert.equal(shadow?.selector, '#shadow-button')
    assert.equal(shadow?.tagName, 'button')
    await act('capture-selection')
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-specrails-native-hit-layer],[data-specrails-native-selection]')].some(element => !element.hidden)), false)
    await page.mouse.click(80, 200)
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => window.frameClicks), 1, 'normal iframe interaction must resume after selection')
    await page.evaluate(() => window.addEventListener('beforetoggle', event => event.preventDefault(), true))
    await act('enable')
    await page.mouse.click(80, 200)
    assert.equal((await act('selection'))?.selector, '#frame', 'page popover handlers cannot disable the input shield')
    assert.equal(await page.evaluate(() => window.frameClicks), 1)
    await act('disable')
    console.log(`${engine.name()}: cross-origin iframe, long press, Shadow DOM, popover fallback and restored browsing passed`)
    await browser.close()
    browser = null
  }
} finally {
  await browser?.close()
  pageServer.closeAllConnections()
  frameServer.closeAllConnections()
  await Promise.all([new Promise(resolve => pageServer.close(resolve)), new Promise(resolve => frameServer.close(resolve))])
}
