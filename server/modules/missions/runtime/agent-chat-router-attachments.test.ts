import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import fs from 'fs'
import path from 'path'
import request from 'supertest'

// The attachment manager singleton resolves its home at import time.
const testHome = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/agent-chat-attachments-${process.pid}`
  process.env.SPECRAILS_REGISTRY_HOME = dir
  return dir
})

import { initDesktopDb, type DbInstance } from '../../../desktop-db'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import { createAgentChatRouter } from './agent-chat-router'
import type { AgentChatManager } from './agent-chat-manager'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])

let db: DbInstance
let conversationId: string

beforeEach(() => {
  fs.mkdirSync(testHome, { recursive: true })
  db = initDesktopDb(':memory:')
  conversationId = createAgentConversation(db, { provider: 'claude' }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(testHome, { recursive: true, force: true })
})

function upload(file: Buffer, filename: string, contentType?: string) {
  const app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentChatRouter({ manager: {} as unknown as AgentChatManager, desktopDb: db }))
  return request(app)
    .post(`/api/agent/conversations/${conversationId}/attachments`)
    .attach('file', file, { filename, contentType })
}

describe('agent conversation attachment upload', () => {
  it.each(['notes.md', 'dump.sql', 'main.ts', 'config.yaml'])('accepts %s as readable text', async (filename) => {
    const res = await upload(Buffer.from('some content'), filename)

    expect(res.status).toBe(201)
    expect(Object.keys(res.body)).toEqual(['attachment'])
    expect(res.body.attachment).toMatchObject({ filename, mimeType: 'text/plain', size: 12 })
  })

  it('refuses a zip with a message naming the file and the reason', async () => {
    const res = await upload(ZIP_HEADER, 'bundle.zip', 'application/zip')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('"bundle.zip" is not a text file and cannot be attached')
  })

  it('refuses a file over 25 MB with the size error', async () => {
    const res = await upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61), 'huge.log')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('File too large (max 25 MB)')
  })

  it('keeps application/pdf for a PDF named .png', async () => {
    const res = await upload(Buffer.from('%PDF-1.4'), 'report.png', 'application/pdf')

    expect(res.status).toBe(201)
    expect(res.body.attachment.mimeType).toBe('application/pdf')
  })

  it('still reports a missing file field', async () => {
    const app = express()
    app.use('/api/agent', createAgentChatRouter({ manager: {} as unknown as AgentChatManager, desktopDb: db }))

    const res = await request(app).post(`/api/agent/conversations/${conversationId}/attachments`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No file uploaded')
  })
})
