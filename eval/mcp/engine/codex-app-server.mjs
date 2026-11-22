// A minimal scripted `codex app-server --listen stdio://` for the eval: enough of
// the JSON-RPC protocol that server/providers/codex-live-session.ts drives a
// mission turn (initialize, thread/start|resume, turn/start, turn/steer), then
// answers each turn with one short scripted agent message. Never calls a model.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/** The scripted reply of a turn (pure): a summary of the top-level entries it can see. */
export function appServerReply(prompt, entries = []) {
  const shown = entries.filter(name => !name.startsWith('.')).slice(0, 8)
  const about = /summar/i.test(String(prompt ?? '')) ? 'Scripted summary of this repository' : 'Scripted answer'
  return `${about}: ${shown.length ? `top-level entries ${shown.join(', ')}` : 'an empty checkout'}.`
}

/** The frames answering one request (pure, except ids). Returns `{ reply, notifications }`. */
export function appServerFrames(request, state) {
  const { id, method, params = {} } = request
  const ok = result => ({ reply: { id, result }, notifications: [] })
  switch (method) {
    case 'initialize': return ok({ userAgent: 'codex-eval/0.171.0' })
    case 'thread/start':
    case 'thread/resume': {
      state.threadId = method === 'thread/resume' && params.threadId ? String(params.threadId) : `eval-thread-${process.pid}-${Date.now()}`
      return { reply: { id, result: { thread: { id: state.threadId } } }, notifications: [{ method: 'thread/started', params: { thread: { id: state.threadId } } }] }
    }
    case 'turn/start': {
      const turnId = `eval-turn-${++state.turns}`
      const text = appServerReply((params.input ?? []).map(part => part?.text ?? '').join('\n'), state.entries)
      const threadId = state.threadId
      const usage = { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 150 }
      return {
        reply: { id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } },
        notifications: [
          { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } },
          { method: 'item/completed', params: { threadId, turnId, item: { id: `${turnId}-msg`, type: 'agentMessage', text } } },
          { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: usage, last: usage } } },
          { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } },
        ],
      }
    }
    // The scripted turn completes at once: there is never an active turn to steer.
    case 'turn/steer': return { reply: { id, error: { code: -32600, message: 'no active turn' } }, notifications: [] }
    default: return { reply: { id, error: { code: -32601, message: `eval app-server: ${method} is not scripted` } }, notifications: [] }
  }
}

export function serveAppServer({ log = () => {}, input = process.stdin, output = process.stdout, cwd = process.cwd() } = {}) {
  let entries = []
  try { entries = fs.readdirSync(cwd).sort() } catch { entries = [] }
  const state = { threadId: null, turns: 0, entries }
  const write = frame => output.write(JSON.stringify(frame) + '\n')
  log({ mode: 'app-server', cwd: path.resolve(cwd) })
  const lines = readline.createInterface({ input })
  lines.on('line', line => {
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { return }
    // Notifications (`initialized`) and our own answers need no reply.
    if (typeof request.method !== 'string' || request.id === undefined) return
    const { reply, notifications } = appServerFrames(request, state)
    write(reply)
    for (const frame of notifications) write(frame)
  })
  lines.on('close', () => process.exit(0))
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(143))
}
