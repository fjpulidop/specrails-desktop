// Throwaway repository generators for the live benchmark. Every repository gets
// a local bare remote under the work directory (never a hosted remote), so a
// delivery can push its branch without publishing anything.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertLocalRemote } from './isolation.mjs'

const NT = "import test from 'node:test'\nimport assert from 'node:assert'\n"
const pkg = (name, scripts = {}, extra = {}) => JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test', ...scripts }, ...extra }, null, 2) + '\n'

/** Template name → files. Pure data; `files` from a scenario override or add paths. */
export const TEMPLATES = {
  'node-lib': name => ({
    'package.json': pkg(name),
    'src/cart.js': "export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n}\n",
    'test/cart.test.js': NT + "import { total } from '../src/cart.js'\ntest('total', () => assert.equal(total([{ price: 2, qty: 3 }]), 6))\n",
    'README.md': `# ${name}\nSmall cart library. Tests: \`npm test\`.\n`,
    '.gitignore': 'node_modules\n',
  }),
  'react-vite': name => ({
    'package.json': pkg(name, { dev: 'vite', build: 'vite build', test: 'vitest run' }, {
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { vite: '5.4.11', '@vitejs/plugin-react': '4.3.4', vitest: '2.1.8', jsdom: '25.0.1', '@testing-library/react': '16.1.0', '@testing-library/dom': '10.4.0' } }),
    'vite.config.js': "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], test: { environment: 'jsdom' } })\n",
    'index.html': '<!doctype html><html><head><title>Books</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
    'src/main.jsx': "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    'src/App.jsx': "export const BOOKS = ['Dune', 'Emma', 'Ulysses', 'Beloved']\nexport default function App() {\n  return <main><h1>Books</h1><ul>{BOOKS.map(b => <li key={b}>{b}</li>)}</ul></main>\n}\n",
    'src/App.test.jsx': "import { render, screen } from '@testing-library/react'\nimport { test, expect } from 'vitest'\nimport App from './App.jsx'\ntest('lists books', () => { render(<App />); expect(screen.getByText('Dune')).toBeTruthy() })\n",
    'README.md': `# ${name}\nReact + Vite. \`npm install && npm test\`, \`npm run dev\`.\n`,
    '.gitignore': 'node_modules\ndist\n',
  }),
  'fastapi': name => ({
    'requirements.txt': 'fastapi==0.115.6\nhttpx==0.28.1\npytest==8.3.4\n',
    'app/__init__.py': '',
    'app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\nNOTES: list[dict] = []\n\n\n@app.get("/notes")\ndef list_notes():\n    return NOTES\n',
    'tests/test_notes.py': 'from fastapi.testclient import TestClient\nfrom app.main import app\n\n\ndef test_list_empty():\n    assert TestClient(app).get("/notes").json() == []\n',
    'README.md': `# ${name}\nFastAPI service. \`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pytest\`.\n`,
    '.gitignore': '.venv/\n__pycache__/\n',
  }),
  'rust-cli': name => ({
    'Cargo.toml': `[package]\nname = "${name.replace(/-/g, '_')}"\nversion = "0.1.0"\nedition = "2021"\n`,
    'src/lib.rs': 'pub fn word_count(s: &str) -> usize {\n    s.split_whitespace().count()\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn counts() { assert_eq!(word_count("a b"), 2); }\n}\n',
    'src/main.rs': `fn main() {\n    let text = std::env::args().skip(1).collect::<Vec<_>>().join(" ");\n    println!("{}", ${name.replace(/-/g, '_')}::word_count(&text));\n}\n`,
    'README.md': `# ${name}\nRust CLI. \`cargo test\`.\n`,
    '.gitignore': 'target/\n',
  }),
  'go-api': name => ({
    'go.mod': `module example.com/${name}\n\ngo 1.22\n`,
    'tasks.go': 'package main\n\ntype Task struct {\n\tID    int    `json:"id"`\n\tTitle string `json:"title"`\n}\n\nfunc FilterDone(ts []Task, done map[int]bool) []Task {\n\tout := []Task{}\n\tfor _, t := range ts {\n\t\tif done[t.ID] {\n\t\t\tout = append(out, t)\n\t\t}\n\t}\n\treturn out\n}\n',
    'main.go': 'package main\n\nimport (\n\t"encoding/json"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\thttp.HandleFunc("/tasks", func(w http.ResponseWriter, r *http.Request) {\n\t\tjson.NewEncoder(w).Encode([]Task{{1, "a"}})\n\t})\n\tport := os.Getenv("PORT")\n\tif port == "" {\n\t\tport = "8080"\n\t}\n\thttp.ListenAndServe(":"+port, nil)\n}\n',
    'tasks_test.go': 'package main\n\nimport "testing"\n\nfunc TestFilterDone(t *testing.T) {\n\tgot := FilterDone([]Task{{1, "a"}, {2, "b"}}, map[int]bool{2: true})\n\tif len(got) != 1 || got[0].ID != 2 {\n\t\tt.Fatal(got)\n\t}\n}\n',
    'README.md': `# ${name}\nGo HTTP API. \`go test ./...\`.\n`,
  }),
  'canvas-game': name => ({
    'package.json': pkg(name, { start: 'npx --yes http-server -p ${PORT:-8080} .' }),
    'index.html': '<!doctype html><html><head><title>Dodge</title></head><body><canvas id="c" width="480" height="320"></canvas><script type="module" src="src/main.js"></script></body></html>\n',
    'src/game.js': 'export function createGame() {\n  return { x: 240, y: 300, lives: 3, tick: 0 }\n}\nexport function step(g, input) {\n  g.tick++\n  if (input.left) g.x = Math.max(0, g.x - 5)\n  if (input.right) g.x = Math.min(480, g.x + 5)\n  return g\n}\n',
    'src/main.js': "import { createGame, step } from './game.js'\nconst g = createGame()\nwindow.__game = g\nconst ctx = document.getElementById('c').getContext('2d')\nconst keys = {}\naddEventListener('keydown', e => keys[e.key] = true)\naddEventListener('keyup', e => keys[e.key] = false)\nfunction frame() {\n  step(g, { left: keys.ArrowLeft, right: keys.ArrowRight })\n  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 480, 320)\n  ctx.fillStyle = '#0f0'; ctx.fillRect(g.x - 10, g.y, 20, 10)\n  requestAnimationFrame(frame)\n}\nframe()\n",
    'test/game.test.js': NT + "import { createGame, step } from '../src/game.js'\ntest('moves left', () => assert.equal(step(createGame(), { left: true }).x, 235))\n",
    'README.md': `# ${name}\nCanvas game, open index.html through a static server.\n`,
    '.gitignore': 'node_modules\n',
  }),
  'godot-game': () => ({
    'project.godot': '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Coins"\nconfig/features=PackedStringArray("4.3")\n',
    'scripts/score.gd': 'class_name Score\nextends RefCounted\n\nvar points := 0\n\nfunc add_coin() -> void:\n\tpoints += 1\n',
    'tests/run_tests.gd': 'extends SceneTree\n\nfunc _init() -> void:\n\tvar s = load("res://scripts/score.gd").new()\n\ts.add_coin()\n\tassert(s.points == 1)\n\tprint("tests ok")\n\tquit(0)\n',
    'README.md': '# Coins (Godot 4)\nTests: `godot --headless --path . --script res://tests/run_tests.gd`.\n',
    '.gitignore': '.godot/\n',
  }),
  'mr-api': name => ({
    'package.json': pkg(name),
    'src/users.js': 'export function userDto(u) { return { id: u.id, name: u.name } }\n',
    'test/users.test.js': NT + "import { userDto } from '../src/users.js'\ntest('dto', () => assert.deepEqual(userDto({ id: 1, name: 'Ada', pw: 'x' }), { id: 1, name: 'Ada' }))\n",
    'README.md': `# ${name}\nUser API. Its DTO is consumed by the web repository.\n`, '.gitignore': 'node_modules\n',
  }),
  'mr-web': name => ({
    'package.json': pkg(name),
    'src/render.js': 'export function renderUser(dto) { return `<li data-id="${dto.id}">${dto.name}</li>` }\n',
    'test/render.test.js': NT + "import { renderUser } from '../src/render.js'\ntest('li', () => assert.equal(renderUser({ id: 1, name: 'Ada' }), '<li data-id=\"1\">Ada</li>'))\n",
    'README.md': `# ${name}\nRenders the users served by the API repository.\n`, '.gitignore': 'node_modules\n',
  }),
  'docs-site': name => ({
    'README.md': `# ${name}\nOperations handbook (Markdown only).\n`,
    'docs/index.md': '# Handbook\n\n- [Deploys](deploys.md)\n',
    'docs/deploys.md': '# Deploys\n\nDeploys run from `main` every weekday at 10:00.\n',
  }),
  'gha-lint': name => ({
    'package.json': pkg(name, { test: 'node --test && actionlint' }),
    '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n',
    'src/version.js': "export const VERSION = '1.0.0'\n",
    'test/version.test.js': NT + "import { VERSION } from '../src/version.js'\ntest('semver', () => assert.match(VERSION, /^\\d+\\.\\d+\\.\\d+$/))\n",
    'README.md': `# ${name}\n\`npm test\` runs the unit tests and lints the GitHub Actions workflows with \`actionlint\` (install it machine-wide, e.g. \`brew install actionlint\`).\n`,
    '.gitignore': 'node_modules\n',
  }),
  'cfg-lint': name => ({
    'package.json': pkg(name, { test: 'node --test && cfgvet check' }),
    'config/app.toml': 'name = "app"\nport = 8080\n',
    'src/config.js': "export const DEFAULT_PORT = 8080\n",
    'test/config.test.js': NT + "import { DEFAULT_PORT } from '../src/config.js'\ntest('port', () => assert.equal(DEFAULT_PORT, 8080))\n",
    'README.md': `# ${name}\n\`npm test\` runs the unit tests and checks the config files with \`cfgvet\`, a Homebrew-only tool (no npm or pip package): install it machine-wide with \`brew install cfgvet\`.\n`,
    '.gitignore': 'node_modules\n',
  }),
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Files for a repo spec `{ template, name, files }` (pure). */
export function repoFiles(spec) {
  const make = TEMPLATES[spec.template]
  if (!make) throw new Error(`Unknown repository template "${spec.template}" (known: ${Object.keys(TEMPLATES).join(', ')})`)
  return { ...make(spec.name), ...(spec.files ?? {}) }
}

/**
 * Create `<workDir>/repos/<name>` with one commit and a bare remote at
 * `<workDir>/remotes/<name>.git`. Idempotent: an existing repository is reused.
 */
export function createRepo(spec, workDir) {
  const repo = path.join(workDir, 'repos', spec.name)
  const remote = assertLocalRemote(path.join(workDir, 'remotes', `${spec.name}.git`), workDir)
  if (fs.existsSync(path.join(repo, '.git'))) return repo
  fs.mkdirSync(repo, { recursive: true })
  for (const [rel, content] of Object.entries(repoFiles(spec))) {
    const file = path.join(repo, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    if (rel.endsWith('.sh')) fs.chmodSync(file, 0o755)
  }
  const branch = spec.branch ?? 'main'
  git(['init', '-q', '-b', branch], repo)
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'init'], repo)
  fs.mkdirSync(path.dirname(remote), { recursive: true })
  git(['init', '-q', '--bare', remote], workDir)
  git(['remote', 'add', 'origin', remote], repo)
  git(['push', '-q', 'origin', branch], repo)
  return repo
}
