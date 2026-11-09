import fs from 'fs'
import path from 'path'
import { X509Certificate, createHash } from 'crypto'
import { generate as selfsignedGenerate } from 'selfsigned'
import { resolveSpecrailsHome } from '../util/specrails-home'

// Self-signed TLS for the gateway. Identity = sha256 of the cert DER, pinned by
// the phone from the QR (Syncthing/LocalSend TOFU). We generate ECDSA P-256
// (pure JS via selfsigned/node-forge — no native deps, no build-sidecar change).
//
// selfsigned 5.x's generate() is async-only, so the helpers here are async; every
// caller (gateway start/rotate) already runs in an async context.
//
// Cert + key live under a dir (default ~/.specrails/mobile/) at mode 0600. They
// are loaded from disk on EVERY gateway (re)start (never held only in memory),
// so sleep/DHCP/self-update relaunch preserve device pinning.

export interface GatewayCert {
  certPem: string
  keyPem: string
  /** sha256 hex of the cert DER (lowercase, no separators). */
  fingerprint: string
}

export function mobileDir(): string {
  return path.join(resolveSpecrailsHome(), '.specrails', 'mobile')
}

function certPath(dir: string): string {
  return path.join(dir, 'tls-cert.pem')
}
function keyPath(dir: string): string {
  return path.join(dir, 'tls-key.pem')
}

/** sha256(DER) of a PEM cert, hex lowercase — the value put in the QR and pinned
 *  by the phone (Dart: `sha256.convert(x509.der)`). */
export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw
  return createHash('sha256').update(der).digest('hex')
}

async function generatePair(): Promise<{ certPem: string; keyPem: string }> {
  // The phone pins sha256(cert DER), never the CN, so renaming the CN only
  // affects freshly generated certs (which always require a fresh QR pairing).
  const attrs = [{ name: 'commonName', value: 'specrails-desktop-mobile' }]
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)
  const pems = await selfsignedGenerate(attrs, {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  })
  return { certPem: pems.cert, keyPem: pems.private }
}

function writePair(dir: string, certPem: string, keyPem: string): void {
  fs.mkdirSync(dir, { recursive: true })
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort on platforms without chmod */ }
  fs.writeFileSync(certPath(dir), certPem, { encoding: 'utf-8', mode: 0o600 })
  fs.writeFileSync(keyPath(dir), keyPem, { encoding: 'utf-8', mode: 0o600 })
}

/** Load the existing gateway cert, generating + persisting one on first use. */
export async function loadOrCreateCert(dir: string = mobileDir()): Promise<GatewayCert> {
  try {
    const certPem = fs.readFileSync(certPath(dir), 'utf-8')
    const keyPem = fs.readFileSync(keyPath(dir), 'utf-8')
    if (certPem.includes('BEGIN CERTIFICATE') && keyPem.includes('PRIVATE KEY')) {
      return { certPem, keyPem, fingerprint: fingerprintOf(certPem) }
    }
  } catch {
    // Fall through to generate.
  }
  const { certPem, keyPem } = await generatePair()
  writePair(dir, certPem, keyPem)
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem) }
}

/** Generate a brand-new cert (rotation). Caller is responsible for revoking all
 *  devices afterwards — a rotated cert no longer matches any stored fingerprint,
 *  which is the point: "Reset mobile identity" invalidates every paired device. */
export async function rotateCert(dir: string = mobileDir()): Promise<GatewayCert> {
  const { certPem, keyPem } = await generatePair()
  writePair(dir, certPem, keyPem)
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem) }
}
