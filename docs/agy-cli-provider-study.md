# Estudio: ¿Integrar `agy` (Antigravity CLI) como tercer proveedor en lugar de Gemini CLI?

> Documento de planificación (plan B / watch-item). Generado 2026-06-17 mediante investigación multi-agente de fuentes primarias (issue tracker `google-antigravity/antigravity-cli`, CHANGELOG, Google Developers Blog, GitHub API). Complementa `docs/gemini-cli-provider-study.md` (el plan principal). Lo marcado `[no verificado]` se señala explícitamente.

---

## 1. Respuesta directa

> ## VEREDICTO: **NO — todavía no.** Integra `gemini-cli` (path `GEMINI_API_KEY`) como tercer proveedor ahora, y trata `agy` como **watch-item gated por issues**, no como objetivo actual.

La premisa ("`agy` es el sucesor oficial, no quiero construir sobre algo deprecado") es **correcta a medias y, para nuestro contrato concreto, lleva a la conclusión opuesta**:

1. **El sunset NO mata el path que nos interesa.** Verificado contra fuente primaria (Google Developers Blog, "Transitioning Gemini CLI to Antigravity CLI"). El 18-jun-2026 lo que deja de servirse son **las peticiones de los logins de suscripción consumer (AI Pro / Freestyle) y el tier gratuito**. Literalmente: *"Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for Google AI Pro and Freestyle, as well as those using it free of charge."* Pero el path que un servidor desatendido usaría — **`GEMINI_API_KEY` de pago / enterprise** — **sobrevive explícitamente**: *"Gemini CLI will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys"* y *"We'll continue to support Gemini CLI ... with access to the latest Gemini models and other updates."* El repo `google-gemini/gemini-cli` está **vivo** (`archived:false`, último push 2026-06-17, releases activas v0.46.0 estable / v0.48.0-nightly).

2. **`agy` no satisface el contrato hoy, en ninguna de sus 5 patas críticas a la vez.** Verificado contra el issue tracker (todos OPEN, cero respuesta de Google, a 2026-06-17): `#76` (stdout 0 bytes en non-TTY → rompe la captura básica de subproceso), `#7` (el conversation/session id **nunca** se expone → no hay handle que capturar para `--resume`), `#31` (sin `--acp`/JSON-RPC), `#119`/`#394` (sin `--output-format json`/stream-json), `#78` (OAuth-only, sin auth por API-key headless). Además `#85` (cerrado sin fix shipado) muestra que en **macOS** — nuestro target de escritorio — un proceso en background re-pide login por el timeout de 1s del keyring. **Coste/tokens no se exponen en NINGÚN sitio** (ni stdout, ni transcript.jsonl, ni CLI): la pata `cost` del contrato es directamente irresoluble hoy.

3. **El factor decisivo de bajo coste:** `agy` y `gemini-cli` **comparten el harness `~/.gemini`** (motor de agente común, settings/skills/MCP compartidos). Integrar `gemini-cli` ahora **no es tirar trabajo** si después migramos a `agy`: la auth, la config MCP y los modelos Gemini 3 ya nos llegan por `gemini-cli` apuntando al mismo `~/.gemini`. El swap a `agy` sería un cambio de transporte, no un re-platforming.

**En una frase:** estudiar `agy` *en lugar de* `gemini-cli` es prematuro porque (a) el binario de `gemini-cli` con API-key no muere, (b) `agy` headless está roto en las 5 patas con silencio total de Google, y (c) ambos comparten harness, así que `gemini-cli` ahora es el puente correcto hacia `agy` después.

---

## 2. Superficie del comando `agy`

`agy` es un agente de terminal en Go (bubbletea/TUI), **closed-source** (el repo solo aloja README + CHANGELOG + binarios + issue tracker). Versión actual **1.0.9** (2026-06-17), cadencia ~3 días. **El volcado verbatim de `agy --help` no se obtuvo** (docs JS-rendered); la superficie se reconstruyó del tracker (decisivo, cita flags contra versiones concretas), los CHANGELOG y specs operativos.

