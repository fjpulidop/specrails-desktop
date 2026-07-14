# Contrato de alineación specrails-core ↔ specrails-desktop: relocalización de artefactos a `$HOME`

> Documento de arquitectura. Audiencia: product owner + mantenedores de **specrails-core** y **specrails-desktop**.
> Antecedentes técnicos completos: [`global-artifacts-relocation-evaluation.md`](./global-artifacts-relocation-evaluation.md).
> Evolución posterior (framework bundleado): [`bundled-framework-build-plan.md`](./bundled-framework-build-plan.md).
> Estado: **IMPLEMENTADO** en la rama `feat/relocate-artifacts-to-home` (ambos repos). Las secciones 2-10 describen el DISEÑO original; la **Reconciliación as-built** (abajo) registra los deltas entre el diseño y lo construido — donde difieran, **gana el as-built**.

---

## As-built reconciliation (post-implementación)

Lo construido sigue el contrato salvo estos deltas, descubiertos durante implementación/validación (incl. PoC + capstone 9/9 con un rail real):

1. **El modelo de install evolucionó de "core copia el framework por proyecto" a "framework bundleado, instalado una vez, enlazado por symlink"** (decisión posterior del owner; ver el build-plan). El *framework* provider-invariante (agents `sr-*`, commands, skills, rules, instrucciones) se materializa **una sola vez** en `~/.specrails/framework/<version>/<provider>/` (bundleado dentro del `.dmg`/`.exe` como los runtimes) y cada workspace lo **symlinkea** vía `framework/current`; un app-update re-materializa + hace **swap atómico de `current`** → actualiza todos los workspaces. **Se elimina el `npx specrails-core init` por proyecto** (alta de proyecto offline e instantánea). Las §3/§5 ("core instala en el workspace") siguen siendo correctas para la CAPA PROYECTO; la CAPA FRAMEWORK es ahora compartida. Lo que hace viable la copia compartida: los `${SPECRAILS_REPO_DIR:-.}` en los prompts (§5.3) re-apuntan la I/O al repo **en runtime**, así un fichero de framework idéntico sirve a todos.

2. **codex: NO se hace override de `CODEX_HOME` en los rails.** El §6.1 recomendaba conservar `CODEX_HOME` per-project para rails — **incorrecto**: el PoC demostró que `CODEX_HOME` es todo-o-nada e incluye `auth.json` → 401. Los rails de codex usan **cwd-discovery** (igual que claude), sin override de `CODEX_HOME`. El `CODEX_HOME` per-project se conserva SOLO para el registro MCP del plugin (`codex mcp add`, invocación aparte).

3. **El gate de activación es de DOS partes** (`server/workspace-resolution.ts` `resolveProjectExecution`): "relocated" = existe entrada en el registry **Y** el workspace está poblado (`<workspace>/.specrails/specrails-version`). Un proyecto in-repo existente sin workspace poblado → **legacy** (cwd=project.path, byte-idéntico). Esto hace toda la activación **regression-safe**: solo proyectos realmente reubicados cambian.

4. **Slug inmutable + divergencia standalone↔desktop**: el `slug`+`workspaceDir` de una entrada son **inmutables una vez creada** (`buildMirroredEntry`). Para un repo init'd standalone-luego-importado, el slug del registry (de core) puede diferir del `desktop.sqlite` slug; **el slug del registry es autoritativo para la ubicación de artefactos**. Desktop SIEMPRE resuelve el workspace desde la **entrada del registry** (`resolveArtifacts`), nunca lo computa desde el slug de `desktop.sqlite`.

5. **Red de seguridad de tests**: `resolveHome()` honra `SPECRAILS_REGISTRY_HOME` (core y desktop) y un `vitest-setup.ts` (setupFiles, ambos repos) lo fija a un tmp, de modo que **ningún test escribe el `~/.specrails/registry.json` real** (se cazó y arregló un leak de 115 entradas).

6. **Definición vs configuración de agentes**: las DEFINICIONES (`sr-*.md`) son framework (compartidas, symlink por-fichero para que los `custom-*.md` convivan); la CONFIGURACIÓN (modelos/routing = *profiles*) es per-proyecto en `<workspace>/.specrails/profiles/`, seleccionable por rail. Se siembra un perfil **"balance"** por defecto. `agent-memory/` es siempre dir REAL; los ficheros de instrucción (`CLAUDE/AGENTS/GEMINI.md`) se siembran per-workspace (llevan el nombre de proyecto), los settings provider-invariantes se enlazan.

7. **openspec offline (fase 8)**: `@fission-ai/openspec` se pinea a **1.4.1** y se bundlea en el app; el alta de proyecto pasa a ser **totalmente offline** (era la última llamada de red). Sigue siendo repo-resident (escribe `openspec/**` en el repo). Fallback a `npx` cuando no hay bundle.

8. **Validación**: capstone 9/9 (sr-developer real desde cwd=workspace generó código en el repo, openspec en el repo, workspace limpio) + PoC de discovery por symlink (agents/commands/skills). El bundling Tauri/CI (core+framework+openspec) replica el patrón de runtimes verbatim pero **solo se valida con un build real** del `.dmg`/`.exe`.

---

## 0. Decisiones bloqueadas (entrada del product owner)

Estas cuatro decisiones están **cerradas** y son la premisa de todo el documento:

1. **specrails-core relocaliza SIEMPRE.** Incluye el `npx specrails-core init` que un desarrollador ejecuta en su propio repo, sin desktop presente. Efecto neto: specrails-core **nunca** vuelve a dejar artefactos dentro del repo objetivo. El comportamiento legacy "por defecto = dentro del repo" queda **reemplazado**.
2. **La fuente de verdad compartida es un fichero inspeccionable**, `$HOME/.specrails/registry.json`, versionado por esquema. specrails-desktop lo **escribe**; specrails-core lo **lee** (y escribe/asigna una entrada cuando corre standalone sin desktop). Mapea cada repo a la ubicación de sus artefactos.
3. **Los activos de equipo versionables** (profiles, `.claude/agents/custom-*.md`, entradas `.mcp.json` de plugins) **se mueven a `$HOME` ahora.** El affordance git de "exportar al repo" se **difiere** a un cambio posterior.
4. **Carve-outs que SE QUEDAN en el repo** (lo único que puede permanecer): `openspec/**` (entregable de spec versionado, escrito por el binario externo `@fission-ai/openspec` apuntando a `repoRoot`) y los **git worktrees** (deben compartir el `.git`/object-store del repo). Todo lo demás vive bajo `$HOME`.

---

## 1. Resumen ejecutivo

specrails-core resuelve hoy un único `repoRoot = path.resolve(flags['root-dir'] ?? process.cwd())` y lo usa como base para **todos** los joins de `.specrails/.claude/.codex/.gemini`, tanto en el instalador como en el texto de los prompts de los agentes en runtime. El nuevo modelo **divide ese root en dos**: `codeRoot` (= el repo, conserva solo `openspec/**` y los worktrees) y `artifactRoot` (un directorio bajo `$HOME/.specrails/projects/<slug>/workspace` que contiene **todo lo demás**). La indirección que conecta ambos lados es `$HOME/.specrails/registry.json`, un fichero inspeccionable versionado por esquema que **mapea la realpath canónica del repo → la ubicación de sus artefactos**; specrails-desktop es el escritor primario (proyección de su `desktop.sqlite`), specrails-core es lector y, en modo standalone, asigna su propia entrada. El re-apuntado en runtime replica un precedente **ya en producción** — `SPECRAILS_PROFILE_PATH` se lee primero y cae al path repo-relativo solo si está sin definir (`implement.md:70-91`) — generalizándolo a un conjunto de variables de entorno (`SPECRAILS_TICKETS_PATH`, `SPECRAILS_BACKLOG_CONFIG_PATH`, `SPECRAILS_STATE_DIR`, `SPECRAILS_REPO_DIR`, `SPECRAILS_WORKSPACE_DIR`) inyectadas en el spawn, con el patrón `${ENV:-legacy}` de modo que **"sin definir ⇒ comportamiento legacy byte-idéntico"**. La propiedad de corrección dominante: tras un ciclo completo de setup + job con relocalización activa, el working tree del repo del usuario queda **byte-inalterado** salvo `openspec/**` y los worktrees gitignored. El único riesgo de fallo silencioso es un literal `.specrails/...` o un `path.join(repoRoot, …)` no migrado, que se mitiga con un test de inmutabilidad del repo y un lint de literales sobre `templates/**`.

