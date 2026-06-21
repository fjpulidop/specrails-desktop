import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import http from 'http'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import net from 'net'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  parseArgs,
  formatDuration,
  formatTokens,
  getVersion,
  detectWebManager,
  printSummary,
  KNOWN_VERBS,
  _internal,
} from './specrails-desktop'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStdout(fn: () => void): string {
  const chunks: string[] = []
  const orig = process.stdout.write
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true }) as typeof process.stdout.write
  try { fn() } finally { process.stdout.write = orig }
  return chunks.join('')
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string) => { chunks.push(chunk); return true }) as typeof process.stderr.write
  try { fn() } finally { process.stderr.write = orig }
  return chunks.join('')
}

async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const orig = process.stdout.write
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true }) as typeof process.stdout.write
  try { await fn() } finally { process.stdout.write = orig }
  return chunks.join('')
}

async function captureStderrAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string) => { chunks.push(chunk); return true }) as typeof process.stderr.write
  try { await fn() } finally { process.stderr.write = orig }
  return chunks.join('')
}

interface MockRoute { method?: string; path: string; status: number; body: string | object }

function createMockServer(routes: MockRoute[]): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes.find((r) => req.url === r.path && (r.method === undefined || r.method === req.method))
      if (route) {
        const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
        res.writeHead(route.status, { 'Content-Type': 'application/json' })
        res.end(body)
      } else { res.writeHead(404); res.end('Not Found') }
    })
    server.listen(0, '127.0.0.1', () => { resolve({ server, port: (server.address() as net.AddressInfo).port }) })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns help mode with no args', () => { expect(parseArgs([])).toEqual({ mode: 'help' }) })
  it('returns help mode with --help flag', () => { expect(parseArgs(['--help'])).toEqual({ mode: 'help' }); expect(parseArgs(['-h'])).toEqual({ mode: 'help' }) })
  it('returns version mode with --version flag', () => { expect(parseArgs(['--version'])).toEqual({ mode: 'version' }); expect(parseArgs(['-v'])).toEqual({ mode: 'version' }) })
  it('returns status mode', () => { expect(parseArgs(['--status'])).toEqual({ mode: 'status', port: 4200 }) })
  it('returns jobs mode', () => { expect(parseArgs(['--jobs'])).toEqual({ mode: 'jobs', port: 4200 }) })
  it('parses --port flag', () => { expect(parseArgs(['--port', '5000', '--status'])).toEqual({ mode: 'status', port: 5000 }) })
  it('ignores invalid --port value and uses default', () => { expect(parseArgs(['--port', 'bad', '--status'])).toEqual({ mode: 'status', port: 4200 }) })
  it('routes "desktop" subcommand', () => {
    expect(parseArgs(['desktop', 'start'])).toEqual({ mode: 'desktop', subArgs: ['start'], port: 4200 })
    expect(parseArgs(['desktop', 'stop'])).toEqual({ mode: 'desktop', subArgs: ['stop'], port: 4200 })
    expect(parseArgs(['desktop', 'list'])).toEqual({ mode: 'desktop', subArgs: ['list'], port: 4200 })
  })
  it('routes shorthand server-management subcommands', () => {
    for (const cmd of ['start', 'stop', 'add', 'remove', 'list']) {
      expect(parseArgs([cmd])).toEqual({ mode: 'desktop', subArgs: [cmd], port: 4200 })
    }
  })
  it('passes extra args through', () => { expect(parseArgs(['add', '/some/path'])).toEqual({ mode: 'desktop', subArgs: ['add', '/some/path'], port: 4200 }) })
  it('injects /specrails: prefix for known verbs', () => { expect(parseArgs(['implement', '#42'])).toEqual({ mode: 'command', resolved: '/specrails:implement #42', port: 4200 }) })
  it('injects /specrails: prefix for batch-implement', () => { expect(parseArgs(['batch-implement', '#40', '#41'])).toEqual({ mode: 'command', resolved: '/specrails:batch-implement #40 #41', port: 4200 }) })
  it('passes through slash-prefixed commands as raw', () => { expect(parseArgs(['/specrails:implement', '#42'])).toEqual({ mode: 'raw', resolved: '/specrails:implement #42', port: 4200 }) })
  it('treats unknown tokens as raw prompt', () => { expect(parseArgs(['do something interesting'])).toEqual({ mode: 'raw', resolved: 'do something interesting', port: 4200 }) })
  it('strips --port from args before routing', () => { expect(parseArgs(['--port', '9999', 'implement', '#1'])).toEqual({ mode: 'command', resolved: '/specrails:implement #1', port: 9999 }) })
})

describe('formatDuration', () => {
  it('formats seconds', () => { expect(formatDuration(0)).toBe('0s'); expect(formatDuration(1000)).toBe('1s'); expect(formatDuration(59000)).toBe('59s') })
  it('formats minutes and seconds', () => { expect(formatDuration(60000)).toBe('1m 0s'); expect(formatDuration(90000)).toBe('1m 30s'); expect(formatDuration(3661000)).toBe('61m 1s') })
})