### Headless / scriptable
| Comando/flag | Notas |
|---|---|
| `agy -p "<prompt>"` / `--print` | One-shot headless. **BUG `#76`/`#318`: en non-TTY emite 0 bytes a stdout y stderr, exit 0**, o cuelga. |
| `--prompt` | Alias/compañero de `-p` (issue `#7`). |
| `-i` / `--prompt-interactive` | One-shot y **se queda en TUI** → no headless puro. |
| `-c` / `--continue` | Resume la conversación **más reciente GLOBALMENTE** (peligroso para concurrencia). |
| `--conversation <id>` | Resume una conversación **específica** por id. Funciona con `-p` (issue `#278`). |
| `--model <name>` | Nombres descriptivos: `"Gemini 3.5 Flash (Low)"`, `"Gemini 3.1 Pro (High)"`. Default: Gemini 3.5 Flash. (1.0.5.) |
| `--sandbox` | Aislamiento. Propagación a `-p` arreglada en 1.0.6. |
| `--print-timeout <dur>` | p.ej. `60s`, `90s`. |
| `--log-file <path>` | **Trazas operativas (ids, request traces), NO payload de respuesta.** |
| `--add-dir <path>` | Añade directorio de workspace. |
| `--dangerously-skip-permissions` | Auto-aprueba todo ("YOLO"). |
| `--version`, `--help` / `help` | |
| `agy models` | Lista modelos (1.0.5). |
| `agy update`, `agy changelog` | Self-update / changelog. |
| `agy plugin <list\|import\|install\|uninstall\|enable\|disable\|validate\|link\|help>` | `agy plugin import gemini` importa config de gemini-cli. |

### Ausente (feature-requested, NO implementado en 1.0.9 — verbatim del tracker)
- **`--acp` / `agy acp`** (stdio JSON-RPC) → issue `#31` (OPEN, 81 comentarios, el más pedido), `#195`.
- **`--output-format json` / `stream-json` / NDJSON** → `#119`, `#394`. *`--output-format` es rechazado: `flags provided but not defined: -output-format`.* `-p` emite **un bloque de texto plano con `<thinking>` mezclado**.
- **`--session-id` / captura del conversation-id desde `-p`** → `#7`.
- **`--no-mcp` / `--mcp-config`** → `#342`.
- **`agy serve` / `agy api` / `agy run` / `agy agent`** → no existen. No hay daemon/HTTP local.

### TUI-only (solo dentro de una sesión activa)
Bare `agy`, `-i`, `-c`, y **todos** los slash commands: `/help /config /settings /model /mcp /skills /plugins /permissions /hooks /resume /tasks /diff /add-dir /open /btw /changelog /logout /export /goal /schedule /agent /context /usage /artifact` + modo shell `!`.

---

## 3. Transportes de integración — tabla rankeada

Contra el contrato: **output machine-readable + captura session-id + resume + coste/tokens**.

