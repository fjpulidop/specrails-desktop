import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { buildToolSpecs } from './catalog'
import { registerTieredTool, type McpToolContext, type McpToolSpec } from './types'
import { advertisedActions } from './actions'
import { COMMON_FIELD_BRIEFS, FIELD_BRIEF_MAX, TOOL_BRIEFS } from './wire-briefs'
import { actionsNamedBy, fieldDescription, fieldsForAction, wireInputObject, wireToolDescription } from './wire-schema'

// The compact tools/list catalog every mission turn resends (docs/mcp.md, "Catalog size").

/** What Claude sends to the model per tool: name, description, input_schema. */
const MODEL_PAYLOAD_BUDGET = 60_000
const MODEL_PER_TOOL_MAX = 6_500
const TOOLS_LIST_BUDGET = 80_000
const TOOL_DESCRIPTION_MAX = 750

const catalog = buildToolSpecs()
const ctx = { firstPartyAgent: true, agentTierLevel: 3 } as unknown as McpToolContext
let tools: Tool[]

beforeAll(async () => {
  const server = new McpServer({ name: 'specrails', version: '0' })
  for (const spec of catalog) registerTieredTool(server, {} as McpToolContext, spec)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'wire-test', version: '0' })
  await client.connect(clientSide)
  tools = (await client.listTools()).tools
})

const modelEntry = (tool: Tool) => JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })

/** JSON schema with every description, the safe-integer bounds and $schema removed. */
function structure(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(structure)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' || key === '$schema') continue
    if ((key === 'minimum' && value === -Number.MAX_SAFE_INTEGER) || (key === 'maximum' && value === Number.MAX_SAFE_INTEGER)) continue
    out[key] = structure(value)
  }
  return out
}

const describeTool = () => catalog.find(spec => spec.name === 'specrails_describe')!
const describe_ = (args: Record<string, unknown>) => describeTool().handler(ctx, args) as Record<string, unknown>
type Field = { name: string; description?: string }

describe('wire catalog size', () => {
  it(`keeps the model-facing tools/list under ${MODEL_PAYLOAD_BUDGET} chars and every tool under ${MODEL_PER_TOOL_MAX}`, () => {
    expect(tools).toHaveLength(catalog.length)
    const sizes = tools.map(tool => [tool.name, modelEntry(tool).length] as const)
    for (const [name, size] of sizes) expect(size, name).toBeLessThanOrEqual(MODEL_PER_TOOL_MAX)
    expect(JSON.stringify(tools.map(tool => JSON.parse(modelEntry(tool)))).length).toBeLessThanOrEqual(MODEL_PAYLOAD_BUDGET)
    expect(JSON.stringify({ tools }).length).toBeLessThanOrEqual(TOOLS_LIST_BUDGET)
  })

  it(`keeps tool descriptions under ${TOOL_DESCRIPTION_MAX} chars and field descriptions under ${FIELD_BRIEF_MAX}`, () => {
    for (const tool of tools) {
      expect((tool.description ?? '').length, tool.name).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX)
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (field === 'action') continue
        const text = (schema as { description?: string }).description ?? ''
        expect(text.length, `${tool.name}.${field}: ${text}`).toBeLessThanOrEqual(FIELD_BRIEF_MAX)
      }
    }
  })

  it('names every advertised action in the wire description and points at describe or the guide when detail moved', () => {
    for (const spec of catalog) {
      const text = wireToolDescription(spec)
      for (const action of advertisedActions(spec)) expect(text, `${spec.name}: ${action}`).toMatch(new RegExp(`(^|[^a-z_.])${action.replace(/\./g, '\\.')}($|[^a-z_])`))
    }
  })

  it('has no stale briefs', () => {
    const byName = new Map(catalog.map(spec => [spec.name, spec]))
    for (const [name, brief] of Object.entries(TOOL_BRIEFS)) {
      const spec = byName.get(name)
      expect(spec, name).toBeDefined()
      for (const field of Object.keys(brief.fields ?? {})) expect(Object.keys(spec!.inputSchema), `${name}.${field}`).toContain(field)
    }
    for (const field of Object.keys(COMMON_FIELD_BRIEFS)) expect(catalog.some(spec => field in spec.inputSchema)).toBe(true)
  })
})