describe('formatTokens', () => {
  it('formats numbers with space separators', () => { expect(formatTokens(1000)).toBe('1 000'); expect(formatTokens(1234567)).toBe('1 234 567'); expect(formatTokens(42)).toBe('42') })
})

describe('getVersion', () => {
  it('returns a semver-like version string', () => { expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/) })
})

describe('KNOWN_VERBS', () => {
  it('contains expected verbs', () => {
    expect(KNOWN_VERBS.has('implement')).toBe(true)
    expect(KNOWN_VERBS.has('batch-implement')).toBe(true)
    expect(KNOWN_VERBS.has('health-check')).toBe(true)
    expect(KNOWN_VERBS.has('nonexistent')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

describe('ANSI helpers', () => {
  it('ansi returns raw text when not TTY', () => { expect(_internal.ansi('31', 'hello')).toBe('hello') })
  it('dim/red/bold/dimCyan return text', () => {
    expect(_internal.dim('t')).toBe('t'); expect(_internal.red('t')).toBe('t')
    expect(_internal.bold('t')).toBe('t'); expect(_internal.dimCyan('t')).toBe('t')
  })
  it('cliPrefix returns [specrails-desktop]', () => { expect(_internal.cliPrefix()).toContain('[specrails-desktop]') })
})

describe('cliLog', () => { it('writes to stdout with prefix', () => { const o = captureStdout(() => _internal.cliLog('msg')); expect(o).toContain('[specrails-desktop]'); expect(o).toContain('msg') }) })
describe('cliError', () => { it('writes to stderr with error prefix', () => { const o = captureStderr(() => _internal.cliError('bad')); expect(o).toContain('error: bad') }) })
describe('cliWarn', () => { it('writes to stderr with warning prefix', () => { const o = captureStderr(() => _internal.cliWarn('warn')); expect(o).toContain('warning: warn') }) })

describe('printVersion', () => { it('writes version to stdout', () => { const o = captureStdout(() => _internal.printVersion()); expect(o).toMatch(/specrails-desktop v\d+\.\d+\.\d+/) }) })

describe('printHelp', () => {
  it('writes help text', () => {
    const o = captureStdout(() => _internal.printHelp())
    expect(o).toContain('Usage:'); expect(o).toContain('implement'); expect(o).toContain('--status')
    expect(o).toContain('--jobs'); expect(o).toContain('Project Required')
  })
})

describe('printSummary', () => {
  it('prints duration and exit code', () => { const o = captureStdout(() => printSummary({ durationMs: 5000, exitCode: 0 })); expect(o).toContain('duration: 5s'); expect(o).toContain('exit: 0') })
  it('includes cost', () => { const o = captureStdout(() => printSummary({ durationMs: 1000, exitCode: 0, costUsd: 0.05 })); expect(o).toContain('cost: $0.05') })
  it('includes tokens', () => { const o = captureStdout(() => printSummary({ durationMs: 1000, exitCode: 0, totalTokens: 12345 })); expect(o).toContain('tokens: 12 345') })
})

describe('formatJobDuration', () => {
  it('returns dash for null', () => { expect(_internal.formatJobDuration(null)).toBe('-') })
  it('delegates to formatDuration', () => { expect(_internal.formatJobDuration(5000)).toBe('5s'); expect(_internal.formatJobDuration(90000)).toBe('1m 30s') })
})

describe('formatJobStarted', () => {
  it('formats ISO date string', () => { const r = _internal.formatJobStarted('2024-01-15T14:30:00Z'); expect(r).toMatch(/2024-01-15/); expect(r).toMatch(/\d{2}:\d{2}/) })
  it('handles invalid date', () => { expect(typeof _internal.formatJobStarted('not-a-date')).toBe('string') })
})

// ---------------------------------------------------------------------------
// httpGet / httpPost
// ---------------------------------------------------------------------------

describe('httpGet', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('returns status and body', async () => {
    ;({ server, port } = await createMockServer([{ path: '/test', status: 200, body: { ok: true } }]))
    const res = await _internal.httpGet(`http://127.0.0.1:${port}/test`)
    expect(res.status).toBe(200); expect(JSON.parse(res.body)).toEqual({ ok: true })
  })
  it('rejects on connection error', async () => { await expect(_internal.httpGet('http://127.0.0.1:19999/nope')).rejects.toThrow() })
})

describe('httpPost', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('sends JSON body and returns response', async () => {
    ;({ server, port } = await createMockServer([{ method: 'POST', path: '/submit', status: 201, body: { created: true } }]))
    const res = await _internal.httpPost(`http://127.0.0.1:${port}/submit`, { data: 'hello' })
    expect(res.status).toBe(201); expect(JSON.parse(res.body)).toEqual({ created: true })
  })
})

// ---------------------------------------------------------------------------
// detectWebManager
// ---------------------------------------------------------------------------

describe('detectWebManager', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('detects running manager', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }]))
    const result = await detectWebManager(port)
    expect(result.running).toBe(true); expect(result.baseUrl).toBe(`http://127.0.0.1:${port}`)
  })
  it('detects not running when no server', async () => { expect((await detectWebManager(19998)).running).toBe(false) })
  it('detects not running on non-200', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 500, body: 'error' }]))
    expect((await detectWebManager(port)).running).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPortInUse / readPid / isProcessRunning / desktopServerPath
