import { describe, expect, it } from 'vitest'
import type { ProjectRow } from '../../../desktop-db'
import { translator } from './lang'
import { formatRef, parseRef, resolveProject, resolveProjectSelector, resolveTarget } from './refs'

const t = translator('en')
const row = (id: string, slug: string, name: string, path: string) => ({ id, slug, name, path }) as ProjectRow
const ROWS = [row('p1', 'shop-api', 'Shop API', '/work/shop-api'), row('p2', 'shop-web', 'Shop Web', '/work/shop-web'), row('p3', 'billing', 'Billing', '/work/billing')]

describe('global refs', () => {
  it('formats and parses project-scoped and app-global refs', () => {
    expect(formatRef('run', '8f3c', 'shop-api')).toBe('run:shop-api/8f3c')
    expect(formatRef('spec', 142, 'shop-api')).toBe('spec:shop-api/142')
    expect(formatRef('mission', 'c_91')).toBe('mission:c_91')
    expect(parseRef('run:shop-api/8f3c')).toEqual({ kind: 'run', project: 'shop-api', id: '8f3c' })
    expect(parseRef('mission:c_91')).toEqual({ kind: 'mission', id: 'c_91' })
    expect(parseRef('inbox:item-7')).toEqual({ kind: 'inbox', id: 'item-7' })
  })

  it('percent-encodes ids that would break the shape', () => {
    const ref = formatRef('attachment', 'docs/a b.png', 'shop-api')
    expect(ref).toBe('attachment:shop-api/docs%2Fa%20b.png')
    expect(parseRef(ref)).toEqual({ kind: 'attachment', project: 'shop-api', id: 'docs/a b.png' })
  })

  it('rejects strings that are not refs', () => {
    for (const value of ['8f3c', 'run:8f3c', 'run:shop/a/b', 'unknown:x/1', 'mission:a/b', '', 42]) expect(parseRef(value), String(value)).toBeNull()
    expect(() => formatRef('run', 'x')).toThrow(/needs a project/)
  })
})

describe('project resolution', () => {
  it('matches id, slug, project ref, name, path and a unique prefix', () => {
    expect(resolveProjectSelector(ROWS, 'p3', t).id).toBe('p3')
    expect(resolveProjectSelector(ROWS, 'shop-web', t).id).toBe('p2')
    expect(resolveProjectSelector(ROWS, 'project:billing', t).id).toBe('p3')
    expect(resolveProjectSelector(ROWS, 'shop api', t).id).toBe('p1')
    expect(resolveProjectSelector(ROWS, '/work/billing/', t).id).toBe('p3')
    expect(resolveProjectSelector(ROWS, 'bill', t).id).toBe('p3')
  })

  it('returns choices when ambiguous or unknown', () => {
    expect(() => resolveProjectSelector(ROWS, 'shop', t)).toThrow(expect.objectContaining({ code: 'ambiguous', extra: expect.objectContaining({ choices: [expect.objectContaining({ slug: 'shop-api' }), expect.objectContaining({ slug: 'shop-web' })] }) }))
    expect(() => resolveProjectSelector(ROWS, 'nothing', t)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('prefers the explicit project, then the mission pin, then the session default', () => {
    expect(resolveProject(ROWS, { project: 'billing', pinnedProjectId: 'p1', sessionProjectId: 'p2' }, t)?.id).toBe('p3')
    expect(resolveProject(ROWS, { pinnedProjectId: 'p1', sessionProjectId: 'p2' }, t)?.id).toBe('p1')
    expect(resolveProject(ROWS, { sessionProjectId: 'p2' }, t)?.id).toBe('p2')
    expect(resolveProject(ROWS, {}, t)).toBeNull()
  })
})

describe('resolveTarget', () => {
  const base = { defaultKind: 'run' as const, label: 'specrails_runs(get)' }

  it('takes the project from a full ref, over every default', () => {
    expect(resolveTarget(ROWS, { ...base, ref: 'run:billing/r1', sessionProjectId: 'p1' }, t)).toEqual({ kind: 'run', id: 'r1', project: ROWS[2], ref: 'run:billing/r1' })
  })

  it('scopes a bare id by project, pin or session default', () => {
    expect(resolveTarget(ROWS, { ...base, ref: 'r1', project: 'shop-web' }, t).ref).toBe('run:shop-web/r1')
    expect(resolveTarget(ROWS, { ...base, ref: 'r1', sessionProjectId: 'p1' }, t).ref).toBe('run:shop-api/r1')
    expect(() => resolveTarget(ROWS, { ...base, ref: 'r1' }, t)).toThrow(expect.objectContaining({ code: 'ambiguous' }))
  })

  it('resolves app-global kinds without a project', () => {
    expect(resolveTarget(ROWS, { ...base, defaultKind: 'mission', ref: 'mission:c_1' }, t)).toEqual({ kind: 'mission', id: 'c_1', project: null, ref: 'mission:c_1' })
  })

  it('refuses a wrong kind, a malformed ref and a ref/project disagreement', () => {
    expect(() => resolveTarget(ROWS, { ...base, ref: 'spec:billing/4' }, t)).toThrow(/takes a run ref/)
    expect(() => resolveTarget(ROWS, { ...base, ref: 'run:billing' }, t)).toThrow(/not a valid ref/)
    expect(() => resolveTarget(ROWS, { ...base, ref: 'run:billing/r1', project: 'shop-api' }, t)).toThrow(/belongs to billing/)
    expect(() => resolveTarget(ROWS, { ...base }, t)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(resolveTarget(ROWS, { ...base, kinds: ['run', 'spec'], ref: 'spec:billing/4' }, t).kind).toBe('spec')
  })
})
