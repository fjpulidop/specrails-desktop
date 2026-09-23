import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps CLI policy independent and command modules acyclic', () => {
  const graph: Record<string, string[]> = {}
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'specrails-desktop.ts')) {
    const ast = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = ast.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text)
    if (file === 'args.ts' || file === 'format.ts') expect(imports).toEqual([])
    expect(imports).not.toContain('./specrails-desktop')
    graph[file] = imports.filter(ref => ref.startsWith('./')).map(ref => `${ref.slice(2)}.ts`)
  }
  const done = new Set<string>(), active: string[] = []
  function visit(file: string) {
    if (done.has(file)) return
    if (active.includes(file)) throw new Error(`CLI dependency cycle: ${[...active, file].join(' -> ')}`)
    active.push(file)
    for (const target of graph[file] ?? []) if (target in graph) visit(target)
    active.pop(); done.add(file)
  }
  Object.keys(graph).forEach(visit)
})