// ---------------------------------------------------------------------------

describe('isPortInUse', () => {
  it('returns false for a free port', async () => { expect(await _internal.isPortInUse(0)).toBe(false) })
  it('returns true for busy port', async () => {
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    expect(await _internal.isPortInUse(p)).toBe(true)
    await new Promise<void>((r) => srv.close(() => r()))
  })
})

describe('readPid', () => { it('returns null or number', () => { const r = _internal.readPid(); expect(r === null || typeof r === 'number').toBe(true) }) })

describe('isProcessRunning', () => {
  it('returns true for current process', () => { expect(_internal.isProcessRunning(process.pid)).toBe(true) })
  it('returns false for non-existent PID', () => { expect(_internal.isProcessRunning(999999)).toBe(false) })
})

describe('desktopServerPath', () => { it('returns a path string', () => { const r = _internal.desktopServerPath(); expect(typeof r).toBe('string'); expect(r).toContain('server') }) })

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

describe('handleStatus', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })

  it('prints "not running" when no server', async () => {
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleStatus(19997)).toBe(1) })
    expect(o).toContain('not running')
  })

  it('prints running status for Super mode', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok', version: '1.0.0', mode: 'super', projects: 3 } }]))
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleStatus(port)).toBe(0) })
    expect(o).toContain('running'); expect(o).toContain('v1.0.0'); expect(o).toContain('super')
  })

  it('returns 1 when health returns non-200', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 500, body: 'error' }]))
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleStatus(port)).toBe(1) })
    expect(o).toContain('not running')
  })
})

// ---------------------------------------------------------------------------
// handleJobs
// ---------------------------------------------------------------------------

describe('handleJobs', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })

  it('returns 1 when manager not running', async () => {
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleJobs(19996)).toBe(1) }) })
    expect(se).toContain('not running')
  })

  it('prints "no jobs" when empty', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/jobs', status: 200, body: { jobs: [], total: 0 } }]))
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.handleJobs(port)).toBe(0) }) })
    expect(so).toContain('no jobs')
  })

  it('prints job table', async () => {
    ;({ server, port } = await createMockServer([
      { path: '/api/health', status: 200, body: { status: 'ok' } },
      { path: '/api/jobs', status: 200, body: { jobs: [{ id: 'abc12345-6789', command: '/specrails:implement #42', started_at: '2024-06-15T10:30:00Z', duration_ms: 45000, exit_code: 0, status: 'done' }], total: 1 } },
    ]))
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleJobs(port)).toBe(0) })
    expect(o).toContain('ID'); expect(o).toContain('abc12345'); expect(o).toContain('/specrails:implement #42')
  })

  it('handles 501 from /api/jobs', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/jobs', status: 501, body: '' }]))
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.handleJobs(port)).toBe(1) }) })
    expect(so).toContain('requires manager')
  })

  it('handles unexpected status', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/jobs', status: 503, body: '' }]))
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleJobs(port)).toBe(1) }) })
    expect(se).toContain('unexpected response')
  })

  it('handles invalid JSON', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })) }
      else if (req.url === '/api/jobs') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json') }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleJobs(p)).toBe(1) }) })
    expect(se).toContain('invalid response')
    await closeServer(srv)
  })
})

// ---------------------------------------------------------------------------
// handleDesktop
// ---------------------------------------------------------------------------

describe('handleDesktop', () => {
  it('prints help with no args', async () => { const o = await captureStdoutAsync(async () => { expect(await _internal.handleDesktop([], 4200)).toBe(0) }); expect(o).toContain('server management') })
  it('prints help with --help', async () => { const o = await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['--help'], 4200)).toBe(0) }); expect(o).toContain('server management') })
  it('prints help with -h', async () => { const o = await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['-h'], 4200)).toBe(0) }); expect(o).toContain('server management') })
  it('prints help with help subcommand', async () => { const o = await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['help'], 4200)).toBe(0) }); expect(o).toContain('server management') })
  it('errors for unknown subcommand', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['banana'], 4200)).toBe(1) }) }); expect(se).toContain('unknown subcommand') })
  it('errors for add without path', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['add'], 4200)).toBe(1) }) }); expect(se).toContain('usage:') })
  it('errors for remove without id', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.handleDesktop(['remove'], 4200)).toBe(1) }) }); expect(se).toContain('usage:') })
})

// ---------------------------------------------------------------------------
// desktopStatus / desktopAdd / desktopRemove / desktopList / desktopStop
// ---------------------------------------------------------------------------

