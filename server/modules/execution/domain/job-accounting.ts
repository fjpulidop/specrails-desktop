export type JobInvocationStatus = 'success' | 'failed' | 'aborted'

export interface JobAccountingInput {
  jobId: string
  provider: string
  status: JobInvocationStatus
  startedAt: string
  finishedAt: string | null
  ticketIds: number[]
  estimated: boolean
  result: {
    tokens_in?: number
    tokens_out?: number
    tokens_cache_read?: number
    tokens_cache_create?: number
    total_cost_usd?: number
    num_turns?: number
    model?: string
    session_id?: string
    duration_ms?: number
    duration_api_ms?: number
  }
  conversationId?: string | null
}

/** Project-owned accounting facts; the persistence adapter supplies database representation. */
export type JobInvocation = JobAccountingInput['result'] & {
  id: string
  project_id: string
  provider: string
  surface: 'job'
  surface_ref_id: string
  ticket_id: number | null
  conversation_id: string | null
  status: JobInvocationStatus
  started_at: string
  finished_at: string | null
  total_cost_usd_estimated: boolean
}
