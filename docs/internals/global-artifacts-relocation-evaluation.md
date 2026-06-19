# Evaluación arquitectónica: reubicar TODOS los artefactos fuera de los repos importados

> Documento de decisión técnica. Audiencia: arquitectos de `specrails-core` + `specrails-desktop`.
> Objetivo evaluado: que `specrails-core` instale y que `specrails-desktop` lea **todos** los
> artefactos de Specrails desde `$HOME/.specrails`, y todos los artefactos de los CLIs
> (claude/gemini/codex) desde `$HOME/.claude`, `$HOME/.gemini`, `$HOME/.codex`, de modo que
> **los repos importados NUNCA se modifiquen** (cero `.specrails/.claude/.codex/.gemini` en el repo,
> cero mutaciones de `.gitignore`, cero archivos de instrucciones).

---

## 1. Resumen ejecutivo

El objetivo es **parcialmente alcanzable, no plenamente**, y la frontera entre lo alcanzable y lo irreductible es nítida y está bien fundamentada en la evidencia. La pieza maestra es un hecho confirmado en código y en los CLIs vivos: **los tres CLIs (claude, codex, gemini) anclan su "project scope" — agentes, comandos, skills, settings, archivo de instrucciones, `.mcp.json` — al directorio de trabajo (CWD), no al repo de git.** No existe ningún `--project-dir` en ninguno de los tres. Por tanto, si cada spawn se ejecuta desde un directorio anclado en `$HOME` (con el repo accesible mediante un symlink hijo `./project`), ese directorio pasa a ser el "proyecto" para el CLI y **cero archivos de config aterrizan en el repo**. Este patrón ya está probado y en producción en `server/explore-cwd-manager.ts`.

La recomendación es **adoptar el "workspace gestionado por la app" (Opción 1) como modelo arquitectónico de destino**, porque convierte la inmunidad a colisiones en una **propiedad estructural** (no en supresión por-flag), pero **ejecutarlo por fases empezando por el alcance de la Opción 3 (Híbrido Pragmático)** para los flujos de lectura/interactivos, que ya son relocalizables hoy con cambios solo en desktop y cero cambios en contratos congelados. El panel de jueces se reparte de forma honesta: **la lente de feasibilidad CLI y la de goal-fit/UX eligen la Opción 1** (es la única que usa el único mecanismo universal, CWD-relocation, sin depender de flags que el CLI no soporta); **la lente de blast-radius/contratos elige la Opción 3** (menor superficie de cambio, cero contratos en riesgo).

El techo honesto es **"repo git-limpio", no "repo file-limpio"** para proyectos que ejecutan rails de `implement`: dos artefactos son irreductiblemente repo-bound — `openspec/changes/` (entregable versionado, escrito por el binario externo `@fission-ai/openspec`, leído como working tree repo-relativo por los agentes) y los git worktrees de aislamiento (`.claude/worktrees/`, deben compartir el `.git`/object-store del repo para el merge-back). Ningún flag de ningún CLI los reubica. Para proyectos de **solo lectura** (Explore, quick-spec, chat, ai-edit) el objetivo literal de "cero archivos en el repo" **sí se cumple por completo**.

---

## 2. El problema hoy

Cuando `specrails-desktop` importa un repo, su setup wizard ejecuta `npx specrails-core` (tier `quick`), que corre `scaffoldInstallation()` con `repoRoot = project.path` (la ruta del repo del usuario). Esto **escribe directamente dentro del repo del usuario** a través de cuatro raíces de destino, y además **muta archivos preexistentes del usuario**. El daño concreto, según el inventario de evidencia:

- **Pollution de directorios completos en el repo**: `.specrails/**` (manifest, version pin, `setup-templates/` staging, `install-config.yaml`, opcionalmente `profiles/`) y `<providerDir>/**` donde `providerDir` es `.claude` / `.codex` / `.gemini` según el provider (`scaffold.ts:251-275`, ~40 callsites con `path.join(input.repoRoot, providerDir, ...)`).

- **Mutación de `.gitignore` del usuario**: `ensureGitignore` añade un bloque `# specrails` con `.claude/agent-memory/` y `.specrails/` (y `.gemini/agent-memory/` en gemini) — `scaffold.ts:277-280, 1226-1242`.

- **Mutación quirúrgica de archivos de instrucciones preexistentes**: para codex, `AGENTS.md` raíz por sentinel-block upsert; para gemini, `GEMINI.md` raíz por sentinel + `.gemini/settings.json` por `deepMergeJson`. Preservan contenido fuera del bloque gestionado, pero **escriben en un archivo que el usuario ya tenía** (`scaffold.ts:1038-1071, 723-757`). (Nota: para claude NO se escribe `CLAUDE.md` en el flujo de desktop; eso es tarea del pass de IA `/specrails:enrich`, que el desktop nunca ejecuta en tier quick.)

- **Sobrescritura DESTRUCTIVA de archivos propios del usuario**: `placeQuickTierArtefacts()` escribe `sr-architect.md` / `sr-developer.md` / `sr-reviewer.md` con `writeFileLf` **sin guarda de existencia** (`scaffold.ts:951-956`). Si el usuario ya tenía un `.claude/agents/sr-architect.md` propio, **se clobberea**. El contrato `RESERVED_PATHS` solo protege dos prefijos (`.specrails/profiles/`, `.claude/agents/custom-`) — no protege los `sr-*`, ni el `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` del usuario, ni `.mcp.json`, ni `openspec/`.