| # | Transporte | Output M-R | Captura session | Resume | Coste/tokens | Viable hoy | Coste en el adapter |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| **2** | **transcript.jsonl on-disk** (+ watcher `brain/`) | ⚠️ texto parseado | ✅ (vía `last_conversations.json` o newest `brain/` dir) | ✅ (`--conversation <id>`) | ❌ no en disco | **⚠️ "el menos malo"** | Reader de JSONL undocumented + watcher de FS + plan de migración a SQLite |
| **1** | **pseudo-TTY** (`script`/`unbuffer`/node-pty) | ⚠️ texto TUI renderizado | ❌ | ❌ | ❌ | ⚠️ (solo como **complemento** de #2) | node-pty + strip de `<thinking>` + parsing de marcadores sembrados en el prompt |
| **4** | **SDK Python `google-antigravity`** | ✅ eventos tipados | ✅ in-process (no por id persistido) | ⚠️ in-process (no resume del CLI local) | ⚠️ `total_usage` (alpha, no documentado) | ⚠️ **re-platforming** | **Sidecar Python** separado; abandona el patrón binary-spawn; alpha 0.1.3 |
| **3** | **Managed Agents API / `agy serve`** | — | — | — | — | ❌ | No existe `agy serve`. La "Managed Agents API" es un **producto cloud separado** (Gemini API), no envuelve el `agy` local |
| **6** | **`agy -p` plano** | ❌ (`#76` 0 bytes) | ❌ (`#7`) | ⚠️ (id incapturable) | ❌ | ❌ | Roto on-arrival |
| **5** | **ACP / JSON-RPC stdio** (`--acp`) | ✅ (si existiera) | ✅ | ✅ | ⚠️ | ❌ **vaporware** | El transporte **más limpio** si Google lo shipea; hoy `#31` OPEN sin acuse |

### Lectura de la tabla
- **El "menos malo" viable hoy = #2 (transcript on-disk) + #1 (PTY) combinados.** PTY garantiza que el proceso completa y da texto de fallback; el transcript da output estructurado-ish (línea final `source=MODEL, status=DONE, type=PLANNER_RESPONSE`), captura de session (watch de `brain/` o `cache/last_conversations.json`) y resume (`agy --conversation <id> -p`). **Satisface 4 de 5 patas.**
- **La pata `cost` es el muro:** **ningún** source encontró `usageMetadata`/`tokenCount`/`input_tokens`/`cost` en transcript.jsonl, stdout, PTY ni CLI. Un `pricing.ts` rate-card como el de codex **no tiene de qué multiplicar** porque ni siquiera hay token counts fiables. Esta pata queda **sin resolver**.
- **Riesgo de durabilidad:** el schema JSONL es undocumented y está siendo **superado por SQLite** (`conversations/<id>.db`, 1.0.4+, dual-write 1.0.8+). Cualquier reader tiene fecha de caducidad.
- **El más limpio (#5 ACP) no existe.** El más completo en captura (#4 SDK) **no envuelve el `agy` CLI** — usa su propio runtime cloud bundled.

---

## 4. Si se integrara `agy` — cómo sería el adapter (y por qué es más feo que el `gemini-adapter`)

Declararía contra el contrato `ProviderAdapter` (`server/providers/types.ts`):

```
capabilities: {
  persistentStdin: false,
  nativeResume:    'partial'  // solo vía --conversation con UUID minteado por nosotros
  nativeStreamJson: false,
  nativeCostUsd:    false,
  nativeOtelEnv:    false,
  systemPromptArg:  false      // personas van por AGENTS.md / SKILL.md, no por flag
}
instructionsFilename: 'AGENTS.md'
```

**Transporte:** #2 (transcript reader) + #1 (PTY wrap) combinados. Concretamente el adapter tendría que:

1. **Mintar nosotros el UUID de conversación** y pasarlo en `--conversation <uuid>` en el **primer** run (porque `#7`: el id auto-asignado nunca se expone). Esto invierte el patrón normal "spawn → captura session_id → resume".
2. **Envolver en node-pty** cada spawn para sortear `#76` (stdout 0-bytes en non-TTY). En Windows no hay `script` y `Start-Process -RedirectStandardOutput` cuelga; node-pty es el equivalente portable pero **[no verificado]** para `agy`.
3. **Watcher del directorio `~/.gemini/antigravity-cli/brain/`** para detectar el nuevo `<conversation-id>/` y leer `.system_generated/logs/transcript.jsonl`, parseando líneas undocumented (`source`/`status`/`type`) — con un **reader abstraído** que prevea la migración a `conversations/<id>.db` (SQLite).
4. **`pricing.ts` sin inputs:** para `ai_invocations` (model, tokens, cost) **no tenemos token counts de ninguna fuente**, así que `total_cost_usd` quedaría siempre `—` o un estimado inventado — viola la política de métricas honestas del Job Detail.
5. **Serializar la concurrencia con un lock**, porque `agy` reescribe `cache/last_conversations.json` en **cada** invocación. Eso **rompe el requisito de "concurrencia de varios rails"**: tendríamos que dar a cada rail un `--conversation` UUID distinto **y** un `HOME`/dir aislado, lo cual es **[no probado]**.
6. **Sin historia de auth desatendida:** OAuth-only (`#78`), keyring que re-pide login en background en macOS (`#85`). No hay `SPECRAILS_…_API_KEY` que inyectar como con codex.

**Por qué es más feo que el `gemini-adapter`:** el `gemini-adapter` es un **spawn de binario limpio** (mismo patrón que claude/codex: argv → `parseStreamLine` → `finaliseInvocationResult`), con `GEMINI_API_KEY` para auth desatendida, stream-json nativo y resume por session-id real. El `agy` adapter requeriría **tres puentes nuevos fuera del patrón** (node-pty, watcher de FS, posible sidecar) + un lock global de concurrencia + un coste **fabricado** o ausente. Es estrictamente peor en las 5 patas.

---

## 5. El modelo de agentes/skills de `agy` para el pipeline (esto sí es bueno)

**Reconocimiento honesto: el modelo de agentes de `agy` es bueno y bien diseñado** — solo que la *integración headless* es lo que falla, no la expresividad del pipeline.

Hallazgo decisivo (guía de migración oficial, Google Cloud Community): **los `agent.json` declarativos del viejo Gemini CLI están OBSOLETOS.** Verbatim: *"Under Antigravity, subagents are orchestrated dynamically, making this directory obsolete"* → `rm -rf .agents/agents/`. **No hay un fichero que pre-defina una persona-subagente persistente nombrada**; los subagentes son emergentes (el orquestador llama a un tool `DefineSubagent` en runtime). No podemos shipear architect/developer/reviewer como tres `agent.json` que `agy` cargue.

**Lo que SÍ carga** (el árbol que `specrails-core` tendría que emitir, análogo a `.codex/skills` / `.claude/agents`):

1. **`AGENTS.md`** en la raíz del workspace → personas architect/developer/reviewer como **secciones de prompt** (Goal/Traits/Constraints).
2. **`.agents/skills/sr-architect/SKILL.md`**, `sr-developer/`, `sr-reviewer/` → un SKILL.md por fase, con frontmatter YAML `name:` + `description:` (third-person trigger) y cuerpo Goal/Instructions/Constraints. Cargan por **match semántico** del `description`. **También** surgen como slash commands.
3. **`.agents/workflows/sr-implement.md`** (frontmatter `description:`) → el slash command orquestador que secuencia architect→developer→reviewer, invocado `/sr-implement "<issue>"`.

**Forma del modelo:** **plano / un nivel.** El orquestador gestiona los handoffs; *"Agents do not call subagents; the workflow orchestrator manages handoffs."* La secuencia estricta hay que **forzarla en las instrucciones del workflow.md + constraints del AGENTS.md**.

**Crux a nuestro favor:** ese árbol vive bajo el **harness compartido `~/.gemini/config/` + `.agents/`**, leído idénticamente por la GUI de Antigravity 2.0 y por `agy` headless → **`specrails-core` PUEDE emitir un árbol `agy`**. Eso es trabajo de `specrails-core`, no nuestro.

**Gaps `[no verificado]` antes de comprometerse:** (a) ¿`agy -p "/sr-implement '...'"` expande deterministamente el workflow headless? (b) ¿secuenciación determinista de fases bajo orquestación dinámica?

---

## 6. Timeline / madurez

**Issues bloqueantes (GitHub API, 2026-06-17, todas OPEN, `author_association=NONE` en todos los comentarios → cero respuesta de maintainer/Google, ningún PR de fix mergeado):**

| Issue | Qué bloquea | Estado | Comentarios |
|---|---|---|---|
| `#76` | stdout 0-bytes en non-TTY (el bloqueante #1 de spawn) | OPEN, sin fix | 19 |
| `#7` | conversation-id nunca expuesto (sin captura para resume) | OPEN | 1 |
| `#31` | ACP / JSON-RPC stdio (el transporte limpio) | OPEN, más pedido | 81 |
| `#78` | auth API-key headless (sin historia desatendida) | OPEN | 2 |

**Cadencia:** release cada ~3 días (1.0.4 el 06-01 → 1.0.9 el 06-17), pero **exclusivamente** en pulido TUI / hardening de sandbox / clipboard / statusline. **El contrato headless NO ha avanzado nada** entre 1.0.0→1.0.9.

**Madurez global:** preview público (no GA), closed-source, 339 issues abiertos. El SDK Python es **alpha 0.1.3**.

**Lectura:** el contrato usable **no está cerca**. Dada la velocidad gastada íntegramente en pulido TUI y el **silencio total de Google** en las cuatro issues integrator, una ETA realista es **issue-gated, no date-gated**, del orden de **2–4+ meses** si es que llega. **No integrar ahora.**

---

## 7. Recomendación final + ruta

> **AHORA:** Integra **`gemini-cli` como tercer proveedor** vía el `gemini-adapter` ya diseñado (binary-spawn limpio, `GEMINI_API_KEY`, stream-json + resume nativos). **`agy` = watch-item gated.**

**Justificación:**
- El sunset mata **el login de suscripción consumer + free**, NO el binario open-source con API-key de pago/enterprise — que Google se compromete a seguir soportando *con los modelos nuevos*.
- **El modelo Gemini 3 ya nos llega vía `gemini-cli`** apuntando a `GEMINI_API_KEY`. No hay nada que ganar del lado del modelo cambiando a `agy` hoy.
- **Harness compartido `~/.gemini`:** integrar `gemini-cli` ahora **no es trabajo desechable** — la auth, MCP y el árbol de config quedan asentados en el mismo `~/.gemini` que `agy` reusaría. Un swap futuro sería cambio de transporte.
- `agy` headless está roto en **las 5 patas a la vez**, con la pata **coste irresoluble** y **sin auth desatendida** en macOS, con silencio de Google.

### Si en el futuro `gemini-cli` muriera de verdad para el path API-key
No lo hace (confirmado que sobrevive). Pero **si** llegara a morir, el puente provisional sería el **transporte #2 (transcript.jsonl) + #1 (PTY wrap)**, con coste marcado como estimado-imposible y concurrencia serializada con lock — explícitamente temporal y degradado.

### Condiciones (issues cerradas con fix verificado) que dispararían el cambio a `agy` — **gate AND**:
- ✅ **`#76` cerrada** (stdout en non-TTY capturable), **Y**
- ✅ **`#7` shipado** (conversation-id capturable desde `-p`), **Y**
- ✅ **`#31` (`--acp`/JSON-RPC)** *o* **`--output-format stream-json` (`#119`/`#394`)**, **Y**
- ✅ **`#78` shipado** (auth por API-key + fix del keyring `#85`), **Y**
- ✅ una fuente de **token usage / coste** machine-readable (hoy inexistente — el bloqueante silencioso más duro), **Y**
- ✅ concurrencia segura sin el lock global de `last_conversations.json`.

**Vía paralela (no la principal):** si se prioriza el modelo de agentes de `agy`, el trabajo correcto es que **`specrails-core` aprenda a emitir el árbol `agy`** (`AGENTS.md` + `.agents/skills/sr-*/SKILL.md` + `.agents/workflows/sr-implement.md`), exactamente como ya emite `.codex/skills` — independiente de nuestro adapter, se puede empezar antes de que el transporte madure.

**Watch concreto:** revisar `#76`, `#7`, `#31`/`#119`, `#78` (y el SDK Python alcanzando beta con `total_usage` estable) cada pocas semanas. Hasta que el gate AND se cumpla: **`gemini-cli` ahora, `agy` después.**

---

### Notas de honestidad sobre lo incierto
- `agy --help` verbatim **no obtenido** — superficie reconstruida del tracker/CHANGELOG (alta confianza por estar versionada) + specs operativos.
- **Coste/tokens:** ninguna fuente encontró campos de usage en transcript.jsonl/stdout/CLI — la imposibilidad de la pata coste es por *ausencia de evidencia en cuatro investigaciones*, no por negativa explícita de Google; a efectos prácticos es bloqueante.
- **node-pty para `agy` en Windows:** equivalente portable a `script`, **no verificado** contra `agy`.
- **SDK Python:** resume de una conversación `agy` local por id **no documentado**; gestiona su propio estado con runtime cloud bundled — re-platforming, no wrapping.
- **`agy -p "/workflow"`** expandiendo deterministamente headless: **no verificado**.

---

## 8. Addendum — verificación contra el binario `agy 1.0.9` instalado (2026-06-18)

> Este estudio se generó (2026-06-17) **sin el binario**, reconstruyendo la superficie del tracker/CHANGELOG. Al día siguiente se ejecutó el binario real instalado (`/Users/javi/.local/bin/agy`, Mach-O arm64, 135 MB, **v1.0.9**) en macOS. Esta sección **corrige y confirma** afirmaciones concretas del cuerpo principal. **El veredicto NO cambia** — los bloqueantes estructurales (sin `--output-format stream-json`, sin captura de session-id, sin coste/tokens) siguen en pie; este addendum los refuerza con evidencia directa y corrige solo el detalle del print mode.

### 8.1 Identidad confirmada
Strings del binario: `"You are a subagent of Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team"`, `ANTIGRAVITY_AGENT=1`, config bajo `~/.gemini/antigravity-cli/`. Go (bubbletea/glamour). Confirma §2.

### 8.2 `agy --help` verbatim — ahora SÍ obtenido (corrige §2)
El cuerpo dice *"El volcado verbatim de `agy --help` no se obtuvo"*. Obtenido del binario:

```
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable)
  -c, --continue                  Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests
  -i, --prompt-interactive        Run an initial prompt interactively and continue the session
  --log-file                      Override CLI log file path
  --model                         Model for the current CLI session
  -p, --print, --prompt           Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --sandbox                       Run in a sandbox with terminal restrictions enabled
Subcommands: changelog · help · install · models · plugin/plugins · update
```

**Confirma:** `-p/--print/--prompt`, `-c/--continue`, `--conversation`, `--model`, `--print-timeout` (default 5m), `--dangerously-skip-permissions`, `--sandbox`. **Crítico — NO aparece `--output-format`** → confirma #119/#394 **sin resolver en 1.0.9**.

### 8.3 Print mode SÍ emite a stdout en 1.0.9 (corrige #76)
`agy changelog` 1.0.9 verbatim: *"Fixed a bug in headless print mode resumption (`--conversation`/`-c` `-p ...`) where the CLI would dump the entire historical conversation transcript instead of only printing the newly generated response."*

→ La premisa de **#76** ("stdout 0 bytes en non-TTY") está **parcialmente stale**: en 1.0.9 el print mode emite la respuesta a stdout (el bug arreglado era que emitía *de más* al resumir). **PERO no desbloquea nada**: sigue siendo **texto plano sin `--output-format stream-json`**, así que `parseStreamLine`/`extractResult` no tienen wire format que parsear. La pata "output machine-readable" sigue **rota**. *[No se ejecutó `agy -p "<prompt>"` real — sin gastar auth/tokens; la evidencia es el changelog + la ausencia de `--output-format` en `--help`, no un run.]*

### 8.4 `agy models` verbatim (confirma §2)
```
Gemini 3.5 Flash (Low/Medium/High) · Gemini 3.1 Pro (Low/High)
Claude Sonnet 4.6 (Thinking) · Claude Opus 4.6 (Thinking) · GPT-OSS 120B (Medium)
```
Confirma **nombres descriptivos** (no ids GA) → rompería la atribución de coste en `ai_invocations.model`. Multi-modelo (incluye Claude y GPT-OSS, no solo Gemini).

### 8.5 Auth — este install es OAuth (confirma #78)
`~/.gemini/oauth_creds.json` presente (1.5K) + `google_accounts.json`. **No verificado** si 1.0.9 acepta `GEMINI_API_KEY` headless — el tracker (#78) dice OAuth-only; este install lo es.

### 8.6 Harness `~/.gemini` compartido — confirmado en disco (refuerza §1.3, §3, §5)
Layout real observado:
```
~/.gemini/
  acknowledgments/agents.json   ← MISMO fichero que gemini-adapter.prepareHeadlessSpawn escribe
  agents/
  config/mcp_config.json         ← MCP de agy (vacío en este install)
  antigravity-cli/
    brain/                       ← transcripts por conversación (transporte #2)
    conversations/               ← SQLite (confirma migración JSONL→SQLite, §3)
    cache/  history.jsonl  log/
  oauth_creds.json  trustedFolders.json  settings.json
```
**Confirma el crux de §1.3/§5:** `agy` y `gemini-cli` comparten `~/.gemini`. El `acknowledgments/agents.json` es exactamente el que el `gemini-adapter` ya gestiona. El dir `conversations/` (SQLite) confirma que el schema `transcript.jsonl` está siendo superado (riesgo de durabilidad del transporte #2, §3).

### 8.7 Modelo skills/workflows — confirmado en strings (refuerza §5)
Símbolos del binario: `GetAllSkills`, `GetWorkflows`, `skills_paths`, `SKILLS_STACK`, `WorkflowName`/`WorkflowSpec`, `invoke_subagent`, `define_subagent`, discovery de `*.toml`. Confirma §5: subagentes **dinámicos** (`define_subagent` en runtime, no fichero persistente), skills+workflows como árbol cargable. `agy plugin import gemini|claude` confirma interop con el harness.

### 8.8 Impacto en specrails-core (no estaba explícito en el cuerpo)
El target gemini que **specrails-core 4.8.0** emite (`.gemini/commands/specrails/*.toml` + `.gemini/agents/sr-*.md` + `GEMINI.md`) **NO es el árbol que `agy` carga** (§5: `AGENTS.md` + `.agents/skills/sr-*/SKILL.md` + `.agents/workflows/sr-implement.md`). → un swap a `agy` **para rails** exige **un target NUEVO en specrails-core** (`templates/agy-skills/`), paralelo al gemini ya shipado. Es trabajo de **2 repos** (adapter desktop + core), no solo del adapter. Las superficies spec/explore/quick/chat (prompts directos, sin slash-commands de core) no tocarían core. Coherente con la "vía paralela" de §7.

### Resumen del addendum
| Afirmación del cuerpo (2026-06-17) | Estado tras verificar el binario 1.0.9 |
|---|---|
| `agy --help` verbatim no obtenido | ✅ obtenido (8.2) |
| #76 stdout 0 bytes en non-TTY | ⚠️ **stale** — print mode emite en 1.0.9, pero sin stream-json (8.3) |
| sin `--output-format json/stream-json` | ✅ confirmado (no aparece en `--help`) (8.2) |
| #78 OAuth-only | ✅ este install es OAuth (8.5) |
| coste/tokens no expuestos | ✅ sin cambios (no hay `--output-format` ni usage) |
| harness `~/.gemini` compartido | ✅ confirmado en disco (8.6) |
| migración transcript.jsonl → SQLite (§3) | ✅ `conversations/` SQLite presente (8.6) |
| modelo de agentes dinámico (§5) | ✅ `define_subagent`/`invoke_subagent` en strings (8.7) |
| **VEREDICTO: NO — todavía no** | ✅ **sin cambios; reforzado** |
