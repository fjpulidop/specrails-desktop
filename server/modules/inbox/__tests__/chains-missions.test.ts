import { beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createChain, updateChain } from '../../builder/runtime/milestone-chain-store'
import { createLoopRun, finishLoopRun } from '../../loops/runtime/loop-runs-store'
import { createProjectInboxSource } from '../adapters/project-source'
import { MISSION_CARD_WINDOW_MS } from '../adapters/mission-source'
import { collectInbox } from '../application'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
const sqlTime = (offsetMs: number): string => iso(offsetMs).replace('T', ' ').slice(0, 19)

let db: DbInstance
let desktop: DbInstance
beforeEach(() => {
  db = initDb(':memory:')
  desktop = initDesktopDb(':memory:')
})

const source = (projectId = 'p1', projectDb = db) =>
  createProjectInboxSource({ project: { id: projectId, name: projectId === 'p1' ? 'Alpha' : 'Beta' }, db: projectDb, desktopDb: desktop }, () => NOW)

function chain(id: string, status: 'running' | 'paused' | 'awaiting_approval' | 'completed', patch: Parameters<typeof updateChain>[3] = {}) {
  createChain(db, { id, milestoneN: 2, milestoneId: 'm2', mode: 'sequential', chunks: [[11], [12], [13]], integrationBranch: 'milestone-2', nowMs: NOW - 60_000 })
  if (status !== 'running') expect(updateChain(db, id, 'running', { status, nextChunk: 1, ...patch }, NOW - 30_000)).toBe(true)
}

function conversation(id: string, project: string | null, extra: { archived?: boolean; title?: string } = {}) {
  desktop.prepare('INSERT INTO agent_conversations (id, title, pinned_project_id, archived_at) VALUES (?, ?, ?, ?)').run(id, extra.title ?? `Mission ${id}`, project, extra.archived ? sqlTime(-1000) : null)
}

let seq = 0
function message(conversationId: string, role: string, content: string, at: number, intent: unknown = null): string {
  const id = `m${++seq}`
  desktop.prepare('INSERT INTO agent_messages (id, conversation_id, role, content, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, conversationId, role, content, intent ? JSON.stringify(intent) : null, sqlTime(at))
  return id
}

const railLaunch = (ticketIds: number[]) => '```rail-launch\n' + JSON.stringify({ ticketIds, railIndex: 0 }) + '\n```'
const flowOffer = (idea: string) => '```flow-offer\n' + JSON.stringify({ idea }) + '\n```'

describe('inbox: milestone chains', () => {
  it('lists a paused chain and a checkpoint, never a running or finished chain', () => {
    chain('c-paused', 'paused', { pauseReason: 'integration_failed:conflict' })
    const items = source().collect()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'p1:chain:c-paused', kind: 'chain', action: 'resume-chain', subjectId: 'c-paused', title: 'Milestone 2', detail: 'integration_failed:conflict',
      chain: { milestoneN: 2, status: 'paused', pauseReason: 'integration_failed:conflict', autoAdvance: true, nextChunk: 1, totalChunks: 3, retryChunk: null },
    })
  })

  it('a checkpoint (auto-advance off) is its own item; running and completed chains are not', () => {
    createChain(db, { id: 'c-wait', milestoneN: 3, milestoneId: 'm3', mode: 'sequential', chunks: [[1], [2]], integrationBranch: null, autoAdvance: false, nowMs: NOW })
    expect(updateChain(db, 'c-wait', 'running', { status: 'awaiting_approval', nextChunk: 1 }, NOW)).toBe(true)
    createChain(db, { id: 'c-run', milestoneN: 4, milestoneId: 'm4', mode: 'sequential', chunks: [[3]], integrationBranch: null, nowMs: NOW })
    const items = source().collect()
    expect(items.map((item) => item.subjectId)).toEqual(['c-wait'])
    expect(items[0].chain).toMatchObject({ status: 'awaiting_approval', pauseReason: null, autoAdvance: false })
    expect(updateChain(db, 'c-wait', 'awaiting_approval', { status: 'completed' }, NOW)).toBe(true)
    expect(source().collect()).toEqual([])
  })

  it('folds the failed rail of a rail-caused pause into the chain item, keeping its cause', () => {
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: 1, ticketIds: [12], iterationLimit: 3, startedAt: iso(-600_000) })
    finishLoopRun(db, 'run-1', { outcome: 'failed', finishedAt: iso(-120_000) })
    createLoopRun(db, { id: 'run-other', projectId: 'p1', loopId: 'loop-b', loopName: 'Implement', railIndex: 2, ticketIds: [40], iterationLimit: 3, startedAt: iso(-600_000) })
    finishLoopRun(db, 'run-other', { outcome: 'failed', finishedAt: iso(-120_000) })
    chain('c1', 'paused', { pauseReason: 'chunk_failed', currentRunIds: ['run-1'], retryChunk: 1 })
    const items = source().collect()
    expect(items.map((item) => item.id).sort()).toEqual(['p1:chain:c1', 'p1:failed:run-other'])
    expect(items.find((item) => item.kind === 'chain')).toMatchObject({ railIndex: 1, detail: 'failed', chain: { retryChunk: 1 } })
  })

  it('a chain paused for another reason keeps the rail item separate', () => {
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: 1, ticketIds: [12], iterationLimit: 3, startedAt: iso(-600_000) })
    finishLoopRun(db, 'run-1', { outcome: 'failed', finishedAt: iso(-120_000) })
    chain('c1', 'paused', { pauseReason: 'head_missing', currentRunIds: ['run-1'] })
    expect(source().collect().map((item) => item.kind).sort()).toEqual(['chain', 'failed'])
  })

  it('changes version when the pause changes (a dismissal re-arms)', () => {
    chain('c1', 'paused', { pauseReason: 'chunk_failed', retryChunk: 0 })
    const before = source().collect()[0].version
    expect(updateChain(db, 'c1', 'paused', { pauseReason: 'provider_limit' }, NOW)).toBe(true)
    expect(source().collect()[0].version).not.toBe(before)
  })
})