describe('desktopStatus', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('not running', async () => { const o = await captureStdoutAsync(async () => { expect(await _internal.desktopStatus(19995)).toBe(1) }); expect(o).toContain('not running') })
  it('prints server state', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/state', status: 200, body: { projectCount: 2, projects: [{ name: 'a' }, { name: 'b' }] } }]))
    const o = await captureStdoutAsync(async () => { expect(await _internal.desktopStatus(port)).toBe(0) })
    expect(o).toContain('running'); expect(o).toContain('projects: 2'); expect(o).toContain('a'); expect(o).toContain('b')
  })
})

describe('desktopAdd', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('not running', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopAdd('/p', 19994)).toBe(1) }) }); expect(se).toContain('not running') })
  it('adds project', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { method: 'POST', path: '/api/projects', status: 201, body: { project: { name: 'tp', id: '1' } } }]))
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.desktopAdd('/p', port)).toBe(0) }) })
    expect(so).toContain('added project: tp')
  })
  it('handles 409', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { method: 'POST', path: '/api/projects', status: 409, body: {} }]))
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.desktopAdd('/p', port)).toBe(0) }) })
    expect(so).toContain('already registered')
  })
  it('handles error', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { method: 'POST', path: '/api/projects', status: 400, body: { error: 'bad path' } }]))
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopAdd('/p', port)).toBe(1) }) })
    expect(se).toContain('bad path')
  })
})

describe('desktopRemove', () => {
  let server: http.Server
  afterEach(async () => { if (server) await closeServer(server) })
  it('not running', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopRemove('id', 19993)).toBe(1) }) }); expect(se).toContain('not running') })
  it('removes project', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })) }
      else if (req.url === '/api/projects/id' && req.method === 'DELETE') { res.writeHead(200); res.end('{}') }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const p = (server.address() as net.AddressInfo).port
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.desktopRemove('id', p)).toBe(0) }) })
    expect(so).toContain('project removed')
  })
  it('handles error', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })) }
      else if (req.url === '/api/projects/id' && req.method === 'DELETE') { res.writeHead(404); res.end('{}') }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const p = (server.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopRemove('id', p)).toBe(1) }) })
    expect(se).toContain('failed to remove')
  })
})

describe('desktopList', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('not running', async () => { const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopList(19992)).toBe(1) }) }); expect(se).toContain('not running') })
  it('no projects', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/projects', status: 200, body: { projects: [] } }]))
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.desktopList(port)).toBe(0) }) })
    expect(so).toContain('no projects')
  })
  it('prints table', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/health', status: 200, body: { status: 'ok' } }, { path: '/api/projects', status: 200, body: { projects: [{ id: 'u1', name: 'p1', path: '/a' }, { id: 'u2', name: 'p2', path: '/b' }] } }]))
    const o = await captureStdoutAsync(async () => { expect(await _internal.desktopList(port)).toBe(0) })
    expect(o).toContain('p1'); expect(o).toContain('p2'); expect(o).toContain('ID')
  })
})

describe('desktopStop', () => {
  it('reports not running', async () => {
    // Temporarily hide the real PID file so the test always sees "not running"
    const pidFile = _internal.DESKTOP_PID_FILE
    const bakFile = pidFile + '.test-bak'
    const hadPidFile = fs.existsSync(pidFile)
    if (hadPidFile) fs.renameSync(pidFile, bakFile)
    try {
      let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.desktopStop()).toBe(0) }) })
      expect(so).toContain('not running')
    } finally {
      if (hadPidFile) fs.renameSync(bakFile, pidFile)
    }
  })
})

// ---------------------------------------------------------------------------
// resolveProjectFromCwd
// ---------------------------------------------------------------------------

