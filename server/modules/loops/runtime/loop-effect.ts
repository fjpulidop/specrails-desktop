/**
 * Classify a loop by whether it can WRITE to the repo, DERIVED from node content
 * (not a user toggle). Used by the isolation gate so a repo-mutating loop is
 * isolated and a genuinely read-only loop is not.
 *
 * A loop is `read-only` only when it contains NO node that can mutate the working
 * tree — no `shell` node (arbitrary command) and no `ai-step` node (the AI can
 * edit files). Any of those makes it `mutating`. Deliberately conservative: a
 * false `read-only` would let a repo-mutating loop skip isolation (dangerous),
 * whereas a false `mutating` only costs a cleaned-up empty worktree (harmless).
 * `start` / `end` / `decider` / `condition` never write.
 */
import type { LoopGraph } from './loop-graph'

export function classifyLoopEffect(graph: LoopGraph): 'mutating' | 'read-only' {
  const writes = graph.nodes.some((n) => n.type === 'ai-step' || n.type === 'shell')
  return writes ? 'mutating' : 'read-only'
}

/** Convenience: true when the loop mutates the repo (derived from its nodes). */
export function loopIsMutating(graph: LoopGraph): boolean {
  return classifyLoopEffect(graph) === 'mutating'
}
