import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const boundaries: Record<string, { dependencies: Record<string, string[]>; compositions: string[] }> = {
  'project-settings': { compositions: ['project-router-settings.ts', 'db/settings.ts'], dependencies: {
    'domain.ts': ['../../shared/git-branch-name'],
    'ports.ts': ['./domain'],
    'application.ts': ['./domain', './ports'],
    'index.ts': ['./domain', './ports', './application'],
    'adapters/http.ts': ['express', '..'],
    'adapters/sqlite.ts': ['../../../db/types', '../domain', '../ports'],
  }},
  execution: { compositions: [], dependencies: {
    'domain/scheduling.ts': [],
    'domain/job-accounting.ts': [],
    'ports.ts': ['./domain/job-accounting'],
    'application/record-job-invocations.ts': ['../../../util/distribute-int', '../domain/job-accounting', '../ports'],
    'index.ts': ['./domain/scheduling', './application/record-job-invocations', './domain/job-accounting', './ports'],
  }},
  delivery: { compositions: [], dependencies: {
    'domain/state.ts': [],
    'domain/decision-policy.ts': ['./state'],
    'index.ts': ['./domain/decision-policy', './domain/state'],
  }},
  conversations: { compositions: [], dependencies: {
    'domain/recovery-context.ts': [],
    'domain/draft-stream.ts': [],
    'index.ts': ['./domain/recovery-context', './domain/draft-stream'],
  }},
}
function imports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: string[] = []
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      result.push((node.moduleSpecifier as ts.StringLiteral).text)
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      // Dynamic dependencies cannot bypass the core's declared boundaries.
      result.push('<dynamic dependency>')
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      result.push(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe.each(Object.entries(boundaries))('%s architecture boundaries', (name, { dependencies, compositions }) => {
  const moduleRoot = path.join(__dirname, name)
  it('requires an explicit dependency rule for every production module file', () => {
    const files: string[] = []
    function collect(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== '__tests__') collect(file)
        else if (entry.isFile() && file.endsWith('.ts')) files.push(path.relative(moduleRoot, file).split(path.sep).join('/'))
      }
    }
    collect(moduleRoot)
    expect(files.sort()).toEqual(Object.keys(dependencies).sort())
  })
  for (const [file, allowed] of Object.entries(dependencies)) {
    it(`${file} depends only on its declared layer`, () => {
      expect(imports(path.join(moduleRoot, file)).filter(item => !allowed.includes(item))).toEqual([])
    })
  }
  it('legacy consumers use the public API or explicit composition adapters', () => {
    const violations: string[] = []
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!['dist', 'node_modules', '__tests__', '__fixtures__'].includes(entry.name) && file !== moduleRoot) walk(file)
        } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
          for (const specifier of imports(file)) {
            if (!specifier.startsWith('.')) continue
            const target = path.resolve(path.dirname(file), specifier)
            if (!target.startsWith(moduleRoot + path.sep) || target === path.join(moduleRoot, 'index')) continue
            const relative = path.relative(root, file).split(path.sep).join('/')
            const composition = compositions.includes(relative)
            if (!composition || !/\/adapters\/(http|sqlite)$/.test(specifier)) violations.push(`${relative}: ${specifier}`)
          }
        }
      }
    }
    walk(root)
    expect(violations).toEqual([])
  })
})

it('requires a boundary definition for every module', () => {
  const modules = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('__'))
    .map(entry => entry.name)
  expect(modules.sort()).toEqual(Object.keys(boundaries).sort())
})
