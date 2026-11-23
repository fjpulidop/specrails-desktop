import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { v2Catalog } from './index'
import { DOCS_BEGIN, DOCS_END, renderCatalogReference, withCatalogReference } from './docs-reference'

const PAGE = path.resolve(__dirname, '../../../docs/agents/mcp.md')

describe('docs/agents/mcp.md catalog reference', () => {
  it('lists every v2 tool and action', () => {
    const block = renderCatalogReference(v2Catalog().tools)
    for (const tool of v2Catalog().tools) {
      expect(block).toContain(`### \`${tool.name}\``)
      for (const action of Object.keys(tool.actions)) expect(block).toContain(`| \`${action}\` |`)
    }
    expect(block.startsWith(DOCS_BEGIN)).toBe(true)
    expect(block.endsWith(DOCS_END)).toBe(true)
  })

  it('replaces only the generated block', () => {
    const page = `# Title\n\nintro\n\n${DOCS_BEGIN}\nold\n${DOCS_END}\n\n## After\n`
    const next = withCatalogReference(page, v2Catalog().tools)
    expect(next.startsWith('# Title\n\nintro\n\n')).toBe(true)
    expect(next.endsWith(`${DOCS_END}\n\n## After\n`)).toBe(true)
    expect(next).not.toContain('\nold\n')
    expect(withCatalogReference('# T\n', v2Catalog().tools)).toContain(DOCS_BEGIN)
  })

  it('is current in the page (UPDATE_MCP_DOCS=1 regenerates it)', () => {
    const page = fs.readFileSync(PAGE, 'utf8')
    const next = withCatalogReference(page, v2Catalog().tools)
    if (process.env.UPDATE_MCP_DOCS === '1' && next !== page) fs.writeFileSync(PAGE, next)
    else expect(page.replace(/\r\n/g, '\n')).toBe(next)
  })
})
