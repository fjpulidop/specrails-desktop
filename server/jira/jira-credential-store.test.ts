import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

import {
  KeyfileSecretStore,
  getOrCreateKey,
  defaultKeyfilePath,
  getSecretStore,
  setSecretStore,
  type SecretStore,
} from './jira-credential-store'
import { resolveSpecrailsHome } from '../util/specrails-home'

let tmpDir: string
let keyfilePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-cred-store-'))
  keyfilePath = path.join(tmpDir, '.specrails', 'jira-secret.key')
})

afterEach(() => {
  // Reset the process-wide singleton so tests never bleed into each other.
  setSecretStore(null)
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('defaultKeyfilePath', () => {
  it('joins homeDir/.specrails/jira-secret.key', () => {
    expect(defaultKeyfilePath('/home/alice')).toBe(
      path.join('/home/alice', '.specrails', 'jira-secret.key'),
    )
  })

  it('defaults to the Specrails home when no argument is given', () => {
    expect(defaultKeyfilePath()).toBe(
      path.join(resolveSpecrailsHome(), '.specrails', 'jira-secret.key'),
    )
  })
})

describe('getOrCreateKey', () => {
  it('creates a 32-byte key when the keyfile does not exist', () => {
    expect(fs.existsSync(keyfilePath)).toBe(false)
    const key = getOrCreateKey(keyfilePath)
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
    expect(fs.existsSync(keyfilePath)).toBe(true)
  })

  it('persists the key base64-encoded in the keyfile', () => {
    const key = getOrCreateKey(keyfilePath)
    const raw = fs.readFileSync(keyfilePath, 'utf-8').trim()
    expect(Buffer.from(raw, 'base64')).toEqual(key)
  })

  it('reuses the same key bytes on a second call', () => {
    const first = getOrCreateKey(keyfilePath)
    const second = getOrCreateKey(keyfilePath)
    expect(second).toEqual(first)
    expect(second.equals(first)).toBe(true)
  })

  it('creates the parent directory recursively', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c', 'jira-secret.key')
    expect(fs.existsSync(path.dirname(nested))).toBe(false)
    const key = getOrCreateKey(nested)
    expect(key.length).toBe(32)
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('writes the keyfile with 0600 permissions (POSIX)', () => {
    // chmod is best-effort/no-op on Windows; only assert on POSIX.
    if (process.platform === 'win32') return
    getOrCreateKey(keyfilePath)
    const mode = fs.statSync(keyfilePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('regenerates the key when the existing keyfile holds a wrong-length key', () => {
    // Seed a keyfile with a base64 value that decodes to fewer than 32 bytes.
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true })
    const shortKey = Buffer.from('too-short').toString('base64')
    fs.writeFileSync(keyfilePath, shortKey)

    const key = getOrCreateKey(keyfilePath)
    expect(key.length).toBe(32)

    // The keyfile was rewritten with the freshly generated 32-byte key.
    const raw = fs.readFileSync(keyfilePath, 'utf-8').trim()
    expect(Buffer.from(raw, 'base64').length).toBe(32)
    expect(Buffer.from(raw, 'base64')).toEqual(key)
  })

  it('regenerates the key when the existing keyfile is corrupt/unreadable as a key', () => {
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true })
    // Garbage base64 → decodes to a non-32-byte buffer → falls through to create.
    fs.writeFileSync(keyfilePath, '!!!not-base64-but-still-decodes-weird!!!')
    const key = getOrCreateKey(keyfilePath)
    expect(key.length).toBe(32)
  })

  it('returns the existing key unchanged when it is already valid 32 bytes', () => {
    const original = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true })
    fs.writeFileSync(keyfilePath, original.toString('base64'))
    const key = getOrCreateKey(keyfilePath)
    expect(key).toEqual(original)
  })

  it('tolerates surrounding whitespace/newlines in the keyfile', () => {
    const original = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true })
    fs.writeFileSync(keyfilePath, `\n  ${original.toString('base64')}  \n`)
    const key = getOrCreateKey(keyfilePath)
    expect(key).toEqual(original)
  })
})

