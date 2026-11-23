import { describe, expect, it } from 'vitest'
import { buildToolSpecs } from '../tools/catalog'
import { V1_TO_V2, V1_UNALIASED_TOOLS, deprecationTarget, v1EquivalentOf, v2Equivalent } from '../tools/actions'
import { v2Catalog } from './index'

// The v1 → v2 alias bridge (tools/actions.ts): every v1 tool action names the
// v2 call that replaces it, and that call exists in the v2 catalog.

const v1 = buildToolSpecs()
const actionsOf = (spec: (typeof v1)[number]) => {
  const field = spec.inputSchema.action as { options?: unknown } | undefined
  return Array.isArray(field?.options) ? field.options as string[] : []
}
const { byName } = v2Catalog()

describe('v1 → v2 alias bridge', () => {
  it('maps every v1 tool and action (advertised and hidden) to an existing v2 call', () => {
    const missing: string[] = []
    for (const spec of v1) {
      if (V1_UNALIASED_TOOLS.has(spec.name)) continue
      const actions = actionsOf(spec)
      for (const action of actions.length ? actions : [null]) {
        const target = v2Equivalent(spec.name, action)
        if (!target || !byName.get(target.tool)?.actions[target.action]) missing.push(`${spec.name}(${action ?? ''}) → ${target ? `${target.tool}(${target.action})` : '?'}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('names only real v1 tools and actions', () => {
    const names = new Map(v1.map((spec) => [spec.name, new Set(actionsOf(spec))]))
    for (const [tool, mapping] of Object.entries(V1_TO_V2)) {
      expect(names.has(tool), tool).toBe(true)
      for (const action of Object.keys(mapping.actions ?? {})) expect(names.get(tool)?.has(action), `${tool}(${action})`).toBe(true)
    }
  })

  it('snapshots the full deprecation table', () => {
    const table = v1.filter((spec) => !V1_UNALIASED_TOOLS.has(spec.name)).flatMap((spec) => {
      const actions = actionsOf(spec)
      return (actions.length ? actions : [null]).map((action) => `${spec.name}(${action ?? ''}) → ${deprecationTarget(spec.name, action)}`)
    })
    expect(table).toMatchSnapshot()
  })

  it('names a v1 call for v2 actions that v1 already serves', () => {
    expect(v1EquivalentOf('specrails_runs', 'list')).toBe('specrails_jobs(list)')
    expect(v1EquivalentOf('specrails_overview', 'app')).toBe('specrails_status')
    expect(v1EquivalentOf('specrails_wait', 'events')).toBeNull()
  })
})
