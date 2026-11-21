import {
  boardOrder, buildLanes, countColumns, projectCards,
  type DayWindow, type LiveAttentionRef, type LiveBoardSnapshot, type LiveCard, type LiveMissionFacts,
} from './domain'
import type { MissionDirectory, ProjectLiveBoardSource, TodaySpend } from './ports'

export interface CollectLiveBoardInput<A extends LiveAttentionRef> {
  sources: readonly ProjectLiveBoardSource[]
  /** The inbox's own items (its projection, unchanged): the "Needs you" and review cards. */
  attention: readonly A[]
  missions: MissionDirectory
  todaySpend: TodaySpend
  /** The local day "Done today" covers. */
  day: DayWindow
  now?: () => Date
}

function warn(scope: string, err: unknown): void {
  console.warn(`[live-board] ${scope} unavailable (skipped):`, err instanceof Error ? err.message : err)
}

/**
 * Project the live board: ask each project's own source, isolate failures (one
 * broken project never hides the others, and its inbox items still show),
 * cap each project, then group by mission. Nothing is cached; every call reads
 * current state.
 */
export function collectLiveBoard<A extends LiveAttentionRef>(input: CollectLiveBoardInput<A>): LiveBoardSnapshot<A> {
  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const cards: LiveCard<A>[] = []
  const projects: LiveBoardSnapshot<A>['projects'] = []
  for (const source of input.sources) {
    let runs: ReturnType<ProjectLiveBoardSource['collect']> = []
    try {
      runs = source.collect(input.day)
    } catch (err) {
      warn(source.projectId, err)
    }
    const own = projectCards({
      projectId: source.projectId,
      projectName: source.projectName,
      runs,
      attention: input.attention.filter((item) => item.projectId === source.projectId),
    }, input.day, nowIso)
    cards.push(...own)
    projects.push({ projectId: source.projectId, projectName: source.projectName, count: own.length })
  }
  cards.sort(boardOrder)

  const missionIds = [...new Set(cards.map((card) => card.conversationId).filter((id): id is string => !!id))]
  let missions = new Map<string, LiveMissionFacts>()
  try {
    if (missionIds.length > 0) missions = input.missions.describe(missionIds, input.day)
  } catch (err) {
    warn('missions', err)
  }
  // An Intent session is named by its mission.
  for (const card of cards) if (card.title === null && card.conversationId) card.title = missions.get(card.conversationId)?.title ?? null

  let spend: { costUsd: number; estimated: boolean } | null = null
  try { spend = input.todaySpend.read() } catch (err) { warn('today spend', err) }

  return {
    generatedAt: nowIso,
    day: input.day,
    projects,
    cards,
    lanes: buildLanes(cards, missions),
    totals: { ...countColumns(cards), costTodayUsd: spend?.costUsd ?? null, costTodayEstimated: spend?.estimated ?? false },
  }
}
