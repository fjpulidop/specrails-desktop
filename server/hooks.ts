import { Router, Request, Response } from 'express'
import type { PhaseState, PhaseDefinition, WsMessage } from './types'
import type { DbInstance } from './db'
import { upsertPhase } from './db'

const DEFAULT_PHASE_DEFINITIONS: PhaseDefinition[] = [
  { key: 'architect', label: 'Architect', description: 'Analyzes the issue, researches the codebase, and designs the implementation plan' },
  { key: 'developer', label: 'Developer', description: 'Implements the changes: writes code, edits files, runs tests' },
  { key: 'reviewer', label: 'Reviewer', description: 'Reviews the implementation for correctness, edge cases, and code quality' },
  { key: 'ship', label: 'Ship', description: 'Creates the PR, writes the description, and finalizes the changes for merge' },
]

// Phase tracking is PER-PROJECT — a module-level singleton bled one project's
// active phase set + live states into every other project's `/state` snapshot
// and `/hooks/events` validity check. Each project gets its own scope, keyed by
// projectId. (The WS phase broadcasts already carry the right projectId via the
// project's boundBroadcast; only this server-side snapshot/validity state was
// global.)
interface PhaseScope {
  activePhaseKeys: string[]
  activePhaseDefinitions: PhaseDefinition[]
  phases: Record<string, PhaseState>
}

const scopes = new Map<string, PhaseScope>()

function getScope(projectId: string): PhaseScope {
  let s = scopes.get(projectId)
  if (!s) {
    s = {
      activePhaseKeys: DEFAULT_PHASE_DEFINITIONS.map((d) => d.key),
      activePhaseDefinitions: [...DEFAULT_PHASE_DEFINITIONS],
      phases: Object.fromEntries(DEFAULT_PHASE_DEFINITIONS.map((d) => [d.key, 'idle' as PhaseState])),
    }
    scopes.set(projectId, s)
  }
  return s
}

/** Drop a project's phase scope (called on project removal to avoid a leak). */
export function dropPhaseScope(projectId: string): void {
  scopes.delete(projectId)
}

function isValidPhase(projectId: string, value: string): boolean {
  return getScope(projectId).activePhaseKeys.includes(value)
}

function eventToState(event: string): PhaseState | null {
  if (event === 'agent_start') return 'running'
  if (event === 'agent_stop') return 'done'
  if (event === 'agent_error') return 'error'
  return null
}

export function getPhaseStates(projectId: string): Record<string, PhaseState> {
  return { ...getScope(projectId).phases }
}

export function getPhaseDefinitions(projectId: string): PhaseDefinition[] {
  return [...getScope(projectId).activePhaseDefinitions]
}

export function setActivePhases(
  projectId: string,
  definitions: PhaseDefinition[],
  broadcast: (msg: WsMessage) => void
): void {
  const scope = getScope(projectId)
  // Clear old phase entries
  for (const key of scope.activePhaseKeys) {
    delete scope.phases[key]
  }
  // Install new phase set
  scope.activePhaseDefinitions = definitions
  scope.activePhaseKeys = definitions.map((d) => d.key)
  for (const key of scope.activePhaseKeys) {
    scope.phases[key] = 'idle'
    // Broadcast idle state for each new phase
    broadcast({
      type: 'phase',
      phase: key,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function resetPhases(projectId: string, broadcast: (msg: WsMessage) => void): void {
  const scope = getScope(projectId)
  for (const key of scope.activePhaseKeys) {
    scope.phases[key] = 'idle'
    broadcast({
      type: 'phase',
      phase: key,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function createHooksRouter(
  projectId: string,
  broadcast: (msg: WsMessage) => void,
  db?: DbInstance,
  activeJobRef?: { current: string | null }
): Router {
  const router = Router()

  router.post('/events', (req: Request, res: Response) => {
    const { event, agent } = req.body ?? {}

    if (!agent || !isValidPhase(projectId, agent)) {
      console.warn(`[hooks] unknown agent: ${agent}`)
      res.json({ ok: true })
      return
    }

    const newState = eventToState(event)
    if (!newState) {
      console.warn(`[hooks] unknown event: ${event}`)
      res.json({ ok: true })
      return
    }

    getScope(projectId).phases[agent] = newState
    broadcast({
      type: 'phase',
      phase: agent,
      state: newState,
      timestamp: new Date().toISOString(),
    })

    if (db && activeJobRef?.current) {
      upsertPhase(db, activeJobRef.current, agent, newState)
    }

    res.json({ ok: true })
  })

  return router
}
