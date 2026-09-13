// Isolated browser regression: actual shared React section, no user project or provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-evidence-browser-'))
let browser
try {
  const bundle = path.join(temp, 'fixture.js')
  await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom'; import i18n from 'i18next'; import { initReactI18next } from 'react-i18next';
    import translations from './src/locales/en/agentRuntime.json'; import { AgentRuntimeRuns } from './src/components/settings/AgentRuntimeRuns';
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { agentRuntime: translations } }, interpolation: { escapeValue: false } });
    window.fetch = async url => ({ ok: true, json: async () => String(url).includes('/evidence') ? String(url).includes('section=') ? {schemaVersion:1,available:true,text:'Long output\\n'.repeat(500)} : {schemaVersion:1,available:true,items:Array.from({length:60},(_,i)=>({id:'e'+i,repositoryId:'backend-'+i,label:'Check '+i,status:'passed',disposition:'executed',sources:[]}))} : {runs:[{runId:'fixture',status:'succeeded',nextStep:null,canResume:false,canCancel:false,canSettle:false,active:false,recoverableSteps:[]}]} });
    createRoot(document.getElementById('root')).render(<MemoryRouter><div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden'}}><header style={{height:60,flexShrink:0}}>Mission / Board log fixture</header><div id="host" className="max-h-[40%] overflow-y-auto"><AgentRuntimeRuns projectId="fixture" jobId="fixture" contextual /></div><div style={{flex:1,minHeight:0}}>Job log</div></div></MemoryRouter>);
  `, resolveDir: path.join(root, 'client'), loader: 'tsx' }, bundle: true, outfile: bundle, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const assets = path.join(root, 'client/dist/assets')
  const names = await fs.readdir(assets)
  const css = (await Promise.all(names.filter(name => /^index-.*\.css$/.test(name)).map(name => fs.readFile(path.join(assets, name), 'utf8')))).join('\n')
  assert(css.includes('overflow-y-auto'), 'Build actual client CSS before this smoke')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 520 } })
  await page.route('**/*', route => route.abort())
  await page.setContent('<style>' + css + '</style><div id="root"></div>')
  await page.addScriptTag({ type: 'module', content: await fs.readFile(bundle, 'utf8') })
  for (const mode of ['mission', 'board']) {
    await page.locator('#host').evaluate((node, mode) => { node.style.maxHeight = mode === 'mission' ? '40%' : '90%'; node.scrollTop = 0 }, mode)
    const summary = page.getByText('Verification evidence', { exact: true })
    if (!(await page.locator('details').getAttribute('open')) && !await page.locator('details').evaluate(node => node.open)) await summary.click()
    const pane = page.getByLabel('Verification evidence', { exact: true })
    await pane.hover(); await page.mouse.wheel(0, 1200)
    await page.waitForFunction(() => document.querySelector('[aria-label="Verification evidence"]').scrollTop > 0)
    await pane.focus(); await page.keyboard.press('End')
    await page.waitForFunction(() => { const el = document.querySelector('[aria-label="Verification evidence"]'); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 })
    await page.getByRole('button', { name: 'stdout', exact: true }).last().click()
    const output = page.getByLabel('Verification output')
    await output.focus(); await page.keyboard.press('End')
    await page.waitForFunction(() => document.querySelector('[aria-label="Verification output"]').scrollTop > 0)
    console.log(`${mode}: wheel scrolling and keyboard access to long evidence passed`)
  }
} finally { await browser?.close(); await fs.rm(temp, { recursive: true, force: true }) }