describe('resolveProjectFromCwd', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })
  it('returns project when found', async () => {
    const cwd = process.cwd()
    ;({ server, port } = await createMockServer([{ path: `/api/resolve?path=${encodeURIComponent(cwd)}`, status: 200, body: { project: { id: 'p1', name: 'test', path: cwd } } }]))
    expect(await _internal.resolveProjectFromCwd(`http://127.0.0.1:${port}`)).toEqual({ id: 'p1', name: 'test', path: cwd })
  })
  it('returns null on 404', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/resolve', status: 404, body: '' }]))
    expect(await _internal.resolveProjectFromCwd(`http://127.0.0.1:${port}`)).toBeNull()
  })
  it('returns null on error', async () => { expect(await _internal.resolveProjectFromCwd('http://127.0.0.1:19991')).toBeNull() })

  it('auto-picks on a unique --project name match', async () => {
    ;({ server, port } = await createMockServer([
      { path: '/api/projects', status: 200, body: { projects: [
        { id: 'p1', name: 'app', path: '/repos/app' },
        { id: 'p2', name: 'web', path: '/repos/web' },
      ] } },
    ]))
    expect(await _internal.resolveProjectFromCwd(`http://127.0.0.1:${port}`, 'app'))
      .toEqual({ id: 'p1', name: 'app', path: '/repos/app' })
  })

  it('errors and returns null on an ambiguous --project name collision', async () => {
    ;({ server, port } = await createMockServer([
      { path: '/api/projects', status: 200, body: { projects: [
        { id: 'p1', name: 'app', path: '/repos/a/app' },
        { id: 'p2', name: 'app', path: '/repos/b/app' },
      ] } },
    ]))
    let result: unknown
    const se = await captureStderrAsync(async () => {
      result = await _internal.resolveProjectFromCwd(`http://127.0.0.1:${port}`, 'app')
    })
    expect(result).toBeNull()
    expect(se).toContain('ambiguous')
    expect(se).toContain('/repos/a/app')
    expect(se).toContain('/repos/b/app')
    expect(se).toContain('p1')
    expect(se).toContain('p2')
  })

  it('returns null when no --project name matches', async () => {
    ;({ server, port } = await createMockServer([
      { path: '/api/projects', status: 200, body: { projects: [
        { id: 'p1', name: 'app', path: '/repos/app' },
      ] } },
    ]))
    expect(await _internal.resolveProjectFromCwd(`http://127.0.0.1:${port}`, 'nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runViaWebManager
// ---------------------------------------------------------------------------

describe('runViaWebManager', () => {
  let server: http.Server; let wss: WebSocketServer; let port: number
  afterEach(async () => { if (wss) wss.close(); if (server) await closeServer(server) })

  it('spawns job and streams logs until exit', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end(); return }
      if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'j1' })); return }
      if (req.url === '/api/jobs/j1') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ job: { total_cost_usd: 0.01, tokens_in: 100, tokens_out: 50, duration_ms: 2000 } })); return }
      res.writeHead(404); res.end()
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => { setTimeout(() => { ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: 'Hello', processId: 'j1' })); ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'j1' })) }, 50) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(0) }) })
    expect(so).toContain('Hello'); expect(so).toContain('done')
  })

  it('handles 409 from spawn', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/state', status: 404, body: '' }, { method: 'POST', path: '/api/spawn', status: 409, body: {} }]))
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(1) }) })
    expect(se).toContain('busy')
  })

  it('handles generic error from spawn', async () => {
    ;({ server, port } = await createMockServer([{ path: '/api/state', status: 404, body: '' }, { method: 'POST', path: '/api/spawn', status: 500, body: { error: 'err' } }]))
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(1) }) })
    expect(se).toContain('err')
  })

  it('handles invalid JSON from spawn', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('bad') }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${p}`)).toBe(1) }) })
    expect(se).toContain('invalid response')
    await closeServer(srv)
  })

  it('handles Super mode with project', async () => {
    const cwd = process.cwd()
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ projectCount: 1 })) }
      else if (req.url?.startsWith('/api/resolve')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ project: { id: 'p1', name: 'proj', path: cwd } })) }
      else if (req.method === 'POST' && req.url === '/api/projects/p1/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'j2' })) }
      else if (req.url === '/api/projects/p1/jobs/j2') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ job: { total_cost_usd: 0.02, tokens_in: 200, tokens_out: 100 } })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => { setTimeout(() => {
      ws.send(JSON.stringify({ type: 'phase', phase: 'dev', state: 'running' }))
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: 'Work', processId: 'j2' }))
      ws.send(JSON.stringify({ type: 'log', source: 'stderr', line: 'dbg', processId: 'j2' }))
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'j2' }))
    }, 50) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    let so = ''; let se = ''
    se = await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(0) }) })
    expect(so).toContain('project: proj'); expect(so).toContain('Work'); expect(se).toContain('dbg')
  })

  it('handles Super mode with no project', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ projectCount: 0 })) }
      else if (req.url?.startsWith('/api/resolve')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({})) }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(1) }) })
    expect(se).toContain('no project registered')
  })

  it('handles init message with log buffer', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'j3' })) }
      else if (req.url === '/api/jobs/j3') { res.writeHead(404); res.end() }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => { setTimeout(() => {
      ws.send(JSON.stringify({ type: 'init', logBuffer: [{ type: 'log', source: 'stdout', line: 'Buf1', processId: 'j3' }, { type: 'log', source: 'stdout', line: 'Other', processId: 'x' }] }))
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'j3' }))
    }, 50) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`) }) })
    expect(so).toContain('Buf1'); expect(so).not.toContain('Other')
  })

  it('handles WS close before exit', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'jc' })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => { setTimeout(() => ws.close(), 50) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`)).toBe(1) }) })
    expect(se).toContain('lost connection')
  })

  it('filters other process logs', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'mj' })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => { setTimeout(() => {
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: 'other', processId: 'x' }))
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: 'mine', processId: 'mj' }))
      ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'mj' }))
    }, 50) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`) }) })
    expect(so).toContain('mine'); expect(so).not.toContain('other')
  })

  it('handles spawn connection error', async () => {
    // Server for the state check but nothing for spawn
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else { res.destroy() }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${p}`)).toBe(1) }) })
    expect(se).toContain('failed to connect')
    await closeServer(srv)
  })
})

// ---------------------------------------------------------------------------
// runDirect (with mock claude binary)
// ---------------------------------------------------------------------------

describe('runDirect', () => {
  let tmpDir: string
  let origPath: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'))
    origPath = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = origPath
    try { fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f))); fs.rmdirSync(tmpDir) } catch {}
  })

  function mockClaude(script: string) {
    const p = path.join(tmpDir, 'claude')
    fs.writeFileSync(p, `#!/usr/bin/env node\n${script}`, { mode: 0o755 })
    process.env.PATH = `${tmpDir}:${origPath}`
  }

  it('runs claude and handles stream-json (real assistant + result shapes)', async () => {
    // Real claude: assistant text comes as message.content[] {type:'text',text},
    // cost is total_cost_usd, tokens nest under usage.* (mirror claude-adapter).
    mockClaude(`
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('/specrails:implement #42')).toBe(0) }) })
    expect(so).toContain('Hello'); expect(so).toContain('cost: $0.01'); expect(so).toContain('tokens: 150')
  })

  it('prints the final answer text from the result.result field', async () => {
    mockClaude(`
process.stdout.write(JSON.stringify({ type: 'result', result: 'final answer here', total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
    expect(so).toContain('final answer here'); expect(so).toContain('cost: $0.02'); expect(so).toContain('tokens: 15')
  })

  it('concatenates multiple text blocks in an assistant message', async () => {
    mockClaude(`
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'foo' }, { type: 'tool_use', name: 'Read' }, { type: 'text', text: 'bar' }] } }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
    expect(so).toContain('foobar')
  })

  it('passes a multi-word prompt as a single argv element', async () => {
    // BUG-CLI-01: the prompt must reach claude as ONE -p operand, not split on
    // whitespace. The mock echoes its argv as JSON so we can assert the shape.
    mockClaude(`
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] } }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('fix the   login bug')).toBe(0) }) })
    const printed = so.split('\n').find((l) => l.trim().startsWith('['))
    expect(printed).toBeDefined()
    const argv = JSON.parse(printed!.trim()) as string[]
    const pIdx = argv.indexOf('-p')
    expect(pIdx).toBeGreaterThanOrEqual(0)
    // The element right after -p is the whole prompt; no stray positionals.
    expect(argv[pIdx + 1]).toBe('fix the   login bug')
  })

  it('handles non-json output', async () => {
    mockClaude(`
process.stdout.write('plain text\\n');
process.stdout.write(JSON.stringify({ type: 'text', content: 'json' }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
    expect(so).toContain('plain text'); expect(so).toContain('json')
  })

  it('handles non-zero exit', async () => {
    mockClaude(`process.stderr.write('Error\\n'); process.exit(1);`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('bad')).toBe(1) }) })
    expect(so).toContain('exit: 1')
  })

  it('handles empty lines', async () => {
    mockClaude(`
process.stdout.write('\\n');
process.stdout.write(JSON.stringify({ type: 'text', content: 'after' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'other' }) + '\\n');
process.exit(0);
`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
    expect(so).toContain('after')
  })

  it('handles result with partial token fields (usage.input_tokens only)', async () => {
    mockClaude(`process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 200 } }) + '\\n'); process.exit(0);`)
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
    expect(so).toContain('tokens: 200')
  })

  it('handles text with empty content', async () => {
    mockClaude(`process.stdout.write(JSON.stringify({ type: 'text', content: '' }) + '\\n'); process.exit(0);`)
    await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.runDirect('cmd')).toBe(0) }) })
  })
})

// ---------------------------------------------------------------------------
// desktopStart
// ---------------------------------------------------------------------------

describe('desktopStart', () => {
  // desktopStart short-circuits with "server already running" when
  // ~/.specrails/manager.pid points at a live PID. Tests must not
  // depend on the developer's machine state — back up + clear the
  // pid file for the duration of each test, restore afterwards.
  let _pidBackup: string | null = null

  beforeEach(() => {
    try {
      _pidBackup = fs.readFileSync(_internal.DESKTOP_PID_FILE, 'utf-8')
    } catch {
      _pidBackup = null
    }
    try {
      fs.rmSync(_internal.DESKTOP_PID_FILE, { force: true })
    } catch {
      /* not present — fine */
    }
  })

  afterEach(() => {
    if (_pidBackup !== null) {
      try {
        fs.mkdirSync(path.dirname(_internal.DESKTOP_PID_FILE), { recursive: true })
        fs.writeFileSync(_internal.DESKTOP_PID_FILE, _pidBackup, 'utf-8')
      } catch {
        /* best-effort restore */
      }
    }
  })

  it('port busy error', async () => {
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => { expect(await _internal.desktopStart(p)).toBe(1) }) })
    expect(se).toContain('already in use')
    await new Promise<void>((r) => srv.close(() => r()))
  })
})

// ---------------------------------------------------------------------------
// EXIT_PATTERN / Constants
// ---------------------------------------------------------------------------

describe('EXIT_PATTERN', () => {
  it('matches exit lines', () => { const m = _internal.EXIT_PATTERN.exec('[process exited with code 0]'); expect(m).not.toBeNull(); expect(m![1]).toBe('0') })
  it('matches non-zero exit', () => { const m = _internal.EXIT_PATTERN.exec('[process exited with code 1]'); expect(m![1]).toBe('1') })
  it('no match on random text', () => { expect(_internal.EXIT_PATTERN.exec('hello')).toBeNull() })
})

describe('constants', () => {
  it('DEFAULT_PORT is 4200', () => { expect(_internal.DEFAULT_PORT).toBe(4200) })
  it('DETECTION_TIMEOUT_MS is 500', () => { expect(_internal.DETECTION_TIMEOUT_MS).toBe(500) })
  it('DESKTOP_PID_FILE and DESKTOP_LOG_FILE paths', () => { expect(_internal.DESKTOP_PID_FILE).toContain('.specrails'); expect(_internal.DESKTOP_LOG_FILE).toContain('.specrails') })
})

// ---------------------------------------------------------------------------
// Additional targeted coverage tests
// ---------------------------------------------------------------------------

describe('runDirect edge cases', () => {
  it('handles missing claude binary (ENOENT)', async () => {
    const origPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const se = await captureStderrAsync(async () => {
        await captureStdoutAsync(async () => {
          const code = await _internal.runDirect('cmd')
          expect(code).toBe(1)
        })
      })
      expect(se).toContain('claude')
    } finally {
      process.env.PATH = origPath
    }
  })
})

describe('desktopStop edge cases', () => {
  it('stops a running process (using current PID file simulation)', async () => {
    // Create a temp pid file pointing to a background process
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-test-'))
    const tmpPidFile = path.join(tmpDir, 'manager.pid')

    // Spawn a background sleep process we can kill
    const { spawn } = require('child_process')
    const sleepProc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    sleepProc.unref()
    const pid = sleepProc.pid!

    fs.writeFileSync(tmpPidFile, String(pid))

    // We can't easily redirect readPid to use tmpPidFile without mocking,
    // so test isProcessRunning + kill directly
    expect(_internal.isProcessRunning(pid)).toBe(true)
    try { process.kill(pid, 'SIGTERM') } catch {}

    // Cleanup
    try { fs.unlinkSync(tmpPidFile) } catch {}
    try { fs.rmdirSync(tmpDir) } catch {}
  })
})

describe('runViaWebManager additional edge cases', () => {
  let server: http.Server; let wss: WebSocketServer; let port: number
  afterEach(async () => { if (wss) wss.close(); if (server) await closeServer(server) })

  it('handles WS non-JSON message gracefully', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'jx' })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send('not json at all')
        ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'jx' }))
      }, 50)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      const code = await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`)
      expect(code).toBe(0)
    }) })
  })

  it('handles missing jobId in spawn response', async () => {
    ;({ server, port } = await createMockServer([
      { path: '/api/state', status: 404, body: '' },
      { method: 'POST', path: '/api/spawn', status: 200, body: {} },
    ]))
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      expect(await _internal.runViaWebManager('cmd', `http://127.0.0.1:${port}`)).toBe(1)
    }) })
    expect(se).toContain('invalid response')
  })

  it('handles spawn response with processId fallback field', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ processId: 'legacy-id' })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'legacy-id' }))
      }, 50)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      const code = await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`)
      expect(code).toBe(0)
    }) })
  })

  it('handles job metadata fetch failure gracefully', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'jm' })) }
      else { res.writeHead(404); res.end() }
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'log', source: 'stdout', line: '[process exited with code 0]', processId: 'jm' }))
      }, 50)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => {
      const code = await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`)
      expect(code).toBe(0)
    }) })
    // Should still print summary even without job metadata
    expect(so).toContain('done')
  })
})