- **Escritura delegada fuera del control de core**: `npx @fission-ai/openspec init --tools <provider> <repoRoot>` escribe `openspec/**` y dirs de comandos de provider (`.claude/commands/opsx`) en el repo, con su propia lógica (`init.ts:128, 202-218`).

- **Borrados dentro del repo en cada run**: `pruneLegacyArtifacts()` hace `rmSync` recursivo de varias rutas repo-relativas en cada init (`scaffold.ts:784-814`).

El dolor: ruido de git, riesgo de clobber de config propia del usuario, mutaciones de `.gitignore`/`AGENTS.md`/`GEMINI.md` que el usuario no pidió, y una violación del principio "el repo importado es del usuario, no nuestro". El único precedente sano ya existente es que gemini escribe su índice de acknowledgments **fuera del repo** en `~/.gemini/acknowledgments/agents.json` (`scaffold.ts:676-699`) — la prueba de concepto del patrón `$HOME`.

---

## 3. Inventario completo de artefactos

| Grupo de artefacto | Dónde se escribe HOY | Quién lo escribe | ¿Committed o gitignored? | ¿Reubicable a `$HOME` y cómo? |
|---|---|---|---|---|
| `specrails-manifest.json` + `specrails-version` | `<repo>/.specrails/` | core | gitignored (`.specrails/`) | **Sí** vía nuevo `--workspace-dir`/`artifactRoot` en core. Nombres FROZEN (desktop los regex-matchea); solo cambia la ruta base. |
| `setup-templates/**` (staging de templates) | `<repo>/.specrails/setup-templates/` | core | gitignored | **Sí**, requiere param base-dir en core + subdir por-proyecto (colisionaría entre proyectos si fuera `$HOME` plano). |
| `install-config.yaml` | `<repo>/.specrails/` | TUI bin / desktop | gitignored | **Sí (moderado)**: core ya acepta `--from-config <path>`; desktop **ya** copia a `tmpdir` para el spawn (`setup-manager.ts:122,754`). El pin en `integration-contract.json` es nominal. |
| `profiles/*.json` + `.user-preferred.json` | `<repo>/.specrails/profiles/` | desktop / usuario | **committed (team asset)** | **Sí pero**: app-owned, desktop controla todas las lecturas. Mover a `$HOME` **pierde la propiedad "committable team asset"** — decisión de producto, no solo de ruta. |
| `plugins/state.json` + `snapshots/` | `<repo>/.specrails/plugins/` | desktop | gitignored | **Sí (moderado)**: app-owned; el snapshot `$HOME/.../jobs/<jobId>/plugins.json` ya existe. |
| `file-summaries/<hash>.json` | `<repo>/.specrails/file-summaries/` | desktop | gitignored (línea auto-añadida) | **Sí (moderado)**: app-owned. Quita el append a `.gitignore` y la propiedad de team-share. |
| `local-tickets.json` (spec store canónico) | `<repo>/.specrails/` | desktop (RW) + core (R) | gitignored | **BLOQUEADO sin cambio de core**: contrato de lectura congelado; core + cada persona de agente referencian la ruta repo-relativa; el contrato Jira "zero core changes" lo asume repo-relativo. |
| `backlog-config.json` (switch read-only de Jira) | `<repo>/.specrails/` | desktop | gitignored | **BLOQUEADO**: core lo lee en ruta fija para entrar en su rama read-only. |
| `.claude/{agents,commands,skills,rules}` + `agent-memory/` | `<repo>/.claude/` | core | parcialmente gitignored (`agent-memory/`) | **Sí vía CWD-relocation** (CLI auto-discover desde CWD). Bloqueado si CWD debe ser el repo. |
| `.codex/{config.toml,skills}` + `AGENTS.md` raíz | `<repo>/.codex/`, `<repo>/AGENTS.md` | core | committed / git-noise | **Sí**: `CODEX_HOME` (ya usado per-project) cubre config.toml+MCP+skills+AGENTS.md global, **o** CWD-relocation. |
| `.gemini/{settings.json,agents,commands}` + `GEMINI.md` raíz | `<repo>/.gemini/`, `<repo>/GEMINI.md` | core | committed / git-noise | **Sí**: CWD-relocation (project scope cwd-anchored), `GEMINI_SYSTEM_MD` para instrucciones, user-scope settings para MCP. |
| `.mcp.json` (entradas MCP de plugins) | `<repo>/.mcp.json` | desktop (merge quirúrgico) | committed | **Sí (moderado)**: `--mcp-config <abs>` (mecanismo ya usado para `user-mcp.json`) **o** CWD-relocation. |
| `custom-<plugin>.md` fragmentos | `<repo>/.claude/agents/` | desktop | committed | **Sí vía CWD-relocation** (misma constraint de discovery). |
| `CLAUDE.md` raíz | NO escrito por desktop quick-tier (solo full-tier enrich) | core (full-tier) | committed | **Trivial**: nada lo escribe en el path de desktop; Explore ya lo evita vía explore-cwd. |
| `agent-memory/` (explanations, failures) | `<repo>/.claude/agent-memory/` | core (runtime, prompt MD) | gitignored | **Sí pero requiere NUEVO soporte de core** (`SPECRAILS_STATE_DIR` en templates de prompt). |
| `pipeline-state/`, `health-history/`, `compat-snapshots/`, `.dry-run/`, `backlog-cache.json` | `<repo>/.claude/...` | core (runtime, prompt MD) | gitignored | **Sí pero requiere NUEVO soporte de core** (mismo `SPECRAILS_STATE_DIR`). |
| `openspec/changes/**` (entregable de spec) | `<repo>/openspec/` | `@fission-ai/openspec` (delegado) | **git-TRACKED (committed, el producto)** | **BLOQUEADO**: binario externo, working tree repo-relativo, entregable versionado por diseño. |
| `.claude/worktrees/agent-<id>/` (git worktrees) | `<repo>/.claude/worktrees/` | Claude Code Task `isolation:worktree` | gitignored | **BLOQUEADO**: worktree real, debe compartir `.git`/object-store del repo para merge-back. |
| `~/.gemini/acknowledgments/agents.json` | `$HOME/.gemini/` (ya global) | core | n/a (global) | **Trivial (ya global)**: merge-safe, keyed por `repoRoot`. Re-keying si `.gemini/agents` se mueve. |
| `~/.specrails/doctor.log` | `$HOME/.specrails/` (ya global) | core (doctor) | n/a | **Trivial (ya global)**. |
| `.gitignore` (bloque `# specrails`) | `<repo>/.gitignore` | core | n/a | **Trivial de eliminar**: si los artefactos salen del repo, `ensureGitignore` es un no-op. |