---

## 2. El contrato compartido: `$HOME/.specrails/registry.json`

Esta es la pieza central. `registry.json` es la **única fuente de verdad inspeccionable** que mapea la ruta canónica de un repo a la ubicación `$HOME` de los artefactos relocalizados de ese repo. Existe porque la auditoría de runtime confirmó **cero** lecturas de `registry.json` / `SPECRAILS_STATE_DIR` / `SPECRAILS_WORKSPACE_DIR` en core hoy: la única lectura `$HOME` que existe es `doctor.ts` apendando a `~/.specrails/doctor.log`. Es por tanto código net-new del lado de core (un resolver) y plumbing net-new del lado de desktop (proyección desde la DB).

### 2.1 Esquema final

**Nivel superior** — `projects` es un **objeto JSON keyado por la ruta canónica del repo**, no un array. Justificación: (a) la unicidad de la clave es estructural en JSON (dos escritores concurrentes no pueden apendar entradas duplicadas para el mismo repo); (b) lookup O(1); (c) replica el precedente ya existente `~/.gemini/acknowledgments/agents.json` (keyado por `repoRoot`); (d) es amigable a merge atómico (un escritor muta exactamente una clave y reescribe).

| Campo (top-level) | Tipo | Notas |
|---|---|---|
| `schemaVersion` | integer | Empieza en `1`. Un lector que ve un `schemaVersion` mayor del que entiende DEBE tratar todas las entradas como ausentes (fallback legacy), nunca malparsear. |
| `generator` | string | `"specrails-desktop@2.8.0"` / `"specrails-core@4.9.0"` del último escritor. No load-bearing. |
| `updatedAt` | ISO-8601 | Timestamp de la última escritura del fichero. |
| `projects` | object | Mapa: ruta-canónica-repo → `ProjectEntry`. |

**`ProjectEntry`** (todos los paths son **absolutos** y en separador nativo de la plataforma; los consumidores los tratan como opacos y nunca re-derivan):

| Campo | Load-bearing | Notas |
|---|---|---|
| `repoPath` | sí | La realpath canónica. Espejo de la clave del mapa (value-iteration self-describing). |
| `slug` | sí | El slug compartido. DEBE igualar `desktop.sqlite projects.slug` para el mismo repo. Algoritmo en §2.4. |
| `workspaceDir` | sí | `~/.specrails/projects/<slug>/workspace` — raíz `$HOME` del proyecto. Todo lo demás cuelga de aquí. |
| `artifactRoot` | sí | El dir que core trata como raíz `.specrails`/install en lugar de `repoRoot`. = `<workspaceDir>` (ver §4 layout). |
| `codeRoot` | sí | Siempre el repo (`= repoPath`). Lleva los carve-outs `openspec/**` + worktrees. Se inyecta como `SPECRAILS_REPO_DIR`. |
| `stateDir` | sí | Base de estado runtime (`agent-memory`, `pipeline-state`, `health-history`, `compat-snapshots`, `backlog-cache.json`, `.dry-run`). Inyectado como `SPECRAILS_STATE_DIR`. |
| `ticketsPath` | sí | Absoluto al `local-tickets.json` relocalizado. Inyectado como `SPECRAILS_TICKETS_PATH`. |
| `backlogConfigPath` | sí | Absoluto al `backlog-config.json` (el switch read-only de Jira). Inyectado como `SPECRAILS_BACKLOG_CONFIG_PATH`. **Crítico**: si core no lo encuentra, dispara su rama "default write_access=true" y re-entra a su rama de escritura, rompiendo el contrato read-only de Jira. |
| `profilesDir` | sí | `.specrails/profiles/` relocalizado. El snapshot por job sigue ganando vía `SPECRAILS_PROFILE_PATH`; este es el fallback standalone. |
| `pluginsStateDir` | desktop-only | `.specrails/plugins/`. Core ignora plugins; presente por completitud/inspeccionabilidad. |
| `fileSummariesDir` | desktop-only | `.specrails/file-summaries/`. Propiedad de desktop (Code explorer). |
| `providers` | sí | `["claude","codex","gemini"]`. Espejo de `desktop.sqlite projects.providers`. Permite a core detectar el provider desde el registry en vez de sondear `.claude`/`.codex`/`.gemini` bajo el repo (ahora vacío). |
| `primaryProvider` | sí | `providers[0]`. Espejo de `desktop.sqlite projects.provider`. |
| `coreVersion` | sí | El pin `specrails-version` (nombre y formato **congelados** — desktop lo regex-matchea; solo su ubicación se mueve). |
| `createdAt` | no | Primera asignación de la entrada. |
| `lastInstallAt` | no | Última finalización de `init`/`update`. |
| `source` | sí | `"desktop"` \| `"core-standalone"`. Codifica el dueño único-en-cada-momento; gobierna la reconciliación (§5). |
| `desktopProjectId` | opcional | El `projects.id` UUID de desktop cuando `source:"desktop"`, para re-link robusto de mudanza de repo (§3). Aditivo; lectores antiguos lo ignoran. |

**Por qué se almacenan los sub-paths derivados explícitamente** en lugar de derivarlos de `artifactRoot`: core y desktop deben coincidir byte-a-byte en estos paths o una escritura y una lectura caen en sitios distintos. Escribiendo la ruta resuelta en el fichero, **el layout del escritor gana y el lector es layout-agnóstico** — exactamente la propiedad de robustez del snapshot `SPECRAILS_PROFILE_PATH`.

### 2.2 Ejemplo concreto

```json
{
  "schemaVersion": 1,
  "generator": "specrails-desktop@2.8.0",
  "updatedAt": "2026-06-18T10:42:11.004Z",
  "projects": {
    "/Users/javi/repos/acme-api": {
      "repoPath": "/Users/javi/repos/acme-api",
      "slug": "acme-api",
      "workspaceDir": "/Users/javi/.specrails/projects/acme-api/workspace",
      "artifactRoot": "/Users/javi/.specrails/projects/acme-api/workspace",
      "codeRoot": "/Users/javi/repos/acme-api",
      "stateDir": "/Users/javi/.specrails/projects/acme-api/workspace/.claude",
      "ticketsPath": "/Users/javi/.specrails/projects/acme-api/workspace/.specrails/local-tickets.json",
      "backlogConfigPath": "/Users/javi/.specrails/projects/acme-api/workspace/.specrails/backlog-config.json",
      "profilesDir": "/Users/javi/.specrails/projects/acme-api/workspace/.specrails/profiles",
      "pluginsStateDir": "/Users/javi/.specrails/projects/acme-api/workspace/.specrails/plugins",
      "fileSummariesDir": "/Users/javi/.specrails/projects/acme-api/workspace/.specrails/file-summaries",
      "providers": ["claude", "codex"],
      "primaryProvider": "claude",
      "coreVersion": "4.9.0",
      "createdAt": "2026-05-02T08:15:00.000Z",
      "lastInstallAt": "2026-06-18T10:42:11.000Z",
      "source": "desktop",
      "desktopProjectId": "b1f0…"
    },
    "/Users/javi/work/acme-web/services/acme-api": {
      "repoPath": "/Users/javi/work/acme-web/services/acme-api",
      "slug": "acme-api-2",
      "workspaceDir": "/Users/javi/.specrails/projects/acme-api-2/workspace",
      "artifactRoot": "/Users/javi/.specrails/projects/acme-api-2/workspace",
      "codeRoot": "/Users/javi/work/acme-web/services/acme-api",
      "stateDir": "/Users/javi/.specrails/projects/acme-api-2/workspace/.claude",
      "ticketsPath": "/Users/javi/.specrails/projects/acme-api-2/workspace/.specrails/local-tickets.json",
      "backlogConfigPath": "/Users/javi/.specrails/projects/acme-api-2/workspace/.specrails/backlog-config.json",
      "profilesDir": "/Users/javi/.specrails/projects/acme-api-2/workspace/.specrails/profiles",
      "providers": ["claude"],
      "primaryProvider": "claude",
      "coreVersion": "4.9.0",
      "createdAt": "2026-06-10T12:00:00.000Z",
      "lastInstallAt": "2026-06-10T12:03:30.000Z",
      "source": "core-standalone"
    }
  }
}
```

