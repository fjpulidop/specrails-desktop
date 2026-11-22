import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modeOf, detectRole, minimalInstance, roleObject, fitToSchema, engineOutput } from './engine/scripted.mjs'
import { builderReply, isBuilderTurn, platformFor, slicesFor } from './engine/builder.mjs'

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine', 'claude')
const DEV = { type: 'object', additionalProperties: false, required: ['summary', 'incomplete'], properties: { summary: { type: 'string' }, incomplete: { type: 'array', items: { type: 'string' } }, blocker: { type: 'object' } } }
const REVIEW = { type: 'object', additionalProperties: false, required: ['approved', 'summary', 'issues', 'score', 'aspects'], properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, issues: { type: 'array' }, score: { type: 'number' }, aspects: { type: 'object', required: ['security'], properties: { security: { type: 'number' } } } } }
const ARCH = { type: 'object', additionalProperties: false, required: ['confidence', 'question', 'verification'], properties: { confidence: { enum: ['high', 'low'] }, question: { type: 'string' }, questionOptions: { type: 'array' }, recommendedOption: { type: 'string' }, verification: { type: 'array' } } }

test('mode from the prompt marker, else the default, else complete', () => {
  assert.equal(modeOf('do it [eval-engine:stall] now'), 'stall')
  assert.equal(modeOf('plain', 'fail'), 'fail')
  assert.equal(modeOf('[eval-engine:bogus]', 'nope'), 'complete')
})

test('roles from the structured-output schema', () => {
  assert.equal(detectRole(ARCH), 'architect')
  assert.equal(detectRole(DEV), 'developer')
  assert.equal(detectRole(REVIEW), 'reviewer')
  assert.equal(detectRole({ type: 'object', properties: { x: {} } }), 'structured')
  assert.equal(detectRole(undefined), 'text')
})

test('replies satisfy the closed schemas Desktop and Core pass', () => {
  assert.deepEqual(Object.keys(roleObject('developer', 'complete', DEV)).sort(), ['incomplete', 'summary'])
  const review = roleObject('reviewer', 'complete', REVIEW)
  assert.equal(review.approved, true)
  assert.deepEqual(review.aspects, { security: 90 })
  assert.equal('acceptance' in review, false, 'a key the schema does not allow is dropped')
  const architect = roleObject('architect', 'complete', ARCH)
  assert.equal(architect.confidence, 'high')
  assert.equal(architect.question, '')
  const asking = roleObject('architect', 'question', ARCH)
  assert.equal(asking.confidence, 'low')
  assert.equal(asking.questionOptions.length, 2)
  assert.deepEqual(minimalInstance({ type: 'object', required: ['a', 'b'], properties: { a: { type: 'integer', minimum: 3 }, b: { type: 'array', minItems: 1, items: { type: 'boolean' } } } }), { a: 3, b: [true] })
  assert.deepEqual(fitToSchema({ x: 1, y: 2 }, { type: 'object', additionalProperties: false, properties: { x: {} } }), { x: 1 })
})

test('limit and fail modes fail like the provider does', async () => {
  const limit = await engineOutput({ mode: 'limit', role: 'architect', schema: ARCH, prompt: '', cwd: os.tmpdir(), openspecClient: async () => null })
  assert.equal(limit.isError, true)
  assert.match(limit.text, /hit your session limit/)
  const fail = await engineOutput({ mode: 'fail', role: 'developer', schema: DEV, prompt: '', cwd: os.tmpdir(), openspecClient: async () => null })
  assert.match(fail.text, /API Error: 500/)
})

test('the developer edits the worktree and ticks the OpenSpec tasks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-engine-'))
  try {
    fs.mkdirSync(path.join(cwd, 'openspec', 'changes', 'c1'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'openspec', 'changes', 'c1', 'tasks.md'), '- [ ] 1.1 Do it\n')
    const out = await engineOutput({ mode: 'complete', role: 'developer', schema: DEV, prompt: '', cwd, openspecClient: async () => null })
    assert.equal(out.structured.incomplete.length, 0)
    assert.ok(fs.existsSync(path.join(cwd, 'src', 'eval-change.js')))
    assert.match(fs.readFileSync(path.join(cwd, 'openspec', 'changes', 'c1', 'tasks.md'), 'utf8'), /- \[x\] 1\.1/)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('the claude shim answers --help/--version and scripts print-mode turns', () => {
  assert.match(spawnSync(shim, ['--help'], { encoding: 'utf8' }).stdout, /--mcp-config[\s\S]*--allowedTools[\s\S]*--resume/)
  assert.match(spawnSync(shim, ['--version'], { encoding: 'utf8' }).stdout, /Claude Code/)
  assert.equal(spawnSync(shim, ['login'], { encoding: 'utf8' }).status, 2, 'interactive use is refused')
  const turn = spawnSync(shim, ['-p', '--output-format', 'stream-json', '--json-schema', JSON.stringify(REVIEW)], { input: 'review it', encoding: 'utf8' })
  const frames = turn.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(frames[0].type, 'system')
  const result = frames.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.total_cost_usd, 0)
  assert.equal(result.structured_output.approved, true)
  const limited = spawnSync(shim, ['-p', '--output-format', 'stream-json'], { input: 'work [eval-engine:limit]', encoding: 'utf8' })
  assert.equal(limited.status, 1)
  assert.match(limited.stdout, /hit your session limit/)
})

