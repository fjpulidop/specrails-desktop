import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Test-only: start an ephemeral HTTP fixture on IPv4 loopback and wait until it
 * listens. `app.listen(0)` binds the IPv6 wildcard; on macOS another process
 * may own the same numeric port on 127.0.0.1, so a request to
 * `http://127.0.0.1:<port>` would reach that unrelated service (seen as a
 * plain-text "not found" under parallel test workers). Binding the exact host
 * the test requests makes the port unambiguous.
 */
export async function listenOnLoopback(app: { listen: (port: number, host: string, callback: () => void) => Server }): Promise<{ server: Server; port: number; baseUrl: string; close: () => Promise<void> }> {
  let server!: Server
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  const close = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return }
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
  return { server, port, baseUrl: `http://127.0.0.1:${port}`, close }
}