Las dos entradas son dos repos distintos que comparten el basename `acme-api` — el segundo recibió el sufijo de dedup `-2` (§2.4, edge case "mismo basename"). El primero lo creó desktop; el segundo, un `npx specrails-core init` standalone.

### 2.3 Keying: la realpath canónica

La **clave es la realpath canónica** del repo, calculada idénticamente en ambas herramientas:

```
abs   = path.resolve(repoPathInput)        // relativo → absoluto contra cwd
canon = realpathSafe(abs)                  // fs.realpathSync; si lanza, cae a abs
key   = normalizeKey(canon)                // §6: case-fold en macOS/Windows, conserva forma almacenada
```

desktop ya hace exactamente esto en `desktop-router.ts:canonicalizePath` (`fs.realpathSync`, fallback al path sin resolver si lanza). core ya resuelve `path.resolve(flags['root-dir'] ?? process.cwd())`. Los **symlinks colapsan al target real**, de modo que añadir `/Users/javi/link-to-acme` y `/Users/javi/repos/acme` (mismo target) mapea a una sola entrada.

### 2.4 Regla de acuerdo de slug (DEBE coincidir en ambas herramientas)

Hoy desktop deriva el slug del **nombre** del proyecto (`slugify(derivedName)`, `derivedName` por defecto = `path.basename(canonicalPath)`), **sin sufijo de dedup**, confiando en el `UNIQUE(slug)` de SQLite para hacer 409 ante colisión. Eso es insuficiente para un fichero compartido escrito por dos procesos independientes. El contrato fija un algoritmo **determinista, derivado del basename, con sufijo de dedup `-N`** que ambas herramientas implementan idénticamente:

```
function allocateSlug(canonicalRepoPath, existingSlugs):
    base = slugify(basename(canonicalRepoPath))      // mismo slugify que desktop-router.ts:24
    if base == "":  base = "project"                 // guard basename todo-símbolos
    if base not in existingSlugs:  return base
    n = 2
    while (base + "-" + n) in existingSlugs:  n += 1
    return base + "-" + n
```

- `slugify` es la función **existente** de desktop, byte-a-byte: `toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')` (`desktop-router.ts:24-26`). core la copia textualmente — es pequeña y estable; duplicarla es el patrón ya sancionado en el código (igual que `THEME_ID_ALLOWLIST` / `LANGUAGE_ID_ALLOWLIST`).
- `existingSlugs` = unión de (a) todo slug ya en `registry.json` y (b) — cuando desktop es el asignador — todo slug en `desktop.sqlite` (para que un registry momentáneamente atrasado respecto a la DB no reuse un slug vivo). core-standalone usa solo `registry.json`.
- **Derivar del basename, no del nombre**: hace que el slug sea una función determinista de la clave, así dos herramientas que ven el mismo repo calculan el mismo `base` y solo divergen en el sufijo `-N`, que el read-before-allocate resuelve.

**Cómo la SEGUNDA herramienta reusa el slug de la PRIMERA (read-before-allocate):** la asignación NUNCA ocurre sin leer primero el fichero bajo el lock y comprobar si la clave canónica ya tiene entrada. Si la tiene, se devuelve el `slug` existente sin recalcular. Una vez que *cualquiera* de las dos ha escrito una entrada, el slug queda **congelado para siempre** para ese repo. El loop de dedup solo corre para una clave genuinamente nueva, y corre bajo el lock para que dos asignadores concurrentes no reclamen ambos `acme-api-2`.

### 2.5 Regla de escritura atómica + lock

- **Exclusión mutua = lock-file advisory** `registry.json.lock` adquirido por creación exclusiva atómica (`fs.openSync(..., 'wx')`) con spin-retry acotado (p.ej. 50ms × hasta ~2s) y **ruptura de lock obsoleto** (si el mtime del lock supera un TTL, p.ej. 30s, se reclama — cubre un escritor crasheado). Ambas herramientas usan el mismo path y protocolo.
- **Toda escritura es temp-en-mismo-dir + fsync + rename atómico**, así un lector nunca ve un fichero a medio escribir **aun sin el lock** — el lock solo serializa *escritores*, el rename garantiza que los *lectores* ven un fichero completo viejo-o-nuevo.
- **Los lectores read-only NUNCA toman el lock.** Las lecturas de runtime de core (resolver `SPECRAILS_TICKETS_PATH` etc.) y el lado lector de desktop son lookups puros. Solo `init`/`update` (que crean/mutan el install) y el writer de proyección de desktop toman el lock.

---

## 3. Algoritmo de resolución repo → artefactos

Una única rutina compartida, `resolveArtifacts(repoPathInput, opts)`, que **ambas** herramientas ejecutan. core la implementa en un módulo nuevo `src/installer/util/registry.ts` que alimenta tanto los joins del instalador como las env-vars inyectadas en los prompts; desktop implementa la mitad escritora desde su DB (§6).

```
resolveArtifacts(repoPathInput, { allocate, allocator /* "desktop" | "core-standalone" */ }):
    # 1. Canonicalizar idénticamente en ambas herramientas.
    abs   = path.resolve(repoPathInput)
    canon = realpathSafe(abs)                  # fs.realpathSync; cae a abs si lanza
    key   = normalizeKey(canon)                # §6: case-fold por plataforma

    registryPath = path.join(HOME, ".specrails", "registry.json")

    # 2. Fast-path sin lock: lectura pura para un lookup.
    reg   = readRegistryOrEmpty(registryPath)  # parse total; {} si falta/corrupto/schema-mayor
    entry = reg.projects[key]
    if entry:                                  # ya asignada → reusar SIEMPRE (read y allocate)
        return entryToResolution(entry)

    if not allocate:
        # Lector sin entrada: fallback al layout legacy in-repo (artifactRoot = codeRoot).
        # Red de seguridad del core-version-gate / primer arranque.
        return legacyResolution(canon)

    # 3. Path de asignación: lock advisory, re-leer, doble-check, escribir atómico.
    withFileLock(registryPath + ".lock"):
        reg   = readRegistryOrEmpty(registryPath)
        entry = reg.projects[key]
        if entry:                              # alguien asignó entre el paso 2 y el lock
            return entryToResolution(entry)
        slug  = allocateSlug(canon, unionOfSlugs(reg, allocator))
        entry = buildEntry(key, canon, slug, allocator)   # rellena cada campo §2.1
        reg.projects[key] = entry
        reg.schemaVersion = 1
        reg.updatedAt     = now()
        atomicWrite(registryPath, reg)         # temp en mismo dir + fsync + rename
    return entryToResolution(entry)
```

Notas:
- **`readRegistryOrEmpty` es total y fail-open** — fichero ausente, error de parse, o `schemaVersion` mayor del entendido devuelven `{}`, así el caller lo trata como "sin entrada". Un core standalone contra un registry escrito por un desktop futuro NO debe crashear; asigna una entrada fresca que sí entiende (peor caso: un duplicado transitorio que desktop reconcilia). Esto **sesga hacia disponibilidad sobre consistencia estricta**, correcto para un fichero local inspeccionable.
- `legacyResolution(canon)` devuelve `artifactRoot = codeRoot = canon`, `ticketsPath = canon/.specrails/local-tickets.json`, etc. — el comportamiento exacto pre-relocalización. Es lo que hace cierto "sin definir ⇒ byte-idéntico legacy" y es el fallback cuando un desktop nuevo habla con un core viejo (y viceversa).

### 3.1 Repo movido / renombrado (la clave es el path → entrada huérfana)

Mover el repo en disco **huerfaniza** la entrada: una resolución para el path nuevo no encuentra nada y asignaría una entrada fresca (slug nuevo, workspace vacío), perdiendo silenciosamente el install antiguo.

