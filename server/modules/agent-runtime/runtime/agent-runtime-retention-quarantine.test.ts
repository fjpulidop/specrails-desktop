import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, type DbInstance } from '../../../db'
import { runtimeJournalQuarantine, recoverRuntimeQuarantine } from './agent-runtime-retention-quarantine'
import { readRuntimeExpiration } from './agent-runtime-retention-records'
let db: DbInstance, root: string, pipeline: string, original: string
beforeEach(() => {
  db = initDb(':memory:'); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal retention '))); pipeline = path.join(root, 'pipeline'); original = path.join(pipeline, 'run')
  fs.mkdirSync(original, { recursive: true }); fs.writeFileSync(path.join(original, 'evidence'), 'preserved')
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
const record = { runId: 'run', expiredAt: '2026-09-27T00:00:00Z', disposition: 'settled' as const, previousStatus: 'succeeded', summary: { costUsd: null } }
it('expires only owned journal storage and preserves the historical expiration record', async () => {
  fs.mkdirSync(path.join(root, 'repository')); fs.writeFileSync(path.join(root, 'repository/code'), 'implementation')
  const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
  expect(fs.existsSync(original)).toBe(false)
  await expect(store.remove(token)).rejects.toThrow('durable')
  await store.expire(token); await store.remove(token); await store.remove(token)
  expect(readRuntimeExpiration(db, 'run')).toMatchObject({ quarantineToken: token, previousStatus: 'succeeded' })
  expect(fs.readFileSync(path.join(root, 'repository/code'), 'utf8')).toBe('implementation')
  await expect(store.restore(token)).rejects.toThrow('Expired')
})
it('restores a crash after moving the journal but before durable expiration', async () => {
  await runtimeJournalQuarantine(db, pipeline, record).quarantine()
  const release = vi.fn()
  expect(recoverRuntimeQuarantine(db, pipeline, () => release)).toEqual({ restored: ['run'], removed: [], protected: [], errors: [] })
  expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved'); expect(release).toHaveBeenCalledOnce()
})
it('finishes deletion after durable expiration without restoring executable history', async () => {
  const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine(); await store.expire(token)
  expect(recoverRuntimeQuarantine(db, pipeline, () => () => {})).toEqual({ restored: [], removed: ['run'], protected: [], errors: [] })
  expect(fs.existsSync(original)).toBe(false)
})
it('never steals live collection ownership or overwrites a replacement directory', async () => {
  await runtimeJournalQuarantine(db, pipeline, record).quarantine()
  expect(recoverRuntimeQuarantine(db, pipeline, () => null).protected).toEqual(['run'])
  fs.mkdirSync(original); fs.writeFileSync(path.join(original, 'new'), 'unknown owner')
  expect(recoverRuntimeQuarantine(db, pipeline, () => () => {}).errors).toEqual([expect.stringContaining('overwrite')])
  expect(fs.readdirSync(path.join(pipeline, '.retention'))).toHaveLength(1)
  expect(fs.readFileSync(path.join(original, 'new'), 'utf8')).toBe('unknown owner')
})
it('rejects a different quarantine token before any mutation', async () => {
  const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
  await expect(store.expire('other')).rejects.toThrow('ownership')
  await store.restore(token)
  expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved')
})

it('refuses to delete a replaced quarantine journal or unrelated added files', async () => {
  const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine(); await store.expire(token)
  const quarantine = path.join(pipeline, '.retention', token), journal = path.join(quarantine, 'run')
  fs.renameSync(journal, path.join(root, 'original-journal'))
  fs.mkdirSync(journal); fs.writeFileSync(path.join(journal, 'unknown'), 'must survive')
  await expect(store.remove(token)).rejects.toThrow('replaced')
  expect(fs.readFileSync(path.join(journal, 'unknown'), 'utf8')).toBe('must survive')
})

const quarantineRoot = () => path.join(pipeline, '.retention')
const only = () => path.join(quarantineRoot(), fs.readdirSync(quarantineRoot())[0])
const recoverAll = () => recoverRuntimeQuarantine(db, pipeline, () => () => {})
describe('crash boundaries', () => {
  it('discards an unpublished staging intent without touching the original journal', () => {
    const staging = path.join(quarantineRoot(), '.staging-00000000-0000-4000-8000-000000000000')
    fs.mkdirSync(staging, { recursive: true }); fs.writeFileSync(path.join(staging, 'intent.json'), '{"schema')
    expect(recoverAll()).toEqual({ restored: [], removed: [], protected: [], errors: [] })
    expect(fs.readdirSync(quarantineRoot())).toEqual([]); expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved')
  })
  it('removes an empty quarantine left before any intent or after the intent was deleted last', () => {
    fs.mkdirSync(path.join(quarantineRoot(), '00000000-0000-4000-8000-000000000000'), { recursive: true })
    expect(recoverAll().errors).toEqual([]); expect(fs.readdirSync(quarantineRoot())).toEqual([])
  })
  it('keeps data that has no intent authorizing its deletion', () => {
    const orphan = path.join(quarantineRoot(), '00000000-0000-4000-8000-000000000000')
    fs.mkdirSync(path.join(orphan, 'run'), { recursive: true }); fs.writeFileSync(path.join(orphan, 'run/unknown'), 'keep')
    expect(recoverAll().errors).toEqual([expect.stringContaining('without an intent')])
    expect(fs.readFileSync(path.join(orphan, 'run/unknown'), 'utf8')).toBe('keep')
  })
  it('drops a published intent whose journal was never moved after proving the original identity', async () => {
    const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
    fs.renameSync(path.join(quarantineRoot(), token, 'run'), original)
    expect(recoverAll()).toMatchObject({ restored: ['run'], errors: [] })
    expect(fs.readdirSync(quarantineRoot())).toEqual([]); expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved')
  })
  it('never cleans up an intent once the original was replaced by another directory', async () => {
    const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
    fs.rmSync(path.join(quarantineRoot(), token, 'run'), { recursive: true })
    fs.mkdirSync(original); fs.writeFileSync(path.join(original, 'replacement'), 'new owner')
    expect(recoverAll().errors).toEqual([expect.stringContaining('identity changed')])
    expect(fs.existsSync(path.join(quarantineRoot(), token, 'intent.json'))).toBe(true)
    expect(fs.readFileSync(path.join(original, 'replacement'), 'utf8')).toBe('new owner')
  })
  it('finishes an interrupted deletion that already removed part or all of the journal', async () => {
    const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine(); await store.expire(token)
    fs.rmSync(path.join(quarantineRoot(), token, 'run', 'evidence'))
    expect(recoverAll()).toMatchObject({ removed: ['run'], errors: [] })
    expect(fs.readdirSync(quarantineRoot())).toEqual([]); expect(fs.existsSync(original)).toBe(false)
  })
  it('restores through recovery again after an interrupted restore', async () => {
    const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
    const journal = path.join(quarantineRoot(), token, 'run')
    fs.renameSync(journal, original)
    expect(recoverAll()).toMatchObject({ restored: ['run'], errors: [] })
    expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved')
  })
  it('refuses to record expiration when the quarantine no longer holds the moved journal', async () => {
    const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine()
    fs.renameSync(path.join(quarantineRoot(), token, 'run'), original)
    await expect(store.expire(token)).rejects.toThrow('not owned')
    expect(readRuntimeExpiration(db, 'run')).toBeNull()
  })
  it('reports one damaged entry without blocking recovery of the others', async () => {
    fs.mkdirSync(quarantineRoot(), { recursive: true }); fs.writeFileSync(path.join(quarantineRoot(), 'stray'), '')
    await runtimeJournalQuarantine(db, pipeline, record).quarantine()
    expect(recoverAll()).toMatchObject({ restored: ['run'], errors: [expect.stringContaining('stray')] })
    expect(only()).toBe(path.join(quarantineRoot(), 'stray'))
  })
})
