import test from 'node:test'
import assert from 'node:assert/strict'
import { moduleReferences } from './module-references.mjs'

const summary = (file, code) => moduleReferences(file, code).map(({ kind, specifier, literal, line }) => [kind, specifier, literal, line])

test('lists static, dynamic, require and import-type references with literal form and line', () => {
  const code = [
    "import a from './a'",
    "import type { B } from './b'",
    "export * from './c'",
    "export { d } from './d'",
    'export { local }',
    "const e = await import('./e')",
    'const f = require(`./f`)',
    'const g = require(name)',
    "type H = typeof import('./h')",
    "type I = import('./i').I",
    "import J = require('./j')",
    "require.resolve('./k')",
    'const local = 1',
  ].join('\n')
  assert.deepEqual(summary('sample.ts', code), [
    ['import', './a', 'string', 1],
    ['import', './b', 'string', 2],
    ['export', './c', 'string', 3],
    ['export', './d', 'string', 4],
    ['dynamic-import', './e', 'string', 6],
    ['require', './f', 'template', 7],
    ['require', null, null, 8],
    ['import-type', './h', 'string', 9],
    ['import-type', './i', 'string', 10],
  ])
})

test('parses TSX only for .tsx files and keeps TS angle-bracket assertions in .ts files', () => {
  assert.deepEqual(summary('view.tsx', "import { x } from './x'\nexport const V = () => <div>{import('./lazy')}</div>"), [
    ['import', './x', 'string', 1],
    ['dynamic-import', './lazy', 'string', 2],
  ])
  assert.deepEqual(summary('cast.ts', "import { y } from './y'\nconst n = <number>(y as unknown)"), [['import', './y', 'string', 1]])
})
