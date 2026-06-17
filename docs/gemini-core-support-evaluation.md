> Documento de planificación. Generado 2026-06-17 mediante auditoría multi-agente del repo real `/Users/javi/repos/specrails-core` + verificación de fuentes primarias de gemini-cli. Complementa `docs/gemini-cli-provider-study.md` (desktop) — esta evalúa el trabajo en **specrails-core** para habilitar rails/implement en Gemini.

---

# Evaluación: ¿Hay que tocar specrails-core para Gemini CLI?

> **Veredicto en una línea:** Sí, **obligatoriamente hay que tocar core** para que `implement`/`batch-implement` (rails) funcionen en Gemini. El desktop por sí solo (PR-A/PR-B + `gemini-adapter.ts`) cubre **solo** spec/explore/quick. El pipeline architect→developer→reviewer **es expresable sin rediseño de fases** en el modelo plano de Gemini, pero **sin un target gemini en core no hay agentes ni comandos ni skills que ejecutar**, así que los rails en gemini hoy son inejecutables.

---

## 1. Respuesta directa: ¿hay que tocar core?

**Sí, para los rails. No, para spec/explore/quick.** El corte es exacto y limpio:

### Ya funciona HOY sin tocar core (solo desktop adapter)
El desktop tiene `server/providers/gemini-adapter.ts` registrado (`server/providers/index.ts:12,16`), con `projectDirName: '.gemini'`, `instructionsFilename: 'GEMINI.md'`, `nativeCostUsd: false` (gemini-adapter.ts:225-235). Esto cubre las superficies que **NO dependen de artefactos instalados en el repo**:
- **Explore Spec** — spawnea gemini desde `explore-cwd/` con un `CLAUDE.md`/system-prompt embebido por el desktop; no lee `.gemini/*`.
- **Quick spec** (`POST /tickets/generate-spec`) — turno suelto, system prompt inyectado por el desktop.
- **Sidebar chat** — idem.

Estas tres superficies inyectan su propio prompt y no resuelven slash-commands ni subagentes del proyecto. Por eso el adapter desktop basta.

### EXIGE core (sin esto, los rails en gemini no arrancan)
`implement` y `batch-implement` **no son prompts** que el desktop inyecte: son **artefactos instalados en el repo** que el orquestador resuelve nativamente. El desktop solo pasa el comando resuelto al binario (`queue-manager.ts` `buildArgs('rail-job', …)`), y el binario espera encontrar en disco:
1. **Comandos** `implement` / `batch-implement` (en formato gemini: `.gemini/commands/*.toml`).
2. **Agentes** `sr-architect`/`sr-developer`/`sr-reviewer` (en `.gemini/agents/*.md` con frontmatter).
3. **Skills/comandos OpenSpec** (`opsx:*`) instalados por `openspec init --tools gemini`.
4. **`GEMINI.md`** (instrucciones de proyecto) + settings.

**Core no emite NADA de esto para gemini** — verificado: `grep -rni gemini` sobre `src/`, `templates/`, `integration-contract.json` devuelve **0 matches**. El tipo `Provider` es un set cerrado `'claude' | 'codex'` que **rechaza** cualquier otro valor en `install-config.ts:96` (`unsupported provider '...'`). Por tanto, hoy un proyecto gemini no puede ni siquiera instalarse: el handshake desktop→core (desktop escribe `provider:` en `install-config.yaml`, `setup-manager.ts:906`; core valida en `install-config.ts:96` e `init.ts:86`) **falla en duro** con "unsupported provider 'gemini'".

**Conclusión inequívoca:** spec/explore/quick = solo desktop, ya hecho. Rails (implement/batch-implement + agentes + skills + OpenSpec) = **bloqueado en core**, requiere un target gemini.

---

## 2. Cómo emite core hoy por proveedor

El flujo real de instalación: `init.ts` → `provider-detect.derivedPaths(provider)` → `scaffold.scaffoldInstallation` → `installOpenSpecProject`.

### Detección/selección de proveedor (todo cerrado a 2 literales)
- **Tipo:** `Provider = 'claude' | 'codex'` declarado en DOS sitios que deben coincidir: `provider-detect.ts:15` e `install-config.ts:13`.
- **Detección:** `detectAvailability()` solo sondea claude/codex en PATH — verificado verbatim:
  ```ts
  const [claude, codex] = await Promise.all([commandExists('claude'), commandExists('codex')])
  return { claude, codex }
  ```
  (`provider-detect.ts:33-36`).
