// The scripted engine's behaviour. `modeOf`, `detectRole`, `minimalInstance` and
// `roleObject` are pure; `engineOutput` performs the role's file and OpenSpec
// work for the `complete` mode.
import fs from 'node:fs'
import path from 'node:path'
import { builderReply, slicesFor } from './builder.mjs'

export const MODES = Object.freeze(['complete', 'stall', 'limit', 'fail', 'question'])
const MARKER = /\[eval-engine:([a-z]+)\]/

/** The mode a prompt asks for: its marker, else the default, else `complete`. */
export function modeOf(prompt, fallback) {
  const hit = MARKER.exec(String(prompt ?? ''))
  if (hit && MODES.includes(hit[1])) return hit[1]
  return MODES.includes(fallback) ? fallback : 'complete'
}

/** Core role of a structured call, from its --json-schema shape. */
export function detectRole(schema) {
  const props = schema?.properties ?? {}
  const required = schema?.required ?? []
  if (required.includes('approved') && required.includes('score')) return 'reviewer'
  if (required.includes('incomplete') && required.includes('summary')) return 'developer'
  if (props.planningDepth || props.question || (props.confidence && props.clarifications)) return 'architect'
  if (schema) return 'structured'
  return 'text'
}

/** The smallest value that satisfies a JSON schema (enough for the shapes Core and Desktop use). */
export function minimalInstance(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type
  if (schema.anyOf || schema.oneOf) return minimalInstance((schema.anyOf ?? schema.oneOf)[0])
  switch (type) {
    case 'object': {
      const out = {}
      for (const key of schema.required ?? []) out[key] = minimalInstance(schema.properties?.[key] ?? {})
      return out
    }
    case 'array': return Array.from({ length: schema.minItems ?? 0 }, () => minimalInstance(schema.items ?? {}))
    case 'string': return 'x'.repeat(Math.max(1, schema.minLength ?? 2)).slice(0, schema.maxLength ?? 1000).replace(/^x+$/, s => s.length > 1 ? 'ok' : 'x')
    case 'integer':
    case 'number': return schema.minimum ?? 0
    case 'boolean': return true
    default: return null
  }
}

/** Keep only the keys a closed schema allows, on top of its minimal instance (pure). */
export function fitToSchema(object, schema) {
  if (!schema || typeof object !== 'object' || object === null || Array.isArray(object)) return object
  const props = schema.properties ?? {}
  const closed = schema.additionalProperties === false
  const out = { ...(minimalInstance(schema) ?? {}) }
  for (const [key, value] of Object.entries(object)) if (!closed || key in props) out[key] = props[key]?.type === 'object' ? fitToSchema(value, props[key]) : value
  return out
}

/** The structured reply a role gives in `mode` (pure). */
export function roleObject(role, mode, schema) {
  return schema ? fitToSchema(rawRoleObject(role, mode, schema), schema) : rawRoleObject(role, mode, schema)
}

function rawRoleObject(role, mode, schema) {
  if (role === 'architect') return mode === 'question'
    ? { confidence: 'low', question: 'Which storage should the feature use?', questionWhy: 'It decides the design.',
      questionOptions: [{ id: 'a', label: 'Option A: a JSON file', meaning: 'Store values in a JSON file' }, { id: 'b', label: 'Option B: SQLite', meaning: 'Store values in SQLite' }],
      recommendedOption: 'a', verification: [] }
    : { confidence: 'high', question: '', planningDepth: 'focused', planningReason: 'Small scripted change', verification: [] }
  if (role === 'developer') return { summary: 'Implemented the scripted change.', files: ['src/eval-change.js'], tests: [], verification: 'none', incomplete: [] }
  if (role === 'reviewer') return { approved: true, summary: 'Scripted review: the change matches the spec.', issues: [], score: 90,
    aspects: Object.fromEntries(Object.keys(schema?.properties?.aspects?.properties ?? {}).map(k => [k, 90])), acceptance: { criteria: [], checks: [], findings: [] } }
  return minimalInstance(schema)
}

