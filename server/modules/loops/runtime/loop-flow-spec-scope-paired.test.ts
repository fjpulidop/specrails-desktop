import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { acceptedScopeEntries, buildAcceptedScope, buildFlowSummary, buildReturnBriefing, RETURN_SCOPE_CONDUCT, type IntentTranscriptMessage } from '../../intent/domain'
import { renderIntentForAgents } from '../../specs/domain/intent'
import { compileLoopToDefinition } from './loop-definition'
import { FLOW_SCOPE_DECISION_END, FLOW_SUMMARY_FILE, FLOW_UNREQUESTED_PREFIX, flowSpecGraph } from './loop-flow-spec-recipe'

// Intent → Spec against the REAL Core engine (derive-change, verify, the
// reviewer's prompt assembly, the review policy and archive) with
// deterministic local executors. Reproduces the generala-dorada Intent: its
// intent forbids rule changes, then the person asked for other rules during
// Explore and the agent recorded the decision. The reviewer must receive that
// decision as requested scope (and never be told to revert it); a change no
// request supports must stop the run for the PERSON, without a fixer round.
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
const coreMissing = !core || !existsSync(path.join(core, 'dist/agent-runtime/engine/runs.js'))
const timeout = process.platform === 'win32' ? 240_000 : 90_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const load = async <T>(relative: string): Promise<T> => await import(pathToFileURL(path.join(core!, 'dist', relative)).href) as T

const INTENT = renderIntentForAgents({
  problem: 'La pantalla de juego apila todo en vertical.', outcome: 'La pantalla de partida se organiza en dos columnas.',
  successSignals: [], affects: ['Pantalla de partida'], constraints: ['No cambiar reglas ni lógica de juego'], openQuestions: [],
})
const RULES_REQUEST = 'quiero las mismas reglas que la generala de 51 Worldwide Games de Switch (con el libre, una sola generala, el combo)'
const RULES_DECISION = 'cada jugador tendrá doce casillas; «Libre» suma los cinco dados y el bono añade 35 al alcanzar 63 en Números.'
const MESSAGES: IntentTranscriptMessage[] = [
  { role: 'user', content: 'quiero la pantalla de juego más horizontal, puntuaciones a la izquierda', at: '2026-11-21 20:37:13' },
  { role: 'assistant', content: 'Hecho.\nDecision: dos columnas, puntuaciones a la izquierda.', at: '2026-11-21 20:43:11' },
  { role: 'user', content: RULES_REQUEST, at: '2026-11-22 09:10:21' },
  { role: 'assistant', content: `Aplicado.\nDecision: ${RULES_DECISION}`, at: '2026-11-22 09:23:02' },
]

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}
function write(file: string, content: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content) }

/** A worktree reserved at the base, with the Intent's work committed on top: the layout, the rule change and (optionally) an unrequested extra. */
async function intentWorktree(options: { unrequested?: boolean } = {}) {
  const { validatePipelineContext, pipelineStateDirectory } = await load<{ validatePipelineContext(value: unknown): unknown; pipelineStateDirectory(context: unknown): string }>('pipeline/pipeline-state.js')
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow scope '))); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog)
  git(repository, 'init', '-q')
  write(path.join(repository, 'src/rules.cjs'), 'module.exports = { categories: 11, bonus: 0 }\n')
  write(path.join(repository, 'src/layout.cjs'), 'module.exports = "vertical"\n')
  git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'base')
  const base = git(repository, 'rev-parse', 'HEAD')
  write(path.join(repository, 'src/rules.cjs'), 'module.exports = { categories: 12, bonus: 35 }\n')
  write(path.join(repository, 'src/layout.cjs'), 'module.exports = "two-columns"\n')
  write(path.join(repository, 'src/rules.test.cjs'), 'const r = require("./rules.cjs"); if (r.categories !== 12 || r.bonus !== 35) process.exit(1)\n')
  if (options.unrequested) write(path.join(repository, 'src/credits.cjs'), 'module.exports = "credits screen"\n')
  git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'intent work')
  // What Desktop hands the run: the spec (intent + accepted scope, as the
  // executor appends the briefing) and the conversation summary file.
  const acceptedScope = buildAcceptedScope({ constraints: ['No cambiar reglas ni lógica de juego'], messages: MESSAGES })
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'flow-scope-run', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository, baseSha: base }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 11, title: 'Disposición horizontal', description: [INTENT, acceptedScope].join('\n\n') }] })
  write(path.join(pipelineStateDirectory(context), FLOW_SUMMARY_FILE), buildFlowSummary({ idea: null, messages: MESSAGES, intent: INTENT }))
  return { repository, context, acceptedScope }
}

