import type { DayWindow, LiveMissionFacts, LiveRunFacts } from './domain'

/**
 * One project's runs, bound to that project's own state. The collector never
 * receives anything shared between projects.
 */
export interface ProjectLiveBoardSource {
  projectId: string
  projectName: string
  /** Live runs, and runs settled inside `day`. */
  collect(day: DayWindow): LiveRunFacts[]
}

/** Missions (app-level conversations): titles, providers and their own spend today. */
export interface MissionDirectory {
  describe(conversationIds: readonly string[], day: DayWindow): Map<string, LiveMissionFacts>
}

/** Today's spend across every project, from the analytics source (never a new cost calculation). */
export interface TodaySpend {
  read(): { costUsd: number; estimated: boolean }
}
