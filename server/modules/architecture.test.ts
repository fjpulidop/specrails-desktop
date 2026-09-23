import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import manifest from './boundaries.json'

// These core contracts are deliberately independent of the generated inventory:
// regenerating runtime dependencies cannot authorize infrastructure in a core.
const coreDependencies: Record<string, string[]> = {
  'project-settings/domain.ts': ['../../shared/git-branch-name'],
  'project-settings/ports.ts': ['./domain'],
  'project-settings/application.ts': ['./domain', './ports'],
  'project-settings/index.ts': ['./domain', './ports', './application'],
  'execution/domain/scheduling.ts': [],
  'execution/domain/job-accounting.ts': [],
  'execution/domain/usage.ts': ['./job-accounting'],
  'execution/ports.ts': ['./domain/job-accounting', './domain/usage'],
  'execution/application/record-job-invocations.ts': ['../../../util/distribute-int', '../domain/job-accounting', '../ports'],
  'execution/application/enforce-budget.ts': [],
  'execution/application/recover-job-usage.ts': ['../domain/usage', '../ports'],
  'execution/index.ts': ['./domain/scheduling', './application/record-job-invocations', './domain/job-accounting', './ports', './application/recover-job-usage', './domain/usage', './application/enforce-budget'],
  'delivery/domain/state.ts': [],
  'delivery/domain/decision-policy.ts': ['./state'],
  'delivery/index.ts': ['./domain/decision-policy', './domain/state'],
  'conversations/domain/recovery-context.ts': [],
  'conversations/domain/draft-stream.ts': [],
  'conversations/index.ts': ['./domain/recovery-context', './domain/draft-stream'],
}
function imports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: string[] = []
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) result.push((node.moduleSpecifier as ts.StringLiteral).text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0]
      result.push(argument && ts.isStringLiteral(argument) ? argument.text : '<dynamic dependency>')
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
describe('module contracts', () => {
  it('matches the reviewed source, dependency and public-entry inventory', () => {
    execFileSync(process.execPath, ['scripts/audit-server-modules.mjs', '--check'], { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' })
  })
  for (const [file, allowed] of Object.entries(coreDependencies)) {
    it(`${file} depends only on its core contracts`, () => {
      expect(imports(path.join(__dirname, file)).filter(ref => !allowed.includes(ref))).toEqual([])
    })
  }
  it('requires an explicit core rule for every domain/application/port file', () => {
    const cores: string[] = []
    for (const [name, module] of Object.entries(manifest)) {
      for (const file of Object.keys(module.dependencies)) {
        if (/^(domain\/|application\/|domain\.ts$|application\.ts$|ports\.ts$|index\.ts$)/.test(file)) cores.push(`${name}/${file}`)
      }
    }
    expect(cores.sort()).toEqual(Object.keys(coreDependencies).sort())
  })
  it('delivery workflow modules form an acyclic dependency graph', () => {
    const rules: Record<string, string[]> = manifest.delivery.dependencies
    const done = new Set<string>(), active: string[] = []
    function visit(file: string) {
      if (done.has(file)) return
      if (active.includes(file)) throw new Error(`Workflow dependency cycle: ${[...active, file].join(' -> ')}`)
      active.push(file)
      for (const ref of rules[file] ?? []) {
        if (!ref.startsWith('.')) continue
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref)) + '.ts'
        if (target.startsWith('adapters/decisions/') && target in rules) visit(target)
      }
      active.pop(); done.add(file)
    }
    Object.keys(rules).filter(file => file.startsWith('adapters/decisions/')).forEach(visit)
  })
})
