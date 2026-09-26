import type { CoreNodeKind, LoopGraph, WorkflowPieceDescriptor } from './loops-api'
import type { LoopNodeData } from './loop-graph-rf'

export type ParameterSchema = Record<string, unknown>
export const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export function schemaType(schema: ParameterSchema): string {
  if (typeof schema.type === 'string') return schema.type
  if (schema.properties || schema.additionalProperties) return 'object'
  if (schema.items) return 'array'
  return 'string'
}

/** Only explicit defaults and required fields are materialized; optional policy stays Core-owned. */
export function parameterDefault(schema: ParameterSchema): unknown {
  if ('default' in schema) return structuredClone(schema.default)
  if ('const' in schema) return structuredClone(schema.const)
  if (Array.isArray(schema.enum)) return structuredClone(schema.enum[0])
  const alternatives = schema.oneOf ?? schema.anyOf
  if (Array.isArray(alternatives) && !schema.properties) return parameterDefault(asObject(alternatives[0]))
  switch (schemaType(schema)) {
    case 'boolean':
      return false
    case 'number':
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'array':
      return []
    case 'object': {
      const properties = asObject(schema.properties)
      return Object.fromEntries(
        (Array.isArray(schema.required) ? schema.required : [])
          .filter((key) => typeof key === 'string')
          .map((key) => [key, parameterDefault(asObject(properties[key]))]),
      )
    }
    default:
      return ''
  }
}

export function coreNodeData(piece: WorkflowPieceDescriptor): LoopNodeData {
  const params = asObject(parameterDefault(piece.paramsSchema))
  if (piece.kind === 'prompt') {
    params.text = ''
    params.engine = { provider: 'claude' }
    params.access = 'read'
  }
  if (piece.kind === 'shell') params.argv = ['']
  return { kind: 'core', coreKind: piece.kind, params }
}

/** Presentation selects from Core's published union; Core validates effective labels on publication. */
export function effectiveOutcomes(
  piece: WorkflowPieceDescriptor | undefined,
  params: Record<string, unknown>,
  components: LoopGraph['components'] = {},
): string[] {
  if (!piece) return []
  let labels = piece.outcomes
  if (piece.kind === 'prompt')
    labels =
      params.sentinel === 'verification'
        ? ['pass', 'fail', 'failed']
        : params.sentinel === 'blocked'
          ? ['next', 'blocked', 'failed']
          : ['next', 'failed']
  if (piece.kind === 'role-turn')
    labels = params.structuredOutput ? ['next', 'invalid', 'failed'] : ['next', 'failed']
  if (piece.kind === 'component') return components[String(params.ref)]?.outputs ?? ['next', 'failed']
  return labels.filter((label) => piece.outcomes.includes(label))
}

export const pieceGroup = (kind: CoreNodeKind): 'ai' | 'verification' | 'openspec' | 'control' =>
  ['prompt', 'role-turn', 'decider', 'implementation'].includes(kind)
    ? 'ai'
    : ['verify', 'shell'].includes(kind)
      ? 'verification'
      : kind.startsWith('openspec-')
        ? 'openspec'
        : 'control'
