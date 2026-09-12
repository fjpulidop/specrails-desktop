import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { registerRuntimeRolePromptRoutes } from './runtime-role-prompts-router'
import { loadRuntimeRolePrompts } from './agent-runtime-settings'
const defaults = { architect: 'Plan', developer: 'Implement', reviewer: 'Review' }
vi.mock('./agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ rolePromptDefaults: () => defaults }) }))
let root: string
let app: express.Express
beforeEach(() => {
  root = mkdtempSync(join(os.tmpdir(), 'role-prompts-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  app = express(); app.use(express.json()); const router = express.Router(); registerRuntimeRolePromptRoutes(router); app.use('/api', router)
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
it('returns actual defaults, persists overrides and resets one role independently', async () => {
  expect((await request(app).get('/api/runtime-role-prompts')).body).toEqual({ defaults, overrides: {} })
  await request(app).put('/api/runtime-role-prompts').send({ overrides: { architect: 'My plan', reviewer: 'My review' } }).expect(200)
  expect((await request(app).get('/api/runtime-role-prompts')).body.overrides).toEqual({ architect: 'My plan', reviewer: 'My review' })
  await request(app).put('/api/runtime-role-prompts').send({ overrides: { reviewer: 'My review' } }).expect(200)
  expect(loadRuntimeRolePrompts()).toEqual({ reviewer: 'My review' })
})
it.each([null, [], { alien: 'x' }, { developer: ' ' }, { developer: 'x'.repeat(20001) }, { developer: 'x\0y' }])('rejects invalid prompts without replacing saved data (%j)', async overrides => {
  await request(app).put('/api/runtime-role-prompts').send({ overrides: { developer: 'Keep this' } }).expect(200)
  await request(app).put('/api/runtime-role-prompts').send({ overrides }).expect(400)
  expect(loadRuntimeRolePrompts()).toEqual({ developer: 'Keep this' })
})