describe('handleJobs edge case', () => {
  it('handles fetch failure for /api/jobs', async () => {
    // Create server that drops connection on /api/jobs
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (req.url === '/api/jobs') {
        req.socket.destroy()
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p = (srv.address() as net.AddressInfo).port
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      expect(await _internal.handleJobs(p)).toBe(1)
    }) })
    expect(se).toContain('failed to fetch')
    await closeServer(srv)
  })

  it('handles job with null exit_code and duration_ms', async () => {
    const { server: srv, port: p } = await createMockServer([
      { path: '/api/health', status: 200, body: { status: 'ok' } },
      { path: '/api/jobs', status: 200, body: { jobs: [{ id: 'j1', command: 'cmd', started_at: '2024-01-01T00:00:00Z', duration_ms: null, exit_code: null, status: 'running' }], total: 1 } },
    ])
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleJobs(p)).toBe(0) })
    expect(o).toContain('j1')
    expect(o).toContain('-')  // null duration shows as dash
    await closeServer(srv)
  })
})

describe('handleStatus edge case', () => {
  it('prints status without version', async () => {
    const { server: srv, port: p } = await createMockServer([
      { path: '/api/health', status: 200, body: { status: 'ok', mode: 'super' } },
    ])
    const o = await captureStdoutAsync(async () => { expect(await _internal.handleStatus(p)).toBe(0) })
    expect(o).toContain('running')
    expect(o).not.toContain('undefined')
    await closeServer(srv)
  })
})

