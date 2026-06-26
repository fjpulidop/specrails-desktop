import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loopsApi, LoopPublishError, type LoopDefinition } from '../loops-api'

function fakeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const sampleLoop: LoopDefinition = {
  id: 'l1',
  name: 'X',
  description: null,
  status: 'draft',
  graph: { nodes: [], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loopsApi', () => {
  it('list() GETs /api/loops and unwraps the array', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(200, { loops: [sampleLoop] }))
    const loops = await loopsApi.list()
    expect(loops).toEqual([sampleLoop])
    expect(fetchMock).toHaveBeenCalledWith('/api/loops', expect.objectContaining({ method: 'GET' }))
  })

  it('create() POSTs the body and unwraps the loop', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(201, { loop: sampleLoop }))
    const loop = await loopsApi.create({ name: 'X' })
    expect(loop).toEqual(sampleLoop)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/loops')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'X' })
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('publish() returns the published loop on success', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(200, { loop: { ...sampleLoop, status: 'published' } }))
    const loop = await loopsApi.publish('l1')
    expect(loop.status).toBe('published')
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/publish', expect.objectContaining({ method: 'POST' }))
  })

  it('publish() throws LoopPublishError carrying the validation errors on 422', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeRes(422, { error: 'invalid', errors: [{ code: 'NO_START', message: 'no start' }] })
    )
    await expect(loopsApi.publish('l1')).rejects.toBeInstanceOf(LoopPublishError)
    fetchMock.mockResolvedValueOnce(
      fakeRes(422, { error: 'invalid', errors: [{ code: 'NO_END', message: 'no end' }] })
    )
    try {
      await loopsApi.publish('l1')
    } catch (err) {
      expect((err as LoopPublishError).errors[0].code).toBe('NO_END')
    }
  })

  it('remove() tolerates a 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(204, undefined))
    await expect(loopsApi.remove('l1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('surfaces the server error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(500, { error: 'boom' }))
    await expect(loopsApi.list()).rejects.toThrow('boom')
  })

  it('templates() + fromTemplate() hit the template endpoints', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(200, { templates: [{ id: 't', name: 'T', description: 'd', tags: [] }] }))
    expect(await loopsApi.templates()).toHaveLength(1)
    fetchMock.mockResolvedValueOnce(fakeRes(201, { loop: sampleLoop }))
    await loopsApi.fromTemplate('ship-and-green', 'Mine')
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/loops/from-template/ship-and-green')
    expect(JSON.parse(init.body)).toEqual({ name: 'Mine' })
  })

  it('duplicate() and unpublish() target the right routes', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(201, { loop: sampleLoop }))
    await loopsApi.duplicate('l1', 'Copy')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/loops/l1/duplicate', expect.objectContaining({ method: 'POST' }))
    fetchMock.mockResolvedValueOnce(fakeRes(200, { loop: sampleLoop }))
    await loopsApi.unpublish('l1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/loops/l1/unpublish', expect.objectContaining({ method: 'POST' }))
  })

  it('constants CRUD hit the global /api/loops/constants routes', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(200, { constants: [{ id: 'b', name: 'VERIFICATION_PASS', value: 'VERIFICATION: PASS', builtin: true }] }))
    const list = await loopsApi.loopConstants()
    expect(list[0].name).toBe('VERIFICATION_PASS')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/loops/constants', expect.objectContaining({ method: 'GET' }))

    fetchMock.mockResolvedValueOnce(fakeRes(201, { constant: { id: 'c1', name: 'FOO', value: 'bar' } }))
    const created = await loopsApi.createConstant('FOO', 'bar')
    expect(created).toEqual({ id: 'c1', name: 'FOO', value: 'bar' })
    const [, postInit] = fetchMock.mock.lastCall as [string, RequestInit]
    expect(JSON.parse(postInit.body as string)).toEqual({ name: 'FOO', value: 'bar' })

    fetchMock.mockResolvedValueOnce(fakeRes(200, { constant: { id: 'c1', name: 'FOO', value: 'baz' } }))
    await loopsApi.updateConstant('c1', 'baz')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/loops/constants/c1', expect.objectContaining({ method: 'PUT' }))

    fetchMock.mockResolvedValueOnce(fakeRes(200, { deleted: true }))
    await loopsApi.deleteConstant('c1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/loops/constants/c1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('previewLoop POSTs the graph to /loops/preview', async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(200, { steps: [{ nodeId: 'a', kind: 'ai-step', text: 'hi' }] }))
    const out = await loopsApi.previewLoop(sampleLoop.graph, 'codex')
    expect(out.steps[0].text).toBe('hi')
    const [url, init] = fetchMock.mock.lastCall as [string, RequestInit]
    expect(url).toBe('/api/loops/preview')
    expect(JSON.parse(init.body as string)).toEqual({ graph: sampleLoop.graph, provider: 'codex' })
  })
})