- **desktop es la autoridad para el re-link** porque ya aprende el path nuevo (el usuario re-añade, o `GET /api/resolve?path=` resuelve un repo movido, o un affordance "este proyecto se movió"). Cuando desktop observa que un repo que rastrea (mismo `projects.id` en `desktop.sqlite`) tiene ahora un path canónico distinto, **reescribe la clave del registry in-place**: borra la clave vieja, inserta la misma entrada bajo la clave nueva con `repoPath`/`codeRoot` actualizados, **slug y `workspaceDir` sin cambios** (los artefactos `$HOME` no se mueven, solo el puntero al repo). Esto mantiene estable `~/.specrails/projects/<slug>/`, esencial porque `jobs.sqlite`/telemetría/etc. ya van keyados por slug. El `desktopProjectId` opcional permite hacer este match sin adivinar.
- **core-standalone no puede detectar fiablemente una mudanza** (no tiene id de proyecto persistente, solo el path). Para standalone, un repo movido simplemente asigna entrada nueva; la vieja se GC como obsoleta (§5). Aceptable porque standalone no tiene historial de jobs keyado por slug que preservar.

---

## 4. Layout final bajo `$HOME/.specrails/projects/<slug>/`

```
$HOME/.specrails/
├── registry.json                 # CONTRATO COMPARTIDO (desktop escribe, core lee/asigna)
├── registry.json.lock            # lock advisory (creación 'wx' + TTL de obsolescencia)
├── desktop.sqlite                # registro de proyectos de desktop (CANÓNICO, desktop-only)
├── jira-secret.key               # keyfile AES-256-GCM (0600), desktop-only
├── doctor.log                    # log append-only, core-only (única lectura $HOME de core hoy)
└── projects/<slug>/
    ├── workspace/                # = artifactRoot. cwd de jobs y Explore mcp=true relocalizados
    │   ├── .specrails/
    │   │   ├── local-tickets.json (+ .lock)   ← SPECRAILS_TICKETS_PATH        [core escribe/lee · desktop escribe]
    │   │   ├── backlog-config.json            ← SPECRAILS_BACKLOG_CONFIG_PATH  [desktop escribe · core lee]
    │   │   ├── specrails-version              (nombre CONGELADO)               [core]
    │   │   ├── specrails-manifest.json                                          [core]
    │   │   ├── install-config.yaml                                              [desktop escribe · core lee]
    │   │   ├── setup-templates/**                                               [core]
    │   │   ├── profiles/*.json (+ .user-preferred.json)  ← SPECRAILS_PROFILES_DIR [desktop · CARVE-OUT reservado]
    │   │   ├── plugins/{state.json,snapshots/}                                  [desktop-only]
    │   │   └── file-summaries/**                                                [desktop-only]
    │   ├── .claude/              ← SPECRAILS_STATE_DIR (base estado runtime)
    │   │   ├── agents/{sr-*.md, custom-<plugin>.md}        [core sr-* · desktop/plugins custom-* · CARVE-OUT]
    │   │   ├── commands/{sr,specrails}/**                  [core]
    │   │   ├── skills/**                                    [core]
    │   │   ├── rules/**                                     [core]
    │   │   ├── agent-memory/**                              [core runtime]
    │   │   ├── pipeline-state/**                            [core runtime]
    │   │   ├── health-history/**, compat-snapshots/**       [core runtime]
    │   │   └── backlog-cache.json, .dry-run                 [core runtime]
    │   ├── .codex/config.toml                               [core]
    │   ├── .gemini/{settings.json,agents/,commands/}        [core]
    │   ├── CLAUDE.md / AGENTS.md / GEMINI.md  (instrucción framework — autodescubierta por cwd) [core]
    │   ├── .mcp.json                                        [desktop/plugins · CARVE-OUT reservado]
    │   └── project -> <project.path>   (symlink/junction; project-path.txt fallback)
    ├── jobs.sqlite                                          [desktop-only]
    ├── jobs/<jobId>/{profile.json, plugins.json}  (snapshots chmod 400, YA $HOME) [desktop-only]
    ├── codex-home/              (CODEX_HOME per-proyecto)   [desktop-only]
    ├── user-mcp.json            (chmod 600)                 [desktop-only]
    ├── telemetry/<jobId>.ndjson.gz                          [desktop-only]
    └── terminals/<sessionId>/   (shims shell-integration)   [desktop-only]
```

**Carve-outs residentes en el repo (`codeRoot = project.path`):**

```
<project.path>/
├── openspec/                 # entregable de spec versionado, escrito por @fission-ai/openspec   [CARVE-OUT #1]
│   ├── changes/**
│   └── specs/**
├── .git/                     # object-store compartido por los worktrees
└── .claude/worktrees/**      # git worktrees (deben compartir .git)                              [CARVE-OUT #2]
```

> **Regla general de propiedad de path.** Todo lo que es un **artefacto propiedad de Specrails** (`.specrails/**`, `.claude/{agents,commands,skills,rules,agent-memory,…}/**`, `.codex/**`, `.gemini/**`, `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` de framework, `.mcp.json`) → **workspace**. Todo lo que es **el código fuente del usuario, git, coverage, o los registros de aprobación/MCP propios del usuario** → **se queda en `project.path`**.

---

## 5. Cambios en specrails-core

### 5.1 El split `codeRoot` vs `artifactRoot`

`ScaffoldInput` / `BuildManifestInput` ganan `artifactRoot`. Se recomienda **renombrar `repoRoot` → `codeRoot`** para forzar al compilador a marcar cada callsite no migrado. La resolución se hace una vez, al inicio de `runInit`/`runUpdate`/`runDoctor`, y el par `{ codeRoot, artifactRoot }` se hila por todo.

**Callsites del instalador que mueven base a `artifactRoot`** (grupos A–I de `scaffold.ts` ~40 sitios + `manifest.ts` + `update.ts` + `doctor.ts`):

- **A** — skeleton del provider dir (`scaffold.ts:251-267`).
- **B** — skeleton `.specrails/setup-templates/**` (`:268-275`).
- **C** — copia de templates + bundled commands (`:283-301`, `:368-438`); los `scriptDir` (paquete npx) **no cambian**.
- **D** — `placeQuickTierArtefacts` (`:836-1020`), incluidos los mkdir de `agent-memory`. Los **valores de placeholder** (`MEMORY_PATH`, `SECURITY_EXEMPTIONS_PATH`, `PERSONA_DIR`) se escriben *dentro* del prompt y se tratan en §5.3.
- **E** — `placeSkills` (`:1134-1210`).
- **F** — `placeGeminiAgents`/`writeGeminiAgentFromTemplate` (`:591-657`). **Especial**: `writeGeminiAgentAcknowledgments` (`:676-699`) keya `~/.gemini/acknowledgments/agents.json` en el repoRoot y hashea `<root>/.gemini/agents/<id>.md` — **tanto la clave como el path hasheado pasan a `artifactRoot`** (re-keying, no relocaliza el ack file global).
- **G** — settings codex/gemini + ficheros de instrucción (`applyCodexSettings :1038-1072`, `applyGeminiSettings :723-757`); `AGENTS.md`/`GEMINI.md` → `artifactRoot` (la CLI los autodescubre desde el cwd = workspace).
- **H** — manifest (`manifest.ts:78-79`): `specrails-manifest.json` + `specrails-version` → `artifactRoot`. **Nombres congelados** (desktop regex-matchea `specrails-version`), solo cambia el dir base. Los logs `path.relative(repoRoot, …)` → `path.relative(artifactRoot, …)`.
- **I** — `.gitignore` + prune (§5.4).
- **`detectExistingSetup`** (`:224-235`): los sondeos de provider-dir → `artifactRoot`; el sondeo `openspec` → **`codeRoot`** (carve-out).

### 5.2 El carve-out (lo que conserva `codeRoot`)

Explícitamente **se queda en `codeRoot`**:
1. **Invocación openspec** (`init.ts:193-233`): `openspec init --tools <provider> <repoRoot>` con `cwd: repoRoot` — **sin cambios**. openspec escribe `openspec/**` en el repo (entregable intencionado). El residuo de dirs de comandos que openspec deja en el repo (p.ej. `.claude/commands/opsx`) es residuo conocido y aceptado — openspec es un binario externo que no modificamos.
2. **Lecturas runtime de `openspec/changes/**` y `openspec/specs/**`** en prompts: cuando el cwd del rail es el workspace, los paths relativos `openspec/...` se reescriben como `${SPECRAILS_REPO_DIR:-.}/openspec/...` para resolver contra el repo.
3. **git worktrees**: las ops usan `git -C "$SPECRAILS_REPO_DIR"` para compartir el object-store.
4. **`CLAUDE.md` por-capa del usuario** (`{{LAYER_CLAUDE_MD_PATHS}}`, `sr-developer.md:83`) y scans de "Project README / CLAUDE.md" (`explore-spec.md:25`, `doctor.md:14`) — resuelven contra `${SPECRAILS_REPO_DIR:-.}`. **Hay que desambiguarlos** del `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` de framework que la CLI autodescubre desde el cwd = workspace.