// ---------------------------------------------------------------------------
// main function tests (with process.exit mock)
// ---------------------------------------------------------------------------

class ExitError extends Error {
  code: number
  constructor(code: number) { super('process.exit'); this.code = code }
}

describe('main', () => {
  let origExit: typeof process.exit
  let origArgv: string[]
  let exitCode: number

  beforeEach(() => {
    origExit = process.exit
    origArgv = process.argv
    exitCode = -1
    process.exit = ((code: number) => { exitCode = code ?? 0; throw new ExitError(code ?? 0) }) as any
  })

  afterEach(() => {
    process.exit = origExit
    process.argv = origArgv
  })

  async function runMain(): Promise<void> {
    try { await _internal.main() } catch (e) { if (!(e instanceof ExitError)) throw e }
  }

  it('handles --version flag', async () => {
    process.argv = ['node', 'specrails-desktop', '--version']
    const so = await captureStdoutAsync(async () => { await runMain() })
    expect(so).toMatch(/specrails-desktop v\d+/)
    expect(exitCode).toBe(0)
  })

  it('handles --help flag', async () => {
    process.argv = ['node', 'specrails-desktop', '--help']
    const so = await captureStdoutAsync(async () => { await runMain() })
    expect(so).toContain('Usage:')
    expect(exitCode).toBe(0)
  })

  it('handles no args (help)', async () => {
    process.argv = ['node', 'specrails-desktop']
    const so = await captureStdoutAsync(async () => { await runMain() })
    expect(so).toContain('Usage:')
    expect(exitCode).toBe(0)
  })

  it('handles --status with no server', async () => {
    process.argv = ['node', 'specrails-desktop', '--status', '--port', '19989']
    const so = await captureStdoutAsync(async () => { await runMain() })
    expect(so).toContain('not running')
    expect(exitCode).toBe(1)
  })

  it('handles --jobs with no server', async () => {
    process.argv = ['node', 'specrails-desktop', '--jobs', '--port', '19988']
    await captureStderrAsync(async () => { await captureStdoutAsync(async () => { await runMain() }) })
    expect(exitCode).toBe(1)
  })

  it('handles desktop help subcommand', async () => {
    process.argv = ['node', 'specrails-desktop', 'desktop', 'help']
    const so = await captureStdoutAsync(async () => { await runMain() })
    expect(so).toContain('server management')
    expect(exitCode).toBe(0)
  })


})

