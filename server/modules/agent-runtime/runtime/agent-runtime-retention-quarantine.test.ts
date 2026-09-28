import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  expect(recoverRuntimeQuarantine(db, pipeline, () => release)).toEqual({ restored: ['run'], removed: [], protected: [] })
  expect(fs.readFileSync(path.join(original, 'evidence'), 'utf8')).toBe('preserved'); expect(release).toHaveBeenCalledOnce()
})
it('finishes deletion after durable expiration without restoring executable history', async () => {
  const store = runtimeJournalQuarantine(db, pipeline, record), { token } = await store.quarantine(); await store.expire(token)
  expect(recoverRuntimeQuarantine(db, pipeline, () => () => {})).toEqual({ restored: [], removed: ['run'], protected: [] })
  expect(fs.existsSync(original)).toBe(false)
})
it('never steals live collection ownership or overwrites a replacement directory', async () => {
  await runtimeJournalQuarantine(db, pipeline, record).quarantine()
  expect(recoverRuntimeQuarantine(db, pipeline, () => null).protected).toEqual(['run'])
  fs.mkdirSync(original); fs.writeFileSync(path.join(original, 'new'), 'unknown owner')
  expect(() => recoverRuntimeQuarantine(db, pipeline, () => () => {})).toThrow('overwrite')
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
