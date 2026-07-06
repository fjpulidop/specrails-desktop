# Estudio de implementación — Gemini CLI como tercer proveedor de specrails-desktop

> Documento de planificación (no contrato final). Generado 2026-06-16 mediante auditoría multi-agente del código real + investigación de fuentes primarias de `github.com/google-gemini/gemini-cli` (HEAD `5624a3b`, v0.48.0-nightly). Listón de referencia: el adapter de Codex (no-nativo con puentes). Las citas `file:line` provienen de la auditoría del código; las flags/campos de Gemini en `verbatim` de la investigación. Lo marcado `[UNCERTAIN]` se señala con su plan de resolución.

---

## 1. Resumen ejecutivo y alcance

**Veredicto: viable y de bajo riesgo arquitectónico.** El core de spawn/detect/cost/registry ya está generalizado por id de proveedor (`server/providers/registry.ts` es un `Map<ProviderId,adapter>`, `core-compat.ts` recorre `listAdapters()`, `pricing.ts` usa claves `'<id>:<model>'`, `result-event.ts` `finaliseInvocationResult` y `provider-selection.ts` son membership-based). El contrato promete *"un fichero + una entrada de registro"* y eso se cumple para el camino de compilación mínimo. El resto del trabajo es **ensanchar uniones literales `'claude'|'codex'`** y **rellenar branches `=== 'codex'` que no tienen hermano gemini**.

Gemini supera a Codex en dos capacidades clave verificadas:
- **OTEL nativo** (`[confirmed]`): emite OTLP por env (`GEMINI_TELEMETRY_*`), igual que claude → `nativeOtelEnv: true`, **no necesita bridge sintético**.
- **System-prompt nativo** (`[confirmed]`): `GEMINI_SYSTEM_MD=<path>` reemplaza el system prompt por env de proceso → soporte de system-prompt (con matiz, ver §3).

**Entra en v1 (PR-B beta-gated):** jobs/rails básicos, Explore Spec multi-turno (spawn-per-turn con `--resume`), Quick spec, Analytics/coste vía rate-card, OTEL nativo, terminal CLI launch, detección + prerequisitos, selección de modelo, multi-provider per project.

**NO entra en v1 (paridad Codex, se ocultan por intersección de capacidades):** Agent Profiles, SMASH, Contract Refine, Freestyle (+interactivo), plugins/Serena, persistent-stdin de Explore. Gemini se comporta byte-idéntico a Codex en estas superficies **siempre que declare las capacidades correctas y se ensanchen los tipos** — cero código nuevo en esas superficies.

**Diferido a follow-up explícito (decisiones tomadas, no implementadas en v1):** generalizar `provider-capabilities.ts` para *otorgar* a Gemini features hoy claude-only; bridge Windows multi-line argv; traducción slash-command para rails funcionales en Gemini (esto último es **bloqueante para rails reales**, ver §6).

---

## 2. Modelos a ofrecer

Decisión: **pinear ids GA concretos, no alias ni ids preview**, porque los ids `gemini-3-*-preview` rotan (la API ya movió Pro a `gemini-3.1-pro-preview`) y el CLI acepta ids inválidos sin validar (`issue #21391`). `ai_invocations.model` y la clave de pricing necesitan un id concreto y estable → el `modelCatalog()` ofrece ids GA concretos como `value`, que son los que se pasan a `--model` y se almacenan; se evita el churn de los preview.

**Catálogo curado (4 entradas):**

| value (`--model` / `ai_invocations.model`) | label | default |
|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | **sí** |
| `gemini-2.5-flash` | Gemini 2.5 Flash | no |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | no |
| `gemini-3.1-pro-preview` | Gemini 3 Pro (preview) | no |

- **Default = `gemini-2.5-pro`**: GA, no-preview, es el `DEFAULT_GEMINI_MODEL` hardcoded del propio CLI, pricing estable. Evita anclar el producto a un id preview que rotará.
- **Se ofrece `gemini-3.1-pro-preview`** como cuarta opción de calidad (el único Pro de Gemini-3 *con precio publicado*; `gemini-3-pro` no existe como modelo con precio). Etiquetado "preview" para señalar volatilidad.
- **Se omiten `gemini-3-flash-preview` / `gemini-3.5-flash` / `gemini-3.1-flash-lite`**: preview de precio movible; con `flash`/`flash-lite` 2.5 ya cubrimos el tier rápido/barato con GA estable. Añadirlos luego es trivial (solo filas de pricing + catálogo).
- **Se omite pasar alias `auto`/`pro`/`flash`**: el routing `auto` impide stampear un id concreto en `ai_invocations.model`, rompiendo la atribución de coste. Pinneamos ids.

`[UNCERTAIN]`: el mapping alias→id-concreto no está byte-documentado; se resuelve NO usando alias.

