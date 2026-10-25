import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleReferences } from './module-references.mjs'
import { readmeIsCurrent, updateReadme } from './client-feature-readme.mjs'

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
  // Static import/export declarations and import() with a plain string literal.
  const specifiers = moduleReferences(file, fs.readFileSync(file, 'utf8'))
    .filter(ref => ref.literal === 'string' && (ref.kind === 'import' || ref.kind === 'export' || ref.kind === 'dynamic-import'))
    .map(ref => ref.specifier)
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
const readmePath = name => path.join(featureRoot, name, 'README.md')
const readReadme = name => (fs.existsSync(readmePath(name)) ? fs.readFileSync(readmePath(name), 'utf8') : null)
if (process.argv.includes('--write')) {
  fs.writeFileSync(manifestPath, output)
  // Only the generated block of each README is rewritten; hand-written
  // sections around it are preserved (scripts/client-feature-readme.mjs).
  for (const name of names) {
    const current = readReadme(name)
    const next = updateReadme(current, name, manifest[name])
    if (next !== current) fs.writeFileSync(readmePath(name), next)
  }
} else {
  if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n') !== output) {
    console.error('Client feature boundaries changed. Review the public subpaths/dependencies and regenerate with --write.')
    process.exitCode = 1
  }
  const stale = names.filter(name => !readmeIsCurrent(readReadme(name), name, manifest[name]))
  if (stale.length) {
    console.error(`Generated README blocks are out of date: ${stale.map(name => `features/${name}/README.md`).join(', ')}. Regenerate with --write (hand-written sections are kept).`)
    process.exitCode = 1
  }
}