// ---------------------------------------------------------------------------
// WS error handler
// ---------------------------------------------------------------------------

describe('runViaWebManager WS error', () => {
  let server: http.Server; let wss: WebSocketServer; let port: number
  afterEach(async () => { if (wss) wss.close(); if (server) await closeServer(server) })

  it('handles WS error event', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/state') { res.writeHead(404); res.end() }
      else if (req.method === 'POST' && req.url === '/api/spawn') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jobId: 'je' })) }
      else { res.writeHead(404); res.end() }
    })
    // Create WS server that terminates connection abruptly
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.terminate()
      }, 50)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
    await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      const code = await _internal.runViaWebManager('t', `http://127.0.0.1:${port}`)
      expect(code).toBe(1)
    }) })
  })
})

// ---------------------------------------------------------------------------
// handleDesktop dispatching start/stop/status/list to real functions
// ---------------------------------------------------------------------------

describe('handleDesktop dispatch', () => {
  let server: http.Server; let port: number
  afterEach(async () => { if (server) await closeServer(server) })

  it('dispatches stop subcommand', async () => {
    const pidFile = _internal.DESKTOP_PID_FILE
    const bakFile = pidFile + '.dispatch-test-bak'
    const hadPidFile = fs.existsSync(pidFile)
    if (hadPidFile) fs.renameSync(pidFile, bakFile)
    try {
      let so = ''; await captureStderrAsync(async () => { so = await captureStdoutAsync(async () => {
        const code = await _internal.handleDesktop(['stop'], 4200)
        expect(code).toBe(0)
      }) })
      expect(so).toContain('not running')
    } finally {
      if (hadPidFile) fs.renameSync(bakFile, pidFile)
    }
  })

  it('dispatches status subcommand', async () => {
    const o = await captureStdoutAsync(async () => {
      const code = await _internal.handleDesktop(['status'], 19984)
      expect(code).toBe(1)
    })
    expect(o).toContain('not running')
  })

  it('dispatches list subcommand when server not running', async () => {
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      expect(await _internal.handleDesktop(['list'], 19983)).toBe(1)
    }) })
    expect(se).toContain('not running')
  })

  it('dispatches add subcommand when server not running', async () => {
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      expect(await _internal.handleDesktop(['add', '/tmp/test'], 19982)).toBe(1)
    }) })
    expect(se).toContain('not running')
  })

  it('dispatches remove subcommand when server not running', async () => {
    const se = await captureStderrAsync(async () => { await captureStdoutAsync(async () => {
      expect(await _internal.handleDesktop(['remove', 'some-id'], 19981)).toBe(1)
    }) })
    expect(se).toContain('not running')
  })
})
