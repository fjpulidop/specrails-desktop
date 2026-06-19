I have enough confirmation of the reusable mechanics. Here is the build plan.

---

# BUILD PLAN — Framework specrails-core empaquetado en la app de escritorio

> **Objetivo de una frase**: instalar el *framework* de specrails-core **una sola vez** desde dentro del `.dmg`/`.exe`, materializarlo en `~/.specrails/framework/<version>/`, y que cada workspace lo **enlace por symlink** (con fallback a copia donde el symlink falle). Las actualizaciones de core viajan con la actualización de la app: un único swap atómico de `~/.specrails/framework/current` actualiza **todos** los workspaces a la vez. Se elimina el `npx specrails-core init` por proyecto en escritorio.

**Audiencia**: owner + maintainers. Esto dirige la implementación.

---

## 1. Modelo de destino

El framework deja de copiarse por proyecto. Pasa a ser un único árbol versionado, compartido por todos los workspaces vía un symlink indireccional (`current`):

```
~/.specrails/
├── framework/
│   ├── 4.9.0/                      ← materializado UNA vez desde el bundle de la app
│   │   ├── claude/                 ← providerDir framework (estático, read-only)
│   │   │   ├── agents/sr-*.md
│   │   │   ├── commands/specrails/*.md
│   │   │   ├── skills/<sr-*>/SKILL.md
│   │   │   └── rules/layer.md
│   │   ├── codex/                  ← .codex/skills/**, settings
│   │   ├── gemini/                 ← .gemini/{agents,commands,settings}
│   │   └── setup-templates/        ← caché enrich (INPUT de /specrails:enrich), provider-invariante
│   ├── 4.10.0/                     ← tras un app-update: nueva versión materializada al lado
│   └── current  ──────────────►  4.10.0/      (symlink; swap atómico = una operación)
│
├── registry.json                   ← (YA EXISTE) allocation por repo
├── manager.pid
└── projects/<slug>/
    ├── workspace/                  ← (YA EXISTE) cwd de spawns; SPECRAILS_REPO_DIR apunta al repo
    │   ├── project ───────────►  <repo real>     (symlink/junction; YA EXISTE)
    │   └── .claude/                ← providerDir DEL WORKSPACE
    │       ├── agents     ─────►  ~/.specrails/framework/current/claude/agents      (LINK)
    │       ├── commands   ─────►  ~/.specrails/framework/current/claude/commands    (LINK)
    │       ├── skills     ─────►  ~/.specrails/framework/current/claude/skills      (LINK)
    │       ├── rules      ─────►  ~/.specrails/framework/current/claude/rules       (LINK)
    │       └── agent-memory/       ← DIR REAL, escribible, per-workspace (NO se enlaza)
    └── .specrails/
        ├── specrails-version        ← marcador per-install (gate de "relocated")
        ├── specrails-manifest.json  ← registra qué versión de framework consume
        └── install-config.yaml      ← (vive IN-REPO en codeRoot, no aquí)
```

**Invariante de enlace**: se enlazan **solo los subárboles estáticos** del providerDir (`agents/`, `commands/`, `skills/`, `rules/`, `settings`). `agent-memory/` queda como directorio real y escribible en el workspace — nunca apunta al framework read-only. `openspec/**` sigue residiendo **en el repo** (codeRoot), no en el workspace.

**Por qué `current` y no enlazar a `4.10.0/` directo**: el indireccional permite que un app-update materialice `4.10.0/` al lado de `4.9.0/`, verifique, y luego haga **un solo `renameSync` atómico** de `current`. Todos los workspaces que enlazan a `current/...` quedan actualizados sin tocar ningún workspace. En POSIX esto es O(1); en Windows ver §7.

---

## 2. Split framework vs proyecto

Tabla definitiva. **framework-once** = se materializa una vez en `~/.specrails/framework/<version>/<provider>/`. **project-seed** = se crea por workspace en `assembleProjectWorkspace` (sin red, instantáneo).