describe('wire schema keeps behaviour', () => {
  it('differs from the full schema only in text (same types, enums, required fields and bounds)', () => {
    for (const spec of catalog) {
      const full = toJsonSchemaCompat(spec.aliases ? z.object(spec.inputSchema).loose() : z.object(spec.inputSchema))
      const wire = toJsonSchemaCompat(wireInputObject(spec))
      expect(structure(wire), spec.name).toEqual(structure(full))
      expect(wire).not.toHaveProperty('$schema')
    }
  })

  it('accepts and rejects exactly what the full schema does, hidden aliases included', () => {
    const jobs = catalog.find(spec => spec.name === 'specrails_jobs')!
    const wire = wireInputObject(jobs)
    expect(wire.safeParse({ action: 'runtime_diagnose', jobId: 'j1' }).success).toBe(true)
    expect(wire.safeParse({ action: 'nope' }).success).toBe(false)
    const specs = catalog.find(spec => spec.name === 'specrails_specs_write')!
    for (const args of [{ action: 'update', id: 4, priority: null }, { action: 'update', id: 1.5 }, { action: 'add_addendum', id: 4, body: 'x'.repeat(8001) }, { action: 'smash', id: 4, mode: 'deep' }]) {
      expect(wireInputObject(specs).safeParse(args).success, JSON.stringify(args).slice(0, 60)).toBe(z.object(specs.inputSchema).safeParse(args).success)
    }
  })

  it('still advertises only the advertised actions', () => {
    const jobs = tools.find(tool => tool.name === 'specrails_jobs')!
    const action = (jobs.inputSchema.properties as Record<string, { enum?: string[] }>).action
    expect(action.enum).not.toContain('runtime_diagnose')
    expect(action.enum).toContain('diagnose_failure')
  })

  it('lists the required arguments per action in the action field when the tool declares them', () => {
    const runs = tools.find(tool => tool.name === 'specrails_runs')!
    const text = (runs.inputSchema.properties as Record<string, { description?: string }>).action.description
    expect(text).toContain('steer: jobId, steeringText, requestId')
  })
})

describe('full field docs stay reachable through specrails_describe', () => {
  const shortened = (spec: McpToolSpec) => Object.entries(spec.inputSchema)
    .map(([name, field]) => [name, fieldDescription(field as z.ZodTypeAny)] as const)
    .filter(([name, full]) => name !== 'action' && full !== undefined && wireDescriptionOf(spec.name, name) !== full)
  const wireDescriptionOf = (tool: string, field: string) =>
    ((tools.find(entry => entry.name === tool)!.inputSchema.properties ?? {}) as Record<string, { description?: string }>)[field]?.description

  it('returns every shortened description verbatim from describe(name)', () => {
    for (const spec of catalog) {
      const fields = describe_({ name: spec.name }).inputFields as Field[]
      for (const [name, full] of shortened(spec)) expect(fields.find(field => field.name === name)?.description, `${spec.name}.${name}`).toBe(full)
    }
  })

  it('returns every field doc, in full, from describe(name, action) for each action it belongs to', () => {
    let checked = 0
    for (const spec of catalog) {
      const actions = advertisedActions(spec)
      for (const action of actions) {
        const answer = describe_({ name: spec.name, action })
        const fields = answer.fields as Field[]
        const declared = spec.actionFields?.[action]
        const expected = new Set([...(declared?.required ?? []), ...(declared?.oneOf ?? []), ...(declared?.optional ?? [])])
        for (const [name, raw] of Object.entries(spec.inputSchema)) {
          const full = fieldDescription(raw as z.ZodTypeAny)
          const named = actionsNamedBy(full, actions)
          if (name === 'action' || !(expected.has(name) || named.includes(action) || !named.length)) continue
          expect(fields.find(field => field.name === name)?.description, `${spec.name}(${action}).${name}`).toBe(full)
          checked++
        }
        expect(answer.action).toBe(action)
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('scopes a field to the actions its description names', () => {
    const specs = catalog.find(spec => spec.name === 'specrails_specs_write')!
    const generate = fieldsForAction(specs, advertisedActions(specs), 'generate')
    expect(generate).toEqual(expect.arrayContaining(['idea', 'model', 'contextScope', 'projectId']))
    expect(generate).not.toContain('smashedAt')
    const describedGenerate = describe_({ name: 'specrails_specs_write', action: 'generate' })
    expect(describedGenerate).toMatchObject({ action: 'generate', tier: 'ai-spawn', required: ['idea'] })
    expect(describedGenerate.otherFields).toContain('smashedAt')
    expect(fieldsForAction(specs, advertisedActions(specs), 'dismiss_addendum')).toContain('addendumId')
  })

  it('describes an alias action as the call it stands for and rejects an unknown action', () => {
    expect(describe_({ name: 'specrails_jobs', action: 'runtime_diagnose' })).toMatchObject({ name: 'specrails_runs', action: 'diagnose', aliasOf: 'specrails_runs(diagnose)', required: ['jobId'] })
    expect(() => describe_({ name: 'specrails_jobs', action: 'nope' })).toThrow(/no action "nope"/)
  })

  it('keeps describe(name, arguments) validating the whole call', () => {
    const answer = describe_({ name: 'specrails_runs', action: 'steer', arguments: { action: 'steer', jobId: 'j1' } })
    expect(answer.validation).toMatchObject({ valid: false })
  })
})