- **Validación dura:** `install-config.ts:96` rechaza ≠ claude/codex; `init.ts:86` rechaza el flag `--provider`; `bin/tui-installer.mjs:114/118`.

### Dónde divergen claude vs codex
Toda la divergencia es **imperativa, `if (input.provider === 'codex')`**, no hay registry/adapter (contraste con el `ProviderAdapter` del desktop). Sitios clave en `scaffold.ts`:
- **Convención de paths** centralizada en `derivedPaths` — verificado verbatim: codex → `{ '.codex', 'AGENTS.md' }`, else → `{ '.claude', 'CLAUDE.md' }` (`provider-detect.ts:87-92`).
- Esqueleto de directorios (`scaffold.ts:174-184`): claude `.claude/commands/specrails` + `.claude/skills`; codex `.codex/skills/{enrich,doctor,rails}`.
- Colocación de comandos (`copyBundledCommands`, `scaffold.ts:278-311`): claude copia `.md` verbatim; codex porta cada comando a `.codex/skills/<name>/SKILL.md` vía `writeCodexSkillFromCommand` (rewrite `.claude/`→`.codex/`, `/specrails:x`→`$x`) salvo que exista override en `templates/codex-skills/<name>/`.
- Agentes (`scaffold.ts:493-648`): claude coloca `.claude/agents/sr-*.md` + memory dirs; codex **salta agentes** y usa rail-skills en `.codex/skills/rails/`.
- Skills (`placeSkills`, `scaffold.ts:762-830`): claude **genera** `sr-*` skills desde el cuerpo del comando (`SKILL_FROM_COMMAND`, `scaffold.ts:46-82` + `writeClaudeSkillFromCommand`); codex copia `templates/codex-skills/rails/`.
- Settings (`scaffold.ts:244-250`): codex-only `applyCodexSettings` escribe `.codex/config.toml` + `AGENTS.md` con bloque sentinel-managed (`renderInitialAgentsMd`, `scaffold.ts:666-747`). Claude **no** tiene settings-writer aquí (su `CLAUDE.md` no lo escribe el instalador, solo lo chequea `doctor.ts:91`).

### Cómo se instala OpenSpec (esto SÍ es ya per-provider)
`installOpenSpecProject(repoRoot, provider)` (llamado solo en `init.ts:128`, **no** en update) shellea — verificado verbatim:
```ts
args: ['--yes', '-p', `@fission-ai/openspec@${pinnedVersion}`, '--',
       'openspec', 'init', '--tools', provider, repoRoot]
```
(`init.ts:204-218`, pin `1.3.1` desde `pinned-versions.json:3`). **Pasa `provider` DIRECTO a `--tools`.** Esto significa que la capa OpenSpec **no es el bloqueante**: `openspec init --tools gemini` es nativamente soportado por openspec 1.3.1 (genera `.gemini/commands/opsx` + `.gemini/skills/openspec-*` + el dir agnóstico `openspec/{specs,changes}`). En cuanto core propague el literal `gemini` a esta llamada (pasos 1+3 abajo), OpenSpec hace lo correcto **sin cambios de código**.

---

## 3. El target gemini en core: qué emitir, transform vs autoría nueva, additividad

### Qué debe emitir
| Artefacto | Formato gemini | Origen |
|---|---|---|
| `implement`, `batch-implement` (+ resto comandos) | `.gemini/commands/specrails/*.toml` — **solo `prompt` + `description`**, sin `tools`/`model` | **Transform** de `templates/commands/specrails/*.md` (reusar el cuerpo, re-envolver en TOML) |
| `sr-architect/developer/reviewer` (+ opcionales) | `.gemini/agents/sr-*.md` con **YAML frontmatter** que SÍ lleva `model` + `tools` | **Transform** de `templates/agents/sr-*.md` (markdown ya compatible; ajustar frontmatter + `MEMORY_PATH`→`.gemini/agent-memory/`) |
| `GEMINI.md` + settings | `GEMINI.md` con bloque sentinel + `.gemini/settings.json` (con `experimental.enableAgents`) | **Autoría nueva** — clon de `applyCodexSettings`/`renderInitialAgentsMd` (`scaffold.ts:666-747`) |
| OpenSpec (`opsx:*`) | `.gemini/commands/opsx/*` + `.gemini/skills/openspec-*` | **Sin cambios** — lo emite `openspec init --tools gemini` |

