import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const vendored = resolve(process.cwd(), 'server/schemas/workflow-definition.schema.json')
const core = resolve(
  process.env.SPECRAILS_CORE_SOURCE_DIR ?? resolve(process.cwd(), '../specrails-core'),
  'schemas/workflow-definition.schema.json',
)
describe('workflow definition schema', () => {
  it('vendors the published versioned Core schema', () => {
    const schema = JSON.parse(readFileSync(vendored, 'utf8'))
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.properties.schemaVersion.const).toBe(1)
    expect(schema.required).toContain('version')
    expect(schema.additionalProperties).toBe(false)
  })
  it.skipIf(!existsSync(core))('has byte parity with the paired Core source', () => {
    expect(readFileSync(vendored)).toEqual(readFileSync(core))
  })
})
