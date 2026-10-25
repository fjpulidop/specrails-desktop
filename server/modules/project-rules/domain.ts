/**
 * Project rules inventory (feedback-2026-10 task 4.4, annex D.5).
 *
 * Core's rules step writes `.specrails/rules.json`: the gates the project
 * already runs (lint, type checks, architecture tests, hooks, CI, `openspec
 * validate`) and every written rule of CLAUDE.md / AGENTS.md / CONTRIBUTING
 * classified as `enforcedBy` (a check already enforces it), `automatable`
 * (a check could, `proposedCheck` says which) or `humanOnly` (a reviewer must
 * look). Desktop shows it in project settings, turns an automatable rule into
 * a spec in one click, lists human-only rules in the review packet and offers
 * the gates as the default verification plan.
 *
 * Pure: parsing, bounds and derivations only. Zero imports (pinned by the
 * architecture test). Tolerant: a malformed entry is dropped and counted,
 * never fatal; nothing here ever gates a run.
 */

export const RULES_FILE = 'rules.json'
const RULE_TEXT_CAP = 1000
const LIST_CAP = 500

/** `unclassified`: Core recorded the rule but could not classify it (offline
 *  `init`, no runtime configuration or a failed call; see `classification`). */
export type RuleStatus = 'enforcedBy' | 'automatable' | 'humanOnly' | 'unclassified'
export const RULE_STATUSES: readonly RuleStatus[] = ['enforcedBy', 'automatable', 'humanOnly', 'unclassified']

export interface RuleGate {
  id: string
  /** lint | format | typecheck | test | architecture | hook | ci | spec (Core 5.7); free text tolerated. */
  kind: string
  command: string
  /** Where Core found it (package.json, a workflow file…), when reported. */
  source: string | null
}

/** Core's `classification` block: why rules are (not) classified. */
export interface RulesClassification {
  status: 'classified' | 'cached' | 'offline' | 'unavailable' | 'failed' | 'empty' | 'unknown'
  provider: string | null
  model: string | null
  reason: string | null
  classifiedAt: string | null
}

export interface ProjectRule {
  /** Core's stable id (`r-<12 hex>`, a hash of file and statement); `index-<n>` for files without ids. */
  id: string
  /** Position inside the file. */
  index: number
  text: string
  /** Where the rule is written, e.g. `AGENTS.md:92`. */
  source: string | null
  status: RuleStatus
  enforcedBy: string | null
  proposedCheck: string | null
}

export interface ProjectRulesInventory {
  generatedAt: string | null
  gates: RuleGate[]
  rules: ProjectRule[]
  counts: Record<RuleStatus, number>
  classification: RulesClassification | null
  /** Entries Desktop skipped because they did not match the contract. */
  dropped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, cap = RULE_TEXT_CAP): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, cap) : null
}

/** Parse a rules.json document; null when it is not an object with lists. */
export function parseRulesInventory(value: unknown): ProjectRulesInventory | null {
  if (!isRecord(value) || (!Array.isArray(value.gates) && !Array.isArray(value.rules))) return null
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return null
  let dropped = 0
  const gates: RuleGate[] = []
  for (const raw of Array.isArray(value.gates) ? value.gates : []) {
    const command = isRecord(raw) ? text(raw.command, 500) : null
    if (!isRecord(raw) || !command) { dropped++; continue }
    if (gates.length >= LIST_CAP) continue
    gates.push({ id: text(raw.id, 120) ?? `gate-${gates.length + 1}`, kind: text(raw.kind, 40) ?? 'other', command, source: text(raw.source, 300) })
  }
  const rules: ProjectRule[] = []
  const counts: Record<RuleStatus, number> = { enforcedBy: 0, automatable: 0, humanOnly: 0, unclassified: 0 }
  const rawRules = Array.isArray(value.rules) ? value.rules : []
  rawRules.forEach((raw, index) => {
    const ruleText = isRecord(raw) ? text(raw.text) : null
    if (!isRecord(raw) || !ruleText || !RULE_STATUSES.includes(raw.status as RuleStatus)) { dropped++; return }
    if (rules.length >= LIST_CAP) return
    const status = raw.status as RuleStatus
    counts[status]++
    rules.push({
      id: text(raw.id, 64) ?? `index-${index}`,
      index,
      text: ruleText,
      source: text(raw.source, 300),
      status,
      enforcedBy: text(raw.enforcedBy, 300),
      proposedCheck: text(raw.proposedCheck),
    })
  })
  return { generatedAt: text(value.generatedAt, 64), gates, rules, counts, classification: parseClassification(value.classification), dropped }
}

const CLASSIFICATION_STATUSES: readonly RulesClassification['status'][] = ['classified', 'cached', 'offline', 'unavailable', 'failed', 'empty']

function parseClassification(value: unknown): RulesClassification | null {
  if (!isRecord(value)) return null
  const status = CLASSIFICATION_STATUSES.includes(value.status as RulesClassification['status']) ? value.status as RulesClassification['status'] : 'unknown'
  return { status, provider: text(value.provider, 64), model: text(value.model, 128), reason: text(value.reason, 600), classifiedAt: text(value.classifiedAt, 64) }
}

/** The rules a reviewer must check by hand ("Needs human eyes"). */
export function humanOnlyRules(inventory: ProjectRulesInventory | null | undefined): Array<{ text: string; source: string | null }> {
  return (inventory?.rules ?? []).filter((rule) => rule.status === 'humanOnly').map(({ text: ruleText, source }) => ({ text: ruleText, source }))
}

/**
 * A gate command as a verification entry, or null when it is not a plain
 * `command arg…` line. Core's verification runner never uses a shell, so a
 * gate with shell syntax (pipes, `&&`, redirections, substitutions, quotes)
 * is not offered rather than run differently than written.
 */
export function gateToVerificationCommand(gate: RuleGate): { command: string; args: string[] } | null {
  if (/[|&;<>`$(){}"'\\*?]/.test(gate.command)) return null
  const parts = gate.command.split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 32) return null
  return { command: parts[0], args: parts.slice(1) }
}

/** Spec fields for "Create spec" on an automatable rule (ticket source `rules`). */
export function specFromRule(rule: ProjectRule): { title: string; description: string; labels: string[]; nonGoals: string[] } {
  const check = rule.proposedCheck ?? 'An automated check that fails when the rule is broken'
  const title = `Enforce: ${rule.text}`.slice(0, 160)
  const description = [
    '## Problem Statement',
    `The project states this rule${rule.source ? ` (${rule.source})` : ''}, but no automated check enforces it today:`,
    '',
    `> ${rule.text}`,
    '',
    '## Proposed Solution',
    `${check}. Run it with the project's existing gates so a violation fails locally and in CI.`,
    '',
    '## Acceptance Criteria',
    '- [ ] The check fails on a deliberate violation of the rule, with a message naming the rule.',
    '- [ ] The check passes on the current codebase (or the existing violations are fixed in this change).',
    '- [ ] The check runs as part of the project\'s verification commands.',
    '- [ ] The rule\'s documentation points to the check that now enforces it.',
  ].join('\n')
  return { title, description, labels: ['rules', 'automation'], nonGoals: ['Changing what the rule says', 'Enforcing other rules from the inventory'] }
}
