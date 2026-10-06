import { defaultLoopAgents } from './loop-agents'
import type { LoopGraph, LoopNode, CoreNodeKind } from './loop-graph'

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const strings = { type: 'array', items: string, maxItems: 100 }
const score = { type: 'number', minimum: 0, maximum: 100 }
const aspects = { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 }
const reviewPolicy = 'approved == true; issues must be empty; score >= 70; ' + Object.entries(aspects).map(([aspect, threshold]) => `${aspect} >= ${threshold}`).join('; ')

export const HOST_BLOCKER_KINDS = ['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope'] as const
/** Fixer/developer structured `blocker`: the host ends the run on it instead of counting a correction round. */
const blocker = objectSchema({ kind: { enum: [...HOST_BLOCKER_KINDS] }, command: string, cwd: string, evidence: string, requiredAction: string }, ['kind', 'requiredAction'])

/** Host-owned environment repair and structured blockers need the paired Core generation. */
export const supportsHostBlockers = (capabilities?: Record<string, number>): boolean => capabilities?.hostBlockers === 1

/** The recipe, roles, schemas and decisions are Desktop data, never Core phases.
 *  `capabilities` are the installed Core's advertised runtime capabilities: without `hostBlockers`
 *  the verify nodes compile exactly as before (no `setup`, no `blocked` edge, no `blockerFrom`). */