interface Verdict { approved: boolean; issues: string[]; unrequested: string[] }
async function run(options: { unrequested?: boolean; review: (prompt: string) => Verdict }) {
  const { ExecutorRegistry } = await load<{ ExecutorRegistry: new () => { register(id: string, executor: unknown): unknown } }>('agent-runtime/executors.js')
  const { OpenSpecTools } = await load<{ OpenSpecTools: new (binding: unknown) => { execute(input: Record<string, unknown>): Promise<unknown> } }>('agent-runtime/openspec.js')
  const { createRun } = await load<{ createRun(input: Record<string, unknown>): Promise<{ state: { status: string; scopes: Array<{ nodePath: string; kind: string }> }; completion?: { ok: boolean; reasons: string[] } }> }>('agent-runtime/engine/runs.js')
  const { definitionVersion } = await load<{ definitionVersion(definition: unknown): string }>('agent-runtime/engine/canonical-json.js')
  const worktree = await intentWorktree(options)
  const requests: Array<{ role: string; prompt: string }> = []
  const files = ['src/rules.cjs', 'src/layout.cjs', 'src/rules.test.cjs', ...(options.unrequested ? ['src/credits.cjs'] : [])]
  const registry = new ExecutorRegistry()
  registry.register('fixture', { async execute(request: { role: string; prompt: string; openspec?: unknown }) {
    requests.push({ role: request.role, prompt: request.prompt })
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: null }
    if (request.role === 'reviewer') return { text: JSON.stringify({ summary: 'Reviewed', score: 90, ...options.review(request.prompt) }), usage }
    if (request.role === 'developer') throw new Error('No fixer round may run in these scenarios')
    const tools = new OpenSpecTools(request.openspec)
    await tools.execute({ action: 'load_skill' })
    await tools.execute({ action: 'new' })
    const artifacts: Array<[string, string, string]> = [
      ['proposal', 'proposal.md', '## Why\nThe person asked for a horizontal layout and the Switch rules.\n## What Changes\nTwo columns; twelve categories and the 35-point bonus.\n## Capabilities\n### New Capabilities\n- generala-match: Switch rules.\n## Impact\nRules and layout.\n'],
      ['design', 'design.md', '## Context\nDerived from the diff.\n## Blast radius\n' + files.map(file => `- \`${file}\`: changed in the Intent`).join('\n') + '\n## Rejected alternatives\nNone recorded.\n## Non-Goals\n- None.\n## Assumptions\n- Superseded: "No cambiar reglas" by the request of 2026-11-22 09:10 UTC.\n'],
      ['specs', 'specs/generala-match/spec.md', '## ADDED Requirements\n### Requirement: Twelve categories\nEach player SHALL have twelve categories and a 35-point numbers bonus.\n#### Scenario: Reach 63\n- **WHEN** the numbers reach 63\n- **THEN** the bonus adds 35\n'],
      ['tasks', 'tasks.md', '- [x] 1. Adopt the Switch rules\n  - Evidence: src/rules.cjs, src/rules.test.cjs\n- [x] 2. Two-column layout\n  - Evidence: src/layout.cjs (no test)\n' + (options.unrequested ? '- [x] 3. Credits\n  - Evidence: src/credits.cjs (no test)\n' : '')],
    ]
    for (const [artifact, file, content] of artifacts) {
      await tools.execute({ action: 'instructions', artifact })
      await tools.execute({ action: 'write_artifact', path: file, content })
    }
    return { text: JSON.stringify({ confidence: 'high', verification: [{ repositoryId: 'repo', command: process.execPath, args: ['src/rules.test.cjs'] }] }), usage }
  } })
  const roles = { deriver: { access: 'read' as const }, developer: { access: 'write' as const }, reviewer: { access: 'read' as const } }
  const definition = compileLoopToDefinition(flowSpecGraph(), { id: 'factory:flow-spec', title: 'Intent → Spec', provider: 'fixture', constants: {}, roles, changeId: 'disposicion-horizontal', briefing: worktree.acceptedScope })
  const published = { ...definition, version: definitionVersion(definition) }
  const role = { provider: 'fixture' }
  const config = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const result = await createRun({ context: worktree.context, config, definition: published, registry, change: 'disposicion-horizontal' })
  return { ...worktree, result, requests }
}