| Artifact | framework-once | project-seed | Provider |
|---|:---:|:---:|---|
| `templates/agents/sr-*.md` (14 personas) | ✅ (enlazado) | | per-provider (rewrite ruta / frontmatter gemini) |
| `templates/commands/specrails/*.md` (24) | ✅ (enlazado) | | claude; portado a codex skills / gemini toml |
| `templates/codex-skills/**` | ✅ (copia verbatim) | | codex |
| `templates/gemini-commands/{implement,batch-implement}.toml` | ✅ | | gemini |
| `templates/rules/layer.md` | ✅ (enlazado) | | per-provider |
| `commands/{enrich,doctor}.md` (raíz) | ✅ | | invariante |
| `templates/settings/{codex-config.toml, gemini-settings.json}` | ✅ | | per-provider |
| `setup-templates/**` (caché enrich: settings.json, confidence-config, perf-thresholds, security-exemptions, personas, claude-md, profiles/default.json) | ✅ (en `<version>/setup-templates/`) | | invariante |
| **registry.json entry** | | ✅ | — |
| `<workspace>/project` symlink (junction/text fallback) | | ✅ | — |
| `.specrails/specrails-version` + `specrails-manifest.json` | | ✅ | — |
| `.specrails/install-config.yaml` (in-repo, codeRoot) | | ✅ (autor=user) | — |
| `<providerDir>/agent-memory/<id>/` dirs (+ `explanations/`) | | ✅ (DIR real escribible) | per-provider |
| `openspec/**` (in-repo, codeRoot) | | ✅ (vía `openspec init`, requiere red) | per-provider |
| `~/.gemini/acknowledgments/agents.json` entry | | ✅ (re-hash de los ficheros ENLAZADOS, keyed por repoRoot) | gemini |
| `local-tickets.json`, `profiles/.user-preferred.json`, `plugins/state.json`, `file-summaries/**` | | ✅ (lazy en runtime, no en install) | — |

### Manejo de placeholders al compartir

- **`{{PROJECT_NAME}}`**: solo aparece en *product agents*, comandos VPC, y `claude-md/root.md` — **ninguno se coloca en el tier quick/default**. Es enrich-only. El tier quick es **project-genérico**.
- **`{{LAYER_*}}`, `{{ARCHITECTURE_DIAGRAM}}`, `{{CI_*}}`, `{{BACKLOG_*}}`, campos de persona**: `renderPlaceholders` (scaffold.ts:1261-1267) **strippea todo `{{...}}` no sustituido a string vacío** en el tier quick. Por eso un fichero compartido por symlink es seguro sin reescritura per-project.
- **`MEMORY_PATH`, `PERSONA_DIR`, `SECURITY_EXEMPTIONS_PATH`**: son constantes **por provider** (no por proyecto). Pre-renderizan bien en la copia compartida del framework.
- **`codex-config.toml MODEL_NAME`**: hardcodeado a `gpt-5.5-mini` en install → constante per-provider, compartible.

**Conclusión**: el symlink puro del subárbol estático del providerDir es viable **sin reescritura per-project**. Esto se protege con un test de invariante (ver §9): "ningún token per-project debe rellenarse en tier quick".

---

## 3. Cambios en specrails-core

Se refactoriza el monolito `scaffoldInstallation` (scaffold.ts:252) en dos funciones puras y composables. Su cuerpo ya separa concerns en helpers que mapean 1:1.

### 3.1 `installFramework(globalDir, provider, version)` — idempotente, versionado

Materializa el framework UNA vez en `globalDir/<version>/<providerDir>/`. Cuerpo = los helpers existentes pero escribiendo al dir global en lugar de per-workspace:

- `templatesSrc → setup-templates` copyDir (scaffold.ts:299-314) → `<version>/setup-templates/`
- `copyBundledCommands` (:386) → coloca `commands/specrails/*`, `codex-skills/**`, gemini overrides
- `placeSkills` (:1177) → genera skills claude desde commands
- `applyCodexSettings` (:1081) / `applyGeminiSettings` (:751) → settings por provider
- `writeGeminiAgentFromTemplate` (:609) → re-emite frontmatter gemini

**Idempotencia**: si `<version>/<provider>/` ya existe y su manifest hash coincide, no-op. `buildManifest` (manifest.ts:47) corre **una vez** sobre `frameworkDir`. **Multi-provider**: `<version>/` se sub-keyea por provider; se materializa una vez **por provider** que el proyecto instale.

### 3.2 `assembleProjectWorkspace(workspace, frameworkDir, project)` — sin red

Reemplaza `placeQuickTierArtefacts` (scaffold.ts:878). En lugar de escribir ficheros per-project:

1. **Enlaza** los subárboles estáticos del `<frameworkDir>/<providerDir>/` dentro del workspace (`agents/`, `commands/`, `skills/`, `rules/`, settings). Copy fallback en Windows (misma lógica que `ensureProjectLink`).
2. **Seeds del proyecto** (conserva de `placeQuickTierArtefacts`):
   - mkdir loop de `agent-memory/<id>/` (:1005) + `explanations/` (:179) — **dirs reales escribibles, NUNCA enlazados**.
   - exclusión VPC (:989).
   - `writeManifestFiles` (manifest.ts:74) → `.specrails/{specrails-version, specrails-manifest.json}` apuntando a la versión del framework.
   - `writeGeminiAgentAcknowledgments` (scaffold.ts:696) **per-project** — re-hashea los ficheros **enlazados**, keyed por repoRoot (gemini-only; fácil de olvidar).
3. **No** corre `openspec init` aquí — se separa (ver 3.4).

`renderPlaceholders` ya no se invoca en el camino quick (los tokens son provider-constantes).

### 3.3 Descomposición de init/update

- **`init.ts:124`** se descompone en:
  `ensureFramework(version, provider)` *(skip si la app ya lo materializó)* → `assembleProjectWorkspace(resolveArtifacts(allocate:true))` → `installOpenSpecProject(codeRoot)`.
- **`update.ts:138`** (re-scaffold) se convierte en:
  re-materializar framework a `<nueva-version>/` → **swap atómico** de `~/.specrails/framework/current` → re-link workspaces. **Un swap actualiza todos.**

### 3.4 Modo framework-global standalone (`npx specrails-core init` sin escritorio)

Nueva variante que también instala el framework una vez:
- `installFramework(~/.specrails/framework, provider, CORE_VERSION)` si no existe esa versión.
- `assembleProjectWorkspace(...)` con symlink al framework global.
- `installOpenSpecProject(codeRoot)` in-repo.

Para el caso standalone, el framework viene del propio paquete npm de core (no del bundle de la app). La diferencia escritorio vs standalone es **solo el origen** del árbol a materializar (bundle de la app vs `node_modules/specrails-core/templates`). El resto es idéntico.

### 3.5 Composición con el split codeRoot/artifactRoot (ya construido)

- `resolveArtifacts(allocate:true)` (registry.ts:395) sigue siendo el allocator per-project; `assembleProjectWorkspace` consume su `Resolution` (workspaceDir/artifactRoot/codeRoot/stateDir) sin cambios.
- Los `${SPECRAILS_REPO_DIR:-.}` en los cuerpos de agent/command son expansiones de env **en runtime** (stage-3), no sustituciones en install — son exactamente lo que hace que un fichero compartido re-apunte la I/O al repo en ejecución. **Esto es lo que hace viable la copia única compartida.**
- **openspec carve-out**: `openspec/**` se queda residente en el repo (codeRoot) vía la red `npx @fission-ai/openspec init`. **No es framework, no es instantáneo, no es offline, no es relocalizable.** El objetivo "eliminar npx per-project" **no cubre openspec** (ver §9).

---

## 4. Cambios en specrails-desktop

### 4.1 Bundle de templates en la app (espeja el patrón runtimes **verbatim**)

- **`tauri.conf.json`**: añadir `"framework/**/*"` a `bundle.resources` (junto a `"runtimes/**/*"`, hoy en línea 46). Forma glob para preservar la estructura anidada.
- **CI (`desktop-release.yml`)**: paso que ensambla `src-tauri/framework/` antes de `tauri build` — copia `templates/**`, `commands/{enrich,doctor}.md`, y genera los providerDir materializados (claude/codex/gemini) + `setup-templates/`. Es el mismo patrón que ensambla `runtimes/`. `src-tauri/framework/` gitignored con `.gitkeep`.
- **`scripts/build-sidecar.mjs`**: si algún asset del framework debe resolverse en filesystem real (no dentro del snapshot pkg), copiarlo igual que `node-pty`. La mayoría son ficheros de texto estáticos → bajo riesgo (ver §9).
- **`lib.rs`** (espejo de líneas 181-215): resolver `<resource_dir>/framework`, gate por existencia (`framework/.../claude/agents` existe y no vacío), y exportar `SPECRAILS_BUNDLED_FRAMEWORK_PATH` al sidecar. **Existence-gated** como los runtimes: si no hay framework empaquetado → fallback al `npx` legacy (no dead-end).