export function configurableImplementGraph(capabilities?: Record<string, number>): LoopGraph {
  const hostBlockers = supportsHostBlockers(capabilities)
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
  const turn = (id: string, label: string, roleId: string, prompt: string, schema: Record<string, unknown>, next: string, extra: Record<string, unknown> = {}) => node(id, label, 'role-turn', { roleId, prompt, structuredOutput: schema, sessionContinuity: 'none', ...extra }, { next, invalid: 'failed', failed: 'failed' })
  const verifyParams = { commands: 'configured', additionalCommandsFrom: 'architect', ...(hostBlockers ? { setup: 'configured', hostBlockers: true } : {}) }
  const verifyEnds = (passed: string, failed: string, blockedEnd: string) => ({ pass: passed, fail: failed, failed: 'failed', ...(hostBlockers ? { blocked: blockedEnd } : {}) })
  // Same Core generation as host blockers: older role-turn schemas reject unknown params.
  const writes = hostBlockers ? { verificationProposalsFrom: 'architect' } : {}
  const change = '{{run.changeId}}'
  turn('architect', 'Architect', 'plan', `Plan the frozen ticket requirements for OpenSpec change ${change}. Use the bound official fast-forward skill. Author complete proposal, design, delta specs and actionable tasks. Propose existing repository verification commands for repositories with no configured checks. Return confidence, question (empty when none), and verification [{repositoryId,command,args,cwd?}]. When revisiting low confidence, investigate the missing repository evidence before asking again. Context and human answers: {{history.text}}`, objectSchema({ confidence: { enum: ['high', 'medium', 'low'] }, question: string, verification: { type: 'array', maxItems: 20, items: objectSchema({ repositoryId: string, command: string, args: strings, cwd: string }, ['repositoryId', 'command', 'args']) } }), 'confidence')
  node('confidence', 'Planning confidence', 'condition', { expr: '$outputs.architect.structured.confidence != "low"' }, { true: 'validate', false: 'investigate' })
  node('investigate', 'Investigate low confidence once', 'condition', { expr: '!exists($vars.planInvestigated) || $vars.planInvestigated == false' }, { true: 'mark-investigated', false: 'clarify' })
  node('mark-investigated', 'Mark confidence investigation', 'assign', { set: { planInvestigated: true } }, { next: 'architect', failed: 'failed' })
  node('clarify', 'Clarify plan', 'question', { text: '{{outputs.architect.structured.question}}' }, { next: 'reset-confidence' })
  node('reset-confidence', 'Reset confidence after answer', 'assign', { set: { planInvestigated: false } }, { next: 'architect', failed: 'failed' })
  node('validate', 'Validate OpenSpec', 'openspec-validate', { change }, { pass: 'freeze', fail: 'architect', failed: 'failed' })
  node('freeze', 'Freeze approved artifacts', 'artifact-contract', { change, contractId: 'plan', action: 'freeze' }, { pass: 'initialize-corrections', fail: 'architect', failed: 'failed' })
  node('initialize-corrections', 'Initialize automatic correction budget', 'assign', { set: { correctionAttempts: 0, correctionLimit: 3 } }, { next: 'developer', failed: 'failed' })
  const implementation = objectSchema({ summary: string, incomplete: strings, blocker }, ['summary', 'incomplete'])
  turn('developer', 'Developer', 'build', `Implement every approved task for change ${change} using the bound official apply skill. Preserve proposal, design and specs; only tick tasks you completed. Report summary and incomplete task descriptions. Prior execution evidence and human answers: {{history.text}}`, implementation, 'tasks', writes)
  node('tasks', 'Check artifacts and completed tasks', 'artifact-contract', { change, contractId: 'plan', action: 'check', requireCompletedTasks: true }, { pass: 'verify', fail: 'developer', failed: 'failed' })
  node('verify', 'Verify candidate', 'verify', verifyParams, verifyEnds('reviewer', 'correction-context', 'host-blocked'))
  turn('reviewer', 'Reviewer', 'assess', `Review change ${change} read-only against all approved artifacts and frozen ticket acceptance criteria. Inspect real code and the host verification evidence: {{outputs.verify}}. Return approved, summary, issues, score (0-100), and aspects. Acceptance policy: ${reviewPolicy}. For any rejection or below-threshold score, explain the concrete unmet requirement and actionable repair in summary and issues; passing commands do not prove every acceptance obligation. Prior execution: {{history.text}}`, objectSchema({ approved: { type: 'boolean' }, summary: string, issues: strings, score, aspects: objectSchema(Object.fromEntries(Object.keys(aspects).map(aspect => [aspect, score]))) }), 'review-policy')
  node('review-policy', 'Review acceptance policy', 'condition', { expr: ['$outputs.reviewer.structured.approved == true', '$outputs.reviewer.structured.issues.length == 0', '$outputs.reviewer.structured.score >= 70', ...Object.entries(aspects).map(([aspect, threshold]) => `$outputs.reviewer.structured.aspects.${aspect} >= ${threshold}`)].join(' && ') }, { true: 'approve', false: 'correction-context' })
  node('correction-context', 'Select current review findings', 'condition', { expr: '$outputs.verify.valid == true && exists($outputs.reviewer.candidateHash) && $outputs.reviewer.candidateHash == $outputs.verify.candidateHash' }, { true: 'capture-review', false: 'clear-review' })
  node('capture-review', 'Capture current review findings', 'assign', { set: { latestReview: '{{outputs.reviewer.structured}}' } }, { next: 'correction-budget', failed: 'failed' })
  node('clear-review', 'Clear outdated review findings', 'assign', { set: { latestReview: 'No reviewer findings for the current verified candidate. Diagnose the current host verification failure first.' } }, { next: 'correction-budget', failed: 'failed' })
  node('correction-budget', 'Check automatic correction budget', 'condition', { expr: '$vars.correctionAttempts < $vars.correctionLimit' }, { true: 'begin-correction', false: 'correction-exhausted' })
  node('begin-correction', 'Count automatic correction attempt', 'assign', { increment: { correctionAttempts: 1 } }, { next: 'fixer', failed: 'failed' })
  turn('fixer', 'Fixer', 'correct', `Correct the reported implementation, test or review failure for change ${change} using the bound apply skill and preserving approved artifacts. Read failureSummary, command, cwd, exitCode and evidenceId first; use read_verification_evidence for truncated evidence. If Host verification is valid, repair the concrete rejected review obligation or below-threshold aspect instead of only rerunning green commands. Acceptance policy: ${reviewPolicy}. Reproduce the exact focused failure, inspect the assertion and tested code, then apply the smallest repair that preserves the required behavior. An unchanged filename does not prove an unrelated failure. A mandatory test inside the admitted workspace may receive a proven formatting/compatibility repair while retaining every required guard. Report diagnosis, focused commands with original exit codes, repair and unresolved failures in summary and incomplete. If the cause is a host precondition or environment blocker outside this change, make no edits and return the structured blocker (kind, command, cwd, evidence, requiredAction): the host ends the run with your required action. Any other unchanged correction stops this run even when host checks pass. Do not make unrelated edits merely to change the candidate hash. Host verification: {{outputs.verify}}. Latest review findings for this candidate: {{run.latestReview}}. Prior execution: {{history.text}}`, implementation, 'correction-blocker', writes)
  node('correction-blocker', 'Fixer reported a host blocker', 'condition', { expr: 'exists($outputs.fixer.structured.blocker) && $outputs.fixer.structured.blocker != null' }, { true: 'fixer-blocked', false: 'correction-progress' })
  node('correction-progress', 'Check correction progress', 'condition', { expr: 'exists($outputs.fixer.candidateHash) && $outputs.fixer.candidateHash != null && $outputs.fixer.candidateHash != $outputs.verify.candidateHash' }, { true: 'tasks', false: 'correction-stalled' })
  node('approve', 'Approve archive', 'approval', { reason: `Approve archiving the reviewed and verified candidate for change ${change}.`, bindCandidate: true, enabled: agents.approvalBeforeArchive === true }, { next: 'approval-policy' })
  node('approval-policy', 'Approval decision', 'condition', { expr: '$outputs.approve.response.approved == true' }, { true: 'archive', false: 'failed' })
  node('archive', 'Archive OpenSpec', 'openspec-archive', { change, allowArchived: true, requiresVerified: true, reviewedCandidate: '{{outputs.reviewer.candidateHash}}', approvedCandidate: '{{outputs.approve.candidateHash}}' }, { next: 'verify-archive', failed: 'verify' })
  node('verify-archive', 'Verify archived candidate', 'verify', verifyParams, verifyEnds('done', 'failed', 'host-blocked-archive'))
  nodes.push({ id: 'done', type: 'end', position: { x: 0, y: nodes.length * 140 }, data: { outcome: 'success', requiresVerified: true } }, { id: 'failed', type: 'end', position: { x: 360, y: nodes.length * 140 }, data: { outcome: 'failure' } },
    { id: 'correction-stalled', type: 'end', position: { x: 720, y: nodes.length * 140 }, data: { outcome: 'failure', reason: `Automatic correction made no candidate changes. Host verification is valid: {{outputs.verify.valid}}. Acceptance policy: ${reviewPolicy}. Latest review findings: {{run.latestReview}}. Fixer diagnosis: {{outputs.fixer.structured.summary}}` } },
    { id: 'correction-exhausted', type: 'end', position: { x: 1080, y: nodes.length * 140 }, data: { outcome: 'failure', reason: `Automatic correction limit reached ({{run.correctionAttempts}}/{{run.correctionLimit}}). Acceptance policy: ${reviewPolicy}. Latest review findings: {{run.latestReview}}. Fixer diagnosis: {{outputs.fixer.structured.summary}}. Host verification: {{outputs.verify}}` } },
    { id: 'fixer-blocked', type: 'end', position: { x: 1440, y: nodes.length * 140 }, data: { outcome: 'failure', reason: 'Fixer reported a host blocker ({{outputs.fixer.structured.blocker.kind}}): {{outputs.fixer.structured.blocker.requiredAction}} Evidence: {{outputs.fixer.structured.blocker.evidence}}', ...(hostBlockers ? { blockerFrom: 'fixer' } : {}) } })
  if (hostBlockers) {
    const hostBlocked = (id: string, source: string) => ({ id, type: 'end' as const, position: { x: 1800, y: nodes.length * 140 }, data: { outcome: 'failure' as const, blockerFrom: source, reason: `Host blocker ({{outputs.${source}.blocker.kind}}): {{outputs.${source}.blocker.reason}} Required action: {{outputs.${source}.blocker.requiredAction}}` } })
    nodes.push(hostBlocked('host-blocked', 'verify'), hostBlocked('host-blocked-archive', 'verify-archive'))
  }
  edges.unshift({ id: 'e-start', source: 'start', target: 'architect' })
  return { nodes, edges, config: { maxIterations: 12, maxTransitions: 200, timeoutMinutes: 0, aiStepTimeoutMinutes: 0, change: 'new', journal: 'ledger-only', ticketScope: 'all', agents, reviewerStepId: 'reviewer' } }
}