### 5.3 Re-apuntado de lecturas en runtime — inyección de env-vars (RECOMENDADO sobre que los agentes lean `registry.json`)

**Decisión: inyectar env-vars en el spawn; NO hacer que los prompts markdown parseen `registry.json`.** Razones: (a) hay precedente ya en producción — `SPECRAILS_PROFILE_PATH` se lee **primero**, fallback repo-relativo **después** (`implement.md:70-91`); (b) pedir a un prompt en bash que parsee JSON, canonicalice su cwd, sha256ee e indexe es frágil e inverificable en ~8 templates; (c) el spawner (desktop, o un shim de core-standalone) ya conoce el workspace; (d) mantiene el legacy byte-idéntico (**sin definir ⇒ fallback repo-relativo**).

**Conjunto de env-vars (todas con default = fallback legacy):**

| Env var | Apunta a | Reemplaza el literal | Read-first / fallback |
|---|---|---|---|
| `SPECRAILS_TICKETS_PATH` | `<artifactRoot>/.specrails/local-tickets.json` | `.specrails/local-tickets.json` | env → repo-relativo |
| `SPECRAILS_BACKLOG_CONFIG_PATH` | `<artifactRoot>/.specrails/backlog-config.json` | `.specrails/backlog-config.json` | env → repo-relativo |
| `SPECRAILS_PROFILES_DIR` | `<artifactRoot>/.specrails/profiles/` | `.specrails/profiles/` | `SPECRAILS_PROFILE_PATH` (snapshot job, gana) → env → repo-relativo |
| `SPECRAILS_STATE_DIR` | `<artifactRoot>/.claude` (o `<artifactRoot>/state`) | `.claude/{agent-memory,pipeline-state,health-history,compat-snapshots,backlog-cache.json,.dry-run}` | env → `.claude` |
| `SPECRAILS_REPO_DIR` | `<codeRoot>` | `openspec/**`, `CLAUDE.md` del usuario, git/worktree | env → `.` (cwd) |
| `SPECRAILS_WORKSPACE_DIR` | `<artifactRoot>` (base instalador; también cwd de rails) | n/a (flag instalador) | flag/env → registry → asignar |

**La edición de mayor palanca** es la **tabla de placeholders `BACKLOG_*` de `enrich.md`** (`:501,848,1232-1239`) — es el template que GENERA el texto de file-ops inline de cada comando. Re-apuntar ahí los literales de tickets/backlog-config a `${SPECRAILS_TICKETS_PATH:-.specrails/local-tickets.json}` y `${SPECRAILS_BACKLOG_CONFIG_PATH:-.specrails/backlog-config.json}` **una vez** y todos los comandos downstream lo heredan. Luego, barrido exhaustivo de los literales restantes.

**Must-not-miss callsites** (un solo literal no migrado lee silenciosamente de la ubicación vacía equivocada y rompe el pipeline sin error):

- `local-tickets.json`: `implement.md:33,316,500,1212`; `propose-spec`/`get-backlog-specs`/`explore-spec`/`enrich`/`auto-propose`; rails `sr-architect`/`sr-developer`/`sr-reviewer`/`sr-product-*` en `templates/agents/*` + sus mirrors `templates/codex-skills/rails/*/SKILL.md`. **El `.lock` sigue la misma base.** Las líneas guard `Do NOT update .specrails/local-tickets.json` también deben referenciar el path resuelto o el guard deja de matchear el fichero real.
- `backlog-config.json`: `implement.md:29`; `enrich.md:160,280,502,851,1018,1260`; `propose-spec.md:50,52`; `auto-propose:70,199,265`. **Peligro**: la rama "default write_access=true cuando ausente" (`propose-spec.md:52`) debe disparar solo cuando **ambos** —el path resuelto por env Y el repo-relativo— estén ausentes; un env-var definido con fichero faltante significa "aún no escrito", no "default a write".
- `profiles/project-default.json`: `implement.md:71,90-91`; `batch-implement.md:37,194-195`. Ya env-first vía `SPECRAILS_PROFILE_PATH`; añadir un **escalón intermedio** `${SPECRAILS_PROFILES_DIR:-.specrails/profiles}/project-default.json`.
- **Templates lectoras puras** (rompen en silencio si solo el escritor relocaliza): `why.md:17` y `memory-inspect.md:43` (leen `agent-memory`), `retry.md:41,68` (lee `pipeline-state` que escribe `implement.md`), `compat-check.md` (baseline), `backlog-cache.json` (`get-backlog-specs.md:213` escribe, `implement.md:332,1210` lee+diff). Todas → `${SPECRAILS_STATE_DIR:-.claude}/…`.
- `health-history/` (`health-check.md`, `telemetry.md`, `vpc-drift.md`), `compat-snapshots/` (`compat-check.md`), dirs de marcador `.dry-run` → `${SPECRAILS_STATE_DIR:-.claude}/…`.

**Convergencia dual para standalone (sin spawner vivo):** además del `${ENV:-…}` en los templates, `scaffold.ts` sustituye los **paths absolutos resueltos** dentro de los cuerpos de prompt generados en tiempo de install vía placeholders nuevos `{{TICKETS_PATH}}`/`{{STATE_DIR}}`/`{{REPO_DIR}}`/`{{PROFILES_DIR}}`/`{{BACKLOG_CONFIG_PATH}}` — así los agentes colocados llevan paths concretos aun sin env en runtime; los snapshots por-job de desktop siguen ganando. Net: dos mecanismos independientes convergen (sustitución en install + `${ENV:-…}` en runtime).

### 5.4 `.gitignore` + `pruneLegacyArtifacts`

- **`ensureGitignore` (`:277-280`) pasa a no-op cuando `artifactRoot != codeRoot`** — nada propiedad de Specrails aterriza en el repo, no hay nada que ignorar. Guard: `if (artifactRoot === codeRoot) ensureGitignore(...)`.
- **`pruneLegacyArtifacts` (`:301,784-814`)** opera sobre `artifactRoot` y gana una **aserción dura: todo target de prune está dentro de `artifactRoot`/`$HOME`**; cualquier target que resolvería dentro de `codeRoot` se **salta**. Prune se vuelve un no-op estructural contra el repo del usuario. **Nunca `rmSync` dentro de `codeRoot`.**
- **Barrido in-repo no destructivo (opt-in):** `reportInRepoArtifacts(codeRoot)` **detecta** (no borra) artefactos in-repo preexistentes e imprime un aviso. La eliminación es opt-in tras un flag `--clean-repo` en `doctor`/`init`/`update`. `openspec/**` y worktrees **nunca** se listan para limpieza.

### 5.5 UX standalone (discoverability sin pointer en el repo)

1. **`init` imprime el workspace resuelto** encima del sentinel congelado `init complete` (que **no cambia** — desktop lo matchea byte-a-byte): `Installed specrails for <repo> → <artifactRoot>` + `Registry: ~/.specrails/registry.json`.
2. **`doctor` resuelve vía registry** y sondea provider-dir/agents/instrucción bajo `artifactRoot`; imprime `Workspace:` y `Code root:`. El check git sigue en `codeRoot`. Nuevo `doctor --where` imprime solo el workspace para scripting (`cd "$(specrails-core doctor --where)"`).
3. **`resolveExistingProvider`/`resolveInstalledProvider`** (`update.ts:196-211`, `doctor.ts:159-163`) detectan provider desde `artifactRoot` o, mejor, **leen el provider del manifest/registry** (más robusto).

### 5.6 Esfuerzo

Medio-alto y mecánicamente uniforme pero **exhaustivo**: el módulo `path-resolver` (net-new), el split `codeRoot/artifactRoot` en ~40 callsites del instalador, el barrido de ~8 templates de runtime + sus mirrors. El riesgo está concentrado en la exhaustividad, no en la dificultad conceptual — de ahí los tests guard (§9).

---

## 6. Cambios y contratos en specrails-desktop

