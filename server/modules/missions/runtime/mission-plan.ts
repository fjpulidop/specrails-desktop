/**
 * The mission's work plan: the steps the agent set out to do and how far it got, shown in the mission's
 * Plan pill (client: MissionPlanPill) and readable over MCP. Two sources feed it:
 * - the agent's own todo list when its provider has one (Claude's `TodoWrite`, seen in the turn's tool
 *   calls): nothing extra to ask of the agent;
 * - Specrails' `specrails_missions(plan)` (in-app agents of any provider; the Intent persona asks for it).
 *
 * Stored as a silent system row (`mission-plan`), so it persists, reaches every window over the usual
 * message events and keeps its history: a new plan (a different list of work, or one after the previous
 * was finished) opens a new row; updates to the current one rewrite it in place.
 */
import type { DbInstance } from '../../../db'
import { findAgentSystemMessages } from '../../agents/runtime/agent-store'
import { getAgentChatManager } from './agent-chat-registry'

export const MISSION_PLAN_KIND = 'mission-plan'
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'
export interface PlanStep { content: string; status: PlanStepStatus }
export interface MissionPlan { title: string | null; steps: PlanStep[] }
export interface MissionPlanRow extends MissionPlan {
  kind: typeof MISSION_PLAN_KIND
  /** Who wrote it: the agent's todo tool, or Specrails' plan action. */
  source: 'todo-tool' | 'specrails'
  at: string
}

const MAX_STEPS = 40
const MAX_STEP_CHARS = 240
const MAX_TITLE_CHARS = 120
const STATUS: Record<string, PlanStepStatus> = { pending: 'pending', in_progress: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', completed: 'completed', done: 'completed', complete: 'completed' }

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** A plan from loose input (`steps` of `{ content|step|text, status }`), or null when it holds no step. */
export function normalizePlan(input: { title?: unknown; steps?: unknown }): MissionPlan | null {
  const steps = (Array.isArray(input.steps) ? input.steps : []).flatMap((raw): PlanStep[] => {
    const step = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    const text = step ? [step.content, step.step, step.text].find((value) => typeof value === 'string' && value.trim()) as string | undefined : typeof raw === 'string' ? raw : undefined
    if (!text?.trim()) return []
    const status = STATUS[String(step?.status ?? 'pending').toLowerCase()] ?? 'pending'
    return [{ content: clip(text, MAX_STEP_CHARS), status }]
  }).slice(0, MAX_STEPS)
  if (!steps.length) return null
  const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, MAX_TITLE_CHARS) : null
  return { title, steps }
}

/** Claude's `TodoWrite` input (`{ todos: [{ content, status, activeForm }] }`) as a plan, or null. */
export function planFromTodoWrite(input: unknown): MissionPlan | null {
  const value = typeof input === 'string' ? (() => { try { return JSON.parse(input) as unknown } catch { return null } })() : input
  const todos = value && typeof value === 'object' ? (value as { todos?: unknown }).todos : undefined
  return Array.isArray(todos) ? normalizePlan({ steps: todos }) : null
}

/** A todo-list tool Specrails reads as the plan (the provider's own name for it). */
export function isTodoTool(name: string): boolean {
  return name === 'TodoWrite'
}

const done = (plan: MissionPlan) => plan.steps.every((step) => step.status === 'completed')
const sharesWork = (a: MissionPlan, b: MissionPlan) => {
  const before = new Set(a.steps.map((step) => step.content.toLowerCase()))
  return b.steps.some((step) => before.has(step.content.toLowerCase()))
}

/** Per conversation: the row the current plan lives in (in memory; a restart starts a new row). */
const current = new Map<string, { key: string; plan: MissionPlan }>()
let sequence = 0

/**
 * Publishes the mission's plan. The same work (a step in common, not finished) updates its row in place;
 * a new list of work opens a new row, so the history keeps each plan. Never throws: the plan is advisory.
 */
export function publishMissionPlan(conversationId: string, plan: MissionPlan, source: MissionPlanRow['source']): boolean {
  try {
    const chat = getAgentChatManager()
    if (!chat) return false
    const previous = current.get(conversationId)
    const key = previous && !done(previous.plan) && sharesWork(previous.plan, plan) ? previous.key : `${MISSION_PLAN_KIND}:${conversationId}:${Date.now()}:${++sequence}`
    const row: MissionPlanRow = { kind: MISSION_PLAN_KIND, title: plan.title ?? previous?.plan.title ?? null, steps: plan.steps, source, at: new Date().toISOString() }
    const id = chat.upsertSystemRow(conversationId, { ...row }, key)
    if (id === null) return false
    current.set(conversationId, { key, plan: { title: row.title, steps: plan.steps } })
    return true
  } catch (err) {
    console.error('[mission-plan] could not publish the plan:', err)
    return false
  }
}

/** The mission's latest plan (MCP reads it), or null. */
export function latestMissionPlan(db: DbInstance, conversationId: string): MissionPlanRow | null {
  const rows = findAgentSystemMessages(db, conversationId, (content) => content.includes(`"kind":"${MISSION_PLAN_KIND}"`))
  for (let index = rows.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(rows[index]!.content) as MissionPlanRow & { dedupeKey?: string }
      const plan = normalizePlan(parsed)
      if (parsed.kind === MISSION_PLAN_KIND && plan) return { kind: MISSION_PLAN_KIND, ...plan, source: parsed.source === 'todo-tool' ? 'todo-tool' : 'specrails', at: typeof parsed.at === 'string' ? parsed.at : '' }
    } catch { /* not a plan row */ }
  }
  return null
}