test('builder turns: a complete blueprint-draft snapshot, the marker riding into the first spec', async () => {
  assert.equal(isBuilderTurn('Emit a ```blueprint-draft block'), true)
  assert.equal(isBuilderTurn('Implement the spec'), false)
  const block = text => JSON.parse(/```blueprint-draft\n([\s\S]*?)\n```/.exec(text)[1])
  const plain = block(builderReply())
  assert.equal(plain.blueprintVersion, 1)
  assert.equal(plain.specsComplete, true)
  assert.equal(plain.m1Specs.length, 5)
  assert.equal(plain.m1Specs[0].kind, 'scaffold')
  assert.equal(new Set(plain.m1Specs.map(s => s.title)).size, 5)
  const marked = block(builderReply({ marker: '[eval-engine:question]' }))
  assert.match(marked.m1Specs[0].description, /\[eval-engine:question\]$/)
  // The person's messages pick the slices (a revision adds to them), always within the gate's 5–10 specs.
  assert.deepEqual(slicesFor('A small todo app'), ['add a todo', 'list the todos', 'mark a todo done', 'delete a todo'])
  const first = slicesFor('A todo app: add tasks, mark them done, delete them and filter by all/active/done.')
  assert.deepEqual(first, ['add a todo', 'mark a todo done', 'delete a todo', 'filter the todos by status'])
  assert.deepEqual(slicesFor('Please also let me edit a todo.', first), ['add a todo', 'mark a todo done', 'edit a todo', 'delete a todo', 'filter the todos by status'])
  const revised = block(builderReply({ slices: slicesFor('edit too', first) }))
  assert.equal(revised.m1Specs.length, 6)
  assert.ok(revised.m1Specs.some(s => s.title === 'Let the user edit a todo'))
  assert.ok(!revised.milestones[1].plannedSpecs.includes('Filter by status'))
  const out = await engineOutput({ mode: 'question', role: 'builder', prompt: 'A todo CLI [eval-engine:question]' })
  assert.match(out.text, /```blueprint-draft/)
  assert.match(out.text, /eval-engine:question/)
})

test('the codex shim publishes its model catalog, so Core confirms the effort of a switched run', () => {
  const codex = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine', 'codex')
  const out = spawnSync(codex, ['debug', 'models'], { encoding: 'utf8' })
  assert.equal(out.status, 0)
  const sol = JSON.parse(out.stdout).models.find(m => m.slug === 'gpt-6.2-sol')
  assert.ok(sol.supported_reasoning_levels.some(l => l.effort === 'medium'))
})

test('triage turns answer one JSON object on an offered loop', async () => {
  const { isTriageTurn, triageAnswer, engineOutput: run } = await import('./engine/scripted.mjs')
  assert.equal(isTriageTurn('You triage one software spec before implementation.'), true)
  const answer = JSON.parse(triageAnswer('Triage evidence (JSON data):\n' + JSON.stringify({ spec: {}, loops: [{ id: 'factory:quick', name: 'Quick' }] })))
  assert.equal(answer.recommendedLoop, 'factory:quick')
  assert.equal(answer.size, 'S')
  assert.match((await run({ mode: 'complete', role: 'triage', prompt: '{"loops":[]}' })).text, /"size":"S"/)
})

test('builder turns follow the platform the person names, revisions included', () => {
  assert.equal(platformFor('A small todo app'), 'cli')
  assert.equal(platformFor('A todo single-page web app with localStorage'), 'web')
  assert.equal(platformFor('Make it a browser app, not a CLI or Node.js tool', 'cli'), 'web')
  assert.equal(platformFor('Add an edit feature', 'web'), 'web')
  const block = text => JSON.parse(/```blueprint-draft\n([\s\S]*?)\n```/.exec(text)[1])
  const web = block(builderReply({ platform: 'web' }))
  assert.match(web.platform, /Web/)
  assert.equal(web.stack.db, 'browser localStorage')
  assert.match(web.m1Specs[1].shortSummary, /in the browser/)
  assert.match(block(builderReply()).platform, /CLI/)
})
