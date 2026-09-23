import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = path.join(root, 'server')
const modules = path.join(server, 'modules')
const slash = value => value.split(path.sep).join('/')
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['dist', '__tests__', '__fixtures__', 'node_modules'].includes(entry.name)) return []
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') && !file.endsWith('.test.ts') ? [file] : []
  })
}
function imports(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const refs = new Set()
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) refs.add(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0]
      refs.add(argument && ts.isStringLiteral(argument) ? argument.text : '<dynamic dependency>')
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) refs.add(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...refs].sort()
}
const files = sources(server), existing = new Set(files)
function owner(file) {
  const relative = slash(path.relative(modules, file))
  return !relative.startsWith('../') && relative.includes('/') ? relative.split('/')[0] : null
}
const names = fs.readdirSync(modules, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('__')).map(entry => entry.name).sort()
const manifest = Object.fromEntries(names.map(name => [name, { publicEntries: [], dependencies: {} }]))
for (const file of files) {
  const from = owner(file), refs = imports(file)
  if (from) manifest[from].dependencies[slash(path.relative(path.join(modules, from), file))] = refs
  for (const ref of refs) {
    if (!ref.startsWith('.')) continue
    const base = path.resolve(path.dirname(file), ref)
    const target = [base, `${base}.ts`, path.join(base, 'index.ts')].find(candidate => existing.has(candidate))
    if (!target) continue
    const to = owner(target)
    if (to && to !== from) manifest[to].publicEntries.push(slash(path.relative(path.join(modules, to), target)))
  }
}
for (const module of Object.values(manifest)) {
  module.publicEntries = [...new Set(module.publicEntries)].sort()
  module.dependencies = Object.fromEntries(Object.entries(module.dependencies).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
const target = path.join(modules, 'boundaries.json')
const output = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--write')) fs.writeFileSync(target, output)
else if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) {
  console.error('Server module dependencies/public subpaths changed. Review and regenerate with --write.')
  process.exitCode = 1
}
