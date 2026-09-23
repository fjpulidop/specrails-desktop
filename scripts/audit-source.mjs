import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// A conservative import inventory, not an automatic deletion tool. Include both
// shipping and demo entry points. Tests are reported separately, never as proof
// that a production feature is reachable.
const roots = ['server', 'client/src', 'cli', 'local-runner/src', 'mcp-bridge/src']
const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name)) walk(file)
    else if (entry.isFile() && /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')) files.push(file)
  }
}
roots.forEach(walk)
const known = new Set(files)
const graph = new Map()
const dynamic = []
function resolve(from, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, '.ts')].find(f => known.has(f))
}
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const edges = new Set()
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = node.arguments[0]
      if (!specifier || !ts.isStringLiteralLike(specifier)) dynamic.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const target = resolve(file, specifier.text)
      if (target) edges.add(target)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  graph.set(file, edges)
}
const entryPoints = ['server/index.ts', 'client/src/main.tsx', 'client/src/demo-mode/demo-entry.tsx', 'cli/specrails-desktop.ts', 'local-runner/src/index.ts', 'mcp-bridge/src/index.ts']
const reachable = new Set()
function mark(file) {
  if (reachable.has(file)) return
  reachable.add(file)
  for (const dependency of graph.get(file) ?? []) mark(dependency)
}
for (const entry of entryPoints) {
  if (!known.has(entry)) throw new Error(`Missing application entry point: ${entry}`)
  mark(entry)
}
const isTest = file => /(?:\.(?:test|spec)\.[^/]+$|\/__tests__\/|\/__fixtures__\/|\/(?:vitest-setup|test-setup|test-utils)\.)/.test(file)
const candidates = files.filter(file => !isTest(file) && !reachable.has(file)).sort()
console.log(JSON.stringify({ entryPoints, sourceFiles: files.length, reachableFiles: reachable.size, reviewCandidates: candidates, nonLiteralImports: dynamic }, null, 2))
if (process.env.AUDIT_IMPORTERS === '1') {
  for (const candidate of candidates) console.error(candidate, JSON.stringify([...graph].filter(([, deps]) => deps.has(candidate)).map(([file]) => file)))
}
