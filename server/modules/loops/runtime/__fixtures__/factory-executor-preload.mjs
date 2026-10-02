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
      fs.appendFileSync(process.env.SPECRAILS_FACTORY_CALLS, JSON.stringify({ role: request.role, model: request.model, nativeCommand: request.nativeCommand ?? null, access: request.access, artifacts: request.artifacts, prompt: request.prompt }) + '\n')
      const blockAt = process.env.SPECRAILS_FACTORY_BLOCK
      const blockedMarker = process.env.SPECRAILS_FACTORY_CALLS + '.blocked'
      if (blockAt && (request.nativeCommand?.id ?? request.role) === blockAt && !fs.existsSync(blockedMarker)) {
        fs.writeFileSync(blockedMarker, 'accepted question')
        return { text: 'LOOP_BLOCKED: Confirm the requested value?', usage }
      }
      if (request.nativeCommand) {
        const change = request.nativeCommand.args.trim().split(/\s/)[0], active = path.join(request.cwd, 'openspec/changes', change)
        if (request.nativeCommand.id === 'opsx:ff') {
          await runOpenSpec(resolveOpenSpecCli(), request.cwd, ['new', 'change', change, '--json'])
          for (const [file, content] of Object.entries(artifacts('feature'))) { fs.mkdirSync(path.dirname(path.join(active, file)), { recursive: true }); fs.writeFileSync(path.join(active, file), content) }
        } else if (request.nativeCommand.id === 'opsx:apply') {
          fs.writeFileSync(path.join(request.cwd, 'code.cjs'), request.role === 'build' && process.env.SPECRAILS_FACTORY_CORRECT === '1' ? 'module.exports = 3\n' : 'module.exports = 2\n')
          fs.writeFileSync(path.join(active, 'tasks.md'), '- [x] 1. Update and verify the function\n')
        } else throw Error('Unexpected native command')
        return { text: 'Native skill completed', usage }
      }
      if (request.prompt.includes('You are the Loop Decider')) return { text: JSON.stringify({ verdict: process.env.SPECRAILS_FACTORY_STALL === '1' ? 'continue' : 'stop', reason: process.env.SPECRAILS_FACTORY_STALL === '1' ? 'Another acceptance obligation remains missing.' : 'Actual host checks now prove the requested value.' }), usage }
      if (request.role === 'accessibility') return { text: 'Accessibility review completed against actual code.', usage }
      if (!request.openspec) {
        if (request.prompt.includes('Implement the following spec completely')) {
          if (!request.prompt.includes('Title: Return two') || !request.prompt.includes('code.cjs returns two') || request.prompt.includes('openspec-apply-change'))
            throw Error('Freestyle received an unrendered spec or instructions for an unbound apply workflow')
        }
        // The first claimed PASS is intentionally false; only the fix turn
        // changes code. This proves sentinels cannot replace host verification.
        if (++promptTurns > 1) fs.writeFileSync(path.join(request.cwd, 'code.cjs'), 'module.exports = 2\n')
        return { text: 'VERIFICATION: PASS', usage }
      }
      const tools = new OpenSpecTools(request.openspec), change = request.openspec.change
      const omitReviewWorkflow = ['reviewer', 'assess'].includes(request.role) && process.env.SPECRAILS_FACTORY_OMIT_REVIEW_WORKFLOW === '1'
      if (!omitReviewWorkflow) await tools.execute({ action: 'load_skill' })
      if (['architect', 'plan'].includes(request.role)) {
        await tools.execute({ action: 'new' })
        for (const [file, content] of Object.entries(artifacts('feature-' + change.slice(-6)))) {
          const artifact = file.startsWith('specs/') ? 'specs' : file.slice(0, -3)
          await tools.execute({ action: 'instructions', artifact })
          await tools.execute({ action: 'write_artifact', path: file, content })
        }
        const calls = fs.readFileSync(process.env.SPECRAILS_FACTORY_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const low = process.env.SPECRAILS_FACTORY_CONFIDENCE === '1' && calls.filter(call => call.role === 'plan').length <= 2
        return { text: request.role === 'plan' ? JSON.stringify({ confidence: low ? 'low' : 'high', question: low ? 'Confirm the requested value?' : '', verification: [] }) : '{"confidence":"high"}', usage }
      }
      if (!omitReviewWorkflow) await tools.execute({ action: 'instructions', artifact: 'apply' })
      if (['developer', 'build', 'correct'].includes(request.role)) {
        if (request.role === 'correct' && process.env.SPECRAILS_FACTORY_NOOP === '1') return { text: JSON.stringify({ summary: 'Queue-modal test is outside the approved scope; no edits were made.', incomplete: [] }), usage }
        if (request.role === 'correct' && process.env.SPECRAILS_FACTORY_REGEX === '1') {
          const file = path.join(request.cwd, 'guard.test.cjs')
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('&& !confirmPending/', '&&\\s*!confirmPending/'))
        }
        const calls = fs.readFileSync(process.env.SPECRAILS_FACTORY_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const breakReviewCorrection = request.role === 'correct' && process.env.SPECRAILS_FACTORY_STALE_REVIEW === '1' && calls.filter(call => call.role === 'correct').length === 1
        fs.writeFileSync(path.join(request.cwd, 'code.cjs'), (request.role === 'build' && process.env.SPECRAILS_FACTORY_CORRECT === '1') || breakReviewCorrection ? 'module.exports = 3\n' : 'module.exports = 2\n')
        const file = path.join(request.openspec.root, 'openspec/changes', change, 'tasks.md')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'))
        return { text: request.role === 'developer' ? 'Implemented the required value.' : '{"summary":"Implemented the required value.","incomplete":[]}', usage }
      }
      if (request.role === 'assess') {
        const ids = JSON.parse(process.env.SPECRAILS_FACTORY_ADDENDA ?? '[]')
        const calls = fs.readFileSync(process.env.SPECRAILS_FACTORY_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const verdict = calls.filter(call => call.role === 'assess').length === 1 ? 'partial' : 'applied'
        if (ids.length && calls.filter(call => call.role === 'assess').length > 1 && !calls.find(call => call.role === 'correct')?.prompt.includes('"verdict":"partial"')) throw Error('The correction prompt omitted the actual reviewer finding')
        const addenda = Object.fromEntries(ids.map((id, index) => [`a${index}`, { id, verdict, files: ['code.cjs'], tests: ['Node verifies value equals 2'] }]))
        return { text: JSON.stringify({ approved: true, summary: 'Read actual code and verification evidence', issues: [], score: 90, aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 }, ...(ids.length ? { addenda } : {}) }), usage }
      }
      const obligations = JSON.parse(request.prompt.split('Current frozen acceptance obligations (all remain required):\n')[1].split('\n')[0])
      return { text: JSON.stringify({ approved: true, summary: 'Inspected actual code and host verification', issues: [], score: 90,
        aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
        acceptance: { criteria: obligations.map(item => ({ specId: item.specId, criterionIndex: item.criterionIndex, status: 'met', evidence: ['code.cjs returns 2 and host verification passed'] })), checks: [], findings: [] } }), usage }
    },
  }
  ExecutorRegistry.prototype.get = function(id) { if (id !== 'claude') throw Error('Unexpected provider'); return executor }
}