### Transform vs autoría — la asimetría es **decisiva** y la dicta el formato gemini
El veredicto verificado fija la regla: **commands TOML solo aceptan `prompt`+`description`** (sin `tools`/`model` por comando), pero **subagents `.md` SÍ aceptan `tools`+`model` en frontmatter**. Consecuencia de arquitectura para el scaffold:

> El **model-routing y el tool-gating** que hoy viven embebidos en `implement.md` (bloque ORCHESTRATOR_MODEL ~líneas 160-171 + overrides por agente) **deben migrar al frontmatter de los `.gemini/agents/sr-*.md`**, NO al comando TOML.

Mapeo correcto: orquestador → `.gemini/commands/specrails/{implement,batch-implement}.toml` (solo prompt+description); roles → `.gemini/agents/sr-*.md` (con `model:`, `tools:`). Esto **espeja el split de codex** (comando-vs-skill) pero con el primitivo de subagente nativo de gemini en vez de `spawn_agent`.

**Neto:** es una **mezcla** — cuerpos de comandos y agentes son **transforms mecánicos** de los templates claude existentes; el **emisor TOML** (`writeGeminiCommandFromCommand`, análogo a `writeCodexSkillFromCommand`), el **escritor `GEMINI.md`/settings**, y el **plumbing de tipo/detección** son **autoría nueva**. Lo más limpio: añadir `templates/gemini-skills/` (o `templates/gemini-*`) como dir de override para lo que el transform mecánico produzca mal, igual que `templates/codex-skills/`.

### Cómo se añade de forma aditiva sin romper claude/codex
Es aditivo en **semántica** (cada branch es `=== 'codex'` / else-claude; añadir un brazo `=== 'gemini'` deja los paths existentes byte-idénticos; el allow-list de validación solo se ensancha, nunca rechaza configs previas válidas), pero **NO aditivo en código** (no hay abstracción → hay que editar cada sitio). Cambios concretos (~7 archivos + nuevo árbol de templates):
1. Ensanchar `Provider` en `provider-detect.ts:15` **y** `install-config.ts:13` (deben quedar idénticos); relajar validadores `init.ts:86`, `install-config.ts:96`, `bin/tui-installer.mjs:114/118`.
2. `detectAvailability` (`provider-detect.ts:33-36`): añadir `commandExists('gemini')`; extender `resolveProvider` (61-80) + el mensaje de error que hoy solo nombra Claude+Codex.
3. `derivedPaths` (`provider-detect.ts:87-92`): brazo gemini → `{ '.gemini', 'GEMINI.md' }`.
4. `scaffold.ts`: brazos gemini en cada `=== 'codex'` (dir skeleton 174-184, colocación comandos 278-325, quick-tier 493-648, `placeSkills` 762-830, prune 454-462) + `applyGeminiSettings` clon de `applyCodexSettings`.
5. `prereqs.ts:91-104`: gatear el bloque claude-only o dar a gemini un path mínimo (sin auth-assert, como codex).
6. `doctor.ts:96/160/167` + `update.ts:196-210` (`resolveExistingProvider` probe `.gemini`).
7. `integration-contract.json:3-26`: bloque `providers.gemini` (la superficie casi-declarativa que lee el desktop; la de menor fricción).
8. OpenSpec: **cero cambios de código** más allá de propagar `gemini` (pasos 1+3 → ya llega a `init.ts:215`).

---

## 4. El bloqueante de orquestación: ¿plano de gemini lo soporta?

**Veredicto honesto (verificado contra fuentes Google primarias): el pipeline ES expresable en el modelo plano de gemini SIN rediseño de fases.** No es un blocker de capacidad; es trabajo imperativo en core.

Razonamiento (todo confirmado):
- El pipeline es **recursivo pero SHALLOW**: el orquestador spawnea architect→developer→reviewer a **profundidad 1**; las hojas **nunca re-spawnean** (un developer no llama a un reviewer; lo único "hacia abajo" es un `Skill("opsx:ff/apply/archive")` **in-context**, que shellea al CLI `openspec`, **no es un subagente**). Contrato verbatim: `implement.md:5` "delegate to the agents"; `implement.md:547` spawn de sr-architect; codex `implement/SKILL.md:24` "Each phase MUST be a real spawn_agent call".
- El modelo de gemini es exactamente eso: orquestador delega depth-1, subagentes **FLAT** (`docs/core/subagents.md` verbatim: "subagents cannot call other subagents"). La restricción plana (las hojas no spawnean) **nunca se viola** porque todo el spawning requerido ocurre en el orquestador a depth-1.
- **El único rediseño** es `batch-implement`, que conceptualmente anida (batch→implement→roles = depth 2), ilegal en plano. **Pero el proyecto YA lo resolvió para codex**: `codex-skills/batch-implement/SKILL.md:5` "Drives architect/developer/reviewer spawns at the ROOT agent level — does NOT spawn a nested $implement sub-agent per ticket". El batch-implement gemini **reutiliza esa misma disciplina de aplanamiento ya probada**.