describe('KeyfileSecretStore', () => {
  it('round-trips encrypt → decrypt', () => {
    const store = new KeyfileSecretStore(keyfilePath)
    const plaintext = 'jira-api-token-ATATT3xFfGF0-secret'
    const blob = store.encrypt(plaintext)
    expect(blob).not.toBe(plaintext)
    expect(store.decrypt(blob)).toBe(plaintext)
  })

  it('round-trips empty string and unicode', () => {
    const store = new KeyfileSecretStore(keyfilePath)
    expect(store.decrypt(store.encrypt(''))).toBe('')
    const unicode = 'héllo 🌍 トークン'
    expect(store.decrypt(store.encrypt(unicode))).toBe(unicode)
  })

  it('produces the v1:iv:tag:ct shape', () => {
    const store = new KeyfileSecretStore(keyfilePath)
    const blob = store.encrypt('payload')
    const parts = blob.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    // iv is 12 bytes → base64-decodes to 12 bytes; tag is 16 bytes (GCM).
    expect(Buffer.from(parts[1], 'base64').length).toBe(12)
    expect(Buffer.from(parts[2], 'base64').length).toBe(16)
    // ciphertext for non-empty input has > 0 bytes.
    expect(Buffer.from(parts[3], 'base64').length).toBeGreaterThan(0)
  })

  it('uses a fresh random IV per encryption (non-deterministic ciphertext)', () => {
    const store = new KeyfileSecretStore(keyfilePath)
    const a = store.encrypt('same-input')
    const b = store.encrypt('same-input')
    expect(a).not.toBe(b)
    // Both still decrypt back to the original.
    expect(store.decrypt(a)).toBe('same-input')
    expect(store.decrypt(b)).toBe('same-input')
  })

  it('two stores sharing the same keyfile can decrypt each other', () => {
    const a = new KeyfileSecretStore(keyfilePath)
    const blob = a.encrypt('shared')
    const b = new KeyfileSecretStore(keyfilePath)
    expect(b.decrypt(blob)).toBe('shared')
  })

  it('a store with a different key cannot decrypt (auth tag mismatch throws)', () => {
    const a = new KeyfileSecretStore(keyfilePath)
    const blob = a.encrypt('cross-key')
    const otherKeyfile = path.join(tmpDir, 'other', 'jira-secret.key')
    const b = new KeyfileSecretStore(otherKeyfile)
    expect(() => b.decrypt(blob)).toThrow()
  })

  describe('decrypt rejects malformed input', () => {
    let store: KeyfileSecretStore
    beforeEach(() => {
      store = new KeyfileSecretStore(keyfilePath)
    })

    it('throws on too few parts', () => {
      expect(() => store.decrypt('v1:onlytwo:parts')).toThrow(
        /malformed ciphertext/,
      )
    })

    it('throws on too many parts', () => {
      expect(() => store.decrypt('v1:a:b:c:d')).toThrow(/malformed ciphertext/)
    })

    it('throws on a wrong version prefix', () => {
      // Build a real v1 blob, then swap the version token to v2.
      const real = store.encrypt('x')
      const parts = real.split(':')
      parts[0] = 'v2'
      expect(() => store.decrypt(parts.join(':'))).toThrow(
        /malformed ciphertext/,
      )
    })

    it('throws on an empty string', () => {
      expect(() => store.decrypt('')).toThrow(/malformed ciphertext/)
    })

    it('throws on a tampered ciphertext (correct shape, wrong bytes)', () => {
      const real = store.encrypt('tamper-me')
      const parts = real.split(':')
      // Flip the ciphertext to a different valid-base64 value of same shape.
      const ctBytes = Buffer.from(parts[3], 'base64')
      ctBytes[0] = ctBytes[0] ^ 0xff
      parts[3] = ctBytes.toString('base64')
      expect(() => store.decrypt(parts.join(':'))).toThrow()
    })

    it('throws on a tampered auth tag', () => {
      const real = store.encrypt('tamper-tag')
      const parts = real.split(':')
      const tagBytes = Buffer.from(parts[2], 'base64')
      tagBytes[0] = tagBytes[0] ^ 0xff
      parts[2] = tagBytes.toString('base64')
      expect(() => store.decrypt(parts.join(':'))).toThrow()
    })
  })
})

describe('getSecretStore / setSecretStore singleton', () => {
  it('returns a KeyfileSecretStore by default and memoizes it', () => {
    setSecretStore(null)
    const first = getSecretStore()
    const second = getSecretStore()
    expect(first).toBeInstanceOf(KeyfileSecretStore)
    expect(second).toBe(first)
  })

  it('setSecretStore overrides the singleton', () => {
    const fake: SecretStore = {
      encrypt: (s) => 'enc:' + s,
      decrypt: (s) => s.slice(4),
    }
    setSecretStore(fake)
    const got = getSecretStore()
    expect(got).toBe(fake)
    expect(got.encrypt('abc')).toBe('enc:abc')
    expect(got.decrypt('enc:abc')).toBe('abc')
  })

  it('setSecretStore(null) resets and re-creates a fresh default on next get', () => {
    const fake: SecretStore = {
      encrypt: (s) => 'enc:' + s,
      decrypt: (s) => s.slice(4),
    }
    setSecretStore(fake)
    expect(getSecretStore()).toBe(fake)

    setSecretStore(null)
    const fresh = getSecretStore()
    expect(fresh).not.toBe(fake)
    expect(fresh).toBeInstanceOf(KeyfileSecretStore)
  })

  it('the injected fake round-trips through the SecretStore interface', () => {
    setSecretStore({ encrypt: (s) => 'enc:' + s, decrypt: (s) => s.slice(4) })
    const store = getSecretStore()
    expect(store.decrypt(store.encrypt('round-trip'))).toBe('round-trip')
  })
})
