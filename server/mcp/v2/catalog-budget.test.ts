import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import o200k from 'js-tiktoken/ranks/o200k_base'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness } from './__fixtures__/harness'
import { registerV2Surface, V2_INSTRUCTIONS, v2Catalog } from './index'
import { buildToolSpecs } from '../tools/catalog'
import { approxTokens } from './core/size-guard'

// The v2 catalog's token budget (design §2): measured with o200k (exact for
// Codex/GPT; Claude is ≈ +10–20% on JSON schemas) on what each client's model
// reads for every tool on every turn.
//
// - Codex shape: { type:'function', name:'mcp__specrails__<tool>', description, parameters }
// - Claude shape: { name, description, input_schema }
//
// Budgets: whole catalog ≤ 6,500 (Codex shape), any one tool ≤ 900, the six
// always-loaded tools ≤ 3,000, server instructions ≤ 600.

const enc = new Tiktoken(o200k)
const tokens = (value: unknown) => enc.encode(typeof value === 'string' ? value : JSON.stringify(value)).length

const BUDGET = { catalog: 6500, tool: 900, alwaysLoaded: 3000, instructions: 600, outputSchema: 50 }

interface Listed { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown; _meta?: Record<string, unknown> }

let client: Client
let listed: Listed[]

beforeAll(async () => {
  const harness = createHarness()
  registerV2Surface(harness.server, harness.ctx, buildToolSpecs(), { inApp: false })
  client = await harness.connect()
  listed = (await client.listTools()).tools as Listed[]
})

afterAll(async () => { await client.close() })

const codexShape = (tool: Listed) => ({ type: 'function', name: `mcp__specrails__${tool.name}`, description: tool.description, parameters: tool.inputSchema })
const claudeShape = (tool: Listed) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })

describe('v2 catalog token budget (o200k)', () => {
  it('advertises exactly the 15 v2 tools', () => {
    expect(listed.map((tool) => tool.name)).toEqual(v2Catalog().tools.map((tool) => tool.name))
    expect(listed).toHaveLength(15)
  })

  it(`fits the whole catalog in ${BUDGET.catalog} tokens and every tool in ${BUDGET.tool}`, () => {
    const rows = listed.map((tool) => ({ tool: tool.name, codex: tokens(codexShape(tool)), claude: tokens(claudeShape(tool)) }))
    const codex = rows.reduce((sum, row) => sum + row.codex, 0)
    const claude = rows.reduce((sum, row) => sum + row.claude, 0)
    // Printed so a failing budget names the heavy tools (and docs can quote the numbers).
    console.info(`[mcp-v2 budget] catalog codex=${codex} claude=${claude}\n${rows.map((row) => `  ${row.tool}: ${row.codex}`).join('\n')}`)
    expect(codex).toBeLessThanOrEqual(BUDGET.catalog)
    for (const row of rows) expect(row.codex, row.tool).toBeLessThanOrEqual(BUDGET.tool)
  })

  it(`keeps the always-loaded core under ${BUDGET.alwaysLoaded} tokens`, () => {
    const core = listed.filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
    expect(core.map((tool) => tool.name).sort()).toEqual(['specrails_deliveries', 'specrails_inbox', 'specrails_overview', 'specrails_runs', 'specrails_specs', 'specrails_wait'])
    expect(core.reduce((sum, tool) => sum + tokens(claudeShape(tool)), 0)).toBeLessThanOrEqual(BUDGET.alwaysLoaded)
  })

  it('keeps the output schema minimal and the instructions short', () => {
    for (const tool of listed) expect(tokens(tool.outputSchema ?? {}), tool.name).toBeLessThanOrEqual(BUDGET.outputSchema)
    expect(tokens(V2_INSTRUCTIONS)).toBeLessThanOrEqual(BUDGET.instructions)
  })

  it('keeps field descriptions to 8 words', () => {
    for (const tool of listed) {
      const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const [name, property] of Object.entries(properties)) {
        if (name === 'action' || !property.description) continue
        expect(property.description.split(/\s+/).length, `${tool.name}.${name}`).toBeLessThanOrEqual(8)
      }
    }
  })

  it('advertises no ±2^53 integer bounds and no $schema', () => {
    const text = JSON.stringify(listed.map((tool) => tool.inputSchema))
    expect(text).not.toContain('9007199254740991')
    expect(text).not.toContain('$schema')
  })
})

describe('approxTokens (the runtime size guard estimate)', () => {
  it('never undercounts the real tokenizer by more than 10% on JSON payloads', () => {
    const samples = [
      ...listed.map((tool) => tool.inputSchema),
      { v: 2, ok: true, summary: 'Run 8f3c is waiting for your answer.', data: { items: Array.from({ length: 40 }, (_, i) => ({ id: `run-${i}`, status: 'running', title: `Implement feature ${i}`, spentUsd: i * 0.13 })) } },
      { logs: Array.from({ length: 50 }, (_, i) => `2026-11-21T10:${String(i).padStart(2, '0')}:00Z [developer] npm test -- --run src/feature-${i}.test.ts passed`) },
      { text: 'Especificación: añadir el botón azul y comprobar la accesibilidad en todos los temas.' },
      { text: '仕様：青いボタンを追加し、すべてのテーマでアクセシビリティを確認します。' },
    ]
    for (const sample of samples) {
      const text = JSON.stringify(sample)
      expect(approxTokens(text), text.slice(0, 60)).toBeGreaterThanOrEqual(Math.floor(tokens(text) * 0.9))
    }
  })
})