it.skipIf(coreMissing)('a rule change the person asked for during Explore reaches the reviewer as requested scope and is delivered, never reverted', async () => {
  const actual = await run({
    // A reviewer that follows its instructions: it may only ask to revert what
    // nobody requested. If the scope or the rule were missing it would demand
    // the revert, as the generala-dorada reviewer did.
    review: prompt => prompt.includes(RULES_REQUEST.slice(0, 60)) && prompt.includes('Never ask to revert, remove or restore behaviour the person asked for')
      ? { approved: true, issues: [], unrequested: [] }
      : { approved: false, issues: ['src/rules.cjs: Revert the rule changes; the intent preserves the game rules'], unrequested: [] },
  })
  expect(actual.result.state.status, JSON.stringify(actual.result.completion)).toBe('succeeded')
  expect(actual.requests.map(request => request.role)).toEqual(['deriver', 'reviewer'])
  const reviewer = actual.requests[1]!.prompt
  // Desktop's node prompt, Desktop's accepted scope (with provenance) and Core's derived-scope rule.
  expect(reviewer).toContain('a later request supersedes an earlier constraint it contradicts')
  expect(reviewer).toContain('Accepted scope (what the person asked for and decided during the Intent session)')
  expect(reviewer).toContain(`2026-11-22 09:10 UTC — Person asked: "${RULES_REQUEST}"`)
  expect(reviewer).toContain(`2026-11-22 09:23 UTC — Decision recorded: "${RULES_DECISION}"`)
  expect(reviewer).toContain('IS the requested scope, and a later request supersedes an earlier constraint of the spec\'s intent it contradicts')
  expect(reviewer).not.toContain('or the change must revert it')
  // The deriver read the summary with the precedence and the stamped decision.
  const deriver = actual.requests[0]!.prompt
  expect(deriver).toContain('A later one supersedes an earlier one, and any constraint of the intent, that it contradicts')
  expect(deriver).toContain(`- [2026-11-22 09:23 UTC] ${RULES_DECISION}`)
  expect(deriver).toContain('is requested scope: describe it as requirements, never as out-of-scope or incidental change')
  // Nothing the person asked for was undone.
  expect(readFileSync(path.join(actual.repository, 'src/rules.cjs'), 'utf8')).toContain('categories: 12, bonus: 35')
  expect(acceptedScopeEntries(MESSAGES)).toHaveLength(4)
}, timeout)

it.skipIf(coreMissing)('an unrequested change stops the run for the person to decide: no fixer round, nothing reverted, the return briefing offers the choice', async () => {
  const flagged = `${FLOW_UNREQUESTED_PREFIX} src/credits.cjs: a credits screen; no request or decision of the Intent supports it`
  const actual = await run({ unrequested: true, review: () => ({ approved: false, issues: [flagged], unrequested: [flagged] }) })
  expect(actual.result.state.status).toBe('failed')
  expect(actual.requests.map(request => request.role)).toEqual(['deriver', 'reviewer'])
  expect(actual.result.state.scopes).toEqual(expect.arrayContaining([expect.objectContaining({ nodePath: FLOW_SCOPE_DECISION_END, kind: 'end' })]))
  expect(actual.result.completion!.reasons.join('\n')).toContain('the person decides whether to keep them as requirements or revert them')
  expect(readFileSync(path.join(actual.repository, 'src/credits.cjs'), 'utf8')).toContain('credits screen')
  expect(readFileSync(path.join(actual.repository, 'src/rules.cjs'), 'utf8')).toContain('categories: 12, bonus: 35')
  // Back to Intent: the agent receives the change apart, with the person-decides conduct.
  const briefing = buildReturnBriefing({ reason: 'review', summary: 'Reviewed', issues: [flagged], issuesOmitted: 0, score: 90, failingChecks: [] })
  expect(briefing).toContain('the person decides each one; never revert it on your own):\n1. src/credits.cjs: a credits screen')
  expect(briefing).toContain(RETURN_SCOPE_CONDUCT)
}, timeout)
