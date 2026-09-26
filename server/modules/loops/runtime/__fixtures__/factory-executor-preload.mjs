// Test-only executor replacement. The bridge, CLI, graph, OpenSpec and host
// verification remain real; no provider executable or network is contacted.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const core = process.env.SPECRAILS_FACTORY_CORE
if (core && path.resolve(process.argv[1] ?? '') === path.join(core, 'dist/agent-runtime/cli.js')) {
  const load = relative => import(pathToFileURL(path.join(core, 'dist', relative)).href)
  const { ExecutorRegistry } = await load('agent-runtime/executors.js')
  const { OpenSpecTools, resolveOpenSpecCli, runOpenSpec } = await load('agent-runtime/openspec.js')
  const usage = { inputTokens: 10, outputTokens: 5, costUsd: null }
  let promptTurns = 0
  const artifacts = capability => ({
    'proposal.md': `## Why\nReturn the required value.\n## What Changes\nUpdate code.cjs.\n## Capabilities\n### New Capabilities\n- ${capability}: Return two.\n## Impact\nOne function.\n`,
    'design.md': '## Design\nSet the value and verify it with Node.\n',
    [`specs/${capability}/spec.md`]: '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** code.cjs is loaded\n- **THEN** its value is two\n',
    'tasks.md': '- [ ] 1. Update and verify the function\n',
  })
  const executor = {
    capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request) {
      fs.appendFileSync(process.env.SPECRAILS_FACTORY_CALLS, JSON.stringify({ role: request.role, nativeCommand: request.nativeCommand ?? null, access: request.access, artifacts: request.artifacts }) + '\n')
      if (request.nativeCommand) {
        const change = request.nativeCommand.args.trim().split(/\s/)[0], active = path.join(request.cwd, 'openspec/changes', change)
        if (request.nativeCommand.id === 'opsx:ff') {
          await runOpenSpec(resolveOpenSpecCli(), request.cwd, ['new', 'change', change, '--json'])
          for (const [file, content] of Object.entries(artifacts('feature'))) { fs.mkdirSync(path.dirname(path.join(active, file)), { recursive: true }); fs.writeFileSync(path.join(active, file), content) }
        } else if (request.nativeCommand.id === 'opsx:apply') {
          fs.writeFileSync(path.join(request.cwd, 'code.cjs'), 'module.exports = 2\n')
          fs.writeFileSync(path.join(active, 'tasks.md'), '- [x] 1. Update and verify the function\n')
        } else throw Error('Unexpected native command')
        return { text: 'Native skill completed', usage }
      }
      if (request.prompt.includes('You are the Loop Decider')) return { text: JSON.stringify({ verdict: 'stop', reason: 'Actual host checks now prove the requested value.' }), usage }
      if (!request.openspec) {
        // The first claimed PASS is intentionally false; only the fix turn
        // changes code. This proves sentinels cannot replace host verification.
        if (++promptTurns > 1) fs.writeFileSync(path.join(request.cwd, 'code.cjs'), 'module.exports = 2\n')
        return { text: 'VERIFICATION: PASS', usage }
      }
      const tools = new OpenSpecTools(request.openspec), change = request.openspec.change
      await tools.execute({ action: 'load_skill' })
      if (request.role === 'architect') {
        await tools.execute({ action: 'new' })
        for (const [file, content] of Object.entries(artifacts('feature-' + change.slice(-6)))) {
          const artifact = file.startsWith('specs/') ? 'specs' : file.slice(0, -3)
          await tools.execute({ action: 'instructions', artifact })
          await tools.execute({ action: 'write_artifact', path: file, content })
        }
        return { text: '{"confidence":"high"}', usage }
      }
      await tools.execute({ action: 'instructions', artifact: 'apply' })
      if (request.role === 'developer') {
        fs.writeFileSync(path.join(request.cwd, 'code.cjs'), 'module.exports = 2\n')
        const file = path.join(request.openspec.root, 'openspec/changes', change, 'tasks.md')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'))
        return { text: 'Implemented the required value.', usage }
      }
      const obligations = JSON.parse(request.prompt.split('Current frozen acceptance obligations (all remain required):\n')[1].split('\n')[0])
      return { text: JSON.stringify({ approved: true, summary: 'Inspected actual code and host verification', issues: [], score: 90,
        aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
        acceptance: { criteria: obligations.map(item => ({ specId: item.specId, criterionIndex: item.criterionIndex, status: 'met', evidence: ['code.cjs returns 2 and host verification passed'] })), checks: [], findings: [] } }), usage }
    },
  }
  ExecutorRegistry.prototype.get = function(id) { if (id !== 'claude') throw Error('Unexpected provider'); return executor }
}