**Filas para `server/pricing.ts` (clave `'gemini:<model>'`, USD por 1M tokens, Standard paid tier):**

```ts
// Gemini (Google). Ref: ai.google.dev/gemini-api/docs/pricing (fetched 2026-06-16).
// nativeCostUsd:false → estas tarifas son la ÚNICA fuente de coste.
'gemini:gemini-2.5-pro':         { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.125, lastReviewedAt: '2026-06-16' },
'gemini:gemini-2.5-flash':       { inputPer1M: 0.30, outputPer1M: 2.50,  cacheReadPer1M: 0.03,  lastReviewedAt: '2026-06-16' },
'gemini:gemini-2.5-flash-lite':  { inputPer1M: 0.10, outputPer1M: 0.40,  cacheReadPer1M: 0.01,  lastReviewedAt: '2026-06-16' },
'gemini:gemini-3.1-pro-preview': { inputPer1M: 2.00, outputPer1M: 12.00, cacheReadPer1M: 0.20,  lastReviewedAt: '2026-06-16' },
```

Notas de tiering y caché (decisiones explícitas):
- **`gemini-2.5-pro` y `gemini-3.1-pro-preview` son context-tiered** (>200k tokens duplica precio: pro $2.50/$15.00; 3.1-pro $4.00/$18.00). `PriceEntry` no soporta tiering por tamaño de prompt. **Decisión v1: usar el tier ≤200k** (la mayoría de jobs caen ahí). El coste de prompts >200k se **infra-estima** — aceptable y honesto (Analytics ya marca `estimated=true`). Fidelidad = follow-up que ensancha `PriceEntry` con tiering (toca también codex pro). No bloqueante.
- **Free tier**: existe (OAuth 60 RPM/1000 RPD; API key free 10 RPM/250 RPD, solo Flash). **No se modela en pricing** — el rate-card es para coste estimado, no para gating de cuota (coherente con codex).
- **Caché**: `cacheReadPer1M` asume (como OpenAI/codex) que los cached tokens son un *subconjunto* de `tokens_in`. Gemini reporta `cachedContentTokenCount` separado → `[UNCERTAIN]` **resolución**: en `extractResult` mapear `cached` a `tokens_cache_read` y NO restarlo de `tokens_in` (mismo patrón que codex `cached_input_tokens`); el test de pricing fija el contrato.

---

## 3. El adapter `server/providers/gemini-adapter.ts`

Estructura espejo de `codex-adapter.ts`. Constantes `GEMINI_MODELS`, `GEMINI_MIN_VERSION`, helper `fold()` (igual que codex-adapter.ts:49-52), `WHICH_CMD`, `compareSemver`.

### Propiedades readonly

