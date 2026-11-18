import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { summarizeResult } from './summaries'
import { buildToolSpecs } from './catalog'
import { gitFollowUp } from './context'
import { GIT_DIAGNOSTIC_ACTIONS } from '../../git-diagnostics'
import { SPECRAILS_GUIDE } from '../guide'
import type { McpToolContext } from './types'
import { initDesktopDb } from '../../desktop-db'

describe('hand-written envelope summaries', () => {
  it('projects.list names the projects and points at status and context', () => {
    const meta = summarizeResult('specrails_projects', 'list', {}, [
      { id: 'p1', name: 'Shop', available: true }, { id: 'p2', name: 'Blog', available: false },
    ])
    expect(meta?.summary).toBe('2 registered projects: Shop, Blog. 1 unavailable right now.')
    expect(meta?.next?.map((n) => n.tool)).toEqual(['specrails_status', 'specrails_context'])
    expect(summarizeResult('specrails_projects', 'list', {}, [])?.summary).toMatch(/^No projects are registered yet/)
    const many = summarizeResult('specrails_projects', 'list', {}, Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })))
    expect(many?.summary).toBe('6 registered projects: P0, P1, P2, P3 (+2 more).')
  })

  it('projects.get describes identity, providers and repositories', () => {
    const meta = summarizeResult('specrails_projects', 'get', {}, { id: 'p1', name: 'Shop', path: '/w/shop', providers: ['claude', 'codex'], repositories: [{}, {}], available: true })
    expect(meta?.summary).toBe('Project Shop (p1) at /w/shop; providers claude, codex; 2 repositories.')
    expect(meta?.ids).toEqual({ projectId: 'p1' })
    expect(summarizeResult('specrails_projects', 'get', {}, {})).toBeUndefined()
  })

  it('specs.list counts statuses and offers the next page', () => {
    const meta = summarizeResult('specrails_specs', 'list', { action: 'list', projectId: 'p1' }, {
      tickets: [{ id: 1, status: 'todo' }, { id: 2, status: 'todo' }, { id: 3, status: 'done' }], total: 40, matched: 10, nextOffset: 3,
    })
    expect(meta?.summary).toBe('Showing 3 of 10 matching specs (40 in the backlog): todo 2, done 1.')
    expect(meta?.truncated).toBe(true)
    expect(meta?.cursor).toBe(3)
    expect(meta?.next).toEqual([
      { tool: 'specrails_specs', args: { action: 'get', id: 1, projectId: 'p1' }, why: expect.any(String) },
      { tool: 'specrails_specs', args: { action: 'list', projectId: 'p1', offset: 3 }, why: expect.any(String) },
    ])
    expect(summarizeResult('specrails_specs', 'list', {}, { tickets: [], total: 5, matched: 0 })?.summary).toBe('No specs match (5 in the backlog).')
  })

  it('specs.get states status and priority', () => {
    const meta = summarizeResult('specrails_specs', 'get', { projectId: 'p1' }, { ticket: { id: 7, title: 'Login', status: 'on_review', priority: 'high', needs_review: true } })
    expect(meta?.summary).toBe('Spec #7 “Login” is on_review (high priority). It is flagged needs_review.')
    expect(meta?.status).toBe('on_review')
  })

  it('rails.list counts running work and deliveries awaiting review', () => {
    const meta = summarizeResult('specrails_rails', 'list', { projectId: 'p1' }, {
      rails: [{ railIndex: 0 }, { railIndex: 1 }, { railIndex: 2 }],
      activeJobs: { 0: { jobId: 'j1' } }, activeLoopRuns: {},
      prDeliveries: { 1: { id: 'd1', decision: 'on_review' }, 2: { id: 'd2', decision: 'pr_failed' } },
    })
    expect(meta?.summary).toBe('3 rails: 1 running, 1 delivery awaiting review, 1 other open.')
    expect(meta?.next).toEqual([
      { tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: 'd1', projectId: 'p1' }, why: expect.any(String) },
      { tool: 'specrails_watch', args: { ref: 'j1', projectId: 'p1' }, why: expect.any(String) },
    ])
  })

  it('jobs.get explains a failure and suggests diagnose_failure/logs; a running job suggests watch', () => {
    const failed = summarizeResult('specrails_jobs', 'get', { projectId: 'p1' }, { job: { id: 'j1', status: 'failed', command: '/sr:implement 3', total_cost_usd: 0.42, failureDiagnosis: { kind: 'provider_limit', detail: null } } })
    expect(failed?.summary).toBe('Job j1 (/sr:implement 3) is failed. Reason: provider limit. Cost $0.42.')
    expect(failed?.next?.map((n) => n.args.action)).toEqual(['diagnose_failure', 'logs'])
    const running = summarizeResult('specrails_jobs', 'get', {}, { job: { id: 'j2', status: 'running' } })
    expect(running?.next?.[0].tool).toBe('specrails_watch')
    expect(summarizeResult('specrails_jobs', 'get', {}, { job: { id: 'j3', status: 'completed' } })?.next).toEqual([])
  })

  it('analytics.spending reports total, delta, top category and estimates', () => {
    const meta = summarizeResult('specrails_analytics', 'spending', { period: '7d' }, {
      summary: { totalCostUsd: 12.4, totalRuns: 30, totalEstimatedCostUsd: 2, deltaPct: -12.6 },
      byCategory: [{ category: 'implementation', costUsd: 9.1 }, { category: 'missions', costUsd: 3.3 }],
    })
    expect(meta?.summary).toBe('Spent $12 across 30 runs in the 7d window (-13% vs the previous period). Most went to implementation ($9.10). $2.00 of it is estimated.')
    expect(summarizeResult('specrails_analytics', 'spending', {}, {})).toBeUndefined()
  })

  it('returns undefined for tools without a summarizer', () => {
    expect(summarizeResult('specrails_git', 'info', {}, {})).toBeUndefined()
    expect(summarizeResult('specrails_projects', null, {}, [])).toBeUndefined()
  })
})

