import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { MAX_STAGED_RELATIVE_PATH, assertStagedPathBudget, relocatePnpmStores } from './assemble-bundled-core.mjs'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-core-test-'))
}

test('relocatePnpmStores moves a leaked store to short paths and keeps every import working', () => {
  const root = scratch()
  try {
    const nm = path.join(root, 'node_modules')
    const pkg = path.join(nm, '@langchain/langgraph-sdk')
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), text) }
    // The real @langchain/langgraph-sdk shape: a rolldown build importing into, out of and across its leaked store.
    write('package.json', JSON.stringify({ name: '@langchain/langgraph-sdk', type: 'module' }))
    write('dist/_virtual/_rolldown/runtime.js', 'export const runtime = "rt"\n')
    write('dist/node_modules/.pnpm/is-network-error@1.3.1/node_modules/is-network-error/index.js', 'export default (e) => e === "net"\n')
    write('dist/node_modules/.pnpm/is-network-error@1.3.1/node_modules/is-network-error/index.js.map', '{}')
    write('dist/node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.js',
      'import isNetworkError from "../../../is-network-error@1.3.1/node_modules/is-network-error/index.js"\nimport { runtime } from "../../../../../_virtual/_rolldown/runtime.js"\nexport const retry = () => `${isNetworkError("net")}:${runtime}`\n')
    write('dist/utils/async_caller.js', 'import { retry } from "../node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.js"\nexport const call = () => retry()\n')
    write('dist/index.js', 'export { call } from "./utils/async_caller.js"\n')
    // A real dependency next to the package and a .pnpm outside node_modules stay untouched.
    fs.mkdirSync(path.join(pkg, 'node_modules/p-queue'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'node_modules/p-queue/index.js'), 'export default 1\n')
    fs.mkdirSync(path.join(nm, 'some-pkg/.pnpm'), { recursive: true })
    fs.writeFileSync(path.join(nm, 'some-pkg/.pnpm/keep.txt'), 'keep')

    assert.equal(relocatePnpmStores(nm), 1)
    assert.ok(!fs.existsSync(path.join(pkg, 'dist/node_modules')), 'the store and the node_modules it emptied are gone')
    assert.ok(fs.existsSync(path.join(pkg, 'dist/_pnpm/p-retry@7.1.1/index.js')))
    assert.ok(fs.existsSync(path.join(pkg, 'dist/_pnpm/is-network-error@1.3.1/index.js')))
    assert.ok(fs.existsSync(path.join(pkg, 'node_modules/p-queue/index.js')), 'real dependency untouched')
    assert.ok(fs.existsSync(path.join(nm, 'some-pkg/.pnpm/keep.txt')), 'a .pnpm outside node_modules is untouched')
    // Imports into, across and out of the store resolve after the move.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(pkg, 'dist/index.js'))}); console.log(m.call())`], { encoding: 'utf8' })
    assert.equal(out.trim(), 'true:rt')
    assert.equal(relocatePnpmStores(nm), 0)
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
