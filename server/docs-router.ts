import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'

// ─── User-guide docs ────────────────────────────────────────────────────────
//
// The Documentation panel serves a dedicated, language-aware USER-GUIDE tree —
// NOT the developer docs (docs/internals, docs/platforms, top-level dev .md).
// Layout on disk:
//
//   docs/guide/<lang>/<category>/<order>-<slug>.md
//
// where <lang> is an i18n language id (`en`, `es`, …). English (`en`) is the
// source-of-truth locale and is always present; any missing language OR missing
// page falls back to the English file, so an untranslated language still shows
// real content instead of an empty panel.
//
// Resolution precedence for the guide ROOT (the dir that holds <lang>/):
//   1. ~/.specrails/docs/guide/   (user-editable override — wins when present)
//   2. bundled Tauri resource     (<resource_dir>/docs/guide in the packaged app)
//   3. repo / compiled dist       (docs/guide relative to __dirname)
// All candidates are existence-gated; a missing tree never crashes — the panel
// just shows no categories.

// ─── Default language + validation ──────────────────────────────────────────

const DEFAULT_LANG = 'en'

// Mirror of client/src/lib/i18n.ts LANGUAGE_IDS. Kept here (not imported — the
// server is CommonJS and must not depend on the ESM client) so an unknown / bogus
// `?lang=` value can never be turned into a filesystem path.
const SUPPORTED_LANGS = new Set(['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])

function normalizeLang(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_LANG
  const base = raw.toLowerCase().split('-')[0].trim()
  return SUPPORTED_LANGS.has(base) ? base : DEFAULT_LANG
}

// ─── Guide-root resolution ──────────────────────────────────────────────────

/**
 * The bundled (packaged-app) guide root, or null when not running inside a
 * Tauri bundle / the dir is absent. The Tauri host exports
 * `SPECRAILS_BUNDLED_DOCS_PATH=<resource_dir>/docs` (existence-gated, mirroring
 * the runtimes/core envs); as a defence-in-depth fallback we also derive
 * `<resource_dir>/docs` from `SPECRAILS_BUNDLED_RUNTIMES_PATH` (whose parent IS
 * the resource dir) so a build that forgot the docs env still resolves.
 */
function resolveBundledGuideRoot(): string | null {
  const direct = process.env.SPECRAILS_BUNDLED_DOCS_PATH
  if (direct && direct.length > 0) {
    const guide = path.join(direct, 'guide')
    if (fs.existsSync(guide)) return guide
  }
  const runtimes = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (runtimes && runtimes.length > 0) {
    // <resource_dir>/runtimes → <resource_dir>/docs/guide
    const guide = path.join(path.dirname(runtimes), 'docs', 'guide')
    if (fs.existsSync(guide)) return guide
  }
  return null
}

/**
 * Resolve the guide ROOT directory (the one containing <lang>/ subdirs).
 * Returns null when no guide tree can be found anywhere (the panel then shows
 * an empty index rather than crashing).
 */
function resolveGuideRoot(): string | null {
  // 1. User override: ~/.specrails/docs/guide
  const userGuide = path.join(os.homedir(), '.specrails', 'docs', 'guide')
  if (fs.existsSync(userGuide)) return userGuide

  // 2. Bundled app resource
  const bundled = resolveBundledGuideRoot()
  if (bundled) return bundled

  // 3. Repo / compiled dist (relative to this file)
  const candidates = [
    path.resolve(__dirname, '../docs/guide'), // dev: server/ -> ../docs/guide
    path.resolve(__dirname, '../../docs/guide'), // compiled: server/dist/ -> ../../docs/guide
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return null
}

/** The localized directory for a given language under the guide root. */
function langDir(guideRoot: string, lang: string): string {
  return path.join(guideRoot, lang)
}

// ─── Category configuration ─────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  en: {
    'getting-started': 'Getting started',
    specs: 'Specs',
    pipeline: 'Pipeline',
    agents: 'Agents',
    insights: 'Insights',
    integrations: 'Integrations',
    settings: 'Settings',
  },
  es: {
    'getting-started': 'Primeros pasos',
    specs: 'Specs',
    pipeline: 'Pipeline',
    agents: 'Agentes',
    insights: 'Insights',
    integrations: 'Integraciones',
    settings: 'Ajustes',
  },
  fr: {
    'getting-started': 'Bien démarrer',
    specs: 'Specs',
    pipeline: 'Pipeline',
    agents: 'Agents',
    insights: 'Insights',
    integrations: 'Intégrations',
    settings: 'Réglages',
  },
  de: {
    'getting-started': 'Erste Schritte',
    specs: 'Specs',
    pipeline: 'Pipeline',
    agents: 'Agenten',
    insights: 'Insights',
    integrations: 'Integrationen',
    settings: 'Einstellungen',
  },
  pt: {
    'getting-started': 'Primeiros passos',
    specs: 'Specs',
    pipeline: 'Pipeline',
    agents: 'Agentes',
    insights: 'Insights',
    integrations: 'Integrações',
    settings: 'Definições',
  },
  it: {
    'getting-started': 'Primi passi',
    specs: 'Spec',
    pipeline: 'Pipeline',
    agents: 'Agenti',
    insights: 'Insights',
    integrations: 'Integrazioni',
    settings: 'Impostazioni',
  },
  zh: {
    'getting-started': '入门',
    specs: '规格',
    pipeline: '流水线',
    agents: '代理',
    insights: '洞察',
    integrations: '集成',
    settings: '设置',
  },
  ja: {
    'getting-started': 'はじめに',
    specs: 'スペック',
    pipeline: 'パイプライン',
    agents: 'エージェント',
    insights: 'インサイト',
    integrations: '連携',
    settings: '設定',
  },
}

/**
 * Preferred display order. Categories not in this list come after, alphabetically.
 */
const CATEGORY_ORDER = [
  'getting-started',
  'specs',
  'pipeline',
  'agents',
  'insights',
  'integrations',
  'settings',
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function categoryLabel(slug: string, lang: string): string {
  return CATEGORY_LABELS[lang]?.[slug] ?? CATEGORY_LABELS[DEFAULT_LANG]?.[slug] ?? slugToTitle(slug)
}

/**
 * Headings may carry an explicit, locale-independent anchor: `## Title {#anchor}`.
 * The anchor is a link target for in-app "Learn more" hints, never part of the
 * visible title.
 */
const HEADING_ANCHOR = /\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i

function stripHeadingAnchor(text: string): string {
  return text.replace(HEADING_ANCHOR, '').trim()
}

function extractTitle(content: string, slug: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? stripHeadingAnchor(match[1]) || slugToTitle(slug) : slugToTitle(slug)
}

interface GuideHeading {
  level: number
  text: string
  anchor: string | null
}

/** Headings outside code fences, with their optional explicit anchors. */
function extractHeadings(content: string): GuideHeading[] {
  const out: GuideHeading[] = []
  let fenced = false
  for (const line of content.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    if (fenced) continue
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const anchor = HEADING_ANCHOR.exec(m[2])?.[1]?.toLowerCase() ?? null
    const text = stripHeadingAnchor(m[2])
    if (text) out.push({ level: m[1].length, text, anchor })
  }
  return out
}

/** Parse an `<order>-<slug>.md` filename into { order, slug }. */
function parseGuideFile(file: string): { order: number; slug: string } | null {
  const m = file.match(/^(\d+)-(.+)\.md$/)
  if (!m) return null
  return { order: parseInt(m[1], 10), slug: m[2] }
}

function categoryRank(slug: string): number {
  const i = CATEGORY_ORDER.indexOf(slug)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

interface DocEntry {
  title: string
  slug: string
}
interface DocSearchResult {
  category: string
  categoryName: string
  slug: string
  title: string
  /** The matching heading, or null when the page title itself matched. */
  heading: string | null
  /** The heading's explicit anchor (`{#id}`) when it has one. */
  anchor: string | null
  rank: number
}
const MAX_SEARCH_RESULTS = 8
interface DocCategory {
  name: string
  slug: string
  docs: DocEntry[]
}

/** List the category subdirectories of a localized lang dir (existence-safe). */
function listCategories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Build the full category/doc index for a language, falling back to English
 * per-category and per-page. The English tree defines the canonical set of
 * categories and slugs; a translated language contributes localized titles for
 * the pages it has, and English fills the gaps.
 */
function buildCategories(guideRoot: string, lang: string): DocCategory[] {
  const enDir = langDir(guideRoot, DEFAULT_LANG)
  if (!fs.existsSync(enDir)) return []

  const localizedDir = langDir(guideRoot, lang)

  const categories: DocCategory[] = []
  for (const cat of listCategories(enDir)) {
    const enCatDir = path.join(enDir, cat)
    const localizedCatDir = path.join(localizedDir, cat)

    let files: string[]
    try {
      files = fs.readdirSync(enCatDir).filter((f) => f.endsWith('.md'))
    } catch {
      files = []
    }

    const parsed = files
      .map((f) => ({ file: f, meta: parseGuideFile(f) }))
      .filter((x): x is { file: string; meta: { order: number; slug: string } } => x.meta !== null)
      .sort((a, b) => a.meta.order - b.meta.order || a.meta.slug.localeCompare(b.meta.slug))

    const docs: DocEntry[] = parsed.map(({ file, meta }) => {
      // Prefer the localized file's title; fall back to the English file.
      const localizedPath = path.join(localizedCatDir, file)
      const enPath = path.join(enCatDir, file)
      const readPath = fs.existsSync(localizedPath) ? localizedPath : enPath
      let title = slugToTitle(meta.slug)
      try {
        title = extractTitle(fs.readFileSync(readPath, 'utf-8'), meta.slug)
      } catch {
        /* fall back to slug-derived title */
      }
      return { title, slug: meta.slug }
    })

    if (docs.length > 0) {
      categories.push({ name: categoryLabel(cat, lang), slug: cat, docs })
    }
  }

  return categories.sort(
    (a, b) => categoryRank(a.slug) - categoryRank(b.slug) || a.slug.localeCompare(b.slug)
  )
}

// ─── Path-safety guards ─────────────────────────────────────────────────────

function isSafeSegment(seg: string): boolean {
  return (
    typeof seg === 'string' &&
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    seg === path.basename(seg) &&
    !seg.includes('/') &&
    !seg.includes('\\')
  )
}

/**
 * Resolve the on-disk file for a (lang, category, slug). Tries the localized
 * file first, then English. Returns null when neither exists or a path-safety
 * check fails. The slug in the URL is the *bare* slug (no order prefix); we map
 * it to the `<order>-<slug>.md` file by scanning the English category dir
 * (English is canonical for the set of slugs).
 */
function resolveDocFile(
  guideRoot: string,
  lang: string,
  category: string,
  slug: string
): { filePath: string } | null {
  if (!isSafeSegment(category) || !isSafeSegment(slug)) return null

  const enCatDir = path.join(langDir(guideRoot, DEFAULT_LANG), category)
  let files: string[]
  try {
    files = fs.readdirSync(enCatDir).filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }

  const match = files.find((f) => {
    const meta = parseGuideFile(f)
    return meta?.slug === slug
  })
  if (!match) return null

  const localizedPath = path.join(langDir(guideRoot, lang), category, match)
  const enPath = path.join(enCatDir, match)
  const filePath = fs.existsSync(localizedPath) ? localizedPath : enPath

  // Defence-in-depth: the resolved file must live inside the guide root.
  const rel = path.relative(path.resolve(guideRoot), path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  if (!fs.existsSync(filePath)) return null
  return { filePath }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createDocsRouter(): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const lang = normalizeLang(req.query.lang)
    const guideRoot = resolveGuideRoot()
    const categories = guideRoot ? buildCategories(guideRoot, lang) : []
    res.json({ categories })
  })

  // Search the guide's page titles and headings in one language (the in-app
  // `?` cheatsheet lists the matches next to the shortcuts). A page that is
  // not translated falls back to English, like the index.
  router.get('/search', (req, res) => {
    const lang = normalizeLang(req.query.lang)
    const query = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase(lang) : ''
    const guideRoot = resolveGuideRoot()
    if (!query || query.length > 80 || !guideRoot) {
      res.json({ results: [] })
      return
    }
    const results: DocSearchResult[] = []
    for (const cat of buildCategories(guideRoot, lang)) {
      for (const doc of cat.docs) {
        const resolved = resolveDocFile(guideRoot, lang, cat.slug, doc.slug)
        if (!resolved) continue
        let content = ''
        try {
          content = fs.readFileSync(resolved.filePath, 'utf-8')
        } catch {
          continue
        }
        const titleHit = doc.title.toLocaleLowerCase(lang).includes(query)
        const headings = extractHeadings(content).filter((h) => h.level > 1 && h.text.toLocaleLowerCase(lang).includes(query))
        if (titleHit) {
          results.push({ category: cat.slug, categoryName: cat.name, slug: doc.slug, title: doc.title, heading: null, anchor: null, rank: 0 })
        }
        for (const h of headings.slice(0, 3)) {
          results.push({ category: cat.slug, categoryName: cat.name, slug: doc.slug, title: doc.title, heading: h.text, anchor: h.anchor, rank: 1 })
        }
      }
    }
    results.sort((a, b) => a.rank - b.rank)
    res.json({ results: results.slice(0, MAX_SEARCH_RESULTS).map(({ rank: _rank, ...rest }) => rest) })
  })

  router.get('/:category/:slug', (req, res) => {
    const { category, slug } = req.params
    const lang = normalizeLang(req.query.lang)

    if (!isSafeSegment(category)) {
      res.status(404).json({ error: 'Category not found' })
      return
    }
    if (!isSafeSegment(slug)) {
      res.status(400).json({ error: 'Invalid slug' })
      return
    }

    const guideRoot = resolveGuideRoot()
    if (!guideRoot) {
      res.status(404).json({ error: 'Document not found' })
      return
    }

    const resolved = resolveDocFile(guideRoot, lang, category, slug)
    if (!resolved) {
      res.status(404).json({ error: 'Document not found' })
      return
    }

    let content: string
    try {
      content = fs.readFileSync(resolved.filePath, 'utf-8')
    } catch {
      res.status(500).json({ error: 'Failed to read document' })
      return
    }

    const title = extractTitle(content, slug)
    res.json({ title, content, category, slug })
  })

  return router
}
