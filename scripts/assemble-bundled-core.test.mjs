import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_STAGED_RELATIVE_PATH, assertStagedPathBudget, prunePnpmStores } from './assemble-bundled-core.mjs'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-core-test-'))
}

test('prunePnpmStores removes a leaked pnpm virtual store and the node_modules it emptied, nothing else', () => {
  const root = scratch()
  try {
    const nm = path.join(root, 'node_modules')
    // The v2.48.0 shape: a real dependency next to the package, plus a store leaked inside dist/.
    fs.mkdirSync(path.join(nm, '@langchain/langgraph-sdk/node_modules/p-queue'), { recursive: true })
    fs.writeFileSync(path.join(nm, '@langchain/langgraph-sdk/node_modules/p-queue/index.js'), 'ok')
    const store = path.join(nm, '@langchain/langgraph-sdk/dist/node_modules/.pnpm/is-network-error@1.3.1/node_modules/is-network-error')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'index.cjs.map'), '{}')
    // A directory merely NAMED .pnpm outside node_modules is not a store.
    fs.mkdirSync(path.join(nm, 'some-pkg/.pnpm'), { recursive: true })
    fs.writeFileSync(path.join(nm, 'some-pkg/.pnpm/keep.txt'), 'keep')

    assert.equal(prunePnpmStores(nm), 1)
    assert.ok(!fs.existsSync(path.join(nm, '@langchain/langgraph-sdk/dist/node_modules')), 'emptied node_modules is dropped')
    assert.ok(fs.existsSync(path.join(nm, '@langchain/langgraph-sdk/node_modules/p-queue/index.js')), 'real dependency untouched')
    assert.ok(fs.existsSync(path.join(nm, 'some-pkg/.pnpm/keep.txt')), 'a .pnpm outside node_modules is untouched')
    assert.equal(prunePnpmStores(nm), 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('assertStagedPathBudget names the deepest offender and passes a tree within budget', () => {
  const root = scratch()
  try {
    const ok = path.join(root, 'a'.repeat(40), 'b'.repeat(40))
    fs.mkdirSync(ok, { recursive: true })
    fs.writeFileSync(path.join(ok, 'c'.repeat(20) + '.js'), '')
    assert.doesNotThrow(() => assertStagedPathBudget(root))
    const deep = path.join(root, 'x'.repeat(60), 'y'.repeat(60))
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'z.js'), '')
    assert.throws(() => assertStagedPathBudget(root), (error) =>
      error.message.includes(`exceed ${MAX_STAGED_RELATIVE_PATH} chars`) && error.message.includes('Error 1304') && error.message.includes('x'.repeat(60)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
