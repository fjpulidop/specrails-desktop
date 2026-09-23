import http from 'http'
import path from 'path'
import os from 'os'
import fs from 'fs'



export const DETECTION_TIMEOUT_MS = 500

export const HTTP_REQUEST_TIMEOUT_MS = 15_000


// ---------------------------------------------------------------------------
// Manager detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  running: boolean
  baseUrl: string
}


export function detectWebManager(port: number): Promise<DetectionResult> {
  const baseUrl = `http://127.0.0.1:${port}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ running: false, baseUrl })
    }, DETECTION_TIMEOUT_MS)

    const req = http.get(`${baseUrl}/api/health`, { timeout: DETECTION_TIMEOUT_MS }, (res) => {
      clearTimeout(timer)
      res.resume() // drain the response
      if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ running: true, baseUrl })
      } else {
        resolve({ running: false, baseUrl })
      }
    })

    req.on('error', () => {
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })

    req.on('timeout', () => {
      req.destroy()
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })
  })
}


// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function loadDesktopToken(): string | null {
  const candidates = [
    path.join(os.homedir(), '.specrails', 'desktop.token'),
    // Legacy fallback: pre-rename installs keep the token at hub.token until the
    // server migrates it on next startup. Compat only — do not extend.
    path.join(os.homedir(), '.specrails', 'hub.token'),
  ]
  for (const tokenPath of candidates) {
    try {
      const t = fs.readFileSync(tokenPath, 'utf-8').trim()
      if (t.length >= 32) return t
    } catch {
      // try next candidate
    }
  }
  return null
}


export function requestTimeoutError(url: string, timeoutMs: number): Error {
  return new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
}


export function httpGet(url: string, timeoutMs = HTTP_REQUEST_TIMEOUT_MS): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const token = loadDesktopToken()
    const parsed = new URL(url)
    const headers: http.OutgoingHttpHeaders = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    }
    const req = http.get(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(requestTimeoutError(url, timeoutMs))
    })
    req.on('error', reject)
  })
}


export function httpPost(url: string, payload: unknown, timeoutMs = HTTP_REQUEST_TIMEOUT_MS): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const urlObj = new URL(url)
    const token = loadDesktopToken()
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers,
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(requestTimeoutError(url, timeoutMs))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}
