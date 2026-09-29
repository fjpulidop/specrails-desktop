import { dump, load, JSON_SCHEMA } from 'js-yaml'

export type AgentRoleField = 'access' | 'artifacts' | 'openspecSkill' | 'engine.provider' | 'engine.model' | 'engine.effort' | 'engine.thinking' | 'engine.maxTurns' | 'engine.escalation.model' | 'engine.escalation.effort'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Keep instructions byte-for-byte; structured edits only serialize frontmatter. */
export function readAgentRoleMetadata(body: string): { metadata: Record<string, unknown>; instructions: string; newline: string } {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/.exec(body)
  if (!match) throw new Error('invalid_frontmatter')
  const metadata = load(match[2], { schema: JSON_SCHEMA })
  if (!object(metadata) || metadata.engine !== undefined && !object(metadata.engine)) throw new Error('invalid_frontmatter')
  return { metadata, instructions: body.slice(match[0].length), newline: match[1] }
}

export function agentRoleField(metadata: Record<string, unknown>, field: AgentRoleField): string {
  let value: unknown = metadata
  for (const key of field.split('.')) value = object(value) ? value[key] : undefined
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

export function setAgentRoleMetadata(body: string, field: AgentRoleField, value: string): string {
  const { metadata, instructions, newline } = readAgentRoleMetadata(body)
  const segments = field.split('.')
  let target = metadata
  const ancestors: Array<{ parent: Record<string, unknown>; key: string }> = []
  for (const key of segments.slice(0, -1)) {
    if (!object(target[key])) target[key] = {}
    ancestors.push({ parent: target, key }); target = target[key] as Record<string, unknown>
  }
  const key = segments[segments.length - 1]
  if (value === '') delete target[key]
  else target[key] = field === 'engine.maxTurns' ? Number(value) : value
  for (const { parent, key: parentKey } of ancestors.reverse()) {
    if (object(parent[parentKey]) && Object.keys(parent[parentKey]).length === 0) delete parent[parentKey]
  }
  const frontmatter = dump(metadata, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true }).replace(/\n/g, newline)
  return `---${newline}${frontmatter}---${newline}${instructions}`
}
