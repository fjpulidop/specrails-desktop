/**
 * Native-browser regression for inline mission references. Bundles the actual
 * editor in an isolated React fixture; no Specrails server or user data is used.
 * Run: node scripts/smoke-agent-inline-references.mjs
 * Optional: SPECRAILS_SMOKE_BROWSER=/path/to/chromium
 * Optional: SPECRAILS_SMOKE_ENGINE=webkit to verify the macOS WebView engine.
 * Optional: SPECRAILS_SMOKE_SCENARIO=substring to run one matching scenario.
 * Optional: SPECRAILS_SMOKE_SCREENSHOT=/absolute/path.png saves the first scenario.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engineName = process.env.SPECRAILS_SMOKE_ENGINE ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engineName), 'SPECRAILS_SMOKE_ENGINE must be chromium or webkit')
const engine = engineName === 'webkit' ? webkit : chromium
const { outputFiles } = await build({
  stdin: {
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { AgentComposerEditor } from './src/components/agent-chat/AgentComposerEditor';
      const chips = {
        spec: { kind: 'spec', id: '1', label: 'Scaffold the runnable project', token: '#1', status: 'todo', projectId: 'p1' },
        project: { kind: 'project', id: 'p1', label: 'NeoTetris', token: '@NeoTetris', projectId: 'p1' },
      };
      let sequence = 0;
      function Fixture() {
        const [draft, setDraft] = useState({ value: '', references: [] });
        const [version, setVersion] = useState(0);
        const current = useRef(draft);
        current.current = draft;
        const editor = useRef(null);
        window.fixture = {
          seed(value, references = []) {
            flushSync(() => { setDraft({ value, references }); setVersion(v => v + 1); });
            editor.current.focus();
            editor.current.setSelectionRange(value.length, value.length);
          },
          select(start, end = start) {
            editor.current.focus();
            editor.current.setSelectionRange(start, end);
          },
          insert(kind, start, end) {
            const chip = chips[kind];
            const prior = current.current;
            const value = prior.value.slice(0, start) + chip.token + prior.value.slice(end);
            const difference = chip.token.length - (end - start);
            const references = prior.references
              .filter(r => r.end <= start || r.start >= end)
              .map(r => r.start >= end ? { ...r, start: r.start + difference, end: r.end + difference } : r);
            references.push({ key: 'reference-' + ++sequence, start, end: start + chip.token.length, chip });
            references.sort((a, b) => a.start - b.start);
            flushSync(() => setDraft({ value, references }));
            editor.current.focus();
            editor.current.setSelectionRange(start + chip.token.length, start + chip.token.length);
          },
          snapshot() {
            const element = document.querySelector('[role="textbox"]');
            return {
              ...current.current,
              selection: [editor.current.selectionStart, editor.current.selectionEnd],
              dom: Array.from(element.childNodes).map(node => node.nodeType === Node.TEXT_NODE
                ? { text: node.textContent }
                : node.dataset?.inlineReference
                  ? { token: node.dataset.token }
                  : { html: node.outerHTML }),
            };
          },
        };
        return <>
          <h1>Inline reference browser regression</h1>
          <AgentComposerEditor key={version} ref={editor} value={draft.value}
            references={draft.references} ariaLabel="Mission message"
            onChange={(value, references) => setDraft({ value, references })}
            onSelect={() => {}} onKeyDown={() => {}} onPaste={() => {}} />
          <pre id="state">{JSON.stringify(draft)}</pre>
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
    resolveDir: path.join(root, 'client'),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
})

const bundle = outputFiles[0].text
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      body { background: #0c0c16; color: #eee; font: 20px system-ui; padding: 40px; }
      h1 { font-size: 18px; color: #aaa; }
      [role=textbox] { border: 1px solid #414157; border-radius: 20px; padding: 24px; min-height: 130px; white-space: pre-wrap; outline: none; }
      [data-inline-reference] { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #196473; border-radius: 30px; background: #0d2b32; color: #00c6e3; padding: 2px 9px; vertical-align: middle; font-size: 16px; }
      button { background: transparent; color: inherit; border: 0; }
      #state { white-space: pre-wrap; font-size: 12px; color: #888; }
    </style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
})

let browser
let passed = 0
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  browser = await engine.launch({
    headless: true,
    ...(process.env.SPECRAILS_SMOKE_BROWSER ? { executablePath: process.env.SPECRAILS_SMOKE_BROWSER } : {}),
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => !!window.fixture)
  const seed = (value) => page.evaluate(value => window.fixture.seed(value), value)
  const insert = (kind, start, end) => page.evaluate(({ kind, start, end }) => window.fixture.insert(kind, start, end), { kind, start, end })
  const select = (start, end = start) => page.evaluate(({ start, end }) => window.fixture.select(start, end), { start, end })
  const snapshot = () => page.evaluate(() => window.fixture.snapshot())
  const inlineOrder = (state) => {
    const nodes = state.dom.at(-1)?.html === '<br>' ? state.dom.slice(0, -1) : state.dom
    return nodes.map(node => node.text === undefined ? node : { text: node.text.replace(/\u200b/g, '') }).filter(node => node.text !== '')
  }
  const waitForText = async (expected) => {
    await page.waitForFunction(expected => window.fixture.snapshot().value === expected, expected, { timeout: 3_000 })
    const state = await snapshot()
    for (const reference of state.references) {
      assert.equal(state.value.slice(reference.start, reference.end), reference.chip.token, 'every reference remains attached to its original token')
    }
    return state
  }
  const failures = []
  const scenario = async (name, check) => {
    if (process.env.SPECRAILS_SMOKE_SCENARIO && !name.includes(process.env.SPECRAILS_SMOKE_SCENARIO)) return
    try {
      await check()
      passed++
      console.log(`PASS: ${name}`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      console.error(`FAIL: ${name}`)
      console.error('Failure snapshot:', JSON.stringify(await snapshot()))
    }
  }
  const undo = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  const redo = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')

  await scenario('spec stays between its prefix and suffix, and typing continues after the pill', async () => {
    let state
  await seed('implementemos el #1 después')
    await insert('spec', 17, 19)
    state = await snapshot()
    assert.deepEqual(inlineOrder(state), [{ text: 'implementemos el ' }, { token: '#1' }, { text: ' después' }])
    assert.deepEqual(state.selection, [19, 19])
    await page.keyboard.type(' ahora')
    state = await waitForText('implementemos el #1 ahora después')
    assert.equal(state.references.length, 1)
    if (process.env.SPECRAILS_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SPECRAILS_SMOKE_SCREENSHOT })
  })

  await scenario('@ project references retain their invoked position and caret', async () => {
    let state
  await seed('revisemos @NeoTetris juntos')
    await insert('project', 10, 20)
    state = await snapshot()
    assert.deepEqual(inlineOrder(state), [{ text: 'revisemos ' }, { token: '@NeoTetris' }, { text: ' juntos' }])
    await page.keyboard.type(' aquí')
    await waitForText('revisemos @NeoTetris aquí juntos')
  })

  await scenario('Backspace removes one whole pill; native undo and redo preserve its identity', async () => {
    let state
  await seed('antes #1 después')
    await insert('spec', 6, 8)
    await page.keyboard.press('Backspace')
    state = await waitForText('antes  después')
    assert.equal(state.references.length, 0)
    await undo()
    state = await waitForText('antes #1 después')
    assert.equal(state.references.length, 1)
    await redo()
    state = await waitForText('antes  después')
    assert.equal(state.references.length, 0)
  })

  await scenario('Delete removes a pill from its leading edge without changing neighboring text', async () => {
    let state
  await seed('antes #1 después')
    await insert('spec', 6, 8)
    await select(6)
    await page.keyboard.press('Delete')
    state = await waitForText('antes  después')
    assert.equal(state.references.length, 0)
  })

  await scenario('repeated references remain independent when one occurrence is deleted', async () => {
    let state
  await seed('#1 compara #1')
    await insert('spec', 0, 2)
    await insert('spec', 11, 13)
    state = await snapshot()
    assert.equal(state.references.length, 2)
    assert.notEqual(state.references[0].key, state.references[1].key)
    await select(2)
    await page.keyboard.press('Backspace')
    state = await waitForText(' compara #1')
    assert.equal(state.references.length, 1)
    assert.equal(state.references[0].start, 9)
  })

  await scenario('Shift+Enter and multiline plain-text paste preserve references and normalize line endings', async () => {
    let state
  await seed('implementemos el #1')
    await insert('spec', 17, 19)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('y revisemos')
    state = await waitForText('implementemos el #1\ny revisemos')
    assert.equal(state.references.length, 1)
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', '\r\ncon <script>texto</script>\rfinal')
      data.setData('text/html', '<img src=x onerror="window.fixturePasteExecuted=true">')
      document.querySelector('[role="textbox"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    state = await waitForText('implementemos el #1\ny revisemos\ncon <script>texto</script>\nfinal')
    assert.equal(await page.locator('[role="textbox"] img').count(), 0)
    assert.equal(await page.evaluate(() => !!window.fixturePasteExecuted), false)
    assert.equal(state.references.length, 1)
  })

  await scenario('replacing a selection across a pill removes the selected reference', async () => {
    let state
  await seed('antes #1 después')
    await insert('spec', 6, 8)
    await select(3, 11)
    await page.keyboard.type('X')
    state = await waitForText('antXspués')
    assert.equal(state.references.length, 0)
  })

  await scenario('native undo and redo of continuing text retain the preceding reference', async () => {
    let state
  await seed('')
    await page.keyboard.type('implementemos el #1')
    await insert('spec', 17, 19)
    await page.keyboard.type(' ahora')
    await waitForText('implementemos el #1 ahora')
    await undo()
    state = await waitForText('implementemos el #1')
    assert.equal(state.references.length, 1)
    await redo()
    await waitForText('implementemos el #1 ahora')
  })

  await scenario('undo and redo of palette insertion preserve the typed prefix and query', async () => {
    let state
  await seed('')
    await page.keyboard.type('implementemos el #1')
    await insert('spec', 17, 19)
    await undo()
    state = await waitForText('implementemos el #1')
    assert.equal(state.references.length, 0, 'undoing palette insertion restores the typed query as ordinary text')
    assert.ok(state.selection[0] >= 17, 'undoing a reference must not select the preceding prompt text')
    await redo()
    state = await waitForText('implementemos el #1')
    assert.equal(state.references.length, 1, 'redoing palette insertion restores its inline reference')
  })

  await scenario('copy uses plain reference tokens, and undoing cut restores both reference identities', async () => {
    let state
  await seed('#1 y @NeoTetris')
    await insert('spec', 0, 2)
    await insert('project', 5, 15)
    await select(0, 15)
    const copied = await page.evaluate(() => {
      const data = new DataTransfer()
      document.querySelector('[role="textbox"]').dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })
    assert.equal(copied, '#1 y @NeoTetris', 'copy exports tokens rather than pill labels or remove buttons')
    await page.evaluate(() => {
      document.querySelector('[role="textbox"]').dispatchEvent(new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))
    })
    state = await waitForText('')
    assert.equal(state.references.length, 0)
    await undo()
    state = await waitForText('#1 y @NeoTetris')
    assert.equal(state.references.length, 2)
  })

  await scenario('empty lines are preserved and caret offsets remain correct before line breaks', async () => {
    let state
  await seed('#1')
    await insert('spec', 0, 2)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('fin')
    state = await waitForText('#1\n\nfin')
    assert.equal(state.references.length, 1)
    await select(2)
    await page.keyboard.type(' luego')
    await waitForText('#1 luego\n\nfin')
  })

  await scenario('the remove button keeps focus and caret at the deleted reference', async () => {
    let state
  await seed('antes #1 después')
    await insert('spec', 6, 8)
    await page.locator('[data-remove-reference]').click()
    state = await waitForText('antes  después')
    assert.equal(state.references.length, 0)
    assert.deepEqual(state.selection, [6, 6])
    await page.keyboard.type('texto')
    await waitForText('antes texto después')
  })

  await scenario('Edit menu undo and redo retain the complete prompt and reference', async () => {
    await seed('')
    await page.keyboard.type('implementemos el #1')
    await insert('spec', 17, 19)
    await page.evaluate(() => document.execCommand('undo'))
    let state = await waitForText('implementemos el #1')
    assert.equal(state.references.length, 0)
    assert.ok(state.selection[0] >= 17)
    await page.evaluate(() => document.execCommand('redo'))
    state = await waitForText('implementemos el #1')
    assert.equal(state.references.length, 1)
  })

  assert.deepEqual(errors, [])
  assert.ok(passed + failures.length > 0, 'The scenario filter must match at least one native editor scenario')
  assert.deepEqual(failures, [], 'All native editor scenarios must pass')
  console.log(`Inline reference smoke passed (${passed} scenarios, ${engineName}).`)
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) console.error('Failure snapshot:', JSON.stringify(await page.evaluate(() => window.fixture?.snapshot()).catch(() => null)))
  }
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
