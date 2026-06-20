// Encrypted-at-rest credential store for Jira tokens.
//
// A Jira API token / PAT is a bearer credential with the user's full Jira
// permissions, so it must not sit in plaintext SQLite (the webhook-HMAC bar).
// v1: AES-256-GCM (node:crypto, no native plugin) under a per-install 0600
// keyfile. v2 can swap the backend to a Tauri keychain/stronghold by replacing
// `SecretStore` — every callsite goes through this single interface.
//
// The ciphertext lives in the per-project `jira_connection.encrypted_token`
// column; the symmetric key lives once at `~/.specrails/jira-secret.key`.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

export interface SecretStore {
  encrypt(plaintext: string): string
  decrypt(blob: string): string
}

const ALGO = 'aes-256-gcm'
const VERSION = 'v1'

/** Resolve the keyfile path (override-able for tests). */
export function defaultKeyfilePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.specrails', 'jira-secret.key')
}

/**
 * Load the 32-byte symmetric key, creating it (0600) on first use. The key is
 * stored base64 in a single keyfile so the v2 keychain swap is one place.
 */
export function getOrCreateKey(keyfilePath: string = defaultKeyfilePath()): Buffer {
  try {
    const raw = fs.readFileSync(keyfilePath, 'utf-8').trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length === 32) return key
    // File exists but the decoded key is the wrong length (truncated/corrupt) —
    // fall through to regenerate. A WRONG-LENGTH existing key is unrecoverable
    // anyway, so rotating is the only option.
  } catch (err) {
    // ONLY (re)create when the file genuinely doesn't exist. A transient FS
    // error (EACCES/EBUSY/EMFILE/momentary unreadability) must NOT rotate the
    // key — doing so makes every previously-stored Jira token across all
    // projects permanently undecryptable. Rethrow so the caller sees the real
    // error instead of silently destroying credentials.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const key = crypto.randomBytes(32)
  const dir = path.dirname(keyfilePath)
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* best-effort (no-op on Windows) */
  }
  // Write 0600 atomically: write to a temp file then rename.
  const tmp = `${keyfilePath}.tmp`
  fs.writeFileSync(tmp, key.toString('base64'), { mode: 0o600 })
  fs.renameSync(tmp, keyfilePath)
  try {
    fs.chmodSync(keyfilePath, 0o600)
  } catch {
    /* best-effort */
  }
  return key
}

/** AES-256-GCM secret store backed by the keyfile. */
export class KeyfileSecretStore implements SecretStore {
  private _key: Buffer

  constructor(keyfilePath: string = defaultKeyfilePath()) {
    this._key = getOrCreateKey(keyfilePath)
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALGO, this._key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
  }

  decrypt(blob: string): string {
    const parts = blob.split(':')
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('jira-credential-store: malformed ciphertext')
    }
    const iv = Buffer.from(parts[1], 'base64')
    const tag = Buffer.from(parts[2], 'base64')
    const ct = Buffer.from(parts[3], 'base64')
    const decipher = crypto.createDecipheriv(ALGO, this._key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  }
}

/** Process-wide singleton (the keyfile is shared across all projects). */
let _store: SecretStore | null = null
export function getSecretStore(): SecretStore {
  if (!_store) _store = new KeyfileSecretStore()
  return _store
}

/** Test seam: inject a store (e.g. an in-memory one). */
export function setSecretStore(store: SecretStore | null): void {
  _store = store
}
