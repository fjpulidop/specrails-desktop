import { describe, expect, it } from 'vitest'
import { gateToVerificationCommand, humanOnlyRules, parseRulesInventory, specFromRule } from './domain'

const D5 = {
  generatedAt: '2026-11-10T09:00:00Z',
  gates: [
    { id: 'eslint', kind: 'lint', command: 'npm run lint' },
    { id: 'architecture-tests', kind: 'test', command: 'npx vitest run server/modules/architecture.test.ts' },
    { kind: 'ci' },
  ],
  rules: [
    { text: 'Frontend API calls use getApiBase()', source: 'AGENTS.md:92', status: 'automatable', proposedCheck: 'ESLint rule forbidding literal /api/ prefixes in client/src' },
    { text: 'Desktop /api routes mount before /api/projects routes', source: 'AGENTS.md:90', status: 'enforcedBy', enforcedBy: 'route-order test' },
    { text: 'App settings are a modal; project settings are a route', source: 'AGENTS.md:101', status: 'humanOnly' },
    { text: 'Unclassified', status: 'maybe' },
  ],
}

describe('project rules inventory (annex D.5)', () => {
  it('parses gates and rules, counting statuses and dropping malformed entries', () => {
    const inventory = parseRulesInventory(D5)!
    expect(inventory.gates.map((gate) => gate.id)).toEqual(['eslint', 'architecture-tests'])
    expect(inventory.rules.map((rule) => [rule.index, rule.status])).toEqual([[0, 'automatable'], [1, 'enforcedBy'], [2, 'humanOnly']])
    expect(inventory.counts).toEqual({ enforcedBy: 1, automatable: 1, humanOnly: 1, unclassified: 0 })
    expect(inventory.rules[0].id).toBe('index-0')
    expect(inventory.classification).toBeNull()
    expect(inventory.dropped).toBe(2)
    expect(humanOnlyRules(inventory)).toEqual([{ text: 'App settings are a modal; project settings are a route', source: 'AGENTS.md:101' }])
    expect(humanOnlyRules(null)).toEqual([])
  })

  it('rejects documents that are not an inventory', () => {
    expect(parseRulesInventory(null)).toBeNull()
    expect(parseRulesInventory({ hello: 1 })).toBeNull()
    expect(parseRulesInventory({ schemaVersion: 2, rules: [] })).toBeNull()
  })

  it('offers only plain gate commands as verification entries', () => {
    expect(gateToVerificationCommand({ id: 'a', kind: 'lint', command: 'npm run lint' })).toEqual({ command: 'npm', args: ['run', 'lint'] })
    expect(gateToVerificationCommand({ id: 'b', kind: 'ci', command: 'npm test && npm run build' })).toBeNull()
    expect(gateToVerificationCommand({ id: 'c', kind: 'x', command: 'echo "$HOME"' })).toBeNull()
  })

  it('turns an automatable rule into a spec draft', () => {
    const spec = specFromRule(parseRulesInventory(D5)!.rules[0])
    expect(spec.title).toBe('Enforce: Frontend API calls use getApiBase()')
    expect(spec.description).toContain('ESLint rule forbidding literal /api/ prefixes in client/src')
    expect(spec.description).toContain('(AGENTS.md:92)')
    expect(spec.nonGoals.length).toBeGreaterThan(0)
  })

  it('reads the Core 5.7 shape: stable ids, gate sources, unclassified rules and the classification block', () => {
    const inventory = parseRulesInventory({
      schemaVersion: 1, generatedAt: 't',
      gates: [{ id: 'lint', kind: 'lint', command: 'npm run lint', source: 'package.json' }],
      rules: [{ id: 'r-0123456789ab', text: 'Never log secrets', source: 'AGENTS.md:4', status: 'unclassified' }],
      classification: { status: 'offline', reason: 'init runs offline' },
    })!
    expect(inventory.gates[0].source).toBe('package.json')
    expect(inventory.rules[0]).toMatchObject({ id: 'r-0123456789ab', status: 'unclassified' })
    expect(inventory.counts.unclassified).toBe(1)
    expect(inventory.classification).toEqual({ status: 'offline', provider: null, model: null, reason: 'init runs offline', classifiedAt: null })
    expect(parseRulesInventory({ rules: [], classification: { status: 'weird' } })!.classification?.status).toBe('unknown')
  })
})
