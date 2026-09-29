export interface RuntimeTopologyNode {
  id: string
  kind: string
  label: string
  ends: Record<string, string | null>
  component?: string
}
export interface RuntimeTopologyBody { entry: string; nodes: RuntimeTopologyNode[] }
export interface RuntimeTopology extends RuntimeTopologyBody { components: Record<string, RuntimeTopologyBody> }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function body(value: unknown): RuntimeTopologyBody | null {
  if (!record(value) || typeof value.entry !== 'string' || !Array.isArray(value.nodes) || value.nodes.length > 10_000) return null
  const nodes: RuntimeTopologyNode[] = []
  for (const node of value.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !node.id || typeof node.kind !== 'string' || typeof node.label !== 'string' || !record(node.ends) || Object.values(node.ends).some(to => to !== null && typeof to !== 'string') || node.component !== undefined && typeof node.component !== 'string') return null
    nodes.push({ id: node.id, kind: node.kind, label: node.label, ends: node.ends as Record<string, string | null>, ...(typeof node.component === 'string' ? { component: node.component } : {}) })
  }
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length || !ids.has(value.entry) || nodes.some(node => Object.values(node.ends).some(to => to !== null && !ids.has(to)))) return null
  return { entry: value.entry, nodes }
}
/** Consume Core's public topology, never executable prompts or inferred edges. */
export function parseRuntimeTopology(value: unknown): RuntimeTopology | null {
  const root = body(value)
  if (!root || !record(value) || value.components !== undefined && !record(value.components)) return null
  const components: Record<string, RuntimeTopologyBody> = Object.create(null)
  for (const [id, raw] of Object.entries(value.components ?? {})) {
    const parsed = body(raw)
    if (!parsed) return null
    components[id] = parsed
  }
  return { ...root, components }
}