El lado desktop ya tiene el precedente load-bearing en producción (`explore-cwd-manager.ts`), el árbol `$HOME` por-proyecto, el patrón env-pointer `SPECRAILS_PROFILE_PATH`/`SPECRAILS_PLUGINS_*`, y el registro slug↔repoPath en `desktop.sqlite`. El trabajo es **generalizar el explore-cwd en un `WorkspaceManager` universal**, **re-apuntar cada `path.join(project.path, '.specrails'|'.claude'|…)` al workspace**, y **escribir `registry.json`**.

### 6.1 cwd de spawn + env por provider

`ExploreCwdManager` se generaliza a un `WorkspaceManager` que materializa `~/.specrails/projects/<slug>/workspace/` con `./project -> <project.path>` (symlink/junction, fallback `project-path.txt` — la lógica existente `ensureProjectLink`). **Las AI-CLI relocalizadas usan el workspace salvo los procesos deliberadamente repo-bound y Explore con `mcp=false`, que conserva su `explore-cwd`.**

**Managers que MUEVEN cwd → workspace:** `QueueManager._startJob` (rails — el grande), `ChatManager` (sidebar + Explore con `mcp=true`), `AgentRefineManager` (ai-edit), `ContractRefineRunner` cuando refleja un Explore `mcp=true`, `project-router /tickets/generate-spec` (quick-spec), `FileSummaryManager`, `SetupManager.startInstall` (corre `npx specrails-core init --root-dir <project.path> --workspace-dir <workspace>`). Explore y Contract Refine con `mcp=false` permanecen en el app-managed `explore-cwd`.

**Managers que CONSERVAN cwd = `project.path`:** `TerminalManager` (shell repo-bound), `file-provenance.ts` (git repo-bound), `code-explorer-router` (lee fuente), lecturas de fuente de `FileSummaryManager`, `metrics.ts` (coverage).

**El split crítico de corrección:** `QueueManager` parte su `_cwd` único en `_workspace` (cwd de spawn) y `_codeRoot` (= `project.path`). Las llamadas de provenance/git (`queue-manager.ts:1169,1180` que hoy pasan `this._cwd`) **deben re-apuntarse a `_codeRoot`, NO al workspace** — si no, snapshotean un workspace vacío y rompen la atribución "touched by AI" del Code explorer **sin error**.

**Recipe de spawn por provider (cwd=workspace):**
- **claude**: autodescubre `.claude/{agents,commands,skills}` + `CLAUDE.md` + `.mcp.json` desde cwd — **sin flags nuevos en el happy path**. Añade `--add-dir <workspace>/project` para que las tools file alcancen el repo por path absoluto. Conserva `--setting-sources project,local`.
- **codex**: conserva `CODEX_HOME=~/.specrails/projects/<slug>/codex-home` (ya $HOME). Añade `-c project_root_markers=[]` (defensivo) para que no camine ancestros a un `AGENTS.md` repo-side.
  - **⚠️ Sandbox writable-roots (bug de loops, corregido):** el sandbox de codex solo permite **escribir** en su cwd de spawn. Bajo relocalización el cwd es el **workspace**, no el repo → escrituras al código fuente (alcanzado vía `./project`) fallan con `Operation not permitted`. Los rails de codex no lo sufren porque `rail-job` usa `--sandbox danger-full-access`; pero las **iteraciones de loop resume** (`chat-resume`) corren bajo `workspace-write` y quedaban sin acceso de escritura al repo, haciendo girar el ciclo verify→fix sin fin (12 iteraciones, 0 cambios). `--add-dir` es **claude-only** y codex ni siquiera lo soporta. **Fix** (`loop-executors.ts`): para codex relocalizado inyecta `-c sandbox_workspace_write.writable_roots=["<repoDir>", "<cwd>"]` en `extraArgs` (no-op inocuo bajo `danger-full-access` en la iteración 1).
  - **Smoke check (manual):** en un proyecto relocalizado con provider=codex, lanzar un loop "Implement" cuyo paso de fix deba editar una fuente del repo; confirmar en el transcript que (a) `apply_patch`/edit a `<repoDir>/...` **NO** devuelve `Operation not permitted`, y (b) `npm run build`/`tsc -b` puede escribir `node_modules/.tmp/*.tsbuildinfo`. Reproducción del fallo: revertir el `extraArgs` de codex → la edición del repo en la iteración ≥2 vuelve a fallar con `Operation not permitted`. Cubierto por `server/loop-executors.test.ts` (assert del arg `writable_roots`).
- **gemini**: inyecta `GEMINI_CLI_TRUST_WORKSPACE=true` (ancla el root confiable al workspace). **Re-keya** `~/.gemini/acknowledgments/agents.json` al workspace.
- Los tres: el workspace **estrictamente fuera del repo** y el discovery no debe seguir `./project` (mitiga la fuga por ancestor-walk de codex/gemini).
- **Caso especial Explore `mcp=true` (implementado):** `ChatManager` resuelve el cwd mediante la misma puerta de relocalización: workspace cuando el proyecto está relocalizado, `project.path` en legacy. Las rutas persistent-stdin, crash-respawn y Contract Refine conservan esa misma pareja cwd/env. Una sesión anterior creada bajo el cwd del repo que devuelve exactamente `No conversation found with session ID` se invalida y reintenta fresh una sola vez desde el workspace (transcript persistido acotado para Explore; ticket sembrado y tools deshabilitadas para Contract Refine), nunca volviendo al repo. `SPECRAILS_EXPLORE_LEGACY_CWD=1` sigue forzando `project.path`.

### 6.2 Sitios de re-apuntado de path (`project.path` → workspace)

`resolveArtifactRoot(slug) → <workspace>`; `project.path` sigue siendo `codeRoot`. Sitios: `ticket-store.ts:126` (+ el guard de traversal de `integration-contract.json` cuya raíz pasa al workspace), `ticket-watcher.ts:47`, `jira-materializer.ts:204,209,237`, `jira-backlog-config.ts:21`, `profile-manager.ts:93` (+ `projectSupportsProfiles` `queue-manager.ts:66-69`), `plugins/paths.ts` (+ `plugin-manager.ts`, `claude-md-mutation.ts:50`), `file-summary-manager.ts:111,119` (el append `.gitignore :160` pasa a **no-op**, las lecturas de fuente `:200,309,459` **se quedan** en `project.path`), `context-scope.ts:199`, `setup-manager.ts:137,164-165,248-250`, `desktop-router.ts:82-83` (sonda workspace **Y** project.path por migración), `profiles-router.ts`, `project-router-helpers.ts`. **Conservan `project.path`:** `plugins/claude-approval.ts` (registro de aprobación del usuario, keyado en el repo) y `metrics.ts` (coverage).

### 6.3 Protocolo `desktop.sqlite` ↔ `registry.json`

**`desktop.sqlite` es CANÓNICO; `registry.json` es una proyección slim, write-mostly que desktop emite desde su DB.** Nunca pueden divergir.

- **desktop → registry.json (escritura):** nuevo `server/registry-mirror.ts` con `upsertRegistryEntry(project)` / `removeRegistryEntry(repoRoot)`, llamado en `addProject` (tras insert OK), `ProjectRegistry.removeProject` (tras delete + `removeExploreCwd`), cambio de provider/path. **Reconciliación al arranque:** el constructor de `ProjectRegistry` reescribe `registry.json` completo desde `desktop.sqlite` — así un hand-edit o una escritura parcial crasheada se auto-curan. desktop **nunca** lee sus propios datos de vuelta del registry.
- **core ← registry.json (lectura), con un carve-out de escritura:** core lee para cada resolución install-time y runtime. core solo ESCRIBE cuando es el *asignador* (standalone `init` sin entrada previa, `source:"core-standalone"`) o al refrescar `coreVersion`/`providers`/`lastInstallAt` de la entrada que está instalando. core **NO** debe reescribir `slug`/`key`/`workspaceDir`/path-fields de una entrada existente.
- **Standalone-luego-importado (caso anti-divergencia):** cuando desktop importa después un repo que core ya asignó standalone, desktop encuentra la entrada `source:"core-standalone"` por clave canónica, **adopta su slug** (lo escribe en `desktop.sqlite` en vez de asignar uno nuevo), voltea `source:"desktop"`, adjunta `desktopProjectId`, y desde ahí lo posee. El slug nunca cambia; el `~/.specrails/projects/<slug>/` que el install standalone pobló se reusa intacto.

