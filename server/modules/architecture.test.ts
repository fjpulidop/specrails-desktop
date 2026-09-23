import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const moduleRoot = path.join(__dirname, 'project-settings')
const dependencies: Record<string, string[]> = {
  'domain.ts': ['../../shared/git-branch-name'],
  'ports.ts': ['./domain'],
  'application.ts': ['./domain', './ports'],
  'index.ts': ['./domain', './ports', './application'],
  'adapters/http.ts': ['express', '..'],
  'adapters/sqlite.ts': ['../../../db/types', '../domain', '../ports'],
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

describe('project-settings architecture boundaries', () => {
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
            if (!specifier.includes('modules/project-settings/') || specifier.endsWith('modules/project-settings/index')) continue
            const relative = path.relative(root, file).split(path.sep).join('/')
            const composition = ['project-router-settings.ts', 'db/settings.ts'].includes(relative)
            if (!composition || !/\/adapters\/(http|sqlite)$/.test(specifier)) violations.push(`${relative}: ${specifier}`)
          }
        }
      }
    }
    walk(root)
    expect(violations).toEqual([])
  })
})
