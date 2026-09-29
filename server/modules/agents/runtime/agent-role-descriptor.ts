import { load, JSON_SCHEMA } from 'js-yaml'
export interface RuntimeRoleDescriptor {
  provider: string; model?: string; maxTurns?: number; effort?: string; thinking?: 'on' | 'off'; escalation?: { model: string; effort?: string }
  access: 'read' | 'write'
  artifacts: 'none' | 'tasks-checkboxes' | 'all'
  prompt?: string
  openspecSkill?: 'openspec-ff-change' | 'openspec-apply-change' | 'openspec-verify-change'
}

export interface CustomAgentRoleDocument { id: string; content: string }
export const RUNTIME_ROLE_ID = /^[a-z][a-z0-9-]{0,63}$/
const BUILTINS = new Set(['architect', 'developer', 'reviewer', 'fixer'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Pure frontmatter-to-role mapping; source access never follows model/prompt wording. */
export function projectCustomAgentRole(document: CustomAgentRoleDocument, fallback: Pick<RuntimeRoleDescriptor, 'provider' | 'model' | 'effort'>): { id: string; role: RuntimeRoleDescriptor } {
  const id = document.id.startsWith('custom-') ? document.id.slice(7) : ''
  if (!RUNTIME_ROLE_ID.test(id) || BUILTINS.has(id)) throw new Error(`Custom agent ${document.id} must map to a non-built-in role matching ${RUNTIME_ROLE_ID.source}`)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(document.content)
  if (!match && document.content.startsWith('---')) throw new Error(`Custom agent ${document.id} has incomplete YAML frontmatter`)
  const metadata = match ? load(match[1], { schema: JSON_SCHEMA }) : {}
  if (!object(metadata)) throw new Error(`Custom agent ${document.id} has invalid frontmatter`)
  if (metadata.name !== undefined && metadata.name !== document.id) throw new Error(`Custom agent ${document.id} frontmatter name differs from its file identity`)
  const prompt = (match ? match[2] : document.content).trim()
  if (!prompt || prompt.length > 20_000 || prompt.includes('\0')) throw new Error(`Custom agent ${document.id} instructions must contain 1–20,000 characters`)
  const access = metadata.access ?? 'read', artifacts = metadata.artifacts ?? 'none'
  if (!['read', 'write'].includes(String(access)) || !['none', 'tasks-checkboxes', 'all'].includes(String(artifacts))) throw new Error(`Custom agent ${document.id} declares invalid source or artifact access`)
  if (metadata.openspecSkill !== undefined && !['openspec-ff-change', 'openspec-apply-change', 'openspec-verify-change'].includes(String(metadata.openspecSkill))) throw new Error(`Custom agent ${document.id} declares an unsupported OpenSpec skill`)
  const engine = metadata.engine === undefined ? {} : metadata.engine
  if (!object(engine) || Object.keys(engine).some(key => !['provider', 'model', 'effort', 'thinking', 'maxTurns', 'escalation'].includes(key))) throw new Error(`Custom agent ${document.id} engine must contain only provider, model, effort, thinking, maxTurns and escalation`)
  const provider = engine.provider ?? fallback.provider
  const model = engine.model ?? (metadata.model === 'inherit' ? undefined : metadata.model) ?? fallback.model
  const effort = engine.effort ?? metadata.effort ?? fallback.effort
  if (typeof provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) ||
    model !== undefined && (typeof model !== 'string' || !model || model.length > 256 || /^-|[\r\n\0]/.test(model)) ||
    effort !== undefined && (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) ||
    engine.thinking !== undefined && !['on', 'off'].includes(String(engine.thinking)) ||
    engine.maxTurns !== undefined && (!Number.isSafeInteger(engine.maxTurns) || (engine.maxTurns as number) < 1)) throw new Error(`Custom agent ${document.id} has invalid engine settings`)
  const escalation = engine.escalation
  if (escalation !== undefined && (
    !object(escalation) || Object.keys(escalation).some(key => !['model', 'effort'].includes(key)) ||
    typeof escalation.model !== 'string' || !escalation.model || escalation.model.length > 256 || /^-|[\r\n\0]/.test(escalation.model) ||
    escalation.effort !== undefined && (typeof escalation.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(escalation.effort)) ||
    !model || escalation.model === model && escalation.effort === effort
  )) throw new Error(`Custom agent ${document.id} escalation requires a valid, different model or effort and an explicit base model`)
  return { id, role: { provider, ...(model === undefined ? {} : { model: model as string }), ...(effort === undefined ? {} : { effort: effort as string }),
    access: access as RuntimeRoleDescriptor['access'], artifacts: artifacts as RuntimeRoleDescriptor['artifacts'], prompt,
    ...(metadata.openspecSkill === undefined ? {} : { openspecSkill: metadata.openspecSkill as RuntimeRoleDescriptor['openspecSkill'] }),
    ...(engine.thinking === undefined ? {} : { thinking: engine.thinking as 'on' | 'off' }), ...(engine.maxTurns === undefined ? {} : { maxTurns: engine.maxTurns as number }),
    ...(escalation === undefined ? {} : { escalation: escalation as RuntimeRoleDescriptor['escalation'] }) } }
}

export function projectCustomAgentRoles(documents: readonly CustomAgentRoleDocument[], fallback: Pick<RuntimeRoleDescriptor, 'provider' | 'model' | 'effort'>, explicit: Readonly<Record<string, RuntimeRoleDescriptor>> = {}): Record<string, RuntimeRoleDescriptor> {
  const roles: Record<string, RuntimeRoleDescriptor> = {}
  for (const document of documents) {
    const { id, role } = projectCustomAgentRole(document, fallback)
    if (Object.hasOwn(roles, id)) throw new Error(`Duplicate custom agent role ${id}`)
    roles[id] = { ...role, ...explicit[id] }
  }
  return { ...roles, ...Object.fromEntries(Object.entries(explicit).filter(([id]) => !Object.hasOwn(roles, id))) }
}