La regla que evita divergencia: **para cualquier repo, exactamente un escritor es el dueño en cada momento** — desktop una vez conoce el proyecto, core solo mientras un repo standalone es desconocido para desktop. `source` codifica la propiedad; la adopción es un flip de un solo sentido core→desktop. Dos desktops en máquinas distintas nunca comparten `$HOME` ⇒ no hay divergencia cross-máquina.

### 6.4 Precedencia env-pointer en el spawn

A nivel de rail, desktop inyecta `SPECRAILS_WORKSPACE_DIR`, `SPECRAILS_STATE_DIR`, `SPECRAILS_TICKETS_PATH`, `SPECRAILS_BACKLOG_CONFIG_PATH`, `SPECRAILS_REPO_DIR` (= `project.path`), junto a los ya existentes `SPECRAILS_PROFILE_PATH`/`SPECRAILS_PLUGINS_*`/OTEL. Esto hace `registry.json` el **fallback** del core standalone (sin env) y las env-vars el **fast path** de los spawns de desktop — no pueden discrepar porque desktop deriva el env del mismo workspace que escribió en `registry.json`.

### 6.5 file-provenance / code-explorer (sigue repo-bound)

`file-provenance.ts` (que ya despoja `GIT_DIR`/`GIT_WORK_TREE` y fija git a su cwd pasado) **no necesita cambios** — solo el argumento del caller en `QueueManager` (`this._cwd` → `_codeRoot`). Lecturas de fuente de `code-explorer-router` y de `FileSummaryManager` se quedan en `project.path`; los **outputs** de summary relocalizan.

---

## 7. Contratos que cambian

