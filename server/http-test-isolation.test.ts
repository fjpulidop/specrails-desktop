import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'

const servers: Server[] = []
async function listener(body: string, host: string, port = 0): Promise<Server> {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ owner: body })) })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, ipv6Only: host === '::' }, () => { server.removeListener('error', reject); resolve() })
  })
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return }
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

it('connects to its IPv6 fixture when an unrelated IPv4 service owns the same numeric port', async () => {
  const unrelated = await listener('unrelated service', '127.0.0.1')
  const fixture = await listener('test fixture', '::', (unrelated.address() as AddressInfo).port)
  const response = await request(fixture).get('/proof')
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ owner: 'test fixture' })
})

it('retains explicit IPv4 fixture connections', async () => {
  const fixture = await listener('IPv4 fixture', '127.0.0.1')
  expect((await request(fixture).get('/proof')).body).toEqual({ owner: 'IPv4 fixture' })
})

it('does not redirect explicitly addressed HTTP endpoints', async () => {
  const fixture = await listener('explicit URL', '127.0.0.1')
  expect((await request(`http://127.0.0.1:${(fixture.address() as AddressInfo).port}`).get('/proof')).body).toEqual({ owner: 'explicit URL' })
})