describe('inbox: mission cards', () => {
  it('lists an undecided launch proposal and Intent offer of a mission pinned to the project', () => {
    conversation('conv-1', 'p1', { title: 'Ship the checkout' })
    message('conv-1', 'user', 'Plan it', -600_000)
    const launch = message('conv-1', 'assistant', `Ready.\n${railLaunch([12, 14])}\n${flowOffer('Rework the cart')}`, -300_000)
    const items = source().collect()
    expect(items.map((item) => item.card?.kind).sort()).toEqual(['flow-offer', 'rail-launch'])
    expect(items.find((item) => item.card?.kind === 'rail-launch')).toMatchObject({
      id: `p1:mission:${launch}:rail-launch:0`, kind: 'mission', action: 'open-mission', conversationId: 'conv-1', title: 'Ship the checkout', detail: '#12, #14',
      card: { id: `${launch}:rail-launch:0`, kind: 'rail-launch', ticketIds: [12, 14] }, at: iso(-300_000),
    })
    expect(items.find((item) => item.card?.kind === 'flow-offer')?.detail).toBe('Rework the cart')
  })

  it('drops decided cards, cards the person moved past, old cards, archived and other projects\' missions', () => {
    conversation('decided', 'p1')
    message('decided', 'assistant', railLaunch([1]), -300_000, [{ kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: iso(-200_000) }])
    conversation('replied', 'p1')
    message('replied', 'assistant', railLaunch([2]), -300_000)
    message('replied', 'user', 'Not now, first fix the tests', -100_000)
    conversation('old', 'p1')
    message('old', 'assistant', railLaunch([3]), -MISSION_CARD_WINDOW_MS - 60_000)
    conversation('archived', 'p1', { archived: true })
    message('archived', 'assistant', railLaunch([4]), -300_000)
    conversation('elsewhere', 'p2')
    message('elsewhere', 'assistant', railLaunch([5]), -300_000)
    conversation('home', null)
    message('home', 'assistant', railLaunch([6]), -300_000)
    conversation('unreadable', 'p1')
    message('unreadable', 'assistant', '```rail-launch\n{not json}\n```', -300_000)
    expect(source().collect()).toEqual([])
    expect(source('p2', initDb(':memory:')).collect().map((item) => item.card?.ticketIds)).toEqual([[5]])
  })

  it('lists a CI-fix offer still offered for the project\'s delivery, newest copy only', () => {
    conversation('conv-ci', 'p2')
    const offer = (state: string, at: number, prNumber = 41) => message('conv-ci', 'system', JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd-7', prNumber, state, at: iso(at) }), at)
    offer('offered', -400_000, 40)
    const newest = offer('offered', -200_000)
    message('conv-ci', 'system', JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd-8', prNumber: 50, state: 'dismissed', at: iso(-100_000) }), -100_000)
    message('conv-ci', 'system', JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p2', prDeliveryId: 'd-9', prNumber: 60, state: 'offered', at: iso(-100_000) }), -100_000)
    const items = source().collect()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mission', detail: 'PR #41', conversationId: 'conv-ci', card: { id: `${newest}:pr-ci-offer:0`, kind: 'pr-ci-offer', prNumber: 41, prDeliveryId: 'd-7' } })
  })

  it('other projects\' offers never crowd this project\'s offer out of the read', () => {
    conversation('conv-ci', 'p2')
    message('conv-ci', 'system', JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p1', prDeliveryId: 'd-1', prNumber: 7, state: 'offered', at: iso(-500_000) }), -500_000)
    for (let i = 0; i < 120; i++) {
      message('conv-ci', 'system', JSON.stringify({ kind: 'pr-ci-offer', projectId: 'p2', prDeliveryId: `d-x${i}`, prNumber: 100 + i, state: 'offered', at: iso(-100_000 + i) }), -100_000 + i)
    }
    expect(source().collect().map((item) => item.detail)).toEqual(['PR #7'])
  })

  it('a missing app database or mission table costs only the mission cards', () => {
    chain('c1', 'paused', { pauseReason: 'head_missing' })
    desktop.exec('DROP TABLE agent_messages')
    expect(collectInbox([source()], () => new Date(NOW)).items.map((item) => item.kind)).toEqual(['chain'])
    expect(createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db }, () => NOW).collect().map((item) => item.kind)).toEqual(['chain'])
  })
})