const LIMIT_TEXT = "You've hit your session limit · resets 3am (Europe/Madrid)"

/** Active OpenSpec change folders under `root` (not the archive). */
function activeChanges(root) {
  const dir = path.join(root, 'openspec', 'changes')
  try { return fs.readdirSync(dir).filter(n => n !== 'archive' && fs.existsSync(path.join(dir, n, 'tasks.md'))).map(n => path.join(dir, n)) } catch { return [] }
}

/** Perform one invocation; returns `{ text, structured?, isError?, exitCode?, stderr? }`. */
/** Where a Builder session keeps its slices (next to the engine log), or null without one. */
function builderStateFile(session) {
  const log = process.env.EVAL_ENGINE_LOG
  return log && session ? path.join(path.dirname(log), 'builder-sessions', `${String(session).replace(/[^\w.-]/g, '_')}.json`) : null
}

export async function engineOutput({ mode, role, schema, prompt, cwd, mcpConfig, openspecClient, session = null }) {
  // Builder turns always answer with a full blueprint; a marker in the person's message rides into its first spec.
  if (role === 'builder') {
    // The slices the conversation asked for so far ride in a per-session file (a resumed turn sees only its message).
    const file = builderStateFile(session)
    let previous = []
    try { previous = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).slices ?? [] : [] } catch { previous = [] }
    const slices = slicesFor(prompt, previous)
    if (file) try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ slices })) } catch { /* best effort */ }
    return { text: builderReply({ marker: MARKER.exec(String(prompt ?? ''))?.[0] ?? null, slices }) }
  }
  if (mode === 'limit') return { text: LIMIT_TEXT, isError: true, exitCode: 1, stderr: LIMIT_TEXT }
  if (mode === 'fail') return { text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error (scripted)"}}', isError: true, exitCode: 1 }
  const object = roleObject(role, mode, schema)
  if (mode === 'complete' && ['architect', 'developer', 'reviewer'].includes(role)) {
    const tools = await openspecClient(mcpConfig).catch(() => null)
    try {
      if (tools) {
        await tools.call({ action: 'load_skill' })
        if (role !== 'architect') await tools.call({ action: 'instructions', artifact: 'apply' })
      }
      if (role === 'architect' && tools) {
        const title = (/title[":\s]+([^\n"]{3,80})/i.exec(prompt)?.[1] ?? 'Scripted change').trim()
        const files = [
          ['proposal', 'proposal.md', `# ${title}\n\n## Why\nThe spec asks for it.\n\n## What Changes\n- Add src/eval-change.js.\n`],
          ['design', 'design.md', '# Design\nOne new module.\n\n## Non-Goals\n- Nothing else changes.\n'],
          ['specs', 'specs/eval-change/spec.md', '## ADDED Requirements\n### Requirement: Scripted change\nThe system SHALL export the scripted value.\n#### Scenario: Value exported\n- **WHEN** the module is loaded\n- **THEN** it exports the scripted value\n'],
          ['tasks', 'tasks.md', '## 1. Implementation\n- [ ] 1.1 Add src/eval-change.js\n'],
        ]
        for (const [artifact, file, content] of files) {
          await tools.call({ action: 'instructions', artifact }).catch(() => null)
          await tools.call({ action: 'write_artifact', path: file, content })
        }
      }
      if (role === 'developer') {
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'src', 'eval-change.js'), `export const SCRIPTED = ${JSON.stringify(new Date().toISOString())}\n`)
        for (const change of activeChanges(cwd)) {
          const file = path.join(change, 'tasks.md')
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'))
        }
      }
    } finally { await tools?.close?.().catch(() => {}) }
  }
  if (object === null || object === undefined) return { text: 'Done.' }
  return { text: JSON.stringify(object), structured: typeof object === 'object' ? object : undefined }
}
