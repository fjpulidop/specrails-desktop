import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'client/src')
const featureRoot = path.join(source, 'features')
const manifestPath = path.join(featureRoot, 'boundaries.json')
const slash = value => value.split(path.sep).join('/')
const sorted = values => [...values].sort()
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === '__fixtures__') return []
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file) ? [file] : []
  })
}
const sources = files(source)
const existing = new Set(sources)
const names = sorted(fs.readdirSync(featureRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name))
const features = Object.fromEntries(names.map(name => [name, { publicEntries: new Set(), dependencies: new Set() }]))
function owner(file) {
  const relative = slash(path.relative(featureRoot, file))
  return !relative.startsWith('../') && relative.includes('/') ? relative.split('/')[0] : null
}
function resolve(file, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(file), specifier)
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(candidate => existing.has(candidate))
}
const violations = []
for (const file of sources) {
  const from = owner(file)
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  for (const specifier of specifiers) {
    const target = resolve(file, specifier)
    if (!target) continue
    const to = owner(target)
    if (from && ['App.tsx', 'main.tsx', 'test-utils.tsx', 'test-setup.ts'].includes(path.relative(source, target))) violations.push(`${slash(path.relative(source, file))} imports application composition/test infrastructure`)
    if (!to || to === from) continue
    features[to].publicEntries.add(slash(path.relative(path.join(featureRoot, to), target)))
    if (from) features[from].dependencies.add(to)
  }
}
if (violations.length) throw new Error(violations.join('\n'))
const manifest = Object.fromEntries(names.map(name => [name, {
  publicEntries: sorted(features[name].publicEntries), dependencies: sorted(features[name].dependencies),
}]))
const output = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--write')) {
  fs.writeFileSync(manifestPath, output)
  for (const name of names) {
    const { publicEntries, dependencies } = manifest[name]
    fs.writeFileSync(path.join(featureRoot, name, 'README.md'), `# ${name}\n\nThis capability owns its UI, state, feature utilities and adjacent tests.\nShared rendering primitives, API origin/auth and project cache remain outside features.\n\n## Public subpaths\n\nThese are the explicit entry points consumed by application composition or other\nfeatures. Keep imports focused on a subpath so importing a model does not eagerly\nload every UI component. Changes to this surface require updating the boundary manifest.\n\n${publicEntries.map(file => `- [${file}](${file})`).join('\n') || 'No external consumers.'}\n\n## Feature dependencies\n\n${dependencies.map(dep => `- [${dep}](../${dep}/README.md)`).join('\n') || 'No direct feature dependencies.'}\n\nDependencies record existing collaboration; they do not claim every feature is\nindependent or that this is a hexagonal frontend. Pure models should not gain\nReact, network or native-shell dependencies. Bind effects in hooks and adapters.\n\nRun the adjacent tests with \`npm run test --prefix client -- src/features/${name}\`.\nFor moves, update imports and mocks together, then run client coverage and typecheck.\nValidate navigation with \`node scripts/audit-client-features.mjs --check\`.\n`)
  }
} else if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n') !== output) {
  console.error('Client feature boundaries changed. Review the public subpaths/dependencies and regenerate with --write.')
  process.exitCode = 1
}
