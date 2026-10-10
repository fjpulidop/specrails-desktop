import { parse } from '@babel/parser'

// Syntax-only inventory of module references in a TypeScript/TSX source file.
//
// The architecture audits and tests used the TypeScript 5 compiler API
// (`ts.createSourceFile`) for this. TypeScript 7 is the native compiler and its
// npm package no longer exposes that JavaScript API, so module-reference
// extraction uses Babel's stable TypeScript-aware parser instead. Only syntax
// is inspected; nothing is type-checked or resolved here.
//
// Each reference is { kind, specifier, literal, line }:
//   kind      'import' | 'export' | 'dynamic-import' | 'require' | 'import-type'
//   specifier the module string when the argument is a string literal (or a
//             template literal without substitutions), otherwise null
//   literal   'string' | 'template' | null — the syntactic form of `specifier`
//   line      1-based line of the referencing node

function plugins(file) {
  return /\.tsx$/i.test(file) ? ['typescript', 'jsx'] : ['typescript']
}

function stringValue(node) {
  if (!node) return { specifier: null, literal: null }
  if (node.type === 'StringLiteral') return { specifier: node.value, literal: 'string' }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return { specifier: node.quasis[0].value.cooked, literal: 'template' }
  }
  return { specifier: null, literal: null }
}

function importTypeArgument(node) {
  // Babel 7: TSImportType.argument is a StringLiteral; Babel 8: a TSLiteralType.
  const argument = node.argument
  if (argument?.type === 'TSLiteralType') return argument.literal?.type === 'StringLiteral' ? argument.literal : null
  return argument?.type === 'StringLiteral' ? argument : null
}

/** Parse `code` (named `file` to choose TS vs TSX syntax) and list its module references in source order. */
export function moduleReferences(file, code) {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: plugins(file),
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
  })
  const references = []
  const add = (kind, node, argument) => references.push({ kind, ...stringValue(argument), line: node.loc.start.line })
  const visit = node => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'ImportDeclaration':
        add('import', node, node.source)
        break
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (node.source) add('export', node, node.source)
        break
      case 'ImportExpression':
        add('dynamic-import', node, node.source)
        break
      case 'CallExpression':
        if (node.callee.type === 'Import') add('dynamic-import', node, node.arguments[0])
        else if (node.callee.type === 'Identifier' && node.callee.name === 'require') add('require', node, node.arguments[0])
        break
      case 'TSImportType': {
        const literal = importTypeArgument(node)
        if (literal) add('import-type', node, literal)
        break
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue
      const value = node[key]
      if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast.program)
  return references
}
