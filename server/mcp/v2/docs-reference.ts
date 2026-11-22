import type { V2ToolDef } from './core/registry'
import { V2_PROMPTS } from './prompts'
import { GUIDE_TOPICS } from './guide'

/**
 * The generated part of `docs/agents/mcp.md`: every v2 tool and action with
 * its tier, confirmation class and one-line doc, the prompts and the guide
 * topics, rendered from the catalog so the reference cannot drift.
 * docs-reference.test.ts fails when the page is stale; regenerate with
 * `UPDATE_MCP_DOCS=1 npx vitest run server/mcp/v2/docs-reference.test.ts`.
 */

export const DOCS_BEGIN = '<!-- BEGIN GENERATED: mcp-v2-catalog (server/mcp/v2/docs-reference.ts) -->'
export const DOCS_END = '<!-- END GENERATED: mcp-v2-catalog -->'

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

function tierOf(tier: V2ToolDef['actions'][string]['tier']): string {
  return typeof tier === 'function' ? 'per call' : tier
}

function confirmOf(confirm: V2ToolDef['actions'][string]['confirm']): string {
  if (typeof confirm === 'function') return 'per call'
  return confirm ?? '—'
}

export function renderCatalogReference(tools: readonly V2ToolDef[]): string {
  const out: string[] = [DOCS_BEGIN, '']
  out.push('| Tool | Loaded up front | Actions |', '|---|---|---|')
  for (const tool of tools) out.push(`| \`${tool.name}\` | ${tool.alwaysLoad ? 'yes' : ''} | ${Object.keys(tool.actions).length} |`)
  out.push('')
  for (const tool of tools) {
    out.push(`### \`${tool.name}\``, '', cell(tool.description), '', '| Action | Tier | Confirmation | Notes |', '|---|---|---|---|')
    for (const [name, action] of Object.entries(tool.actions)) {
      const required = action.required?.length ? `Requires ${action.required.map((field) => `\`${field}\``).join(', ')}. ` : ''
      const stub = action.handler ? '' : '(not available yet) '
      out.push(`| \`${name}\` | ${tierOf(action.tier)} | ${confirmOf(action.confirm)} | ${cell(`${stub}${required}${action.doc ?? ''}`)} |`)
    }
    out.push('')
  }
  out.push('### Prompts', '', '| Prompt | Arguments | What it does |', '|---|---|---|')
  for (const prompt of V2_PROMPTS) out.push(`| \`${prompt.name}\` | ${Object.keys(prompt.args).map((arg) => `\`${arg}\``).join(', ')} | ${cell(prompt.description)} |`)
  out.push('', '### Guide topics', '', 'Read with `specrails_system(help, topic:"<id>")` or the resource `specrails://guide/<id>`.', '', '| Topic | When |', '|---|---|')
  for (const topic of GUIDE_TOPICS) out.push(`| \`${topic.id}\` | ${cell(topic.when)} |`)
  out.push('', DOCS_END)
  return out.join('\n')
}

/** Replaces the generated block of a page (or appends it when absent). */
export function withCatalogReference(page: string, tools: readonly V2ToolDef[]): string {
  const block = renderCatalogReference(tools)
  const start = page.indexOf(DOCS_BEGIN)
  const end = page.indexOf(DOCS_END)
  if (start < 0 || end < start) return `${page.trimEnd()}\n\n${block}\n`
  return `${page.slice(0, start)}${block}${page.slice(end + DOCS_END.length)}`
}
