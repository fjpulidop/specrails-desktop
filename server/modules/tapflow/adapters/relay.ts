/**
 * Tapflow's relay over loopback HTTP: liveness, and the one-time admin account and token Specrails
 * creates so the person never sees a login. `tapflow start` has no env bootstrap (only Tapflow's
 * standalone relay reads TAPFLOW_ADMIN_*), so it goes through `POST /auth/init`, which Tapflow accepts
 * from the relay host only. Secrets live in a 0700 directory as 0600 files and are never logged.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { TapflowRelay } from '../application'

type Fetch = typeof fetch

const ADMIN_FILE = 'admin.json'
const TOKEN_FILE = 'token.json'

export interface TapflowSecrets {
  admin(): { email: string; password: string } | null
  token(): string | null
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

function writeSecret(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function createTapflowSecrets(secretsDir: string): TapflowSecrets {
  return {
    admin: () => readJson<{ email: string; password: string }>(path.join(secretsDir, ADMIN_FILE)),
    token: () => readJson<{ token: string }>(path.join(secretsDir, TOKEN_FILE))?.token ?? null,
  }
}

export function createTapflowRelay(deps: { secretsDir: string; fetchImpl?: Fetch; probeTimeoutMs?: number; sleep?: (ms: number) => Promise<void> }): TapflowRelay {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const base = (port: number) => `http://127.0.0.1:${port}/api/v1`

  async function authStatus(port: number): Promise<{ initialized: boolean } | null> {
    try {
      const res = await fetchImpl(`${base(port)}/auth/status`, { signal: AbortSignal.timeout(deps.probeTimeoutMs ?? 1_500) })
      if (!res.ok) return null
      const body = await res.json() as { initialized?: unknown }
      return typeof body.initialized === 'boolean' ? { initialized: body.initialized } : null
    } catch {
      return null
    }
  }

  async function post(port: number, route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetchImpl(`${base(port)}${route}`, {
      method: 'POST',
      // Tapflow's CSRF guard wants a same-origin request.
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  }

  return {
    answering: async (port) => (await authStatus(port)) !== null,
    waitAnswering: async (port, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if ((await authStatus(port)) !== null) return true
        if (Date.now() >= deadline) return false
        await sleep(250)
      }
    },
    ensureCredentials: async (port) => {
      const secrets = createTapflowSecrets(deps.secretsDir)
      if (secrets.token()) return
      const status = await authStatus(port)
      if (!status) throw new Error('Tapflow is not answering.')
      let admin = secrets.admin()
      if (!status.initialized) {
        admin = { email: 'specrails@localhost', password: crypto.randomBytes(24).toString('base64url') }
        writeSecret(deps.secretsDir, ADMIN_FILE, admin)
        const init = await post(port, '/auth/init', admin)
        if (init.status !== 201) throw new Error(`Tapflow refused to create its account (HTTP ${init.status}).`)
      } else if (!admin) {
        throw new Error('This Tapflow already has an account Specrails did not create; sign in to it from its dashboard.')
      }
      const login = await post(port, '/auth/login', admin)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (login.status !== 200 || !cookie) throw new Error(`Tapflow refused the sign-in (HTTP ${login.status}).`)
      const created = await post(port, '/tokens', { name: 'specrails', scope: 'view,builds:write' }, { cookie })
      const token = created.status === 201 ? ((await created.json()) as { token?: unknown }).token : null
      if (typeof token !== 'string' || !token.startsWith('tflw_pat_')) throw new Error(`Tapflow did not issue a token (HTTP ${created.status}).`)
      writeSecret(deps.secretsDir, TOKEN_FILE, { token })
    },
  }
}