| Contrato | Estado hoy | Cambio requerido | Riesgo |
|---|---|---|---|
| **Jira "ZERO core changes"** (CLAUDE.md / `jira-backlog-config.ts`) | "Desktop es la capa de sync; core intacto" apoyado en `local-tickets.json`+`backlog-config.json` repo-relativos que core lee de un path fijo del repo. | **RE-ENUNCIADO**: "core lee el `local-tickets.json`/`backlog-config.json` relocalizado vía `SPECRAILS_TICKETS_PATH`/`SPECRAILS_BACKLOG_CONFIG_PATH` (env-first) o `registry.json` (fallback). `write_access:false` sigue forzando la rama read-only; el outbox + `applyJobOutcomeToTickets` de desktop siguen siendo la única autoridad de estado." Ya **no** es "zero core changes". | **ALTO** — si el config relocalizado no se encuentra, core dispara su default `write_access=true` y empieza a mutar, defaiteando el contrato read-only. Mitigación: el pointer debe resolver **antes** de que dispare el default; desktop **siempre** inyecta `SPECRAILS_BACKLOG_CONFIG_PATH`; test de integración que asserta que un proyecto Jira nunca re-entra a la rama de escritura. |
| **`local-tickets.json` ubicación** | `<repo>/.specrails/local-tickets.json` (+ `.lock`), leído por todos los rails + comandos. | Base → `<workspace>/.specrails/`. Todo literal en prompts → `${SPECRAILS_TICKETS_PATH:-…}`; el `.lock` y las líneas guard siguen la misma base. | **ALTO** — un literal no migrado lee de ubicación vacía y rompe el pipeline en silencio. |
| **`backlog-config.json` ubicación** | `<repo>/.specrails/backlog-config.json`, leído por core (switch read-only). | Base → `<workspace>/.specrails/`; resolución env → registry → repo-relativo. Default-write solo si **ambos** paths ausentes. | **ALTO** — ver fila Jira. |
| **Reserved-paths** (`.specrails/profiles/`, `.claude/agents/custom-*`) | "Activos de equipo commiteables; core nunca los toca en `init`/`update`." | Semántica persiste **relativa a `artifactRoot`** (workspace), no al repo. Actualizar el wording de CLAUDE.md. | **MEDIO** (producto) — profiles/file-summaries/`.mcp.json` **pierden** la propiedad de "activo de equipo commiteable"; git-export diferido (decisión #3, aceptada). |
| **`integration-contract.json`** | `schemaVersion "3.0"`; `configSchema.file` y `ticketProvider.storagePath` repo-relativos. | **Bump `"3.0" → "4.0"`** (breaking). Bloque nuevo `artifactLocation` (registry path/schema, `--workspace-dir`/env, contrato de env runtime, `repoResident` carve-outs). `storagePath` ahora artifactRoot-relativo; el guard de traversal de desktop usa la raíz workspace. | **MEDIO** — consumidores que hardcodearon paths `.specrails/...` repo-relativos deben actualizar. |
| **Core-version gate** (NUEVO, load-bearing) | No existe. | desktop exige un core que soporte `--workspace-dir` + env-pointers (espejo del gate `>= 4.1.0` de profiles, `projectSupportsProfiles`). Contra core viejo: fallback a cwd=`project.path`, sin `--workspace-dir` ni env (legacy byte-idéntico) + banner de upgrade. | **ALTO** — sin el gate, desktop nuevo + core viejo vuelca artefactos en el repo (el core viejo ignora el flag desconocido). |
| **Mobile wire** (`specrailshub`, `hub.*`, `hubInstanceId`, `hub_daily_budget_exceeded`) | Contrato congelado consumido por la app móvil v1. | **NINGUNO — confirmado no afectado.** El wire móvil codifica strings de identidad/wire, **no** paths de fichero de artefactos. | **NULO.** |
| **WS/REST público** | Endpoints devuelven `project.path` (raíz del repo); ZIP de diagnóstico y árbol `code` devuelven paths relativos a `project.path` (fuente). | **NINGUNO.** El repo sigue en `project.path`; ningún API público devuelve paths `.specrails`-relativos. El único consumidor interno de paths de artefacto es desktop. | **BAJO.** |
| **`SPECRAILS_PROFILE_PATH` / snapshots plugins** | Snapshot job en `~/.specrails/projects/<slug>/jobs/<jobId>/` (ya $HOME, chmod 400). | **CONFIRMADO NO AFECTADO** más allá de que el `profilesDir`/`pluginsDir` *fuente* (catálogos, no snapshots) se mueva al workspace. Es el template del patrón env-pointer nuevo. | **NULO.** |

---

## 8. Carve-outs y por qué

**`openspec/**` se queda en el repo** porque es el **entregable de spec versionado** del proyecto, escrito por el binario externo `@fission-ai/openspec` invocado como `openspec init --tools <provider> <repoRoot>` con `cwd: repoRoot`. No modificamos openspec; está diseñado para escribir un árbol de trabajo repo-relativo (`openspec/changes/**`, `openspec/specs/**`) que se commitea como cualquier otro código. Relocalizarlo rompería su contrato externo y separaría el spec de su historial git. Las lecturas runtime de los rails se resuelven contra `${SPECRAILS_REPO_DIR:-.}/openspec/...`.

**Los git worktrees se quedan en el repo** porque **deben compartir el `.git`/object-store** del repo para que el merge-back funcione. Un worktree creado fuera del object-store del repo no puede mergear de vuelta — corrompería silenciosamente los merges de rails multi-feature. Las ops de worktree usan `git -C "$SPECRAILS_REPO_DIR" worktree …` de modo que, aunque el cwd de spawn sea el workspace, git opere contra el `.git` real.

Estos dos son los **únicos** residentes en el repo permitidos. Todo lo demás —artefactos de framework, estado runtime, tickets, config, profiles, plugins, summaries, ficheros de instrucción— vive bajo `$HOME` (decisión #4).

---

## 9. Plan de migración + gate de versión

### 9.1 Migración de installs in-repo existentes (no destructiva, copy-never-move)

Los installs existentes tienen artefactos en `codeRoot/.specrails`, `codeRoot/<providerDir>`, etc. La migración **honra "nunca modificar el repo"**:

1. En el **próximo `init`/`update`** (core) o al **cargar el registry / primer job tras upgrade** (desktop): resolver/asignar la entrada del registry.
2. **Copiar (nunca mover)** el subconjunto propiedad-de-app que el scaffold NO regenera: `local-tickets.json`, `backlog-config.json`, `profiles/*.json` + `.user-preferred.json`, `plugins/state.json`, `file-summaries/`, `install-config.yaml`. core ofrece `migrateInRepoArtifacts(codeRoot, artifactRoot)` idempotente (salta ficheros ya presentes en `artifactRoot`); desktop ofrece `migrateProjectArtifactsToHome(slug)`.
3. (Phase B) re-correr `npx specrails-core init --root-dir <project.path> --workspace-dir <workspace>` para regenerar los artefactos canónicos en `$HOME` y (re)escribir la entrada del registry.
4. desktop marca un flag por-proyecto `artifacts_relocated` en `desktop.sqlite`; lecturas subsecuentes usan el workspace.
5. Los ficheros in-repo se **dejan en sitio, inertes**. El affordance `--clean-repo` (core) / "limpiar ficheros viejos de Specrails del repo" (desktop) es **lo único que muta el repo, nunca automático**. `openspec/**` y worktrees **nunca** se listan.

### 9.2 GC de entradas obsoletas

`registry.json` **nunca** se auto-GC en lectura (un volumen desmontado / repo en disco externo no debe ser desalojado). desktop hace GC lazy de entradas `source:"desktop"` huérfanas (proyecto removido en la UI). Entradas `source:"core-standalone"` cuyo `repoPath` ya no existe se podan **solo** vía `specrails-core doctor --prune` explícito. Borrar una entrada del registry **nunca** borra los datos `~/.specrails/projects/<slug>/`.

### 9.3 Gate de versión en lockstep (load-bearing)

desktop **debe** gatear el paso de `--workspace-dir` + env-pointers sobre `specrails-core >= <relocation-version>` (espejo del gate `>= 4.1.0` de profiles). Un desktop nuevo contra un core **viejo** que no entiende `--workspace-dir` volcaría artefactos en el repo (el core viejo ignora el flag desconocido). Por tanto desktop **no debe** enviarlo y debe caer a su comportamiento in-repo actual hasta que el core del usuario se actualice. **El número de versión exacto se elige y pinea en ambos repos simultáneamente** una vez core publique el soporte — es una pregunta abierta para firmar (§10).

---

## 10. Riesgos y preguntas abiertas para firmar

### 10.1 Dos ítems de PoC aún pendientes (load-bearing — bloquean el modelo)

1. **¿claude registra y EJECUTA subagentes project-scope `sr-*` nativamente desde cwd=workspace cuando `./project` es un symlink al repo?** Esta es la asunción load-bearing de toda la relocalización de rails (Opción 1 de la evaluación). Si claude no descubre los `sr-*` desde el workspace, la relocalización de rails es inválida y hay que repensar el spawn de rails **antes** de cualquier cambio de core. **PoC requerido.**
2. **¿`@fission-ai/openspec init` acepta un target que sea el workspace (fuera del repo, posiblemente sin `.git`) o requiere `repoRoot`?** El carve-out asume que openspec sigue apuntando a `repoRoot` con `cwd: repoRoot`; confirmar que las lecturas openspec de los rails resuelven contra `project.path` cuando cwd=workspace (vía `${SPECRAILS_REPO_DIR:-.}`/`--add-dir`). **PoC requerido.** (Relacionado: ¿`git -C <project.path> worktree-add` funciona correctamente cuando el cwd del proceso spawneador es el workspace? — tercer PoC recomendado para los worktrees.)

### 10.2 Preguntas abiertas de diseño

- **`SPECRAILS_STATE_DIR` base:** ¿un `<artifactRoot>/state/` dedicado (más limpio, provider-agnóstico) o reusar `<artifactRoot>/.claude` (menor diff, pero acopla el estado runtime al dir del provider claude y es incómodo para rails codex/gemini)? Recomendación: dir dedicado con fallback `${SPECRAILS_STATE_DIR:-.claude}`. **Decisión necesaria** (afecta el layout de telemetry/health-history/compat-snapshots).
- **Materialización del workspace en standalone:** ¿core debe materializar él mismo el workspace + symlink `./project` (generalizando el `explore-cwd-manager` de desktop), o asume que el spawner lo creó? Para un `npx specrails-core init` standalone limpio, core probablemente debe crear `artifactRoot` él mismo — pero si también crea el symlink y pone cwd=workspace (Phase B) o deja cwd=repo para standalone está sin resolver.
- **Provider detection:** ¿leer el provider del manifest/registry (robusto) o seguir sondeando `.claude`/`.codex`/`.gemini` bajo `artifactRoot` (espejo de hoy)? Recomendado el manifest, cambia ligeramente el contrato de detección.
- **Rutinas compartidas byte-idénticas:** ¿publicar canonicalize/slugify/lock/normalizeKey como un paquete npm versionado consumido por ambos repos (single source, pero añade dependencia de release-lockstep), o duplicarlas byte-a-byte (el patrón ya usado para `THEME_ID_ALLOWLIST`/`LANGUAGE_ID_ALLOWLIST`, sin dependencia nueva pero con riesgo de drift)? La corrección del contrato depende de que sean idénticas.
- **Semántica exacta del lock advisory** (`open(path,'wx')` + spin-retry + ruptura por TTL de mtime) sobre un `$HOME` montado por red (NFS/SMB) donde la atomicidad de O_EXCL y la granularidad de mtime son más débiles — o si se requiere que `$HOME` sea local.
- **¿Necesita core-standalone escribir `registry.json` en v1?** ¿O se difiere la primera escritura standalone a un writer desktop-only, con core read-only + fallback legacy hasta importarse? La decisión #2 dice que core puede escribir standalone, pero minimizar la superficie de escritura de core elimina la carrera de dos-escritores por completo.
- **`artifactRoot` con `/workspace`** ahora (layout Phase B) vs igual a `workspaceDir` para un rollout Phase-A read-only — ¿per-entrada (permitiendo migración por fases)? El esquema soporta ambos; el orden de migración necesita decisión de producto.
- **Número de versión exacto de core para el gate** (espejo del `>= 4.1.0`) — debe fijarse una vez core publique `--workspace-dir` + `SPECRAILS_*`, en ambos repos simultáneamente.
- **Residuo `opsx` de openspec:** `@fission-ai/openspec init` escribe dirs de comandos provider (p.ej. `.claude/commands/opsx`) en el repo como efecto colateral. El carve-out cubre `openspec/**`, ¿es aceptable ese residuo `opsx` en el `.claude/` del repo, o debe relocalizarse (lo cual openspec, binario externo, no puede)?
- **Lanzamiento "Open AI CLI" del terminal:** lanza un provider CLI desde cwd=`project.path` (shell repo-bound). ¿Necesita la config relocalizada del workspace, o es aceptable un lanzamiento ad-hoc repo-cwd para esa superficie interactiva?
- **Confirmación de producto** de que perder "activo de equipo commiteable" para profiles/file-summaries/`.mcp.json` es aceptable en v1 con git-export diferido (decisión #3 dice que sí, pero los workflows de `.gitignore`-share de file-summary y commit-de-equipo de profiles son features documentadas que se retiran).

---

## Apéndice: invariantes de corrección (deben testearse)

1. Tras un ciclo completo setup + rail job con relocalización activa, el **working tree del repo queda byte-inalterado** salvo `openspec/changes/**` y worktrees gitignored (assert vía `git status`).
2. El cwd de spawn del rail es el workspace; las llamadas git de provenance corren contra `project.path` (el split).
3. Los proyectos en modo Jira **nunca** re-entran a la rama de escritura de core post-relocalización (backlog-config resuelve antes del default write-enabled).
4. `desktop.sqlite` y `registry.json` se reconcilian al arranque; un `registry.json` hand-editado se auto-cura.
5. Proyectos single- y multi-provider resuelven su workspace correctamente (el workspace es per-proyecto, no per-provider; codex conserva su `CODEX_HOME`).
6. **Round-trip del registry**: asignar standalone → re-resolver → idempotente; desktop-pre-escribe-luego-core-lee → sin segunda asignación.
7. **Lint de literales de template**: un test unitario que grepea `templates/**` por literales `.specrails/local-tickets.json` / `.claude/agent-memory/` residuales NO envueltos en `${SPECRAILS_*:-…}` ni en un `{{TOKEN}}`, fallando el build si alguno se cuela. El seguro más barato contra el fallo "lee silenciosamente la ubicación vacía equivocada".
