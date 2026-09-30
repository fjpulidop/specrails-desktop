import { defaultLoopAgents } from './loop-agents'
import type { LoopGraph, LoopNode, CoreNodeKind } from './loop-graph'

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const strings = { type: 'array', items: string, maxItems: 100 }
const score = { type: 'number', minimum: 0, maximum: 100 }
const aspects = { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 }

/** The recipe, roles, schemas and decisions are Desktop data, never Core phases. */
export function configurableImplementGraph(): LoopGraph {
  const agents = defaultLoopAgents()
  agents.roles = {
    plan: { ...agents.agents.architect, access: 'read', artifacts: 'all', openspecSkill: 'openspec-ff-change', prompt: agents.rolePrompts?.architect },
    build: { ...agents.agents.developer, access: 'write', artifacts: 'tasks-checkboxes', openspecSkill: 'openspec-apply-change', prompt: agents.rolePrompts?.developer },
    assess: { ...agents.agents.reviewer, access: 'read', artifacts: 'none', openspecSkill: 'openspec-verify-change', prompt: agents.rolePrompts?.reviewer },
    correct: { ...agents.fixer!, access: 'write', artifacts: 'tasks-checkboxes', openspecSkill: 'openspec-apply-change', prompt: agents.rolePrompts?.fixer },
  }
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }], edges: LoopGraph['edges'] = []
  const node = (id: string, label: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>) => {
    nodes.push({ id, type: 'core', position: { x: 0, y: nodes.length * 140 }, data: { kind, label, params } })
    for (const [outcome, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${outcome}`, source: id, target, label: outcome })
  }
  const turn = (id: string, label: string, roleId: string, prompt: string, schema: Record<string, unknown>, next: string) => node(id, label, 'role-turn', { roleId, prompt, structuredOutput: schema, sessionContinuity: 'none' }, { next, invalid: 'failed', failed: 'failed' })
  const change = '{{run.changeId}}'
  turn('architect', 'Architect', 'plan', `Plan the frozen ticket requirements for OpenSpec change ${change}. Use the bound official fast-forward skill. Author complete proposal, design, delta specs and actionable tasks. Propose existing repository verification commands for repositories with no configured checks. Return confidence, question (empty when none), and verification [{repositoryId,command,args,cwd?}]. When revisiting low confidence, investigate the missing repository evidence before asking again. Context and human answers: {{history.text}}`, objectSchema({ confidence: { enum: ['high', 'medium', 'low'] }, question: string, verification: { type: 'array', maxItems: 20, items: objectSchema({ repositoryId: string, command: string, args: strings, cwd: string }, ['repositoryId', 'command', 'args']) } }), 'confidence')
  node('confidence', 'Planning confidence', 'condition', { expr: '$outputs.architect.structured.confidence != "low"' }, { true: 'validate', false: 'investigate' })
  node('investigate', 'Investigate low confidence once', 'condition', { expr: '!exists($vars.planInvestigated) || $vars.planInvestigated == false' }, { true: 'mark-investigated', false: 'clarify' })
  node('mark-investigated', 'Mark confidence investigation', 'assign', { set: { planInvestigated: true } }, { next: 'architect', failed: 'failed' })
  node('clarify', 'Clarify plan', 'question', { text: '{{outputs.architect.structured.question}}' }, { next: 'reset-confidence' })
  node('reset-confidence', 'Reset confidence after answer', 'assign', { set: { planInvestigated: false } }, { next: 'architect', failed: 'failed' })
  node('validate', 'Validate OpenSpec', 'openspec-validate', { change }, { pass: 'freeze', fail: 'architect', failed: 'failed' })
  node('freeze', 'Freeze approved artifacts', 'artifact-contract', { change, contractId: 'plan', action: 'freeze' }, { pass: 'developer', fail: 'architect', failed: 'failed' })
  const implementation = objectSchema({ summary: string, incomplete: strings })
  turn('developer', 'Developer', 'build', `Implement every approved task for change ${change} using the bound official apply skill. Preserve proposal, design and specs; only tick tasks you completed. Report summary and incomplete task descriptions. Prior execution evidence and human answers: {{history.text}}`, implementation, 'tasks')
  node('tasks', 'Check artifacts and completed tasks', 'artifact-contract', { change, contractId: 'plan', action: 'check', requireCompletedTasks: true }, { pass: 'verify', fail: 'developer', failed: 'failed' })
  node('verify', 'Verify candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'architect' }, { pass: 'reviewer', fail: 'fixer', failed: 'failed' })
  turn('reviewer', 'Reviewer', 'assess', `Review change ${change} read-only against all approved artifacts and frozen ticket acceptance criteria. Inspect real code and the host verification evidence: {{outputs.verify}}. Return approved, summary, issues, score (0-100), and aspects. Prior execution: {{history.text}}`, objectSchema({ approved: { type: 'boolean' }, summary: string, issues: strings, score, aspects: objectSchema(Object.fromEntries(Object.keys(aspects).map(aspect => [aspect, score]))) }), 'review-policy')
  node('review-policy', 'Review acceptance policy', 'condition', { expr: ['$outputs.reviewer.structured.approved == true', '$outputs.reviewer.structured.issues.length == 0', '$outputs.reviewer.structured.score >= 70', ...Object.entries(aspects).map(([aspect, threshold]) => `$outputs.reviewer.structured.aspects.${aspect} >= ${threshold}`)].join(' && ') }, { true: 'approve', false: 'fixer' })
  turn('fixer', 'Fixer', 'correct', `Correct only failures in change ${change}, using the bound apply skill and preserving approved artifacts. Report summary and incomplete tasks. Host verification: {{outputs.verify}}.  Prior execution: {{history.text}}`, implementation, 'tasks')
  node('approve', 'Approve archive', 'approval', { reason: `Approve archiving the reviewed and verified candidate for change ${change}.`, bindCandidate: true, enabled: agents.approvalBeforeArchive === true }, { next: 'approval-policy' })
  node('approval-policy', 'Approval decision', 'condition', { expr: '$outputs.approve.response.approved == true' }, { true: 'archive', false: 'failed' })
  node('archive', 'Archive OpenSpec', 'openspec-archive', { change, allowArchived: true, requiresVerified: true, reviewedCandidate: '{{outputs.reviewer.candidateHash}}', approvedCandidate: '{{outputs.approve.candidateHash}}' }, { next: 'verify-archive', failed: 'verify' })
  node('verify-archive', 'Verify archived candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'architect' }, { pass: 'done', fail: 'failed', failed: 'failed' })
  nodes.push({ id: 'done', type: 'end', position: { x: 0, y: nodes.length * 140 }, data: { outcome: 'success', requiresVerified: true } }, { id: 'failed', type: 'end', position: { x: 360, y: nodes.length * 140 }, data: { outcome: 'failure' } })
  edges.unshift({ id: 'e-start', source: 'start', target: 'architect' })
  return { nodes, edges, config: { maxIterations: 12, maxTransitions: 200, timeoutMinutes: 0, aiStepTimeoutMinutes: 0, change: 'new', journal: 'ledger-only', ticketScope: 'all', agents, reviewerStepId: 'reviewer' } }
}
