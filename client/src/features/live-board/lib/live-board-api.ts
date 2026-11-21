import { API_ORIGIN } from '../../../lib/origin'
import { requestJson } from '../../../lib/api-response'
import { readLiveBoardSnapshot, type LiveBoardSnapshot } from './live-board-model'

/** Desktop-level read-model: every project, read through its own state (one request per refresh). */
export async function fetchLiveBoard(signal?: AbortSignal): Promise<LiveBoardSnapshot> {
  return readLiveBoardSnapshot(await requestJson<unknown>(`${API_ORIGIN}/api/live-board`, { signal }))
}