### 4.2 `FrameworkManager` (nuevo módulo server)

- `materialize()`: copia `SPECRAILS_BUNDLED_FRAMEWORK_PATH` → `~/.specrails/framework/<version>/` si esa versión no existe. Idempotente (skip si manifest hash coincide).
- `swapCurrent(version)`: `renameSync` atómico de `~/.specrails/framework/current` (reusa `atomicWrite`/rename de artifact-registry.ts:213-227). Crea `current.tmp` → rename.
- `versionCheck()`: en **first-run** y **post-update**, compara la versión bundleada con `current` → materializa + swap si difiere.
- Multi-provider: materializa por provider; el swap de `current` cambia **todos los providers a la vez** (un solo `current` por versión que contiene los 3 providerDirs).

### 4.3 Extender `ensureWorkspace` para enlazar el framework

`server/workspace-manager.ts` ya tiene el baile symlink/junction/text-fallback (`ensureProjectLink`, :81-131). Se añade un paso paralelo que enlaza los subárboles estáticos del providerDir desde `~/.specrails/framework/current/<provider>/` al `<workspace>/<providerDir>/`:
- POSIX: `symlinkSync`.
- Windows: intenta junction → symlink → **copy fallback** (la "one current-swap updates all" no aplica en copy; ver §7).
- `agent-memory/` se crea como dir real (nunca enlazado).

### 4.4 `setup-manager` ya no corre `npx … init`

`server/setup-manager.ts:685-858` deja de spawnear `npx specrails-core init`. En su lugar:
- `FrameworkManager.materialize()` (instantáneo/offline — ya está en disco desde el bundle).
- `assembleProjectWorkspace` server-side (port del de core, o invocar core en modo "assemble-only" sin red): enlazar + seeds.
- **openspec init** sigue necesitando red en el primer assemble (paso separado, con su propio progreso de streaming; ver §9 para bundlear openspec offline como follow-up).
- El árbol per-provider (setup-manager.ts:504-558) se materializa por provider seleccionado.

### 4.5 El gate adapta `isWorkspacePopulated` al layout enlazado

`workspace-resolution.ts` (`resolveProjectExecution`, gate de stage 2) detecta "relocated" vía `<workspace>/.specrails/specrails-version`. El check de "populated" debe aceptar **symlinks** como providerDir válido (hoy puede asumir dirs reales). `projectSupportsProfiles` (queue-manager.ts:67-84) sigue gateando por `>= 4.1.0`. El gate dispara **después** de que el framework symlink esté presente en el workspace.

---

## 5. Canal de actualización

```
core bump (4.9.0 → 4.10.0)
   → la app empaqueta el nuevo core en el bundle (CI ensambla framework/4.10.0)
   → el updater de Tauri instala la nueva app (SIN CAMBIOS en el updater)
   → al arrancar la app nueva: FrameworkManager.versionCheck()
        → materialize 4.10.0/ AL LADO de 4.9.0/ (no destructivo)
        → verifica (manifest hash, smoke de un comando)
        → swapCurrent('4.10.0')  ← UN renameSync atómico
   → TODOS los workspaces que enlazan a current/... quedan en 4.10.0 sin tocarlos
```

- **Desacople total del npx per-project**: ningún proyecto vuelve a ejecutar `npx specrails-core` para actualizar el framework. La actualización es O(1) en POSIX (un swap), O(proyectos) solo en Windows-copy-fallback (§7).
- **Versiones antiguas**: `4.9.0/` se conserva hasta que ningún workspace la referencie; GC opcional (borrar dirs de versión != `current` sin referencias) tras N días.
- **Aviso in-app "framework actualizado"**: **SÍ, recomendado** — un toast no intrusivo "specrails-core actualizado a 4.10.0" tras el swap, broadcast por WS (`framework.updated`, app-level sin projectId). Justificación: el usuario debe saber que sus agents/commands cambiaron. No bloquea nada.

---

## 6. Migración desde el modelo recién construido

Hoy los workspaces existentes contienen una **copia completa** del framework (de core stages 1-3 + desktop stage 2). Plan de switch a symlink-to-global, **no destructivo**, en el siguiente arranque:

