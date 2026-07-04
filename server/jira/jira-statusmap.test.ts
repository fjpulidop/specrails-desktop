// Post-connect status-map editing: the db setter + the manager method that the
// PATCH /connection route calls so the status map is editable after connect.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { initDb, type DbInstance } from '../db'
import { setSecretStore } from './jira-credential-store'
import { upsertConnection, getConnection, setStatusMap } from './jira-db'
import { JiraSyncManager } from './jira-sync-manager'

const PROJECT_ID = 'proj-sm'
let db: DbInstance
let projectPath: string

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-statusmap-'))
  setSecretStore({ encrypt: (s: string) => 'enc:' + s, decrypt: (s: string) => s.slice(4) })
  upsertConnection(db, {
    projectId: PROJECT_ID,
    baseUrl: 'https://acme.atlassian.net',
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'me@acme.com',
    jiraProjectKey: 'ACME',
    jiraProjectId: '10000',
    token: 'tok',
    enabled: true,
    statusMap: null,
  })
})

afterEach(() => {
  setSecretStore(null)
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('setStatusMap (db)', () => {
  it('persists a map and reads it back', () => {
    setStatusMap(db, PROJECT_ID, { todo: 'Backlog', done: 'Shipped' })
    expect(getConnection(db, PROJECT_ID)?.statusMap).toEqual({ todo: 'Backlog', done: 'Shipped' })
  })

  it('clears the map with null', () => {
    setStatusMap(db, PROJECT_ID, { todo: 'Backlog' })
    setStatusMap(db, PROJECT_ID, null)
    expect(getConnection(db, PROJECT_ID)?.statusMap).toBeNull()
  })

  it('persists an on_review mapping and reads it back', () => {
    setStatusMap(db, PROJECT_ID, { on_review: 'In Review', done: 'Released' })
    expect(getConnection(db, PROJECT_ID)?.statusMap).toEqual({ on_review: 'In Review', done: 'Released' })
  })

  it('treats an empty object as cleared (null)', () => {
    setStatusMap(db, PROJECT_ID, { todo: 'Backlog' })
    setStatusMap(db, PROJECT_ID, {})
    expect(getConnection(db, PROJECT_ID)?.statusMap).toBeNull()
  })
})

describe('JiraSyncManager.setStatusMap', () => {
  it('updates the persisted status map', () => {
    const mgr = new JiraSyncManager({
      db, projectId: PROJECT_ID, projectPath, broadcast: () => {}, startTimers: false,
    })
    mgr.setStatusMap({ in_progress: 'Doing', cancelled: "Won't Do" })
    expect(getConnection(db, PROJECT_ID)?.statusMap).toEqual({ in_progress: 'Doing', cancelled: "Won't Do" })
    mgr.setStatusMap(null)
    expect(getConnection(db, PROJECT_ID)?.statusMap).toBeNull()
  })
})