describe('discovery and guide for the new tools', () => {
  const ctx = { desktopDb: initDesktopDb(':memory:') } as unknown as McpToolContext
  const search = buildToolSpecs().find((spec) => spec.name === 'specrails_search')!
  const top = async (query: string) => ((await search.handler(ctx, { query })) as Array<{ name: string }>)[0]?.name

  it.each([
    ['what is happening right now', 'specrails_status'],
    ['qué está pasando', 'specrails_status'],
    ['what needs my attention', 'specrails_inbox'],
    ['qué tengo pendiente', 'specrails_inbox'],
    ['misiones activas', 'specrails_missions'],
    ['active missions', 'specrails_missions'],
    ['por qué falló el job', 'specrails_jobs'],
    ['why did the job fail, show logs', 'specrails_jobs'],
  ])('search "%s" → %s', async (query, expected) => {
    expect(await top(query)).toBe(expected)
  })

  it('the guide mentions every new tool and action', () => {
    for (const name of ['specrails_status', 'specrails_inbox', 'specrails_missions', 'diagnose_failure', 'confirm:true', 'dryRun', 'structuredContent']) {
      expect(SPECRAILS_GUIDE).toContain(name)
    }
  })

  it('every specrails_* tool named in the guide exists in the catalog', () => {
    const names = new Set(buildToolSpecs().map((spec) => spec.name))
    for (const match of SPECRAILS_GUIDE.matchAll(/specrails_[a-z_]+/g)) expect(names.has(match[0]), match[0]).toBe(true)
  })

  it('the context Git follow-up names only real specrails_git actions', () => {
    const git = buildToolSpecs().find((spec) => spec.name === 'specrails_git')!
    const valid = new Set((git.inputSchema.action as z.ZodEnum).options as string[])
    const hint = gitFollowUp('p1', 'r2')
    const actions = /action: ([a-z_|]+)/.exec(hint)![1].split('|')
    for (const action of actions) expect(valid.has(action), action).toBe(true)
    expect(actions).toContain('info')
    expect(GIT_DIAGNOSTIC_ACTIONS).toEqual(expect.arrayContaining(actions.filter((a) => a !== 'info')))
    expect(hint).toContain('repositoryId:"r2"')
    expect(gitFollowUp('p1', null)).not.toContain('repositoryId')
  })
})