1. **Detectar copia**: en `ensureWorkspace`, si `<workspace>/<providerDir>/agents/` es un **dir real** (no symlink) y su contenido coincide (hash) con `framework/current/<provider>/agents/`, marcarlo como "copia migrable".
2. **Backup**: renombrar el providerDir copiado a `<providerDir>.pre-symlink.bak` (no borrar).
3. **Re-enlazar**: crear los symlinks estáticos a `framework/current/...`.
4. **Preservar mutable**: mover `agent-memory/` de la copia al nuevo layout como dir real (NO se enlaza — es estado del proyecto).
5. **Verificar**: si un comando/skill resuelve OK vía el symlink, borrar el `.bak`; si no, revertir (restaurar `.bak`).
6. **Idempotente**: una vez migrado (providerDir ya es symlink), no-op en arranques siguientes.

Workspaces con **divergencia local** (el usuario editó un agent en su copia) → **no migrar automáticamente**: dejar la copia, loggear `framework.migration_skipped` con el path, y surfacing opcional en Settings ("este proyecto usa una copia local del framework").

---

## 7. Versionado y concurrencia

- **Dirs versionados**: `framework/<version>/` inmutables tras materializar. Nunca se mutan in-place.
- **Swap atómico de `current`**: `renameSync` de un symlink es atómico en POSIX. En Windows se usa el patrón temp+rename de `atomicWrite` (artifact-registry.ts:213-227).
- **Rail en vuelo durante un update**:
  - Los rails ya capturan un **snapshot per-job** (profile.json chmod 400, plugins.json). El framework consumido se resuelve al **spawn**, no continuamente.
  - **Serializar el swap**: `FrameworkManager.swapCurrent` corre bajo el file-lock del registry (mismo lock que `resolveArtifacts`). Si hay un job spawneando, el swap espera a que termine la resolución de ese job.
  - Un job que ya spawneó con `4.9.0` resuelto en su cwd sigue con `4.9.0` (el symlink `current` cambió, pero el proceso ya tiene los handles abiertos o resolvió rutas absolutas en el snapshot). **No se interrumpe un rail mid-flight.**
  - Recomendación: el swap captura en el snapshot del job la versión de framework resuelta (`specrails.framework_version` en OTEL resource attrs) para trazabilidad.
- **Windows symlink/junction fallback** (workspace-manager.ts:106-124):
  - Junction para `project →` repo funciona.
  - Para los subárboles del framework: junction (apunta a dir) → symlink → **copy**. En modo copy, un app-update **debe re-copiar por workspace** (`update` se vuelve O(proyectos) en Windows). Aceptable v1; el swap O(1) es una optimización solo-POSIX.
  - El marcador necesita `specrails-version >= 4.1.0` o cae a legacy.

---

## 8. Plan de implementación por fases

Cada fase independientemente testeable + verde, con gates de cobertura (**80% server** lines/functions/statements, 70% branches; **80% client** lines/statements; **70% global**).

| Fase | Repo | Contenido | Reusa runtimes-pattern | Test verde |
|---|---|---|---|---|
| **0. PoC** | desktop | PoC: ¿claude/codex/gemini descubren **commands** y **skills** vía symlink? (agents ya PROBADO esta sesión). Bundle de templates sobrevive el resource-copy de Tauri (¿exec bits / symlinks en templates?). | — | PoC documentado, go/no-go |
| **1. Refactor core puro** | core | Partir `scaffoldInstallation` en `installFramework` + `assembleProjectWorkspace`. **Sin cambiar el comportamiento** (siguen escribiendo per-project). Tests de paridad byte. | — | Tests core actuales + nuevos unit |
| **2. Framework global en core** | core | `installFramework(globalDir, provider, version)` escribe a `~/.specrails/framework/<version>/`; `assembleProjectWorkspace` enlaza. Modo standalone `npx init` framework-global. Guard de invariante PROJECT_NAME. | — | Unit + integración (link + seeds + ack gemini) |
| **3. Bundle desktop** | desktop | `tauri.conf` glob + CI ensambla `framework/` + `lib.rs` env `SPECRAILS_BUNDLED_FRAMEWORK_PATH` (existence-gated). | **VERBATIM** (espeja `runtimes/`) | Smoke: framework presente en `.app` / `.exe` |
| **4. FrameworkManager** | desktop | `materialize` + `swapCurrent` (atomic) + `versionCheck`. WS `framework.updated`. | renameSync reusa artifact-registry | Unit server (cobertura 80%) |
| **5. ensureWorkspace + setup-manager** | desktop | Enlazar framework en workspace (copy fallback Win); `setup-manager` deja de spawnear `npx init` (assemble offline). Gate `isWorkspacePopulated` acepta symlinks. | ensureProjectLink reusa | Server cobertura; e2e add-project offline |
| **6. Canal de update** | desktop | Post-update versionCheck → materialize + swap. Aviso in-app. Rail-mid-flight serializado + snapshot framework_version. | updater unchanged | Test swap concurrente + job snapshot |
| **7. Migración** | desktop | Detectar copia → backup → re-enlazar → verificar → GC. Skip en divergencia local. | — | Test migración no-destructiva + revert |
| **8. openspec offline (follow-up)** | core | Bundlear openspec + `init` offline (eliminar la última red). | — | e2e add-project sin red total |

