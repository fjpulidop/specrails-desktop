import { INHERIT_ROLE_PROMPT, type RuntimeConfig } from '../../agent-runtime/runtime/agent-runtime-settings'

/** Published recipe data. Connections and repository verification remain host-owned.
 *  Implementation definitions are `inherit`: the engine (Core) owns how a role thinks, so a
 *  launch resolves them to the selected Core's factory definitions plus the user's global
 *  overrides. Edited recipe text stays frozen with the loop. */
export type LoopAgentConfig = Pick<RuntimeConfig, 'agents' | 'fixer' | 'roles' | 'rolePrompts' | 'limits' | 'review' | 'architect' | 'approvalBeforeArchive' | 'efficiency' | 'guardrails'> & { schemaVersion: 1 }

export function defaultLoopAgents(mode: 'implementation' | 'free' = 'implementation'): LoopAgentConfig {
  return {
    schemaVersion: 1,
    agents: { architect: { provider: 'inherit' }, developer: { provider: 'inherit' }, reviewer: { provider: 'inherit' } },
    fixer: { provider: 'inherit' },
    rolePrompts: mode === 'implementation' ? { architect: INHERIT_ROLE_PROMPT, developer: INHERIT_ROLE_PROMPT, reviewer: INHERIT_ROLE_PROMPT, fixer: INHERIT_ROLE_PROMPT } : {
      architect: 'Explore the repositories and plan the requested work from the supplied goal and acceptance criteria.',
      developer: 'Implement the supplied spec directly in the existing codebase. Explore relevant code, make the requested changes and add meaningful tests. Use the project verification commands. If a human decision is required, finish with LOOP_BLOCKED: followed by the specific question.',
      reviewer: 'Review actual code and verification evidence against the supplied acceptance criteria. Report correctness, security and regression issues.',
      fixer: 'Correct the reported implementation or verification failures with focused changes and tests. Preserve previously completed requirements. If a human decision is required, finish with LOOP_BLOCKED: followed by the specific question.',
    },
    roles: { 'loop-decider': { provider: 'inherit', access: 'read', artifacts: 'none', prompt: 'Inspect actual implementation and verification evidence against every frozen acceptance criterion. Request corrections until the goal is satisfied.' } },
  }
}
