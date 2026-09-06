import { StringDecoder } from 'node:string_decoder'
import { Router, type Request, type Response } from 'express'
import type { DbInstance } from '../db'
import { getAgentConversation } from '../agent-store'
import { getProject, listProjectRepositories } from '../desktop-db'
import { getAllowedProjects } from './mobile-devices'
import type { MobileAuthedRequest } from './mobile-auth'
import { redact } from './mobile-redact'

const ID = /^[A-Za-z0-9_-]{1,160}$/
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const pick = (value: unknown, keys: string[]) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => keys.includes(key)))
export const MOBILE_PROTOCOL_VERSION = 2
export const MISSION_ACCESS_REASON = 'Mission agents can access more than their pinned project. Missions require an all-projects device grant; your permitted Specs and Rails remain available.'
export interface MobileUpstreamResponse { status: number; json: unknown }
export type MobileUpstream = (method: string, path: string, body?: unknown) => Promise<MobileUpstreamResponse>

export function mobileCapabilities(db: DbInstance, deviceId: string) {
  const missions = process.env.SPECRAILS_AGENT_CHAT !== 'false' && getAllowedProjects(db, deviceId) === null
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, features: { missions, missionControl: missions, missionQueue: missions, missionProcesses: missions, repositories: true },
    ...(!missions ? { missionsUnavailableReason: process.env.SPECRAILS_AGENT_CHAT === 'false' ? 'Missions are disabled on Desktop.' : MISSION_ACCESS_REASON } : {}) }
}

function conversationView(value: unknown) {
  return pick(value, ['id', 'title', 'provider', 'model', 'pinned_project_id', 'tier_level', 'reasoning_effort', 'created_at', 'updated_at'])
}

/** Explicit mobile DTO: provider session IDs, attachment paths, tool inputs and
 * arbitrary context metadata never enter the mission wire contract. */
export function missionSnapshot(value: unknown) {
  const data = record(value)
  const messages = Array.isArray(data.messages) ? data.messages : []
  // Shared UTF-8 budget for all text, with pending inputs and the current
  // response reserved first. Metadata is bounded separately by row counts.
  let remaining = 480_000
  let truncated = messages.length > 200
  const take = (raw: string, maximum: number) => {
    const bytes = Buffer.from(raw)
    const budget = Math.min(remaining, maximum)
    const text = bytes.length <= budget ? raw : new StringDecoder('utf8').write(bytes.subarray(0, budget))
    remaining -= Buffer.byteLength(text)
    if (text.length < raw.length) truncated = true
    return text
  }
  const live = record(data.live), liveRaw = String(live.streamingText ?? '')
  const streamingText = take(liveRaw, 80_000)
  const pending = Array.isArray(data.pendingMessages) ? data.pendingMessages : []
  const pendingMessages = pending.slice(0, 50).map(value => {
    const raw = String(record(value).text ?? ''), text = take(raw, 4_000)
    return { ...pick(value, ['queueId', 'deliveryMode', 'timestamp']), text, textTruncated: text.length < raw.length }
  })
  const bounded: Record<string, unknown>[] = []
  for (const message of messages.slice(-200).reverse()) {
    const raw = String(record(message).content ?? '')
    let card: Record<string, unknown> | undefined
    if (record(message).role === 'system') {
      try {
        const parsed = record(JSON.parse(raw))
        if (parsed.kind === 'pr_decision') card = { ...pick(parsed, ['kind', 'railIndex', 'ticketIds', 'decision', 'implementationOutcome', 'deliveryOutcome', 'prNumber']), repositoryDeliveries: (Array.isArray(parsed.repositoryDeliveries) ? parsed.repositoryDeliveries : []).slice(0, 30).map(value => pick(value, ['repositoryId', 'repositoryName', 'decision'])) }
      } catch { /* Non-card system rows do not expose internal provider payloads. */ }
    }
    if (remaining === 0) { truncated = true; break }
    const content = record(message).role === 'system' ? '' : take(raw, 40_000)
    bounded.unshift({ ...pick(message, ['id', 'role', 'created_at', 'delivery_status', 'delivery_receipt']), content, ...(card ? { card } : {}) })
  }
  return { conversation: conversationView(data.conversation), messages: bounded, truncated,
    pendingMessages, pendingTruncated: pending.length > 50,
    live: { ...pick(live, ['isStreaming', 'startedAt']), streamingText, textTruncated: streamingText.length < liveRaw.length } }

}