**Orden estricto**: 0 → 1 → 2 (core verde standalone) → 3 → 4 → 5 → 6 → 7. La 8 es independiente y diferible.

---

## 9. Riesgos y validaciones

**Necesitan PoC (Fase 0):**
- **Discovery de commands/skills por symlink**: AGENTS por symlink está **PROBADO esta sesión**. Falta verificar que claude descubre `commands/specrails/*.md` y `skills/<sr-*>/SKILL.md` cuando el dir es un symlink, y que codex resuelve `.codex/skills/**` y gemini sus `.toml` enlazados. **Bloqueante**: si un provider no sigue symlinks de commands/skills, ese subárbol cae a copy fallback (no se rompe, pero pierde el O(1) update).
- **Templates sobreviven el resource-copy de Tauri**: los runtimes tuvieron caveats (Tauri dereferencia symlinks #13219, no preserva exec bits, no codesigna resources). **Validar**: ¿algún fichero de `templates/**` es un symlink o necesita exec bit? Casi todos son texto (`.md`/`.toml`/`.json`/`.yaml`) → bajo riesgo, **pero confirmar** que no hay symlinks internos y que el árbol anidado se preserva con la forma glob. No requieren codesign (no son Mach-O).

**Riesgos de diseño (mitigaciones ya en el plan):**
- **`agent-memory/` dentro del providerDir** (scaffold.ts:1005): si se enlaza el providerDir entero a un framework read-only, los agents no pueden escribir memoria. **Mitigación**: enlazar solo subárboles estáticos; `agent-memory/` real y escribible.
- **Gemini acknowledgments** (scaffold.ts:696): hashean los bytes exactos de los ficheros, keyed por repoRoot. Cada workspace debe re-escribir su entrada hasheando los ficheros **enlazados**, o gemini headless cae a agents genéricos. **Mitigación**: `writeGeminiAgentAcknowledgments` per-project en `assembleProjectWorkspace`; test que verifica el hash post-link.
- **openspec NO cubierto** por "eliminar npx": sigue requiriendo red en el primer assemble (init.ts:208-248). **Mitigación**: paso separado con streaming; Fase 8 bundlea openspec offline.
- **Invariante quick-tier** depende de que `renderPlaceholders` strippee `{{...}}` a vacío (scaffold.ts:1266). Si un template futuro añade un token per-project a rellenar en quick, el symlink puro se rompe. **Mitigación**: test de guard — "ningún `{{...}}` per-project sobrevive en tier quick; solo PROJECT_NAME existe y es enrich-only".
- **Framework PER PROVIDER**: `.claude/.codex/.gemini` difieren (path rewrites, frontmatter, ports de codex skills). `<version>/` sub-keyeado por provider; el swap de `current` cambia todos los providers juntos.
- **`codex-config.toml MODEL_NAME`** hardcodeado (scaffold.ts:1091): si la selección de modelo se vuelve per-project, la copia compartida de codex necesitaría un overlay, no un link raw. **Hoy**: constante, compartible.
- **Windows copy fallback**: la optimización "un swap actualiza todos" no aplica en copy → update O(proyectos). Aceptable v1.
- **`setup-templates/` (input de enrich)** hoy se copia per-project (scaffold.ts:299). Al compartirse, `/specrails:enrich` debe leerlo del framework dir, no del workspace. **Validar la resolución de rutas de enrich antes de reubicarlo** (Fase 2).