**Precedente `$HOME` ya existente y amplio** (la base de la relocalización): desktop ya guarda `jobs.sqlite`, `jobs/<jobId>/{profile,plugins}.json`, telemetry, terminals shims, `explore-cwd`, `codex-home`, `browser-profile`, `attachments`, `user-mcp.json`, todo bajo `$HOME/.specrails/projects/<slug>/`. El snapshot `SPECRAILS_PROFILE_PATH` y `SPECRAILS_PLUGINS_*` ya apuntan a `$HOME`.

---

## 4. La restricción dura: cómo resuelven la config los CLIs

Esta es la sección make-or-break. El hallazgo maestro, confirmado por la evidencia y los CLIs vivos: **ninguno de los tres CLIs permite apuntar agents/commands de project-scope a un directorio arbitrario SIN mover el CWD. No existe `--project-dir`.** De ahí se deriva todo.

### 4.1 Claude

- **Project scope (`.claude/settings.json`, `.claude/agents`, `.claude/commands`, `CLAUDE.md`, `.mcp.json`) está ESTRICTAMENTE anclado al CWD.** No hay flag/env para cargarlo desde un directorio no-CWD arbitrario (docs oficiales; feature-requests abiertas #25762 y #28808 piden exactamente esto, confirmando que no existe).
- **`CLAUDE_CONFIG_DIR` reubica SOLO el user-scope `~/.claude` (global a todos los proyectos), NO el `.claude` por-proyecto.**
- **Escape hatches por-invocación (sin archivo en el repo):** `--settings <file-or-json>` (ruta arbitraria), `--mcp-config <files...>` (+ `--strict-mcp-config` para ignorar el `.mcp.json` del repo), `--agents <json>` (agentes inline), `--add-dir`, `--system-prompt`/`--append-system-prompt`, `--plugin-dir`/`--plugin-url`.
- **`--setting-sources` es enum-only `{user, project, local}`** — selecciona qué scopes cargar, no dónde viven.
- **PARED dura (solo si CWD debe ser el repo):** no hay forma de cargar agents/commands/settings/`CLAUDE.md` de project-scope desde un directorio arbitrario manteniendo CWD en el repo. **`--add-dir` está documentado como "(CLAUDE.md dirs)"** — carga `CLAUDE.md`/memory desde un dir añadido pero **NO registra los subagentes `sr-*` de project-scope** que el snapshot de profile referencia. Esta es la falla fatal de la inyección de framework en rails de la Opción 3. Tampoco hay `--commands-dir`: los `/specrails:*` requieren `--plugin-dir` o `CLAUDE_CONFIG_DIR/commands`.
- **Esta pared se DISUELVE en el momento en que el CWD se reubica** a un dir `$HOME`: entonces `.claude/agents`, `.claude/commands`, `CLAUDE.md`, `.mcp.json` cargan nativamente desde ese CWD, sin flags.

### 4.2 Codex

- **`AGENTS.md` se resuelve en DOS scopes:** project (walk de git-root→cwd) Y global `CODEX_HOME/AGENTS.md` (con precedencia `AGENTS.override.md`). Un `AGENTS.md` no-repo está nativamente soportado vía `CODEX_HOME` — **sin truco de CWD para las instrucciones**.
- **`CODEX_HOME` reubica `config.toml` (model/sandbox/approval), definiciones MCP, auth Y skills/custom-prompts a un dir por-proyecto.** Desktop ya usa `CODEX_HOME` por-proyecto para MCP.
- **Project config (`.codex/config.toml`, `.codex/skills`) se descubre caminando desde el CWD hasta el project root** (marker por defecto `.git`); `project_root_markers` (settable a `[]`) controla esto.
- **PARED suave:** no hay env/flag para apuntar `AGENTS.md` a un FILE arbitrario más allá de project `.codex`, `CODEX_HOME` o `project_doc_fallback_filenames`. Pero `CODEX_HOME` cubre el caso completo. `-c key=value` override per-invocación, `-p profile`, `--ignore-user-config`, `-C/--cd`.
- **Riesgo de re-discovery:** con CWD=repo, codex **camina git-root→cwd buscando `AGENTS.md` y NO hay flag para deshabilitar ese walk** (confirmado ausente en codex 0.139.0 `--help`). Un `AGENTS.md` preexistente del usuario se concatena aditivamente. Solo "limpio" para repos vírgenes. Con CWD-relocation fuera del repo, el walk no encuentra nada del repo.

### 4.3 Gemini

- **`settings.json` carga de system, user (`~/.gemini/settings.json`) y project (`.gemini/settings.json` en CWD).** Project scope estrictamente cwd-anchored. `mcpServers` viven en `settings.json` en cualquier scope — un CWD `$HOME` o user-scope settings proveen MCP sin archivo en el repo.
- **`GEMINI_SYSTEM_MD` reemplaza el system prompt built-in con un archivo en ruta arbitraria** (abs/rel, `~` expandido) — escape hatch de instrucciones totalmente no-repo, independiente del discovery de `GEMINI.md`.
- **`GEMINI_CLI_HOME` reubica el dir user-level (`~/.gemini`, global). NINGÚN env reubica el `.gemini` de PROJECT** a ruta arbitraria — debe estar en CWD. `XDG_CONFIG_HOME` no se honra.
- **El walk de `GEMINI.md` para en el TRUSTED ROOT (frontera del workspace), no en git-root.** Un CWD `$HOME` que no sea ancestro del repo no re-descubre un `GEMINI.md` repo-side. `GEMINI_CLI_TRUST_WORKSPACE=true` (ya inyectado hoy) ancla el trusted root al workspace.
- **`--include-directories` + `context.loadMemoryFromIncludeDirectories=true`** carga sus `GEMINI.md`. `--policy`/`--admin-policy` cargan policy de rutas arbitrarias.
- **PARED suave:** project commands/agents son cwd-bound; necesitan CWD-relocation para salir del repo. MCP, instrucciones y policy tienen hatches no-CWD.

### 4.4 Síntesis de la restricción

| Tipo de artefacto | claude | codex | gemini |
|---|---|---|---|
| Instrucciones (`CLAUDE/AGENTS/GEMINI.md`) | `--append-system-prompt` / CWD | `CODEX_HOME/AGENTS.md` / CWD | `GEMINI_SYSTEM_MD` / CWD |
| MCP (`.mcp.json` / settings) | `--mcp-config` + `--strict-mcp-config` / CWD | `CODEX_HOME` config.toml | user-scope settings / CWD |
| Settings | `--settings` / CWD | `-c` + `CODEX_HOME` / CWD | `GEMINI_CLI_HOME` (user) / CWD (project) |
| **Agents (project-scope)** | **solo CWD** (o `--agents` inline) | **solo CWD/`CODEX_HOME`** (sin file flag) | **solo CWD** (sin env por-project) |
| **Commands (project-scope)** | **solo CWD** (o `--plugin-dir`; **NO hay `--commands-dir`**) | `CODEX_HOME/skills` / CWD | **solo CWD** |

**La conclusión que decide la arquitectura:** las paredes duras (agents/commands de project-scope) **solo existen si se insiste en mantener CWD=repo**. **Todas se disuelven con CWD-relocation** — el único mecanismo universal a los tres CLIs, ya probado en `explore-cwd-manager.ts`.

---

## 5. Opciones de arquitectura

### Opción 1 — Workspace gestionado por la app (generalizar explore-cwd)

CWD = `$HOME/.specrails/projects/<slug>/workspace/` para **todos** los spawns (excepto terminales). El workspace contiene TODOS los artefactos (`.claude/.codex/.gemini`, instrucciones, `.mcp.json`, `.specrails/`); el repo se alcanza vía symlink `./project`. Core gana un único `--workspace-dir`/`SPECRAILS_WORKSPACE_DIR` que separa `artifactRoot` de `codeRoot` (default unset ⇒ `artifactRoot=codeRoot`, legacy byte-idéntico). Runtime state vía nuevo `SPECRAILS_STATE_DIR`; worktrees repo-bound vía nuevo `SPECRAILS_REPO_DIR`.

- **Trade-offs:** inmunidad a colisiones **estructural** (no per-flag); claude carga agents/commands/`CLAUDE.md`/`.mcp.json` nativamente sin flags frágiles. **Coste:** XL, el grueso en core (~40 callsites de scaffold + 7+ templates de prompt); rails corren CWD=workspace (no el repo), así que toda ruta relativa de edición/git/openspec debe re-apuntar al repo real vía `SPECRAILS_REPO_DIR`/symlink — riesgo de corrección amplio. Requiere release lockstep de dos repos + core-version gate.
- **Scores del panel:** Feasibilidad CLI **8** (top pick), Goal-fit/UX **8** (top pick), Blast-radius/contratos **4**.

### Opción 2 — Globales `$HOME` reales + inyección por-invocación (CWD=repo)

Los artefactos viven en dirs `$HOME` reales por-proyecto; los spawns mantienen CWD=repo y alcanzan la config solo vía env vars + flags. claude: `CLAUDE_CONFIG_DIR` + `--setting-sources user` + `--strict-mcp-config` + `--mcp-config` + `--agents`/`--plugin-dir` + `--append-system-prompt`. codex: `CODEX_HOME`. gemini: `GEMINI_CLI_HOME` + `GEMINI_SYSTEM_MD` + `--include-directories`.

- **Trade-offs:** CWD=repo resuelve git/rutas relativas nativamente (única ventaja). **Pero** se sitúa exactamente en la configuración que la evidencia marca con MÁS paredes duras. codex/gemini project skills/agents **no tienen loader no-CWD** ⇒ "user-scope enmascarando project-scope". codex concatena aditivamente cualquier `AGENTS.md` preexistente del usuario (**sin flag para deshabilitar el walk**). claude no tiene `--commands-dir` ⇒ `/specrails:*` requieren ensamblaje `--plugin-dir` por-proyecto (maquinaria nueva no verificada). Además relocaliza `local-tickets.json`, el read-cache FROZEN de core (contrato Jira "zero core changes") — **el peor riesgo de contrato** para un resultado aún PARCIAL.
- **Scores del panel:** Feasibilidad CLI **4**, Goal-fit/UX **4**, Blast-radius/contratos **3** (el peor en las tres lentes).

### Opción 3 — Híbrido Pragmático (CWD-relocation para lectura, `--add-dir` para rails, gitignore el residuo)

Flujos de lectura/interactivos (Explore, quick-spec, contract-refine, sidebar chat, agent-refine, terminal "Open AI CLI") → CWD-relocation a `$HOME/.../cli-cwd/` (reusando/generalizando `ensureExploreCwd`): **cero archivos en el repo, hoy mismo**. Rail/implement → CWD=repo (inevitable), inyectando framework vía `--add-dir`/`--include-directories`/`CODEX_HOME` + `--strict-mcp-config`, y dejando el residuo irreductible (openspec/changes, worktrees, runtime state) **git-limpio** (ya está en el bloque gitignore de core).

- **Trade-offs:** **menor blast radius** (Medium, ~70% desktop, core OPCIONAL/cero); **cero contratos congelados tocados**; reusa el patrón explore-cwd ya en producción. **Pero** el rail-path es el punto débil honesto: `--add-dir` está documentado como "(CLAUDE.md dirs)" y **puede NO registrar los subagentes `sr-*`** ⇒ fallback a `--agents` inline regenerado por-spawn, con riesgo de drift respecto al snapshot de profile. No alcanza "cero archivos" para proyectos que corren rails (solo git-limpio).
- **Scores del panel:** Feasibilidad CLI **5**, Goal-fit/UX **6**, Blast-radius/contratos **8** (top pick).

---

## 6. Recomendación

**Adoptar la Opción 1 (workspace) como modelo de destino, implementada por fases empezando con el alcance de la Opción 3 para los flujos de lectura.** Esto es un **graft** deliberado:

1. **Fase A (alcance Opción 3, solo desktop, cero cambios de core, cero contratos en riesgo):** generalizar `explore-cwd-manager.ts` en un `CliCwdManager` compartido y enrutar **todos los flujos de lectura/interactivos** (Explore, quick-spec, contract-refine, agent-refine, sidebar chat, terminal "Open AI CLI") a CWD = `$HOME/.../cli-cwd/`. Para estos flujos, el objetivo "cero archivos en el repo" **se cumple por completo, hoy**, con la inmunidad-a-colisiones estructural de la Opción 1. Repointar los sitios app-owned (`ticket-store`, `profile-manager`, `plugins/paths`, `file-summary`, `jira-backlog-config`, `context-scope`) a `$HOME` donde sea seguro.

2. **Fase B (alcance Opción 1, cambio de core, release lockstep):** introducir `--workspace-dir`/`SPECRAILS_WORKSPACE_DIR` + `SPECRAILS_STATE_DIR` + `SPECRAILS_REPO_DIR` en core, y mover **el flujo de rails** al workspace, con worktrees/openspec como las excepciones repo-bound documentadas. Gate por core-version (espejo del gate `>= 4.1.0` de profiles).

**Por qué este graft y no Opción 2/3 puras:** las dos lentes que importan para "que funcione de verdad" (feasibilidad CLI y goal-fit) eligen la Opción 1 porque es la única que descansa **exclusivamente** en CWD-relocation — el único mecanismo universal y no-mágico. La Opción 2 muere en las paredes duras (codex sin loader no-CWD + leak de `AGENTS.md` no suprimible + relocación de `local-tickets.json` que toca un contrato congelado). La Opción 3 hereda la inmunidad de la Opción 1 en lectura pero su rail-path descansa en `--add-dir`, que `claude --help` documenta como "(CLAUDE.md dirs)" — **no registra subagentes de project-scope**. El graft captura lo mejor de ambas: la Opción 3 entrega valor real e inmediato con riesgo mínimo, y la Opción 1 completa el objetivo donde más importa (rails) con la garantía arquitectónica.

### Layout de destino bajo `$HOME`

```
~/.specrails/projects/<slug>/
  workspace/                              # CWD universal (generaliza explore-cwd) — Fase B
    CLAUDE.md | AGENTS.md | GEMINI.md     # instrucciones app/core-owned (por provider)
    .mcp.json                             # entradas MCP de plugins (+ opcional project MCP)
    .claude/{agents,commands,skills,rules,agent-memory}/
    .codex/{config.toml,skills}/          # codex (también cubierto por CODEX_HOME)
    .gemini/{settings.json,agents,commands,agent-memory}/
    .specrails/
      specrails-manifest.json  specrails-version   # nombres FROZEN, ahora aquí
      install-config.yaml
      setup-templates/{agents,commands,skills,rules,personas,claude-md,settings}/
      profiles/*.json  .user-preferred.json        # app-owned (pierde "committable")
      plugins/{state.json,snapshots/}
      file-summaries/<hash>.json
      local-tickets.json                            # read-cache de specs (vía core env pointer)
      backlog-config.json                           # switch read-only de Jira
    pipeline-state/ health-history/ compat-snapshots/ dry-run/ agent-memory/ backlog-cache.json
      # ^ runtime state, redirigido vía SPECRAILS_STATE_DIR (nuevo env de core)
    project -> <project.path>             # symlink/junction (project-path.txt fallback)
  cli-cwd/                                # CWD para flujos de lectura — Fase A (ya existe como explore-cwd)
  jobs.sqlite  codex-home/  telemetry/  terminals/  user-mcp.json  attachments/  ...   # ya en $HOME
```

Lo único que permanece en el repo: `workspace/project` (symlink), `openspec/changes/` (entregable versionado, intencional) y los worktrees git-bound (gitignored).

### Receta de spawn por provider (Fase B, CWD = workspace)

- **claude** (rails, chat, agent-refine, quick-spec, contract-refine): `cwd=<workspace>`. Auto-descubre `.claude/{agents,commands,skills}`, `CLAUDE.md`, `.mcp.json` desde el CWD — **sin flags nuevos en el happy path**. `--add-dir <workspace>/project` para que las tools alcancen archivos del repo por ruta absoluta. `--mcp-config <$HOME user-mcp.json>` para user-MCP sin cambios. `--setting-sources project,local` para aislar de globales del usuario.
- **codex**: `cwd=<workspace>` + mantener `CODEX_HOME=$HOME/.specrails/projects/<slug>/codex-home`. `-c project_root_markers=[]` (defensivo) para que trate el workspace como root y no camine ancestros. `AGENTS.md` en `<workspace>/AGENTS.md` o `CODEX_HOME/AGENTS.md`.
- **gemini**: `cwd=<workspace>`. Project `.gemini/{settings.json,agents,commands}` + `GEMINI.md` cwd-discovered. `GEMINI_CLI_TRUST_WORKSPACE=true` (ya inyectado) ancla el trusted root al workspace ⇒ ningún `GEMINI.md` repo-side se re-descubre. Opcional `GEMINI_SYSTEM_MD=<workspace>/GEMINI.md`. Re-keying del writer `~/.gemini/acknowledgments/agents.json` de `project.path` al workspace, hasheando `<workspace>/.gemini/agents/*.md`.

Para los tres, el env `$HOME` ya existente (`SPECRAILS_PROFILE_PATH`, `SPECRAILS_PLUGINS_*`, `OTEL_*`/`CLAUDE_CODE_ENABLE_TELEMETRY`) no cambia. **Terminales mantienen `cwd=project.path`** — el usuario espera una shell en su repo real. **Git provenance mantiene `cwd=project.path`** — git es repo-bound.

---

## 7. Plan de migración

### Proyectos ya importados

Migración **no-destructiva por diseño** (honra "no modificar el repo"): al cargar el registry (o en el primer job tras el upgrade), `migrateProjectArtifactsToHome(slug)`:

1. Detecta `.specrails/`, `.claude/`, `.codex/`, `.gemini/`, `AGENTS.md`/`GEMINI.md`/`CLAUDE.md` raíz, `.mcp.json` repo-residentes.
2. **Copia (no mueve — deja el repo intacto)** el subconjunto app-owned al nuevo `cli-cwd`/`workspace`: `local-tickets.json`, `profiles/`, `plugins/state.json`, `file-summaries/`, `install-config.yaml`, los `sr-*` agents/commands.
3. Para el workspace (Fase B), re-ejecuta `npx specrails-core init --root-dir <project.path> --workspace-dir <workspace>` para regenerar artefactos canónicos en `$HOME`.
4. Setea un flag en `desktop-db` para que las lecturas siguientes usen `$HOME`.
5. Los archivos repo-residentes de instalaciones previas se **dejan en disco** (no se borran automáticamente) e inertes; se ofrece una affordance manual "limpiar archivos antiguos de Specrails" — que el usuario ejecuta explícitamente (eso sí modifica el repo, nunca automático).

### Cambios en `init`/`update` de core

- **Fase A:** **cero cambios de core.** Desktop ya pasa `--from-config <abs tmpdir path>` (`setup-manager.ts:754`), así que el pin `configSchema.file` es nominal. Se ejecuta `init` con `cwd` = el dir staging `$HOME` (no `project.path`).
- **Fase B:** nuevo `--workspace-dir`/`SPECRAILS_WORKSPACE_DIR` que resuelve `artifactRoot = workspaceDir ?? repoRoot`. Threading de `artifactRoot` a través de ~40 callsites de `scaffold.ts`. `ensureGitignore()` y `pruneLegacyArtifacts()` operan sobre `artifactRoot` (no-op/seguro cuando `artifactRoot !== codeRoot`). Delegado openspec recibe el workspace como target (verificar PoC). Runtime: `SPECRAILS_STATE_DIR` honrado por `implement.md`/`retry.md`/`health-check.md`/`compat-check.md`/`sr-*.md`/`why.md`/`memory-inspect.md` (default unset ⇒ `.claude/...`, legacy). Worktrees repo-bound vía `SPECRAILS_REPO_DIR`. Sentinels `init complete`/`update complete` y nombres de manifest **byte-estables**.

### Backward-compat y kill-switch / rollback

- **Default unset ⇒ legacy byte-idéntico:** todo `npx specrails-core init` standalone (no-desktop) se comporta exactamente igual; `--workspace-dir` solo lo pasa desktop.
- **Core-version gate** (espejo del `>= 4.1.0` de profiles): un desktop nuevo contra un core viejo (sin `--workspace-dir`) **caería de vuelta al comportamiento in-repo** en lugar de mis-targetear silenciosamente. **Este gate es load-bearing** — sin él, un desktop nuevo + core viejo vuelca artefactos en el repo.
- **Rollback:** desactivar el flag de workspace por-proyecto en `desktop-db` revierte a CWD=repo. Los archivos `$HOME` permanecen (limpiables manualmente). Ningún dato se pierde.

---

## 8. Esfuerzo e impacto por repo

### specrails-core

- **Fase A:** **cero cambios.**
- **Fase B (esfuerzo: el grueso, XL del total):**
  - `init.ts`/`update.ts`/`doctor.ts`: nuevo flag `--workspace-dir` + env, resolver `artifactRoot`.
  - `scaffold.ts`: split de `artifactRoot`/`codeRoot` en ~40 callsites de `path.join(input.repoRoot, providerDir, ...)`. **Mecánico pero debe ser exhaustivo** — un solo literal `.claude/...` perdido aterriza en el repo y viola el requisito en silencio.
  - `ensureGitignore()` no-op cuando `artifactRoot !== codeRoot`; `pruneLegacyArtifacts()` sobre `artifactRoot`.
  - Templates de prompt runtime: `SPECRAILS_STATE_DIR` en ~7-8 archivos MD, default `.claude/...`.
  - Worktrees: `SPECRAILS_REPO_DIR` para ops git/worktree distintas del CWD.
  - `integration-contract.json`: bump de `schemaVersion`; documentar el contrato workspace-dir.

### specrails-desktop

- **Fase A (esfuerzo: Medium, ~70% del trabajo de Fase A):**
  - Generalizar `explore-cwd-manager.ts` → `CliCwdManager` compartido (reusar symlink + `project-path.txt` fallback + cleanup que ya existen).
  - Repointar `chat-manager`, `contract-refine-runner`, `agent-refine-manager`, `project-router-tickets` (quick-spec, ai-edit) a `cli-cwd`.
  - `setup-manager`: ejecutar `init` con `cwd` = dir staging `$HOME`.
  - Repointar `ticket-store.resolveTicketStoragePath`, `profile-manager.profilesDir`, `plugins/paths.*`, `file-summary-manager.SUMMARIES_REL`, `jira-backlog-config`, `context-scope` readers a `$HOME`.
  - Re-keying de `gemini-agent-ack`.
- **Fase B (esfuerzo: Medium-Large):**
  - `queue-manager`: cambiar rail-job `cwd` a workspace; inyectar `SPECRAILS_STATE_DIR=<workspace>` + `SPECRAILS_REPO_DIR=<project.path>`. Provenance mantiene `cwd=project.path`.
  - `terminal-manager`: **mantener `cwd=project.path`** (intencional).
  - Migración + core-version gate.

### Riesgos para contratos congelados

| Contrato congelado | ¿En riesgo? | Notas |
|---|---|---|
| Mobile wire (`specrailshub`, `hub.*`, `hubInstanceId`, `hub_daily_budget_exceeded`) | **No** | Strings de identidad/wire, ortogonales a ubicación de archivos. |
| Bundle id `sh.specrails.hub` | **No** | Identidad de app-data/updater; sin relación con repo-vs-HOME. |
| core↔desktop schema identity (`$id`) | **No** | `profile.v1.json` de desktop ya es derivativo con su propio `$id` (línea 3). Mover profiles a `$HOME` no cambia el `$id`. |
| `RESERVED_PATHS` (`.specrails/profiles/`, `.claude/agents/custom-`) | **No** (semántica), **Sí** producto | Semántica preservada relativa a `artifactRoot`. Mover profiles a `$HOME` pierde "committable team asset" — decisión de producto. |
| Sentinels `init complete`/`update complete` | **No** (si byte-estables) | Deben permanecer byte-idénticos; solo cambia su ruta base. |
| `integration-contract.json` `configSchema.file='.specrails/install-config.yaml'` | **Bajo** | Pin nominal; desktop ya pasa `--from-config <abs>`. Fase B puede bumpear `schemaVersion`. |
| Coverage gates (80% server, 80% client, 70% global) | **No** (alcanzables) | Path funcs puras + symlink manager + DB reads en el harness `:memory:` existente son altamente testeables. Requiere volumen de tests nuevo, no bajar thresholds. |

---

## 9. Riesgos y preguntas abiertas

1. **[SPIKE OBLIGATORIO ANTES DE FASE B] ¿`--add-dir` registra subagentes de project-scope?** `claude --help` documenta `--add-dir` como "(CLAUDE.md dirs)". Si la Opción 1 funciona (CWD=workspace, los agents viven en `<workspace>/.claude/agents` y cargan nativamente desde el CWD) esto **no es problema para la Fase B**. Pero **es la falla fatal de cualquier rail-path con CWD=repo** (Opción 3 pura). Validar que con CWD=workspace los `sr-*` se registran nativamente — es la suposición load-bearing de la recomendación.

2. **[SPIKE OBLIGATORIO] ¿`@fission-ai/openspec init` acepta un target out-of-repo / sin `.git`?** Si lo exige, `openspec/changes/` debe quedar como la **única** excepción repo-residente y "cero archivos" es PARCIAL para rails. Probar: init de openspec contra el workspace sin `.git`; si falla, evaluar inicializar un `.git` throwaway en el workspace o aceptar openspec como excepción documentada.

3. **[SPIKE] Worktrees repo-bound desde CWD=workspace.** Los worktrees deben compartir el `.git`/object-store del repo y mergear de vuelta. Validar que `SPECRAILS_REPO_DIR` + `git -C <repo>` worktree-add funcionan cuando el CWD del proceso es el workspace. Un error aquí **corrompe o falla merges de multi-feature rails silenciosamente**.

4. **Exhaustividad de los ~40 callsites de scaffold + ~8 templates de prompt.** Un solo literal `.claude/...`/`path.join(repoRoot,...)` perdido aterriza en el repo sin error. Mitigación: test que asserta el working tree del repo **byte-inalterado** tras un ciclo completo setup+job.

5. **codex/gemini ancestor-walk re-discovery.** Si el workspace se coloca dentro del repo (o el symlink se sigue durante discovery), un `AGENTS.md`/`GEMINI.md` repo-side se filtra. Mitigación: workspace estrictamente fuera del repo + `project_root_markers=[]`/`TRUST_WORKSPACE`. Verificar por versión de CLI.

6. **Disciplina de rutas en rails (CWD=workspace).** Toda ruta relativa que deba resolver en el REPO debe ir por `SPECRAILS_REPO_DIR`/symlink. Si una tool resuelve relativa al CWD, escribe en el workspace por error. Mitigación: `--add-dir <workspace>/project` + disciplina auditada en prompts.

7. **Profiles/file-summaries pierden "committable team asset".** Regresión de producto, no solo de ruta. Posible affordance opt-in "exportar profiles al repo" / "commit profiles".

8. **`--strict-mcp-config` en rails** deshabilita el `.mcp.json` committed del repo — puede romper a un usuario que dependa legítimamente de un MCP server repo-committed fuera del sistema de plugins. Necesita escape hatch por-proyecto.

9. **GAP ortogonal (no causado por esta migración, pero a corregir/flag en la rework de spawn-env):** `gemini-adapter` declara `nativeOtelEnv:true` pero `buildTelemetryEnv` no emite vars `GEMINI_TELEMETRY_*`; si gemini honra los `OTEL_*` genéricos está sin verificar.

10. **Release lockstep de dos repos.** Un desktop con `--workspace-dir` contra un core sin el flag vuelca artefactos en el repo. El core-version gate es load-bearing.

---

## 10. Veredicto final

**GO-WITH-CAVEATS.**

- **Para flujos de lectura/interactivos (Explore, quick-spec, contract-refine, chat, ai-edit): GO inmediato.** Fase A es solo-desktop, cero cambios de core, cero contratos congelados en riesgo, y reusa el patrón explore-cwd ya en producción. El objetivo literal "cero archivos en el repo" **se cumple por completo** para estos flujos. Entrega valor real con riesgo mínimo.

- **Para el flujo de rails/implement: GO con la advertencia honesta de que el techo es "repo git-limpio", no "repo file-limpio".** `openspec/changes/` (entregable versionado intencional) y los git worktrees (deben compartir el `.git` del repo) son **irreductiblemente repo-bound en las tres opciones** — ningún flag de ningún CLI los reubica. Todo lo demás (framework dirs, instrucciones, `.mcp.json`, manifest, version, profiles, plugins, file-summaries, runtime state) se mueve limpiamente al workspace dado el flag de core + `SPECRAILS_STATE_DIR`.

- **NO-GO para la Opción 2 (globales `$HOME` con CWD=repo):** es la peor en las tres lentes del panel; choca con paredes duras no suprimibles (codex sin loader no-CWD, leak de `AGENTS.md`, sin `--commands-dir`) y pone en riesgo el contrato congelado `local-tickets.json` para un resultado aún parcial.

### Lo más importante a validar PRIMERO

**Un PoC que confirme la doble suposición load-bearing de la Fase B antes de comprometer el cambio de core:**

> Con CWD = un workspace `$HOME` fuera del repo, conteniendo `<workspace>/.claude/agents/sr-*.md` + `.mcp.json` + `CLAUDE.md`, y el repo en `<workspace>/project` (symlink): **(a)** ¿claude **registra y ejecuta** los subagentes `sr-*` de project-scope nativamente desde el CWD?, y **(b)** ¿el agente developer puede **editar source, correr tests y manejar git** en el repo real vía `--add-dir <workspace>/project` / `SPECRAILS_REPO_DIR` sin que ninguna tool escriba por error en el workspace?

Si (a) y (b) pasan, la Opción 1 es sólida y el resto es ingeniería exhaustiva. Si (a) falla (claude no registra agents desde el CWD del workspace cuando hay un symlink de por medio, o el discovery se confunde), la arquitectura de rails necesita repensarse antes de tocar core — y ese es exactamente el riesgo que hunde la inyección por-flag de las otras opciones.