export function createMobileMissionsRouter({ db, upstream }: { db: DbInstance; upstream: MobileUpstream }): Router {
  const router = Router()
  const segment = (value: unknown) => typeof value === 'string' ? value : ''
  const send = async (res: Response, method: string, path: string, body?: unknown, shape?: (json: unknown) => unknown) => {
    try { const result = await upstream(method, path, body); res.status(result.status).json(redact(result.status >= 200 && result.status < 300 && shape ? shape(result.json) : result.json)) }
    catch { res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' }) }
  }
  router.get('/capabilities', (req, res) => res.json(mobileCapabilities(db, (req as MobileAuthedRequest).mobileDevice!.id)))
  router.get('/mission-models', (req, res) => {
    const provider = segment(req.query.provider)
    if (!/^[a-z0-9_-]{1,40}$/.test(provider)) { res.status(400).json({ error: 'A valid provider is required' }); return }
    void send(res, 'GET', `/api/agent/models?provider=${encodeURIComponent(provider)}`)
  })
  router.get('/projects/:pid/repositories', (req, res) => {
    const pid = segment(req.params.pid)
    if (!getProject(db, pid)) { res.status(404).json({ error: 'Unknown project' }); return }
    res.json({ repositories: listProjectRepositories(db, pid).map(repository => pick(repository, ['id', 'name', 'isPrimary', 'kind', 'integrationBranch'])) })
  })
  router.use('/projects/:pid/missions', (req, res, next) => {
    const device = (req as MobileAuthedRequest).mobileDevice!
    // A conversation pin is an execution default, not an agent sandbox. Deny
    // restricted devices rather than leaking repinned history or escalating tools.
    if (!mobileCapabilities(db, device.id).features.missions) { res.status(403).json({ error: MISSION_ACCESS_REASON }); return }
    if (!getProject(db, segment(req.params.pid))) { res.status(404).json({ error: 'Unknown project' }); return }
    next()
  })
  const identity = (req: Request, res: Response) => {
    const pid = segment(req.params.pid), cid = segment(req.params.cid)
    if (!ID.test(pid) || !ID.test(cid)) { res.status(400).json({ error: 'Invalid mission identity' }); return null }
    const conversation = getAgentConversation(db, cid)
    if (!conversation || conversation.pinned_project_id !== pid) { res.status(404).json({ error: 'Mission not found in this project' }); return null }
    return { pid, cid, base: `/api/agent/conversations/${encodeURIComponent(cid)}` }
  }
  router.get('/projects/:pid/missions', async (req, res) => {
    const pid = segment(req.params.pid)
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit)
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) { res.status(400).json({ error: 'limit must be 1–200' }); return }
    // Query the project before applying the limit: active projects must not
    // disappear behind another project's most recent conversations.
    const rows = db.prepare('SELECT id FROM agent_conversations WHERE pinned_project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(pid, rawLimit + 1) as Array<{ id: string }>
    try {
      const active = await upstream('GET', '/api/agent/active-turns')
      if (active.status !== 200) { res.status(active.status).json(redact(active.json)); return }
      const activeIds = new Set((Array.isArray(record(active.json).turns) ? record(active.json).turns as unknown[] : []).map(value => record(value).conversationId))
      res.json(redact({ conversations: rows.slice(0, rawLimit).map(row => ({ ...conversationView(getAgentConversation(db, row.id)), isStreaming: activeIds.has(row.id) })), truncated: rows.length > rawLimit }))
    } catch { res.status(502).json({ error: 'Desktop is unreachable' }) }
  })
  router.post('/projects/:pid/missions', (req, res) => {
    const b = record(req.body)
    const body = { ...pick(b, ['provider', 'model', 'reasoningEffort']), pinnedProjectId: segment(req.params.pid), tierLevel: Number.isInteger(b.tierLevel) && Number(b.tierLevel) >= 0 && Number(b.tierLevel) <= 3 ? b.tierLevel : 0 }
    void send(res, 'POST', '/api/agent/conversations', body, data => ({ conversation: conversationView(record(data).conversation) }))
  })
  router.get('/projects/:pid/missions/:cid', (req, res) => {
    const id = identity(req, res); if (id) void send(res, 'GET', id.base, undefined, missionSnapshot)
  })
  router.post('/projects/:pid/missions/:cid/send', (req, res) => {
    const id = identity(req, res); if (!id) return
    const b = record(req.body)
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 40_000 || !ID.test(segment(b.queueId))) { res.status(400).json({ error: 'A message and stable queueId are required (maximum 40000 characters)' }); return }
    if (b.deliveryMode !== undefined && b.deliveryMode !== 'queue' && b.deliveryMode !== 'steer') { res.status(400).json({ error: 'deliveryMode must be queue or steer' }); return }
    void send(res, 'POST', `${id.base}/send`, { text: b.text, queueId: b.queueId, deliveryMode: b.deliveryMode ?? 'queue' }, data => pick(data, ['accepted', 'queued', 'duplicate', 'removed', 'deliveryMode']))
  })
  router.post('/projects/:pid/missions/:cid/abort', (req, res) => { const id = identity(req, res); if (id) void send(res, 'POST', `${id.base}/abort`, {}) })
  for (const action of ['edit', 'steer', 'remove'] as const) {
    const route = `/projects/:pid/missions/:cid/queue/:queueId${action === 'steer' ? '/steer' : ''}`
    const method = action === 'edit' ? 'patch' : action === 'steer' ? 'post' : 'delete'
    router[method](route, (req, res) => {
      const id = identity(req, res); if (!id) return
      const queueId = segment(req.params.queueId), text = record(req.body).text
      if (!ID.test(queueId) || (action === 'edit' && (typeof text !== 'string' || !text.trim() || text.length > 40_000))) { res.status(400).json({ error: 'Invalid queued message' }); return }
      void send(res, method.toUpperCase(), `${id.base}/queue/${encodeURIComponent(queueId)}${action === 'steer' ? '/steer' : ''}`, action === 'edit' ? { text } : undefined)
    })
  }
  router.get('/projects/:pid/missions/:cid/processes', (req, res) => {
    const id = identity(req, res); if (id) void send(res, 'GET', `/api/projects/${encodeURIComponent(id.pid)}/background-processes?chatId=${encodeURIComponent(id.cid)}&includeFinished=true`)
  })
  for (const method of ['get', 'delete'] as const) router[method](`/projects/:pid/missions/:cid/processes/:processId${method === 'get' ? '/logs' : ''}`, (req, res) => {
    const id = identity(req, res); if (!id) return
    const processId = segment(req.params.processId), osPid = Number(req.query.pid)
    if (!ID.test(processId) || !Number.isSafeInteger(osPid) || osPid < 1) { res.status(400).json({ error: 'Execution identity and numeric pid are required' }); return }
    const query = new URLSearchParams({ chatId: id.cid, processId, ...(method === 'get' ? { limit: '1000' } : {}) })
    void send(res, method.toUpperCase(), `/api/projects/${encodeURIComponent(id.pid)}/background-processes/${osPid}${method === 'get' ? '/logs' : ''}?${query}`)
  })
  return router
}
