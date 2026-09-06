export const DEFAULT_DEV_SERVER_PORT = 4200
export const DEFAULT_DEV_CLIENT_PORT = 4201

export type EnvLike = Record<string, string | undefined>

export function parseDevPort(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return fallback
  return port
}

export function resolveServerPort(argv: readonly string[], env: EnvLike = process.env): number {
  let port = parseDevPort(env.SPECRAILS_DEV_SERVER_PORT ?? env.SPECRAILS_PORT, DEFAULT_DEV_SERVER_PORT)

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseDevPort(argv[++i], port)
    }
  }

  return port
}

export function resolveWebDevPorts(env: EnvLike = process.env): {
  serverPort: number
  clientPort: number
  serverOrigin: string
  wsUrl: string
} {
  const serverPort = resolveServerPort([], env)
  const clientPort = parseDevPort(env.SPECRAILS_DEV_CLIENT_PORT, DEFAULT_DEV_CLIENT_PORT)
  if (serverPort === clientPort) {
    throw new Error('SPECRAILS_DEV_CLIENT_PORT must differ from the Specrails API port (SPECRAILS_DEV_SERVER_PORT or SPECRAILS_PORT).')
  }
  return {
    serverPort,
    clientPort,
    // index.ts binds IPv4 loopback. localhost can resolve to another app on ::1
    // using the same numeric port, including a frontend returning HTML for /api.
    serverOrigin: `http://127.0.0.1:${serverPort}`,
    wsUrl: `ws://127.0.0.1:${serverPort}`,
  }
}