**Por tanto: NO hay rediseño del pipeline de fases. La viabilidad de rails en gemini está gateada por el trabajo imperativo en core, no por un gap de capacidad de gemini.**

Matiz honesto (no inventado): subagents en gemini son **experimentales** (namespace `experimental.enableAgents`, PR #14371, públicos desde v0.38.1 — ahora habilitados por defecto pero aún bajo `experimental.*`). Y queda un **unknown externo** que estos repos no pueden resolver: si el orquestador gemini puede **iniciar** spawns en headless/non-interactivo o si la delegación `@name` está garantizada sin TTY (ver riesgos §6).

---

## 5. Esfuerzo + secuenciación + versión + reutilización agy/Antigravity

**Tamaño del trabajo en core:** moderado, no trivial. ~7 archivos editados (`provider-detect`, `install-config`, `scaffold`, `prereqs`, `doctor`, `init`, `update`, `bin/tui-installer.mjs`) + `integration-contract.json` + **un árbol nuevo `templates/gemini-skills/`** (o `gemini-*`) + tests (incluido el contrato `reserved-paths.test.ts`, que debe seguir verde para init+update gemini). La falta de abstracción installer-side significa **N ediciones inline, no un descriptor**. La mayor parte del esfuerzo de autoría es: el emisor TOML, el escritor `GEMINI.md`/settings, y **validar empíricamente** que la orquestación plana de gemini ejecuta las fases en headless.

**Secuenciación con el beta desktop:**
1. **PR-A #396** (generaliza tipos) y **PR-B #397** (adapter beta-gated) habilitan spec/explore/quick en gemini — **independientes de core**, se mergean primero.
2. El target gemini en core es **secuencialmente posterior** y desbloquea rails. Mientras tanto, el desktop debería **ocultar rails/implement para gemini** (capability-intersection: igual que codex fuerza `profile=null` y oculta Agents/Integrations) hasta que core publique el target.

**Versión de core:** feature aditiva → conventional-commit `feat:` → release-please **MINOR**. Desde 4.7.1 actual → **4.8.0**. El profile-gate `>= 4.1.0` (`queue-manager.ts:77`, `profiles-router.ts:233`) **no se toca**: proyectos gemini en 4.8.0 ya lo satisfacen. Que gemini **participe** en profiles es una decisión de política del desktop (probablemente como codex: `profile=null`), no un cambio de gate.

**¿Puramente aditivo?** En contrato/runtime: **sí** (no rompe claude/codex). En código: **no** (cada branch imperativo gana un brazo gemini). Reserved-paths sin cambios.

**Reutilización agy/Antigravity (no es trabajo tirado):** Antigravity comparte el harness `~/.gemini` (mismas convenciones `.gemini/commands/*.toml`, `.gemini/agents/*.md`, `GEMINI.md`). Un target gemini en core que emita en formato `.gemini/*` **sirve de base directa para agy** más adelante — el scaffold gemini es reutilizable casi tal cual. Esto sube el ROI del trabajo de core.

---

## 6. Recomendación

### Decisión: **HACER, pero DESPUÉS del beta desktop de spec/explore/quick (no en paralelo, no bloqueante del beta).**

Justificación: el beta desktop (PR-A/PR-B) entrega valor real de gemini (spec/explore/quick) **sin tocar core** y sin riesgo. Los rails en gemini son un trabajo de core mayor, con un unknown empírico (headless), y **no deben retrasar el beta**. El desktop oculta rails para gemini mientras tanto.

### Ownership
- **Desktop owna:** el adapter gemini (ya hecho), capability-intersection para ocultar rails/Agents/Integrations en gemini hasta que core publique, command-syntax translation en `queue-manager` (hoy claude=verbatim, codex=`/x`→`$x`; gemini necesita su forma), y `profile=null` para rails gemini.
- **Core owna:** el target de instalación gemini completo (tipos/detección, `.gemini/commands/*.toml`, `.gemini/agents/sr-*.md`, `GEMINI.md`/settings, `templates/gemini-skills/`, `integration-contract.json` gemini block, propagar `gemini` a `openspec init --tools`), y los tests.

### Primer paso concreto en core
Un **spike de validación de orquestación**, ANTES de escribir el scaffold completo: instalar manualmente a mano un `.gemini/commands/specrails/implement.toml` (prompt mínimo) + `.gemini/agents/sr-{architect,developer,reviewer}.md` (frontmatter con `model`/`tools`) + `enableAgents`, correr `openspec init --tools gemini`, y ejecutar el binario `gemini` en modo headless/exec (como lo spawnearía el desktop) para **confirmar empíricamente** que el orquestador inicia los spawns depth-1 y completa architect→developer→reviewer sin TTY. Si pasa, se procede al scaffold; si no, el riesgo se materializa antes de invertir en los 7 archivos.

### Riesgos honestos
1. **TOML sin `tools`/`model` por comando** — confirmado: los `.gemini/commands/*.toml` no pueden restringir tools ni fijar modelo. El routing/gating **debe** vivir en el frontmatter de los `.gemini/agents/*.md`. Si algún comando dependía de gating a nivel comando, hay que re-arquitecturarlo a nivel agente.
2. **Subagentes experimentales** — `experimental.enableAgents`; comportamiento puede cambiar entre versiones de gemini-cli. Pinear/probar contra una versión concreta.
3. **Shell-injection con confirm interactivo en headless** — los agentes shellean al CLI `openspec` vía Skill in-context; si gemini exige confirmación interactiva de tool-calls de shell y el desktop lo spawnea sin TTY, las fases podrían colgarse. **Riesgo no verificado, alto impacto** — es lo que el spike del primer paso debe descartar.
4. **`@`-routing headless no garantizado** — la delegación forzada `@sr-architect` puede no funcionar sin interactividad; quizás haya que apoyarse en auto-delegación, menos determinista para un pipeline que exige las tres fases.
5. **OpenSpec install adaptado a gemini** — `openspec init --tools gemini` está confirmado nativo en 1.3.1, pero **no verifiqué empíricamente en esta sesión** que los `.gemini/skills/openspec-*` que genera sean **invocables** por el orquestador gemini en el flujo real (solo que el `--tools` lo acepta). Validar en el spike.

### Lo que NO está cierto (declarado explícitamente)
- Si el orquestador gemini puede **iniciar** spawns en headless/exec, o si solo el harness puede pre-definir un set fijo de agentes. Si fuera lo segundo, el orquestador `implement` habría que re-expresarlo como agentes paralelos definidos por harness en vez de spawns iniciados por el orquestador — **lift mayor**. Esto **decide la viabilidad real** y no es deducible de estos repos.
- El comportamiento exacto de confirm de shell-calls de gemini en headless (riesgo #3).

**Archivos clave (absolutos):**
- Core gap: `/Users/javi/repos/specrails-core/src/installer/phases/provider-detect.ts` (15, 33-36, 87-92), `/Users/javi/repos/specrails-core/src/installer/phases/install-config.ts` (13, 96), `/Users/javi/repos/specrails-core/src/installer/phases/scaffold.ts` (174-184, 244-250, 278-311, 666-747, 762-830), `/Users/javi/repos/specrails-core/src/installer/commands/init.ts` (86, 128, 204-218), `/Users/javi/repos/specrails-core/integration-contract.json` (3-26), `/Users/javi/repos/specrails-core/pinned-versions.json` (3).
- Templates a transformar: `/Users/javi/repos/specrails-core/templates/commands/specrails/implement.md`, `/Users/javi/repos/specrails-core/templates/commands/specrails/batch-implement.md`, `/Users/javi/repos/specrails-core/templates/agents/sr-{architect,developer,reviewer}.md`.
- Precedente de aplanamiento codex: `/Users/javi/repos/specrails-core/templates/codex-skills/batch-implement/SKILL.md` (5, 19-32), `/Users/javi/repos/specrails-core/templates/codex-skills/implement/SKILL.md` (24).
- Desktop (ya hecho): `/Users/javi/repos/specrails-desktop/server/providers/gemini-adapter.ts` (225-235), `/Users/javi/repos/specrails-desktop/server/providers/index.ts` (12, 16); a tocar: `/Users/javi/repos/specrails-desktop/server/queue-manager.ts` (command translation, `profile=null`), `/Users/javi/repos/specrails-desktop/client/src/lib/provider-capabilities.ts` (ocultar rails gemini).
