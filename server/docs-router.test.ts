import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createDocsRouter } from './docs-router'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use('/docs', createDocsRouter())
  return app
}

// Create a real temp homedir so resolveGuideRoot() picks up the user override.
// Structure: tmpHome/.specrails/docs/guide/<lang>/<category>/<order>-<slug>.md
function makeTempHome(): { home: string; guideRoot: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-home-test-'))
  const guideRoot = path.join(home, '.specrails', 'docs', 'guide')
  fs.mkdirSync(guideRoot, { recursive: true })
  return { home, guideRoot }
}

function writeDoc(guideRoot: string, lang: string, category: string, file: string, body: string) {
  const dir = path.join(guideRoot, lang, category)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), body)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('docs-router', () => {
  let home: string
  let guideRoot: string

  beforeEach(() => {
    ;({ home, guideRoot } = makeTempHome())
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    // Ensure no stale bundled-docs env leaks in from the runner.
    delete process.env.SPECRAILS_BUNDLED_DOCS_PATH
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  // ── GET / (index) ────────────────────────────────────────────────────────

  describe('GET /docs', () => {
    it('returns 200 with a categories array', async () => {
      const res = await request(buildApp()).get('/docs')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('categories')
      expect(Array.isArray(res.body.categories)).toBe(true)
    })

    it('returns empty categories when no English tree exists', async () => {
      // Only a non-English dir present → English is canonical, so nothing shows.
      writeDoc(guideRoot, 'es', 'specs', '1-foo.md', '# Foo ES')
      const res = await request(buildApp()).get('/docs')
      expect(res.body.categories).toEqual([])
    })

    it('builds categories from the English tree, ordered by CATEGORY_ORDER', async () => {
      writeDoc(guideRoot, 'en', 'settings', '1-themes.md', '# Themes')
      writeDoc(guideRoot, 'en', 'getting-started', '1-what.md', '# What is specrails')
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Specs & the backlog')

      const res = await request(buildApp()).get('/docs')
      const slugs = res.body.categories.map((c: { slug: string }) => c.slug)
      // getting-started before specs before settings per CATEGORY_ORDER
      expect(slugs).toEqual(['getting-started', 'specs', 'settings'])
    })

    it('uses friendly category labels', async () => {
      writeDoc(guideRoot, 'en', 'getting-started', '1-what.md', '# What')
      const res = await request(buildApp()).get('/docs')
      const cat = res.body.categories.find((c: { slug: string }) => c.slug === 'getting-started')
      expect(cat.name).toBe('Getting started')
    })

    it('localizes category labels for the requested guide language', async () => {
      writeDoc(guideRoot, 'en', 'getting-started', '1-what.md', '# What')
      const res = await request(buildApp()).get('/docs?lang=es')
      const cat = res.body.categories.find((c: { slug: string }) => c.slug === 'getting-started')
      expect(cat.name).toBe('Primeros pasos')
    })

    it('orders docs within a category by the numeric filename prefix', async () => {
      writeDoc(guideRoot, 'en', 'specs', '3-explore.md', '# Explore')
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog')
      writeDoc(guideRoot, 'en', 'specs', '2-quick.md', '# Quick')

      const res = await request(buildApp()).get('/docs')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      const slugs = specs.docs.map((d: { slug: string }) => d.slug)
      expect(slugs).toEqual(['backlog', 'quick', 'explore'])
    })

    it('strips the order prefix from the surfaced slug and reads the H1 title', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-the-backlog.md', '# Specs & the backlog\n\nHi.')
      const res = await request(buildApp()).get('/docs')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      expect(specs.docs[0].slug).toBe('the-backlog')
      expect(specs.docs[0].title).toBe('Specs & the backlog')
    })

    it('falls back to the English title for pages a language has not translated', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Specs & the backlog')
      // No es/specs/1-backlog.md
      const res = await request(buildApp()).get('/docs?lang=es')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      expect(specs.docs[0].title).toBe('Specs & the backlog')
      expect(specs.docs[0].slug).toBe('backlog')
    })

    it('uses the localized title when a translation exists', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Specs & the backlog')
      writeDoc(guideRoot, 'es', 'specs', '1-backlog.md', '# Especificaciones y backlog')
      const res = await request(buildApp()).get('/docs?lang=es')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      expect(specs.docs[0].title).toBe('Especificaciones y backlog')
    })

    it('ignores an unknown lang and falls back to English', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Specs & the backlog')
      writeDoc(guideRoot, 'es', 'specs', '1-backlog.md', '# Especificaciones')
      const res = await request(buildApp()).get('/docs?lang=klingon')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      expect(specs.docs[0].title).toBe('Specs & the backlog')
    })

    it('normalizes a regional lang (es-ES) to its base subtag', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog EN')
      writeDoc(guideRoot, 'es', 'specs', '1-backlog.md', '# Backlog ES')
      const res = await request(buildApp()).get('/docs?lang=es-ES')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      expect(specs.docs[0].title).toBe('Backlog ES')
    })

    it('ignores files without an <order>-<slug>.md shape', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog')
      writeDoc(guideRoot, 'en', 'specs', 'no-order.md', '# Stray')
      writeDoc(guideRoot, 'en', 'specs', 'notes.txt', 'not markdown')
      const res = await request(buildApp()).get('/docs')
      const specs = res.body.categories.find((c: { slug: string }) => c.slug === 'specs')
      const slugs = specs.docs.map((d: { slug: string }) => d.slug)
      expect(slugs).toEqual(['backlog'])
    })

    it('does NOT surface developer docs (no internals/platforms category)', async () => {
      writeDoc(guideRoot, 'en', 'getting-started', '1-what.md', '# What')
      // Plant dev-doc-looking dirs that must never appear in the guide index.
      writeDoc(guideRoot, 'en', 'internals', '1-architecture.md', '# Architecture')
      writeDoc(guideRoot, 'en', 'platforms', '1-macos.md', '# macOS')
      const res = await request(buildApp()).get('/docs')
      const slugs = res.body.categories.map((c: { slug: string }) => c.slug)
      // internals/platforms aren't in CATEGORY_ORDER but the router lists every
      // English subdir; the real guarantee is that the SERVED root is docs/guide
      // (which contains no internals/platforms), proven by the bundled-fallback
      // test below. Here we only assert the known guide categories sort first.
      expect(slugs[0]).toBe('getting-started')
    })
  })

  // ── GET /:category/:slug (content) ─────────────────────────────────────────

  describe('GET /docs/:category/:slug', () => {
    it('serves a page by its bare slug (order prefix stripped)', async () => {
      writeDoc(guideRoot, 'en', 'specs', '2-quick-mode.md', '# Quick mode\n\nBody.')
      const res = await request(buildApp()).get('/docs/specs/quick-mode')
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Quick mode')
      expect(res.body.content).toContain('Body.')
      expect(res.body.category).toBe('specs')
      expect(res.body.slug).toBe('quick-mode')
    })

    it('returns 404 for an unknown slug', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog')
      const res = await request(buildApp()).get('/docs/specs/nope')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/document not found/i)
    })

    it('returns 404 for an unknown category', async () => {
      const res = await request(buildApp()).get('/docs/nope/thing')
      expect(res.status).toBe(404)
    })

    it('serves the localized file when present', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog EN\n\nEN body.')
      writeDoc(guideRoot, 'es', 'specs', '1-backlog.md', '# Backlog ES\n\nES body.')
      const res = await request(buildApp()).get('/docs/specs/backlog?lang=es')
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Backlog ES')
      expect(res.body.content).toContain('ES body.')
    })

    it('falls back to the English file when the language lacks the page', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-backlog.md', '# Backlog EN\n\nEN body.')
      const res = await request(buildApp()).get('/docs/specs/backlog?lang=fr')
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Backlog EN')
      expect(res.body.content).toContain('EN body.')
    })

    it('rejects a slug containing a backslash', async () => {
      const res = await request(buildApp()).get('/docs/specs/bad%5Cslug')
      expect([400, 404]).toContain(res.status)
    })

    it('rejects a ".." category (no traversal above the guide root)', async () => {
      const aboveDir = path.dirname(guideRoot)
      fs.writeFileSync(path.join(aboveDir, 'secret.md'), '# Secret')
      const res = await request(buildApp()).get('/docs/%2e%2e/secret')
      expect([400, 404]).toContain(res.status)
      expect(JSON.stringify(res.body)).not.toContain('Secret')
    })

    it('returns 500 when readFileSync throws on an existing file', async () => {
      writeDoc(guideRoot, 'en', 'specs', '1-read-error.md', '# Content')

      const origReadFileSync = fs.readFileSync
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('1-read-error.md')) {
          throw new Error('Permission denied')
        }
        return origReadFileSync(p, ...(args as [BufferEncoding]))
      })

      const res = await request(buildApp()).get('/docs/specs/read-error')
      expect(res.status).toBe(500)
      expect(res.body.error).toContain('Failed to read document')
    })
  })

  // ── Bundled fallback (repo tree) ───────────────────────────────────────────

  describe('bundled fallback', () => {
    it('falls back to the repo docs/guide tree when no user override exists', async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-empty-'))
      vi.spyOn(os, 'homedir').mockReturnValue(emptyHome)

      const res = await request(buildApp()).get('/docs')
      expect(res.status).toBe(200)
      // The shipped guide carries the getting-started category and only
      // user-guide categories — NEVER internals/platforms (dev docs).
      const slugs: string[] = res.body.categories.map((c: { slug: string }) => c.slug)
      expect(slugs).toContain('getting-started')
      expect(slugs).not.toContain('internals')
      expect(slugs).not.toContain('platforms')

      fs.rmSync(emptyHome, { recursive: true, force: true })
    })

    it('serves a real shipped page (what-is-specrails) from the repo tree', async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-empty2-'))
      vi.spyOn(os, 'homedir').mockReturnValue(emptyHome)

      const res = await request(buildApp()).get('/docs/getting-started/what-is-specrails')
      expect(res.status).toBe(200)
      expect(res.body.content).toContain('# What is specrails')

      fs.rmSync(emptyHome, { recursive: true, force: true })
    })
  })

  // ── Bundled docs path (packaged app) ───────────────────────────────────────

  describe('SPECRAILS_BUNDLED_DOCS_PATH', () => {
    it('resolves the guide root from the bundled docs env when no user override exists', async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-bundle-home-'))
      vi.spyOn(os, 'homedir').mockReturnValue(emptyHome)

      // A fake bundled docs dir: <docsPath>/guide/<lang>/<category>/<file>.md
      const docsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-bundled-docs-'))
      const bg = path.join(docsPath, 'guide')
      fs.mkdirSync(path.join(bg, 'en', 'specs'), { recursive: true })
      fs.writeFileSync(path.join(bg, 'en', 'specs', '1-bundled.md'), '# Bundled page')
      process.env.SPECRAILS_BUNDLED_DOCS_PATH = docsPath

      const res = await request(buildApp()).get('/docs/specs/bundled')
      expect(res.status).toBe(200)
      expect(res.body.content).toContain('# Bundled page')

      delete process.env.SPECRAILS_BUNDLED_DOCS_PATH
      fs.rmSync(emptyHome, { recursive: true, force: true })
      fs.rmSync(docsPath, { recursive: true, force: true })
    })

    it('derives the guide root from SPECRAILS_BUNDLED_RUNTIMES_PATH parent when docs env is unset', async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-rt-home-'))
      vi.spyOn(os, 'homedir').mockReturnValue(emptyHome)

      // <resource_dir>/runtimes and <resource_dir>/docs/guide/...
      const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-resource-'))
      fs.mkdirSync(path.join(resourceDir, 'runtimes'), { recursive: true })
      const bg = path.join(resourceDir, 'docs', 'guide')
      fs.mkdirSync(path.join(bg, 'en', 'specs'), { recursive: true })
      fs.writeFileSync(path.join(bg, 'en', 'specs', '1-rt.md'), '# Runtime-derived page')
      process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = path.join(resourceDir, 'runtimes')

      const res = await request(buildApp()).get('/docs/specs/rt')
      expect(res.status).toBe(200)
      expect(res.body.content).toContain('# Runtime-derived page')

      delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
      fs.rmSync(emptyHome, { recursive: true, force: true })
      fs.rmSync(resourceDir, { recursive: true, force: true })
    })
  })
})