| Miembro | Valor Gemini | Razón |
|---|---|---|
| `id` | `'gemini'` | clave de registro; igual a `projects.providers[]` y al param `aiEngine`. |
| `displayName` | `'Gemini CLI'` | etiqueta UI pura. |
| `binary` | `'gemini'` | ejecutable en PATH. |
| `minCliVersion` | `'0.11.0'` | piso donde stream-json (PR #10883) + resume están validados. <0.6 no tiene `--output-format`; <0.11 no tiene stream-json. |
| `projectDirName` | `'.gemini'` | dir de settings del CLI (`.gemini/settings.json`). |
| `instructionsFilename` | `'GEMINI.md'` | el CLI lee GEMINI.md por defecto; plugin/explore-cwd escriben aquí. **Mejor que codex**: nativo, sin config extra. |
| `mcpRegistration` | `'project-json'` | Gemini registra MCP en `.gemini/settings.json` `mcpServers`. `gemini mcp add -s project` escribe al settings.json. |

### `capabilities` (8 campos)

| Campo | Valor | Por qué |
|---|---|---|
| `nativeResume` | `true` | `--resume <uuid\|index\|latest>` headless wired en non-interactive (`nonInteractiveCli.ts:236-242`, `resumeChat`). El host pre-asigna UUID con `--session-id` y resume con `--resume <uuid>`. |
| `nativeStreamJson` | `true` | `--output-format stream-json` emite NDJSON (`init/message/tool_use/tool_result/error/result`). |
| `nativeCostUsd` | `false` | NO hay campo cost/usd en ningún evento (grep confirmado). → rate-card en pricing.ts (igual codex). |
| `nativeOtelEnv` | `true` | **MEJOR que codex**: emite OTLP nativo por `GEMINI_TELEMETRY_*` env. No necesita bridge sintético (ver §4). |
| `profileEnvSupport` | `true` (vestigial) | Igual que codex: rails fuerzan profile=null para non-claude (`rails-router.ts:250`); valor irrelevante funcionalmente; `true` por paridad. |
| `systemPromptArg` | `false` (v1) | **Matiz**: Gemini SÍ soporta override de system-prompt, pero por **env `GEMINI_SYSTEM_MD=<path>`**, NO por flag de argv. El contrato `systemPromptArg` significa "¿hay un *flag* `--system-prompt`?" → no lo hay. **v1: `false`** y foldear systemPrompt en el prompt (como codex, fold()). El path env es follow-up. |
| `persistentStdin` | omitido (`false`) | El CLI requiere el follow-up prompt vía `-p`/`--prompt` en resume headless (issue #14180), no soporta stdin stream-json long-lived documentado. → Explore cae al spawn-per-turn legacy (sin pérdida vs default, que es OFF). |

**Nota sobre `systemPromptArg=false` pese a soporte nativo**: el contrato solo modela "flag de argv". Como Gemini usa env (`GEMINI_SYSTEM_MD`), la vía limpia v1 es foldear (codex-parity). Un follow-up puede inyectar `GEMINI_SYSTEM_MD` en el env de spawn — pero eso es un reemplazo *completo* del system prompt (no merge), y los managers asumen append; foldear es más seguro en v1.

### `buildArgs(action, opts)` — switch de los 9 SpawnActions

Flags base: `--output-format stream-json`, `--model <opts.model>`. Headless se dispara con `-p <prompt>`. Jobs autónomos: `--approval-mode yolo`. Acciones read-only de spec/explore: `--approval-mode plan`. `opts.extraArgs` siempre se appendea verbatim.

```
chat-turn (Explore):     gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json --session-id <hostUUID>
chat-resume:             gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json --resume <opts.sessionId>
                         // throw si !opts.sessionId  (igual codex)
chat-stream:             throw  // persistentStdin no soportado (igual codex)
rail-job:                gemini -p <command> --model <m> --output-format stream-json --approval-mode yolo --session-id <hostUUID>
                         // NB: el command slash /specrails:X NO lo entiende Gemini → §6 (bloqueante rails reales)
spec-gen:                gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json --approval-mode plan
agent-refine:            gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json --approval-mode yolo
setup-enrich:            gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json
setup-enrich-resume:     gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json --resume <opts.sessionId>
                         // throw si !opts.sessionId
auto-title:              gemini -p <fold(sys,prompt)> --model <m> --output-format stream-json
```

Detalles:
- **`--session-id <hostUUID>` en turno 1** (chat-turn, rail-job): el host mintea un UUID propio y lo pre-asigna, así no depende de parsear `init.session_id` (que es post-2025-12-04). Resume luego con `--resume <eseUUID>`. Robustez de versión.
- **Resume requiere prompt vía `-p`** (no stdin/positional) — issue #14180, workaround estable documentado.
- **`opts.maxTurns`**: Gemini lo mapea a `maxSessionTurns` (settings.json, default 100), NO hay flag `--max-turns`. Ignorar `maxTurns` en buildArgs (como codex); el cap sale por exit code 53.
- **cwd**: todos los spawns desde `project.path` (o explore-cwd) — el resume está scopeado por hash de cwd (`getProjectHash(process.cwd())`). El host ya fija `cwd=project.path` por manager.

### `parseStreamLine(line)` — mapeo evento-gemini → AdapterEvent[]

`JSON.parse` por línea; `null` en línea vacía o parse-fail (igual codex):

| Evento Gemini | AdapterEvent | Mapeo |
|---|---|---|
| `init` `{session_id,model}` | `session-started{sessionId: e.session_id}` | **session_id sale del evento `init`** (único sitio). |
| `message` `{role:'assistant',content,delta}` | `text-delta{text: e.content}` | acumular chunks con `role==='assistant'`. `role:'user'` (echo) → ignorar. |
| `tool_use` `{tool_name,tool_id,parameters}` | `tool-use{name: e.tool_name, inputPreview: ...slice(0,200)}` | preview 200 chars (igual codex). |
| `tool_result` `{tool_id,status,output,error}` | `other{type:'tool_result',raw}` | no hay variant dedicado; codex tampoco lo usa. |
| `result` `{status,stats}` | `result{payload: e}` | terminal; `stats` queda en payload para `extractResult`. |
| `error` `{severity,message}` | `other{type:'error',raw}` | no-fatal; los fatales van a stderr+exit. |
| desconocido | `other{type,raw}` | |

**session_id**: del evento `init.session_id`. Como además pre-asignamos `--session-id`, el host ya lo conoce sin parsear (doble seguridad).

### `extractResult(events)` — suma de tokens

Lee el último `result.payload.stats` (StreamStats, flat):
- `tokens_in ← stats.input_tokens`
- `tokens_out ← stats.output_tokens` (Gemini stream-json **descarta** `thoughts`/`tool` tokens; no hay reasoning separado que foldear)
- `tokens_cache_read ← stats.cached`
- `tokens_cache_create ← undefined`
- `num_turns ←` contar eventos `result` (1 por turno)
- `session_id ←` último `session-started.sessionId`
- `total_cost_usd ← undefined` → `finaliseInvocationResult` (`result-event.ts:48-89`) aplica `estimateCostUsd('gemini', model, usage)` contra `pricing.ts`. Sin filas → coste NULL + warn (`result-event.ts:81`).

### `detectInstalled()` — espejo exacto de codex (contrato cap 3s, types.ts:131-132)

`which/where gemini` → si ausente `{installed:false,executable:false}`. Si presente: `gemini --version` con `timeout:3000`, regex `\d+\.\d+\.\d+`, `compareSemver` vs `GEMINI_MIN_VERSION='0.11.0'` → `meetsMinimum` + string de error/upgrade. Fallo del probe → `{installed:true,executable:false}`. Corre al startup y en `/setup-prerequisites`.

### `baselineAgents()` → `['sr-architect','sr-developer','sr-reviewer']` (vestigial — rails fuerzan profile=null).

### `registration` (`server/providers/index.ts:11-14,17`)
```ts
import { geminiAdapter } from './gemini-adapter'
register(geminiAdapter)
export { claudeAdapter, codexAdapter, geminiAdapter }
```

---

## 4. OTEL: nativo (NO bridge)

**Decisión: `nativeOtelEnv: true` — Gemini va por el path de claude (env-injection), NO por el bridge sintético de codex.** Evidencia `[confirmed]`: `packages/core/src/telemetry/config.ts` (PR #9113) lee de `process.env` con precedencia env>settings, emitiendo OTLP nativo de traces+metrics+logs.

**Cómo se inyecta** — en `server/queue-manager.ts`, con `nativeOtelEnv:true` el bloque del bridge (`queue-manager.ts:1197-1205`, gated `!adapter.capabilities.nativeOtelEnv`) **se salta automáticamente**, y Gemini fluye por `buildTelemetryEnv` (`queue-manager.ts:1042,1105`). El adapter/queue inyecta:
```
GEMINI_TELEMETRY_ENABLED=true
GEMINI_TELEMETRY_TARGET=local
GEMINI_TELEMETRY_OTLP_ENDPOINT=<app OTLP receiver>
GEMINI_TELEMETRY_OTLP_PROTOCOL=grpc           # grpc:4317, evita el bug OTLP/HTTP #15581
GEMINI_TELEMETRY_TRACES_ENABLED=true          # spans (off por defecto)
```

**Qué cambia respecto a claude en queue-manager**: `buildTelemetryEnv` hardcodea `CLAUDE_CODE_ENABLE_TELEMETRY:'1'` (`queue-manager.ts:52-60`), claude-específico. Gemini necesita SU enable-flag. **Cambio requerido (solo si telemetry está ON para un job gemini)**: parametrizar el enable-var por adapter — p.ej. `adapter.nativeOtelEnvVars()` que devuelva `{CLAUDE_CODE_ENABLE_TELEMETRY:'1'}` para claude y el bloque `GEMINI_TELEMETRY_*` para gemini. Los `OTEL_EXPORTER_OTLP_*` estándar siguen neutrales. **No bloqueante** salvo que se active telemetry.

**Caveat de correlación `[UNCERTAIN]`**: el receptor OTLP del app rutea por `specrails.job_id` + `specrails.project_id` en `resource.attributes`. Gemini emite sus propios `session.id`/`installation.id`, NO los de specrails. Si Gemini honra `OTEL_RESOURCE_ATTRIBUTES` (estándar OTEL SDK, **no documentado en telemetry.md**), inyectar `OTEL_RESOURCE_ATTRIBUTES=specrails.job_id=<id>,specrails.project_id=<id>` resuelve la correlación. **Resolución**: probar empíricamente antes de confiar; fallback = correlacionar por `session.id` de spawn-time (lo conocemos vía `--session-id`). Telemetry es opt-in OFF por defecto → no bloquea v1.

**El bridge `codex-otel-bridge.ts` NO se toca** para Gemini (se bypassa por capability).

---

## 5. Change-list exacto por fichero (dos PRs)

### PR-A — Generalización previa (ensanchar tipos, desramificar; sin Gemini todavía)

Mergeable independiente, no cambia comportamiento observable.

| Fichero:línea | Cambio | Bloq |
|---|---|---|
| `server/desktop-db.ts:10,50,167,268,388` | `CliProvider = 'claude'\|'codex'` → ensanchar a incluir `'gemini'` (o alias a `ProviderId`/string). Tipo DB central; todos heredan. `DEFAULT 'claude'` se mantiene. | **sí** |
| `server/spec-models.ts:1-37` | `SpecProvider` union + reemplazar ternario `provider==='codex'?CODEX:CLAUDE` en `getModelsForProvider` por **lookup `Record<provider, SpecModelOption[]>`** (fallback `adapter.defaultModel()`/`[]`). `PROVIDER_DEFAULT_MODEL` → record extensible. | **sí** |
| `server/desktop-router.ts:158-168` (`GET /available-providers`) | Dejar de destructurar `{claude,codex}` fijo; `detectAvailableCLIs()` ya devuelve `Record<string,boolean>` → **devolver el map entero (spread)**. `if(providers.claude\|\|providers.codex)` → `Object.values(providers).some(Boolean)`. | **sí** |
| `server/desktop-router.ts:265-266` | casts `as 'claude'\|'codex'` en addProject → ensanchar (registry valida con `hasAdapter`). | **sí** |
| `server/project-registry.ts:116` | `AddProjectInput.providers?: ('claude'\|'codex')[]` → `ProviderId[]`/`string[]`. | **sí** |
| `client/src/hooks/useDesktop.tsx:29,35,48,172` | 4 anotaciones `('claude'\|'codex')[]` → `string[]`/`ProviderId`. | **sí** |
| `client/src/lib/provider-capabilities.ts:11` | `ProviderId = 'claude'\|'codex'` → añadir `'gemini'`/string. | **sí** |
| `client/src/components/ModelSelector.tsx:20-55,80` | ternario `provider==='claude'?CLAUDE:CODEX` → map por id; `PRESET_DEFAULTS`/`MAX_OVERRIDES` literal → `Record<string,string>`; ensanchar prop union. **Bloqueante funcional**: sin esto Gemini mostraría modelos de Codex. | **sí** |
| `client/src/components/ChatInput.tsx:7-18,25` | selección por id-keyed map; ensanchar `provider?: 'claude'\|'codex'`. | **sí** |
| `client/src/components/AddProjectDialog.tsx:28,31,37,41,67-79,96,141,235-236` | `availableProviders` de `{claude;codex}` fijo → `Record<string,boolean>` iterado sobre `/available-providers`; `!claude && !codex` → iterar keys. | **sí** |
| `client/src/components/{AiEngineSelector:40,53, RailEngineSelector:33,38, CliLaunchMenu:52,55, explore-spec/SpecModelPicker:23,81, SetupWizard:563}` | casts inline `as 'claude'\|'codex'` → ensanchar union. Listas data-driven, Gemini aparece solo. | **sí** |
| `server/util/cli-prompt.ts:178-191` | `spawnAiCli` ya cae a `spawnCli` genérico para binarios desconocidos → **POSIX funciona sin cambio**. Windows multi-line argv (`transformClaudeArgsForWindows`/`transformCodexArgsForWindows`) NO cubre gemini. | cosmético (POSIX) / bloq Windows |

### PR-B — El adapter Gemini + branches y catálogos

| Fichero:línea | Cambio | Bloq |
|---|---|---|
| `server/providers/gemini-adapter.ts` (nuevo) | El adapter completo (§3). | **sí** |
| `server/providers/index.ts:11-14,17` | import + `register(geminiAdapter)` + re-export. | **sí** |
| `server/pricing.ts:44-50` | 4 filas `'gemini:<model>'` (§2). Sin ellas coste=NULL. | **sí** |
| `server/project-router-tickets.ts:1540-1556` (ai-edit) | dispatch hardcoded `if(provider==='codex'){binary='codex'...} else {binary='claude'...}` → **un proyecto gemini spawnearía 'claude' (binario equivocado)**. Reemplazar por `adapter.binary` + `adapter.buildArgs` (patrón ya usado en quick-spec línea 341). | **sí** |
| `server/project-router-tickets.ts:420,610,1022,1148` | bloques `if(provider==='codex')` sin hermano gemini → generalizar o añadir arm gemini. | **sí** |
| `server/setup-manager.ts:697-700,1306-1307` | regex allow-list `m[1]==='claude'\|\|m[1]==='codex'` **descarta 'gemini' silenciosamente** → install-config cae a claude. Añadir `'gemini'`. **Fallo silencioso de alto riesgo.** | **sí** |
| `server/setup-manager.ts:495-503` | `computeSummary` branch codex → hermano gemini si el summary difiere. | menor |
| `server/setup-prerequisites.ts:405-423` | switch de install-hint: añadir `case 'gemini':` (URL/comando install Gemini CLI). | menor |
| `server/agent-refine-manager.ts:73,79` | ensanchar `provider?: 'claude'\|'codex'`. (validateAgentBody ya skip non-claude). | **sí** (compile) |
| `server/chat-manager.ts:124,132,332` | ensanchar `provider?: 'claude'\|'codex'` ctor + cast persistido. Gates `adapter.id==='claude'` (scope/userMcp) ya rutean gemini como codex (OK). | **sí** (compile) |
| `server/result-event.ts:98-117` | `normaliseResultEvent` legacy shim: gemini cae al branch codex `else` (mis-parsea usage). **Preferir `adapter.extractResult`** (path moderno). Ensanchar union por si se usa. | menor |
| `client/src/types/context-scope.ts:62-67` | añadir filas de coste gemini (cliente). | menor |
| `client/src/components/analytics/ProviderBreakdownCard.tsx:9-17` | `PROVIDER_LABEL`/`PROVIDER_ACCENT`: añadir `gemini` (label + accent, p.ej. `bg-accent-success`). | menor |
| `client/src/components/Navbar.tsx:26-43` | badge: añadir `=== 'gemini'` (label/color), sino cae a 'no CLI' rojo. | menor |
| `client/src/components/SetupWizard.tsx:63-76` | heurísticas modelId sonnet/haiku/opus son claude-specific → branch gemini si el configure debe mostrar modelo. | menor |
| `server/desktop-router.ts:28-35,155-157,229-234` | gate beta: añadir `SPECRAILS_GEMINI_BETA` paralelo a `SPECRAILS_CODEX_BETA`. Generalizar el refuse hardcoded `providers.includes('codex')` (línea 229). | menor (necesario para el gate) |
| `docs/adding-a-provider.md` (**no existe en disco**) | **Crearlo** — CLAUDE.md lo referencia pero falta. Documentar el patrón "un fichero + una entrada" usando gemini como ejemplo. | menor |

**NO tocar (verificado, evitar over-edit):** `core-compat.ts` (registry-driven), `provider-selection.ts` (membership; solo necesita `CliProvider` ensanchado), `spawn-lifecycle.ts` (adapter-driven, cero literales), `result-event.ts` `finaliseInvocationResult` (id-driven), `registry.ts`, `queue-manager._resolveJobAdapter`, `COALESCE(provider,'claude')` en ai-invocations/spending/db (solo backfill de NULLs legacy), `contract-refine-runner.ts`/`smash-runner.ts` (claude-only intencional).

---

## 6. Matriz de feature-parity

| Feature | ¿Gemini lo soporta? | Qué haría falta para paridad |
|---|---|---|
| **Jobs/rails (compila + corre)** | **Degradado/Bloqueado** | Compila vía adapter. **BLOQUEANTE para rails reales**: `queue-manager.ts:976-981` pasa el slash `/specrails:implement #N` crudo a Gemini en el `else` final — Gemini NO entiende slash-commands de Claude (Codex los traduce a `$skill`). Paridad: branch gemini que mapee slash→forma que entiendan las skills de specrails-core en Gemini. |
| **Explore Spec (multi-turno)** | **Nativo (degradado)** | `--resume` headless + `--session-id` pre-asignado funcionan. Spawn-per-turn con `-p`. Sin pérdida básica. |
| **— persistent-stdin Explore** | **Bloqueado** | `persistentStdin:false` → spawn-per-turn (default OFF de todas formas). Requiere stdin stream-json long-lived que Gemini no documenta. |
| **— tool-gating (Explore/Quick scope)** | **Degradado (default-safe)** | Gates `adapter.id==='claude'` → gemini recibe args vacíos (sin restricción; usa su propio `--approval-mode plan/yolo`). Paridad: branch gemini en `toolFlagsForScope` (`context-scope.ts`) mapeando ContextScope → flags Gemini. |
| **— MCP per-spec (`.mcp.json`)** | **Degradado** | Gemini usa `.gemini/settings.json` `mcpServers`, NO el `.mcp.json` de claude ni `--mcp-config` inline. Paridad: escribir `.gemini/settings.json` en la cwd o `--allowed-mcp-server-names`. |
| **— user-MCP (My approved MCPs)** | **Degradado (default-safe)** | `buildUserMcpArgs` devuelve `[]` para non-claude. Gemini lee su MCP global desde `~/.gemini/settings.json` (como codex con `~/.codex`) → no-op correcto, sin pérdida. |
| **Quick spec** | **Nativo** | spawn one-shot vía adapter; coste por rate-card. |
| **Agent profiles** | **Bloqueado (paridad codex)** | `CLAUDE_ONLY_SECTIONS=['agents']`, `profileEnvSupport` vestigial. Oculto por intersección. Paridad: soporte por sección en `provider-capabilities.ts:44-71` + `projectSupportsProfiles` por-provider. |
| **Integrations/plugins (MCP/Serena)** | **Bloqueado (paridad codex)** | Manifest Serena omite `providerSupport` → claude-only. Paridad: añadir `'gemini'` a `providerSupport` + entry MCP bajo `.gemini/settings.json`. |
| **SMASH** | **Bloqueado (paridad codex)** | `isSmashCapable→'claude'`. `smash-runner.ts` spawnea `claude` directo sin adapter. Paridad: reescribir runner sobre `getAdapter()` + prompt/parser Gemini + flip del gate. |
| **Contract Refine** | **Bloqueado (inherentemente anthropic en su forma actual)** | `--resume` a sesión Claude + slash `/specrails:contract-refine`. Paridad parcial vía el path no-resume (re-seed por system prompt, como `runContractRefineForQuick`) + de-hardcodear `getAdapter('claude')`. |
| **Freestyle interactivo** | **Bloqueado (paridad codex)** | `mode==='freestyle' && provider!=='claude'→400`; `isFreestyle=adapter.id==='claude'`. Paridad: quitar el 400 para gemini, generalizar el branch freestyle-prompt, `persistentStdin:true` para el interactivo. Mecanismo no-anthropic; factible. |
| **Analytics/coste** | **Nativo (estimado)** | `nativeCostUsd:false` + filas pricing → coste estimado, `estimated=true`. Filtros engine ya data-driven. |
| **OTEL/telemetry** | **Nativo (MEJOR que codex)** | `nativeOtelEnv:true` → env-injection (no bridge). Solo parametrizar el enable-var en `buildTelemetryEnv`. Caveat correlación (§4). |
| **Terminal CLI launch** | **Nativo** | `CliLaunchMenu` itera providers; aparece tras ensanchar union + wiring binario. |

**Problema de la intersección binaria `=== 'claude'`**: `sectionVisibleForProviders` **oculta una sección si CUALQUIER proveedor instalado no la soporta**. En un proyecto mixto claude+gemini, Agents/SMASH/etc. desaparecen porque gemini no las declara — igual que codex hoy. **Si se generalizara `provider-capabilities.ts`** (soporte por-sección por-proveedor en vez del `Set` claude-only), Gemini *ganaría*: Agent Profiles (solo env `SPECRAILS_PROFILE_PATH`, agnóstico), tool-gating, user-MCP, file-summary cheap-model — todas mecanismo-dependientes. Solo Contract Refine es inherentemente anthropic. **Decisión v1**: paridad-codex (ocultar), generalización diferida a follow-up.

---

## 7. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Pin de versión pre-1.0** (cambia a diario; nightly 0.48) | `minCliVersion='0.11.0'` (piso validado de stream-json). `detectInstalled` surface meetsMinimum + upgrade hint. Documentar que los ids preview rotan. |
| **Drift del stream-json** (bugs #9281/#11184/#9009) | Esos bugs son del `--output-format json` (single-object `response`), **NO del stream-json** (usa message deltas, sin `response`). #9009 (flag desconocida) cerrado, afecta <0.6 — el pin 0.11 lo evita. **Golden-snapshot test**: fixtures NDJSON bajo `__fixtures__/` verbatim del `stream-json-formatter.test.ts` upstream, aserción `toEqual` sobre el AdapterEvent[]. |
| **Scope por cwd-hash en resume** | Sesiones scopeadas por `getProjectHash(cwd)`. **Siempre spawn desde `project.path`** (ya lo hace el host). Resume cross-cwd no encuentra la sesión → host-controllable. Pre-asignar `--session-id <UUID>` para no depender de parsear init en builds <2025-12-04. |
| **Exit code 53** (turn limit, no quota) | Mapear 53 = "cap de turnos `maxSessionTurns`" distinto de error general. 42 = bad input/args. Resto non-zero → tratar como exit 1 (general/API). Quota/429/403 colapsan a exit 1. |
| **Auth headless** | **Presetear `GEMINI_API_KEY`** en el env de spawn → `getAuthTypeFromEnv()` devuelve `USE_GEMINI`, `validateAuthMethod` pasa, sin browser. Alt CI: `GOOGLE_GENAI_USE_VERTEXAI=true`+`GOOGLE_CLOUD_PROJECT`+`GOOGLE_CLOUD_LOCATION`+`GOOGLE_APPLICATION_CREDENTIALS`. **No setear `security.auth.enforcedType`** conflictivo. Sin var de auth → `process.exit(FATAL_AUTHENTICATION_ERROR)` (no browser). El host necesita un flujo para que el usuario provea la API key (Settings/AddProject). |
| **Drift OTEL** (correlación `session.id` vs `specrails.job_id`) | Telemetry OFF por defecto → no bloquea v1. Al activar: validar si Gemini propaga `OTEL_RESOURCE_ATTRIBUTES`; fallback correlación por `--session-id` de spawn-time. |
| **Bug OTLP/HTTP #15581** (POST a `/` no `/v1/{signal}`) | Usar `GEMINI_TELEMETRY_OTLP_PROTOCOL=grpc` (default :4317, well-tested), evitar HTTP. |
| **Coste >200k tokens infra-estimado** | Aceptado en v1 (tier ≤200k). Analytics marca `estimated`. Follow-up: tiering en `PriceEntry`. |

---

## 8. Plan de tests + coverage

CI exige **80% server** (lines/functions/statements, 70% branches) y **80% client** (lines/statements, 70% functions). Cada fichero tocado debe llegar.

**Tests nuevos server:**
- `server/providers/gemini-adapter.test.ts` (espejo de `codex-adapter.test.ts`):
  - `capabilities` exactos (8 campos).
  - `buildArgs` por cada uno de los 9 SpawnActions (línea exacta; resume throw si `!sessionId`; chat-stream throw; fold cuando `systemPromptArg=false`; `extraArgs` appendeado).
  - `parseStreamLine`: fixtures NDJSON bajo `server/providers/__fixtures__/gemini-*.ndjson` (init/message/tool_use/tool_result/error/result/línea-vacía/parse-fail), aserción del AdapterEvent[].
  - `extractResult`: stats → tokens_in/out/cache_read, num_turns, session_id, `total_cost_usd` undefined.
  - `detectInstalled`: mock de `execSync` (no instalado / version OK / version < min / probe-fail / timeout >3s → installed:false).
- `server/pricing.test.ts`: 4 filas `gemini:*`, `estimateCostUsd('gemini',model,usage)` correcto; clave ausente → null; semántica cached (no doble-conteo).
- `server/provider-selection.test.ts`: `isProviderEnabled`/`resolveProvider`/`validateRequestedProvider` aceptan `'gemini'`; multi-provider claude+gemini.
- `server/providers/registry.test.ts`: `getAdapter('gemini')`/`hasAdapter`/`listAdapters` incluye gemini tras import de index.

**Tests nuevos client:**
- `ModelSelector`/`ChatInput`: provider `'gemini'` muestra `GEMINI_MODELS` (no Codex).
- `AddProjectDialog`: checkbox gemini cuando `/available-providers` lo devuelve; `noProviderAvailable` iterado.
- `provider-capabilities.test.ts`: `providerLabel('gemini')`, `sectionVisibleForProviders` oculta Agents/SMASH en proyecto con gemini (paridad codex).
- `ProviderBreakdownCard`/`Navbar`: label+accent gemini.

**Gate `SPECRAILS_GEMINI_BETA`**: test en `desktop-router.test.ts` — con `=0`, `/available-providers` devuelve `gemini:false` y `POST /projects` con `providers:['gemini']` se rechaza; default/`1` → habilitado. Espejo de `SPECRAILS_CODEX_BETA`.

**Cumplir 80%**: el adapter es lógica pura (sin I/O salvo `detectInstalled` mockeado) → fácil 100%. Cubrir los 9 cases de `buildArgs` garantiza branch coverage. Las filas pricing y los branches `=== 'codex'` generalizados necesitan un test que ejercite el path gemini (ai-edit con provider gemini → `adapter.binary='gemini'`). Excluir solo lo Tauri-only inalcanzable en jsdom, documentando inline; **nunca para enmascarar tests faltantes**.

---

## 9. Rollout por fases

1. **PR-A (generalización previa)** — ensanchar `CliProvider`/`ProviderId`/las ~12 uniones `('claude'|'codex')[]`, desramificar `/available-providers` y `spec-models.ts`/`ModelSelector`/`ChatInput` a lookups por id. **Sin Gemini todavía**; comportamiento idéntico. Mergeable y testeable solo. Reduce el blast-radius del PR-B.
2. **PR-B (el adapter)** — `gemini-adapter.ts` + `register` + filas pricing + branches gemini (ai-edit dispatch, setup-manager regex, install-hint) + labels/accents + `SPECRAILS_GEMINI_BETA`. **Gemini detrás del gate beta**, default ON con kill-switch.
3. **Beta-gated validation** — probar end-to-end: detect, add-project con gemini, Quick spec, Explore multi-turno (resume), Analytics coste, terminal launch. Validar exit 53/42, auth `GEMINI_API_KEY`. **NO** habilitar rails reales hasta resolver la traducción slash-command (§6, bloqueante) — gemini sirve para spec/explore/quick en esta fase.
4. **Docs** — crear `docs/adding-a-provider.md` (falta) con gemini como ejemplo, y `docs/gemini.md` (espejo de `docs/codex.md`) con setup de API key.

**Primer commit recomendado:** PR-A paso atómico — ensanchar `server/desktop-db.ts:10` `CliProvider` para incluir `'gemini'` y convertir el ternario de `server/spec-models.ts:1-37` `getModelsForProvider` en lookup `Record<provider, SpecModelOption[]>`. Desbloquea la cadena de tipos sin tocar comportamiento y deja la base lista para registrar el adapter.

**Puntos `[UNCERTAIN]` pendientes (no inventados):** (a) `OTEL_RESOURCE_ATTRIBUTES` propagation en Gemini — validar empíricamente antes de confiar para correlación job/project; (b) semántica de `cachedContentTokenCount` como subconjunto de input — fijar por test de pricing; (c) `mcpRegistration` exacto en la versión bundleada — verificado que escribe a settings.json (`project-json`), confirmar en build. Ninguno bloquea v1 (spec/explore/quick); todos tienen fallback.
