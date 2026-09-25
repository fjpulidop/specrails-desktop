# Motor de agentes en Core: catálogo de workflows LangGraph coordinados desde los loops de Desktop

Estado: **plan preparado; implementación pendiente**. Fecha: 25 de septiembre de 2026.

Base sobre la que se escribió: specrails-core **6.0.0** (`integration-contract.json` `schemaVersion: "5.0"`, `RUNTIME_API_VERSION = 1`, `CORE_WORKFLOW_VERSION = '6'` en `src/agent-runtime/core-host.ts:24`, `ROLE_INSTRUCTIONS_VERSION = '9'` en `src/agent-runtime/prompts.ts:7`); specrails-desktop **2.57.0** (`CORE_BUNDLE_VERSION: "6.0.0"` en `.github/workflows/desktop-release.yml:48`, `SUPPORTED_CORE_MAJORS = [4, 5, 6]` y `CORE_PACKAGE_SPEC = 'specrails-core@^6.0.0'` en `server/core-package.ts:5, 12`, última migración de base de datos: **63** en `server/db/migrations.ts`).

Este documento sigue las convenciones de [`implementation-efficiency.md`](implementation-efficiency.md): bloques Core `C0..Cn`, bloques Desktop `D0..Dn`, tabla de etapas y responsabilidad explícita por repositorio. Los identificadores marcados como *(propuesto)* no existen todavía en el código; el resto son reales y se han contrastado con el código fuente. Cuando una ruta lleva número de línea, es la línea en la base indicada arriba; al retomar el plan hay que revalidarla (sección 14).

Origen: análisis del 25 de septiembre de 2026 sobre las cuatro copias locales (core, desktop, web, companion) con nueve lectores de código, cuatro propuestas de diseño independientes (core-first, incremental-adapter, two-plane-contract, skeptic), tres jueces y una pasada de verificación adversarial de doce afirmaciones sobre el código (siete reformuladas). La dirección elegida es **incremental-adapter** con injertos de las otras tres; la sección 4 explica qué se toma de cada una y por qué se descartan las alternativas.

## 1. Objetivo y medida de éxito

Objetivo: que un usuario pueda componer, desde el Loop Builder de Desktop, un loop cuyos pasos de IA sean **workflows LangGraph alojados en Core** (no solo `implement`), elegidos por id, con checkpoint, receipts y evidencias de Core, mientras Desktop sigue siendo la autoridad sobre specs, rails, worktrees, PRs, presupuesto y contabilidad. La filosofía queda intacta y reforzada: **Desktop diseña specs, los rails las ejecutan en un worktree, los loops coordinan**, y lo que coordinan pasa a ser un catálogo de workflows de Core en lugar de prompts `{{cmd:*}}` que simulan roles.

Señales medibles al terminar la etapa 4:

1. Un loop publicado con un nodo `operation: 'core-workflow'` *(propuesto)* y `workflowId: 'specrails-review'` *(propuesto)* se lanza desde un rail, ejecuta la verificación determinista y el reviewer de Core, y su veredicto llega al review packet por la vía que ya existe: `readRuntimeEvidence` lee `state.steps.reviewer.output` del checkpoint (`server/modules/delivery/runtime/delivery-evidence.ts:536-538`) y `harvestDeliveryEvidence` lo proyecta como `evidence.confidence` cuando no hay `confidence-score.json` (`delivery-evidence.ts:436-446`). Funciona igual en los cuatro CLIs y en openai-compatible.
2. Ninguna ejecución guardada con Core 6.0.0 deja de reanudar: el fingerprint de `specrails-implementation` v6 no cambia (test de snapshot en C0) y `legacy-runtime.test.ts` sigue en verde.
3. Cada fase interna de un run de Core se ve como paso hijo en `LoopStepExplorer`, y la contabilidad por rol suma exactamente el `invocationUsage` del `runtime-result` (test de paridad en D2) sin duplicar filas en `ai_invocations`.
4. Un run pausado por pregunta (`exit 2`) se responde desde el chat del job (`POST /:projectId/jobs/:id/messages`), no solo desde Agent Runtime settings (D3).
5. Un reinicio de Desktop deja un loop con cursor persistido en `paused`, no en `completed`/`failed` (D4).
6. Ninguna etapa anterior a la 7 exige un salto mayor del contrato de integración.

## 2. Diagnóstico verificado

### 2.1 Lo que existe hoy

**Core ya tiene el motor.** `runWorkflow(options)` (`specrails-core/src/agent-runtime/workflow.ts:150`) construye un `StateGraph` con un `addNode` por nodo de la `WorkflowDefinition` (`workflow.ts:489-492`), una única arista estática `START → entry` (`:491`) y enrutado dinámico por `Command({goto})` que exige que el sucesor esté en `ends` (`:459-477`). Aporta interrupciones `approval`/`question` (`workflow-types.ts:22-25`), un ledger autoritativo y el checkpoint de LangGraph en un mismo sobre atómico (`durable-store.ts`), lease por directorio (`durable-store.ts:140-172`), presupuesto por run (`WorkflowBudget`), reintentos por nodo (`maxAttempts`, `retrySafe`), invalidación selectiva y recuperación explícita de escrituras interrumpidas. Rechaza reanudar si cambia el fingerprint de la definición o de la entrada (`workflow.ts:67-70, 174-176`).

**Pero solo hay un grafo en producción.** `runCoreWorkflow` (`core-host.ts:75-149`) construye `coreNodes(deps)` (`:108`) y declara `{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, entry: 'architect', nodes en CORE_NODE_ORDER }` (`:140-147`; `graph/state.ts:74-76`: `['architect','developer','fixer','verify','reviewer','archive']`). El orden de declaración fija el "downstream" de invalidación (`workflow-types.ts:89`); el recorrido real lo deciden los `ends` de cada nodo (`graph/nodes.ts:103, 237, 252, 265, 375, 425`): architect → developer → verify → reviewer → archive, con `fixer` solo en correcciones. En el CLI únicamente `runtime run|resume` ejecutan el grafo (`cli.ts:182`); `runtime status` es de solo lectura (`cli.ts:151-156`). El request congelado `agent-runtime-request.json` guarda `{change, config, runtimeIdentity}` (`cli.ts:158-177`, creado con `wx`): `runtimeIdentity.workflowVersion` persiste la **versión** (`core-host.ts:26-27`, `runtime-identity.ts:6-12`), pero no hay ningún **id** de workflow en el request; `specrails-implementation` vive solo en `core-host.ts:141` y en el estado del checkpoint.

**La documentación de Core ya describe el modelo de extensión.** `docs/agent-runtime.md:245-268` ("Embed and extend") enseña `runWorkflow()` para "a different host workflow", ejecutores personalizados vía `ExecutorRegistry` y `coreNodes(deps)` exportado "for hosts that want to reuse a phase inside another graph" (`src/agent-runtime/index.ts`). Desktop, sin embargo, **nunca importa Core en proceso**: `agent-runtime-loader.ts:67-73` lo evita a propósito (Core es ESM; Desktop es CJS más un sidecar `pkg`) y habla con Core solo por subproceso: `api`, `capabilities --stdin`, `prompts`, `validate --stdin` (`agent-runtime-loader.ts:78-105`), `run|resume` (`agent-runtime-bridge.ts:81`), `status` (`server/core-execution.ts:137-144`) y `recovery` (`agent-runtime-recovery.ts`).

**Desktop tiene su propio motor de loops.** `LoopRunManager.run()` (`server/modules/loops/runtime/loop-run-manager.ts:1038`) recorre secuencialmente, con un sucesor por nodo, un `LoopGraph` cuyos tipos son `start | ai-step | shell | decider | condition | end` (`loop-graph.ts:12`); la validación rechaza ramificaciones (`loop-graph.ts:234-255`, `UNSUPPORTED_BRANCHING`). Un nodo se trata como implementación de Core cuando lleva `operation: 'core-implementation'` (`loop-graph.ts:33`), cuando su prompt casa con `{{cmd:implement|batch}}` o cuando empieza por `/specrails:implement`, `/skill:specrails-implement`, `$implement` o `$batch-implement` (`loop-run-manager.ts:1628-1629`); `loop-executors.ts:263-273` lo despacha a `runAgentRuntimeInvocation`, que lanza `node <cli> run|resume --context … --config … --change runtime-<sha>` (`agent-runtime-bridge.ts:81, 111`). Todos los demás pasos de IA lanzan el CLI del proveedor con el prompt expandido (`loop-executors.ts:325`), con dos excepciones: los pasos de verificación con request de runtime existente devuelven un resultado determinista de `checkCoreCompletion` sin lanzar proveedor (`loop-executors.ts:275-277`), y los pasos no-Core pueden ir por la sesión interactiva de Claude (`planInteractiveAiStep`, `loop-executors.ts:465-511`; `_runInteractiveAiStep`, `loop-run-manager.ts:1685-1707`). `prepareCoreExecution` corre para **todo** `ai-step` (`loop-executors.ts:261`) y `validateCoreCompletion` vuelve a ejecutar `status` tras un paso Core (`loop-run-manager.ts:1807-1818`).

**Rails.** Con Loops activos (por defecto, `feature-flags.ts:51-53`) todo lanzamiento pasa por `LoopRunManager`: un `loopId` ausente se rellena con `factoryLoopForMode` (`rails-router.ts:564-566`) y la rama de `:758` llega a `c.loopRunManager.run` (`:1136-1137`). El camino QueueManager con `/specrails:implement` (`rails-router.ts:1257-1260`) solo sobrevive con `SPECRAILS_LOOPS_SECTION=false`. La entrega (worktrees, `rail_pr_deliveries`, review packet) es de Desktop y no depende del motor. Core exige `ownership.git === 'host'` (`core-host.ts:53`); Desktop lo garantiza con `SPECRAILS_GIT_AUTO=false`, pero de forma condicional: `loop-executors.ts:131` solo lo fija si hay manifiesto de ejecución o `isRailPrDeliveryEnabled()`; con `SPECRAILS_RAIL_DELIVER_PR` apagado y sin manifiesto, `core-execution.ts:89` produce `ownership.git: 'core'` y Core rechaza el run.

**Un loop de fábrica es un solo paso opaco.** `factory:implement` y `factory:batch` son un único `ai-step` con `operation: 'core-implementation'` (`loop-factory.ts:47-69`); todo el grafo interno de Core se ve desde el loop como un paso sin fases visibles ni contabilidad por rol.

### 2.2 Qué está duplicado

- Dos motores de "iterar hasta verificar": `LoopRunManager` (deciders, `maxIterations`, coste entre pasos, watchdog de inactividad, pausa humana en `awaitHumanDecision`, `loop-run-manager.ts:1496-1554`) y `runWorkflow` (presupuesto, `maxAttempts`, `recoverInterrupted`, interrupciones).
- Dos almacenes de estado: `loop_runs` + `events` en SQLite frente a `agent-workflow/<runId>/checkpoint.json`.
- Dos planos de control humano: `POST /:projectId/jobs/:id/messages` (`project-router-jobs.ts:364-384`, resuelve la decisión pausada en proceso) y `POST /:projectId/agent-runtime/runs/:runId/resume` (`agent-runtime-controls-router.ts:61-64`; `AgentRuntimeControls.resume`, `agent-runtime-controls.ts:285-386`, exige que el `loop_run` padre esté `completed`: es una continuación post-terminal).
- Dos capas de configuración de agentes con intención solapada: `.specrails/agent-runtime.json` (roles de Core) y los perfiles/`custom-*.md` de la página Agents, que Core 5+ ya no lee (`SPECRAILS_PROFILE_PATH` no aparece en `specrails-core/src` fuera de un comentario en `installer/util/registry.ts:63`).
- La validación semántica de la configuración de runtime está reimplementada en Desktop como espejo de `config.ts` (`agent-runtime-settings.ts:146-216`) sobre una copia vendorizada byte a byte del schema (`server/schemas/agent-runtime.schema.json`, paridad en `agent-runtime-settings.test.ts:192-194`).
- Dos formas de verificar: el sentinel de texto `VERIFICATION: PASS|FAIL` parseado de la salida de un CLI (`execution/runtime/verification-sentinel`) frente al receipt determinista de Core (`verifyPipeline`, `pipeline-state.ts`).

### 2.3 Qué es configurable y qué está cableado

Configurable por datos (`.specrails/agent-runtime.json`, schema v1): proveedor/modelo/esfuerzo/thinking/escalado por rol (`executor-types.ts:23-31`), límites, comandos de verificación, umbrales de review (solo endurecer, `config.ts:46-50`), `rolePrompts` (`config.ts:193-203`), guardrails, eficiencia.

Cableado en código de Core:

- El conjunto de roles: `AgentRole = 'architect' | 'developer' | 'reviewer'` (`executor-types.ts:8`), validado en `validateAgentRequest` (`executor-types.ts:135-136`), `ROLES` en `config.ts:6, 85, 108`, `additionalProperties: false` + `required` en `schemas/agent-runtime.schema.json:38-40`, `ROLE_SKILLS` (`openspec.ts:12`), ramas de `roleInstructions` (`prompts.ts:398-410`), despacho compacto (`openai-executor.ts:87`), motivos de escalado (`role-routing.ts:18-21`), bucle OpenSpec por rol (`core-host.ts:91-95`), agregados de eficiencia (`efficiency.ts:8`, `efficiency-summary.ts:105, 126`). `fixer` es un pseudo-rol cableado (`AgentEventRole`, `stance?: 'fixer'`, `rolePrompts.fixer`, `config.ts:196`) que no es `AgentRole`.
- Los permisos derivados del rol, con dos semánticas distintas: el binario lectura/escritura (`readOnly = request.role !== 'developer'` en `cli-executor.ts:30, 236, 243` y `kimi-acp.ts:15-16`; `this.role === 'developer'` en `workspace-tools.ts:55-56`; `writeProgress` en `openspec.ts:64`) y el **alcance de escritura de artefactos** en `openspec.ts:212-223` (reviewer: nada; developer: solo casillas de `tasks.md`; architect: proposal/design/specs/tasks). `AgentRequest` (`executor-types.ts:85-111`) no tiene campo `access`.
- La forma del grafo y `maxTransitions` (`core-host.ts:145`).
- El journal `state.json`: `PHASES = ['architect','developer','reviewer','archive','ship','ci']` (`pipeline-state.ts:110`) con orden obligatorio en `transitionPipeline` (`pipeline-state.ts:575-586`). Los nodos lo actualizan a mano (`nodes.ts:105, 183, 328, 377`). `pipeline-state.ts` se compila y se copia a cada proyecto como `.specrails/runtime/pipeline-state.mjs` (`scaffold.ts:1645-1650`, `src/architecture.test.ts:48-51`).

Cableado en Desktop: `STEP_IDS` (`agent-runtime-controls.ts:23`), `PHASES` y el validador de ≤ 3 roles (`agent-runtime-metrics.ts:25, 76, 91`), `ROLES`/`PROMPT_ROLES` (`agent-runtime-settings.ts:139, 320`), `RUNTIME_ROLES` en el cliente (`client/src/features/settings/lib/agent-runtime.ts:4-7`) y el gate `checkCoreCompletion`, que exige fases `architect/developer/reviewer/archive` en `done`, veredicto de completion, receipt `full` válido y estado programático `succeeded` (`core-execution.ts:137-181`).

### 2.4 Deriva del contrato

El bloque `agentRuntime` de `integration-contract.json` declara `workflowVersion: "3"` e `instructionsVersion: "3"` (líneas 280-281) frente a `'6'`/`'9'` en código; `phases` omite `fixer` (260-266); `cliOperations` lista `api, validate, run, status, resume` (227-233) mientras `cli.ts:88-143` despacha además `prompts, capabilities, evaluate, evidence, recovery`. El `schemaVersion: "5.0"` de nivel superior no es deriva: lo fija a propósito `src/installer/phases/install-config.test.ts:380` y Desktop solo exige mayor ≥ 4 (`setup-manager.ts:693`). Hoy es metadato obsoleto sin efecto en runtime (ni el instalador ni `validateCoreContract` consumen esos campos; Desktop obtiene `workflowVersions` de `runtime api`, `cli.ts:119`, `agent-runtime-loader.ts:78-86`), pero deja de ser inofensivo en cuanto un segundo workflow quiera anunciarse por contrato. Pins adyacentes desfasados: `agent-runtime-package.test.ts:67` (gateado por env) espera `workflowVersions: ['5']` y `docs/internals/programmatic-agent-runtime.md:118` sigue diciendo que el bundle fija Core 5.1.1.

## 3. Qué aporta LangGraph de verdad y dónde no aporta nada

Superficie de LangGraph realmente usada (`workflow.ts`): checkpointer propio (`FileCheckpointSaver`, `graph-checkpointer.ts`, compilado en `:492`), `interrupt()` (`:353-359`), `getStateHistory` para bifurcar al checkpoint anterior al nodo objetivo (`:509-511`), `graph.getState` para reconciliar la posición con el ledger (`:500`), `Command({resume})` para responder una interrupción (`:502`), replay con `Command({goto})` cuando se pierde un checkpoint (`:327`), `graph.invoke` con `durability: 'sync'` y `recursionLimit` calculado (`:526`) y `Annotation` para el schema (`graph/state.ts:1`). Lo que **no** hay: `Send` (fan-out), subgrafos, `addConditionalEdges` ni streaming; `WorkflowState.nextStep` es `string | null` (`workflow-types.ts:174`) e `InterruptRequest` solo admite `approval` y `question`. Es decir: **un ejecutor durable de pasos con un solo sucesor y dos tipos de interrupción**, la misma forma que `validateLoopGraph` impone al loop de Desktop.

Lo que LangGraph sí da y el loop de Desktop no tiene: reanudación durable a través de reinicios de proceso con invalidación selectiva (`--recover`, `--invalidate`), presupuesto por run con receipts atados al candidato, y un ledger que distingue intento, visita y uso por paso (`workflow-types.ts:162-194`). Eso es valioso para **cualquier** pipeline de agentes, no solo para implement.

Lo que LangGraph no resuelve por sí solo: fan-out paralelo (exigiría rediseñar `nextStep`), steering en mitad de un turno (el hijo se lanza con stdin `ignore`, `agent-runtime-bridge.ts:133-136`), paridad de proveedores (Kimi no reporta uso, `kimi-acp.ts:145`; Gemini es `unknown`, `capabilities.ts:17`; solo Claude acepta tope en USD, `cli-executor.ts:205-208`) ni un DSL declarativo (las definiciones son closures TypeScript).

Conclusión: la apuesta correcta no es "mover los loops a LangGraph" sino **exponer el motor de Core como catálogo de workflows con nombre** y dejar que los loops de Desktop los coordinen. La durabilidad del recorrido del loop se resuelve en Desktop con un cursor (D4), no sincronizando dos ledgers nodo a nodo, condición explícita de `docs/internals/agent-runtime-framework-evaluation.md` ("cada ejecución pertenece a un único motor").

## 4. Decisiones de producto y arquitectura

Alternativas evaluadas y resultado del panel (puntuaciones medias sobre 10 de los tres jueces: arquitectura e invariantes, entregabilidad y riesgo, producto y filosofía):

| Propuesta | Puntuación | Por qué no gana en solitario |
|---|---|---|
| core-first (Core como motor genérico con DSL JSON; los loops se compilan a LangGraph) | 4,3 | Reescribe `nextStep`/`Send`, anida `runWorkflow` en el mismo directorio (colisión de lease), obliga a subir `CORE_WORKFLOW_VERSION` y deja huérfanos los runs guardados; nadie ha pedido fan-out |
| two-plane-contract (manifiesto de "equipos", steering por buzón, MCP por run) | 6,0 | Buen contrato, pero arranca con un salto mayor del contrato y roles abiertos antes de tener un segundo workflow |
| skeptic (higiene primero, cursor durable en Desktop, workflow de solo lectura primero) | 7,2 | Secuencia excelente del riesgo, pero deja el catálogo demasiado tarde |
| **incremental-adapter** (catálogo TypeScript en Core, `--workflow`, nodo `core-workflow` en loops) | **7,7** | Gana en los tres ejes; se le injertan la higiene y el cursor del skeptic, el manifiesto descriptivo y el buzón de steering de two-plane y la capacidad MCP por run de core-first como idea tardía |

Decisiones:

| Decisión | Por qué | Qué protege |
|---|---|---|
| Core expone un **catálogo de workflows TypeScript** compuestos de `coreNodes`/`createRoleInvoker`, seleccionados con `runtime run --workflow <id>` | Es el modelo de extensión que `docs/agent-runtime.md:245-268` ya describe; evita un motor genérico que nadie ha pedido | Dirección `shared ← pipeline ← agent-runtime ← installer` (`src/architecture.test.ts:33-37`); ningún módulo nuevo en Core |
| `specrails-implementation` conserva id, versión `'6'`, orden de declaración, `ends` y `maxTransitions`; un test de snapshot fija su fingerprint | `core-host.ts:79` rechaza cualquier checkpoint con otra `workflowVersion` y `workflow.ts:174-176` cualquier cambio de forma; ambos dejan huérfanos los runs guardados | Reanudación de runs existentes y el fixture v4 (`legacy-runtime.test.ts`) |
| `LoopRunManager` sigue siendo la única autoridad del loop; un nodo `core-workflow` es **atómico** para el loop | Condición de un solo motor por ejecución; Desktop nunca planifica dentro de un workflow de Core | Atomicidad de lanzamiento (`loop-run-manager.ts:1105-1143`), outbox terminal (`loop-runs-store.ts:142-232`), `runId === jobId` |
| Cada paso Core de un loop recibe su propio `coreRunId = <runId>.<nodeId>` *(propuesto)*; el paso implement conserva `coreRunId = runId` | Las regex de id admiten `.` (`pipeline-state.ts:139`, `agent-runtime-controls.ts:22`); cada paso tiene directorio, lease y `checkpoint.json` propios | Lease atómico por directorio; la evidencia del paso implement sigue en la ruta que lee `delivery-evidence.ts:497-557` |
| Los workflows no-implement **no tocan las fases del journal** (`journal: 'ledger-only'`); declaran su completion en el ledger | `transitionPipeline` exige orden de fases y `pipeline-state.ts` se copia compilado a cada proyecto; modificarlo obliga a rematerializar el framework | `checkCoreCompletion` queda intacto y exclusivo de implement |
| Un workflow de solo lectura que **rechaza** termina el run como `succeeded` con `completion.ok: false` y `exit 0` | El bridge marca `failed` cualquier `exit ≠ 0` (`agent-runtime-bridge.ts:197-211`), y dos fallos seguidos abortan el loop (`AI_FAILFAST_THRESHOLD = 2`, `loop-run-manager.ts:481`); el decider tiene que ver el veredicto, no un fallo | Loops `fix → review → decider` funcionan; `failed` queda reservado a errores de ejecución |
| Contrato **5.1 aditivo** y capacidad `workflowCatalog: 1` en `runtime api` | Mismo patrón que `configurableGuardrails` (`agent-runtime-bridge.ts:92-93`, `agent-runtime-settings-router.ts:27`); Desktop viejo + Core nuevo y viceversa siguen funcionando | Acoplamiento de releases mínimo; `check-core-compat` solo actualiza la constante esperada |
| Roles abiertos (`access` + alcance de artefactos) solo cuando el primer workflow con un rol fuera del trío lo exija | Diez sitios cableados, dos semánticas de permiso y el snapshot byte a byte del argv de Claude (`compact-runtime.test.ts:464-473`) la hacen la refactorización más cara; pagarla sin caso de uso es riesgo puro | Paridad de proveedores y Windows (Kimi ACP) |
| Desktop es el único escritor de `ai_invocations`; Core informa, no contabiliza; el desglose por rol va a una tabla hija | Semántica desconocido ≠ 0, `estimated`, reparto entero compartido; `bySurface` y `programmaticUsageAvailability` no deben ver filas duplicadas | `server/util/distribute-int.ts`, `parseProgrammaticUsage` (`agent-runtime-accounting.ts:23-69`), `spending.ts` |
| Steering por buzón de fichero consumido en límites de intento, sin stdin ni línea de protocolo nueva | El request congelado y la identidad del runtime no cambian; funciona igual en los cuatro CLIs | `wx` de `agent-runtime-request.json` (`cli.ts:171-175`), `sameRuntimeIdentity` |
| Durabilidad del recorrido del loop mediante cursor y request congelado en `loop_runs` (Desktop), no moviendo el recorrido a Core | Cierra el único hueco real de durabilidad reutilizando `loop_step_recovery` y el outbox | Reconciliación en arranque (`project-registry.ts:1526`) |
| Pausa por pregunta con **un solo escritor**: el propio paso del loop reanuda a Core con `resume + answer`; `AgentRuntimeControls` no interviene mientras el loop está vivo | `AgentRuntimeControls.resume` exige loop `completed` y sin run activo (`agent-runtime-controls.ts:287-288`); un loop pausado sigue reteniendo `railLoopRuns`, la fila `jobs` y el asignador de `seq` | Sin dos escritores sobre el mismo run |

Arquitectura objetivo (specs → rails → loops → workflows de Core):

1. **Specs** se diseñan en Desktop (Quick/Explore/missions/Project Builder) y se congelan por run en `desktop-context.json` (`core-execution.ts:85-101`).
2. **Rails** eligen loop, engine, worktree y presupuesto; entregan por `rail_pr_deliveries`.
3. **Loops** coordinan pasos: shell, decider, condition y, ahora, `core-workflow:<id>` además de `core-implementation`.
4. **Core** ejecuta cada workflow con checkpoint, receipts, evidencias y roles configurados, y devuelve completion y uso por paso por el mismo protocolo JSONL.

## 5. Contrato Core ⇄ Desktop

**Definición de workflow (Core, TypeScript).** Un `WorkflowHost` *(propuesto)* en `src/agent-runtime/workflows/registry.ts` *(propuesto)*:

```
{ id, version,
  requiresChange: 'new' | 'existing',
  journal: 'implementation' | 'ledger-only',
  roles: [{ id, access: 'read' | 'write', artifacts: 'none' | 'tasks-checkboxes' | 'all', openspecSkill? }],
  steps: string[],                       // orden de declaración (invalidación), no de ejecución
  interrupts: ('approval' | 'question')[],
  build(deps) => WorkflowDefinition,
  completion(state, context) => { ok: boolean; reasons: string[] } }
```

`roles[].access` y `roles[].artifacts` son descriptivos hasta C3, donde pasan a alimentar los ejecutores y el alcance de `openspec.ts:212-223`. `implement` es el primer registro: `build` devuelve el literal actual de `core-host.ts:140-147` sin cambios y `completion` delega en la inspección que hoy hace `checkCoreCompletion` del lado Desktop (fases, receipt, aceptación).

**Comandos y flags.** `runtime run --context --config --change --workflow <id>` (por defecto `specrails-implementation`); `resume` lee el id del request congelado y rechaza `--workflow`; `status` sigue siendo de solo lectura y solo añade campos; `runtime api` añade `workflows: [{id, version, steps, roles, requiresChange, journal, interrupts}]` y `capabilities.workflowCatalog: 1` junto a las ocho capacidades actuales (`cli.ts:119`). Nuevo verbo `runtime signal --context --stdin` en C4. Ningún flag existente cambia de significado. `runtime evaluate` sigue siendo una herramienta interna de Core y **no** entra en `cliOperations` del contrato.

**Request congelado.** `agent-runtime-request.json` gana `workflow: {id, version}`; ausente ⇒ implement. No se añade un digest de definición al `input` de `runWorkflow`: `workflowFingerprint` ya rechaza cualquier cambio de id/versión/forma y `runtimeIdentity.packageIntegrity` (sha256 del paquete, `runtime-identity.ts:15-30`, incluido en la entrada en `core-host.ts:111`) ata la reanudación a los bytes exactos del paquete. C1 añade un test que demuestre `INCOMPATIBLE_RESUME` al reanudar con otro id del catálogo.

**Eventos JSONL.** Sin tipos nuevos: `workflow-event`, `agent-event`, `verification-output`, `span`, `runtime-efficiency-event`, un único `runtime-result` (`cli.ts:185-193`). `runtime-result` y `runtime-status` añaden `workflow: {id, version}` y `completion: {ok, reasons}`; los `workflow-event` `step_succeeded/step_failed` ya llevan `usage` por intento (D2 los explota). Códigos de salida 0/2/1 intactos. Una línea de más de 2.000.000 caracteres invalida el protocolo y el bridge mata al hijo (`agent-runtime-bridge.ts:144-146`): las salidas de completion deben ser acotadas.

**Nombre del change para workflows sobre un cambio existente.** El bridge deriva hoy el change de `runtimeChangeName(coreRun.runId)` (`agent-runtime-bridge.ts:17-19`). Con `coreRunId = <runId>.<nodeId>` esa derivación apuntaría a un change distinto del que implementó el paso anterior. Regla *(propuesta)*: el nodo `core-workflow` declara `change: 'implement-step' | 'run' | '<literal>'`; `implement-step` (por defecto) resuelve `runtimeChangeName(runId)` del paso implement del mismo run, `run` resuelve `{{run.changeId}}` capturado por un paso `opsx:ff`, y el literal se interpola. Si el workflow declara `requiresChange: 'existing'` y no hay change resoluble, el paso falla **antes** de lanzar Core (`loop-run-manager.ts`, validación previa al spawn).

**Identificador de run por paso.** `coreRunId = <runId>.<nodeId>`; los ids de nodo `core-workflow` se restringen a `^[a-z0-9][a-z0-9-]{0,63}$` en `validateLoopGraph` para que el sufijo sea separable sin ambigüedad (`SAFE_ID` acepta `.`, pero el `runId` no lo contiene). Todo consumidor de Desktop que hoy indexa por `runId` (`readCoreCompletion(runId)`, `loop-run-manager.ts:2250`; `hasAgentRuntimeRequest`/`runtimeRunSummary`, `agent-runtime-controls-router.ts:16-19`; búsqueda del loop padre en `agent-runtime-controls.ts:250-283`) recibe un helper `parseCoreRunId` *(propuesto)* que separa run y nodo.

**Evidencia.** Todo workflow escribe bajo `<backlogRoot>/.specrails/pipeline/<coreRunId>/` con `state.json` (inicializado por `initializePipeline`, sin transiciones de fase en `ledger-only`), `verification/evidence/*.json` y `agent-workflow/<coreRunId>/checkpoint.json`. Los nodos de `specrails-review` se llaman `verify` y `reviewer`, y el `output` del reviewer tiene la misma forma que `ReviewRecord` de implement (`graph/state.ts`), de modo que `readRuntimeEvidence` (`delivery-evidence.ts:497-557`) y la proyección a `evidence.confidence` (`:436-446`) funcionan sin cambios.

**Versionado.** `integration-contract.json` 5.0 → **5.1** en C0 (aditivo: bloque `agentRuntime.workflows`, corrección de `workflowVersion`, `instructionsVersion`, `phases`, `cliOperations`; el pin de `src/installer/phases/install-config.test.ts:380` y la mención de `CLAUDE.md:27` se actualizan en el mismo commit). `RUNTIME_API_VERSION` sigue en 1. `CORE_WORKFLOW_VERSION` sigue en `'6'` porque solo describe el grafo implement; cada workflow lleva su propia `version`. La identidad de runtime por run sigue congelada: un `coreRunId` nuevo retiene su propio paquete por `retainAgentRuntime` (cacheado por digest). Salto a contrato 6.0 solo en la etapa 7.

**Compatibilidad hacia atrás.** Desktop nuevo + Core 6.0: el bridge rechaza `workflowId !== 'specrails-implementation'` con un mensaje de "Core demasiado antiguo" cuando falta `workflowCatalog`; los loops de fábrica siguen igual. Desktop viejo + Core 6.1+: no envía `--workflow`, Core asume implement. Runs v4/v6 guardados: reanudan con su paquete retenido.

**Emparejamiento de releases (aplica a cada etapa con release de Core).**

1. Core: release-please publica la versión (`CHANGELOG.md`, `package.json`); `npm run ci` incluye `check:package`.
2. Desktop: subir `CORE_BUNDLE_VERSION` en `.github/workflows/desktop-release.yml:48`; regenerar `scripts/assemble-bundled-core.lock.json` con `node scripts/assemble-bundled-core.mjs <version>`; actualizar la constante esperada del contrato que compara `checkCoreCompat` (`server/core-compat.ts`, invocado por `scripts/check-core-compat.ts:60-70`, que solo tolera como aviso el schema 3); `npm run check-core-compat`, `npm run check:package`, `npm run check-core-compat` en CI; actualizar `docs/internals/programmatic-agent-runtime.md:118`.
3. Nunca marcar probado un gate de release con un bundle de desarrollo (`source-bundle.json`).

## 6. Responsabilidad por repositorio

**Core** implementa el catálogo, el selector, la política de completion por workflow, el puerto de journal `ledger-only`, la generalización de roles (cuando toque), el buzón de steering y las capacidades anunciadas. Core nunca decide entrega, coste aceptado ni pausa de loop.

**Desktop** implementa el nodo `core-workflow`, el gate de completion por workflow, la proyección de fases internas a pasos hijos, la contabilidad por rol, la pausa unificada, el cursor durable, las rutas/MCP de steering, el UI del builder/settings derivado del catálogo y la limpieza de directorios. Desktop nunca planifica dentro de un workflow de Core ni sincroniza ledgers nodo a nodo. Todo bloque Desktop que toque ficheros de `server/modules/**` termina con `npm run audit:architecture` (manifiesto `server/modules/boundaries.json` revisado) y `npm run docs:source-map`.

Reglas de emparejamiento: cada etapa nombra el par de versiones; una etapa "solo Desktop" se valida contra el Core publicado de la etapa anterior.

## 7. Bloques de trabajo Core (C0..C5)

### C0 — Higiene de contrato y fingerprint congelado de implement

Objetivo: cerrar la deriva y fijar la identidad de `specrails-implementation` antes de tocar nada.

- Modificar `integration-contract.json:227-233, 260-266, 280-281`: `cliOperations` += `prompts, capabilities, evidence, recovery` (no `evaluate`, interno); `phases` += `fixer` (en la posición de `CORE_NODE_ORDER`); `workflowVersion: "6"`, `instructionsVersion: "9"`; `schemaVersion: "5.1"` (línea 2, con `src/installer/phases/install-config.test.ts:380` y `CLAUDE.md:27` actualizados); bloque `agentRuntime.workflows: [{ id: 'specrails-implementation', version: '6' }]`.
- Crear `src/agent-runtime/integration-contract.test.ts` *(propuesto)*: compara esos campos del contrato con `CORE_WORKFLOW_VERSION`, `ROLE_INSTRUCTIONS_VERSION`, `CORE_NODE_ORDER` y los verbos despachados en `cli.ts` para que no vuelvan a derivar.
- Extraer del literal de `core-host.ts:140-147` una función pura `implementationWorkflowDefinition(deps)` *(propuesto)*; crear `src/agent-runtime/__fixtures__/implementation-workflow-fingerprint.json` *(propuesto)* con el fingerprint que calcula `validateWorkflow` (`workflow.ts:67-70`) y un test en `core-host.test.ts` que lo compare.
- Corregir el docstring de `core-host.ts:69-74`, hacer que `core-host.ts:27` use `RUNTIME_API_VERSION` en vez del literal `1`, y la referencia inexistente a `schemas/profile.v1.json` en `scaffold.ts:32` y `docs/agent-runtime.md:73`.
- Tests: `core-host.test.ts` (snapshot), `cli.test.ts` (sin cambios de comportamiento; `cli.test.ts:198` ya asserta `'6'`/`'9'`), `legacy-runtime.test.ts`, `install-config.test.ts`, el nuevo test de contrato.
- Contrato: 5.1 aditivo. Sin capacidades nuevas todavía.
- Aceptación: `npm test` y `npm run ci` en Core; el fixture v4 reanuda; Desktop (D0) pasa `check-core-compat` contra el tarball 6.1.0.
- Dependencias: ninguna.

### C1 — Catálogo de workflows y selector `--workflow`

Objetivo: que el CLI pueda ejecutar más de una `WorkflowDefinition` sin cambiar implement.

- Crear `src/agent-runtime/workflows/registry.ts` *(propuesto)* (`WORKFLOWS`, `resolveWorkflow(id)`, tipo `WorkflowHost`) y `src/agent-runtime/workflows/implementation.ts` *(propuesto)* con la definición movida de `core-host.ts` y su `validateCompleted` (`core-host.ts:115-139`) tal cual.
- Modificar `core-host.ts`: `runCoreWorkflow` (`:75-149`) delega en `runNamedWorkflow(id, options)` *(propuesto)*; `preflightCoreWorkflow` (`:50`) recibe el host para aplicar `requiresChange` (`'new'` mantiene la guarda "Change already exists without a programmatic checkpoint" de `:81-83`; `'existing'` exige que `openspec/changes/<change>` exista). La guarda `ownership.git === 'host'` (`:53`) no cambia.
- Modificar `cli.ts:143-195`: `--workflow` en `run`, rechazado en `resume`; `request.workflow`; `status` (`:151-156`) y `runtime-result` emiten `workflow` y `completion`; `api` (`:119`) emite `workflows[]` y `capabilities.workflowCatalog: 1`; `help` (`:103-114`) actualizado.
- Tests: `cli.test.ts` (id desconocido falla antes de escribir el request; `resume --workflow` rechazado; request sin `workflow` ⇒ implement), `core-host.test.ts` (fingerprint intacto tras el movimiento), `workflow.test.ts` (reanudar con la definición de otro id ⇒ `INCOMPATIBLE_RESUME`, extendiendo el `it.each` de `:340-348`), `legacy-runtime.test.ts`.
- Contrato: capacidad `workflowCatalog`; `agentRuntime.workflows` refleja el registro.
- Aceptación: `runtime api` lista implement; `runtime run --workflow specrails-implementation` produce el mismo fingerprint de `checkpoint.json` que sin flag; `runtime run --workflow nope` sale 1 sin crear ficheros.
- Dependencias: C0.

### C2 — Puerto de journal `ledger-only` y primer workflow no-implement: `specrails-review`

Objetivo: un workflow de solo lectura `verify → reviewer → END` que certifica un cambio existente con receipt y veredicto del reviewer, usable desde cualquier loop.

Lo que no funciona si se compone ingenuamente (verificado): `reviewerNode` (`nodes.ts:371-420`) llama a `transitionPipeline(context, 'reviewer', 'running')` (`:377`), lee `journal(context)` para el manifiesto del candidato (`:378, 385, 416`; `artifacts.ts:51-53`), llama a `recordAcceptance` (`:407`) y devuelve `next: 'archive' | 'fixer'` (`:411, 417`); `transitionPipeline` falla en un journal fresco porque architect/developer no están `done` (`pipeline-state.ts:583-586`). Por tanto:

- Crear `src/agent-runtime/workflows/review.ts` *(propuesto)* con nodos propios `verify` y `reviewer` *(mismos ids que implement, para que la evidencia de Desktop los encuentre)* que reutilizan `createRoleInvoker`, `roleInstructions('reviewer', …)` (`prompts.ts:398-413`), `evaluateReview`, `buildAcceptanceReport` y `OpenSpecTools` en modo lectura, pero **no** llaman a `transitionPipeline` ni `recordAcceptance`. El `output` del reviewer tiene la forma de `ReviewRecord` (`approved, summary, issues, score, aspects, candidateHash`). `ends`: `verify → ['reviewer']`, `reviewer → []`.
- Un rechazo del reviewer o una verificación fallida terminan el run como `succeeded` con `completion: { ok: false, reasons }` y `exit 0`; `failed`/`exit 1` queda reservado a errores de ejecución (proveedor, presupuesto, cancelación). Además el último `agent-event` de texto emite una línea `REVIEW: APPROVED|REJECTED — <resumen acotado>` para que el decider del loop la vea en el historial (`loop-run-manager.ts:468` recorta a 1.500 caracteres; mantener la línea al final).
- Plan de verificación: hoy lo vincula el arquitecto (`verification-plan.ts:132-137`); el host `review` vincula solo la baseline de `config.verification` mediante un helper *(propuesto)* y ejecuta `verifyPipeline` con receipt `full`.
- `initializePipeline` sigue ejecutándose (necesario para `context.json`, evidencias y receipts); ninguna fase cambia de estado. `completion(state)` devuelve `ok` cuando el reviewer aprobó y el receipt es válido.
- Modificar `nodes.ts:25-38` solo para exportar los helpers reutilizados; `CoreNodeDeps` no cambia.
- Tests: `workflows/review.test.ts` *(propuesto)* con ejecutor fixture (patrón de `evaluation.ts:31-69`): aprobación, rechazo (exit 0, `ok: false`), verificación fallida, SIGTERM durante `verify` y `resume --recover verify`, `requiresChange: 'existing'` sobre un cambio inexistente ⇒ preflight falla; `cli-executor.test.ts` snapshot byte a byte intacto; `openspec.test.ts` (participación del reviewer auditada; sigue sin poder escribir artefactos, `openspec.ts:212`).
- Contrato: `agentRuntime.workflows` += `specrails-review@1`.
- Aceptación: sobre un cambio OpenSpec ya aplicado, `runtime run --workflow specrails-review --change <existing>` termina 0 con `completion.ok: true` y `verification/evidence/*.json`; en un cambio con tests rotos termina 0 con `completion.ok: false` y `reasons`.
- Dependencias: C1.

### C3 — Roles abiertos y manifiesto efectivo (solo con el primer rol fuera del trío)

Objetivo: permitir `specrails-spec-refine` *(propuesto)* (arquitecto + interrupción `question`, sin developer) y, después, `specrails-bugfix` *(propuesto)* (developer + verify + reviewer, sin arquitecto), sin que `AgentRole` sea un muro.

- `executor-types.ts:8, 85-111, 135-136`: `AgentRequest.access: 'read' | 'write'` y `AgentRequest.artifacts` *(propuestos)*; `validateAgentRequest` valida ambos y acepta ids de rol declarados por el workflow además del trío; `fixer` sigue siendo `stance`, no rol; `AgentEventRole` pasa a admitir los ids declarados.
- Sustituir la derivación binaria por `access`: `request.role !== 'developer'` en `cli-executor.ts:30, 236, 243` y `kimi-acp.ts:15-16`, `this.role === 'developer'` en `workspace-tools.ts:55-56`, `context.role !== 'developer'` en `openspec.ts:64`. Sustituir el alcance por rol de `openspec.ts:212-223` por `artifacts` del descriptor. Los tres roles conservan sus valores implícitos para que el snapshot de argv no cambie.
- `config.ts:6, 85, 108, 196` y `schemas/agent-runtime.schema.json:38-40`: clave aditiva `roles: { [id]: RuntimeAgentConfig }` *(propuesto)* junto a `agents` (que sigue obligatoria con el trío); `graph/roles.ts:83` resuelve la asignación desde `roles`.
- `openspec.ts:12` (`ROLE_SKILLS`), `prompts.ts:398-410`, `openai-executor.ts:87`, `role-routing.ts:18-21`, `core-host.ts:91-95` (bucle OpenSpec por rol), `efficiency.ts:8`, `efficiency-summary.ts:105, 126`: leer skill, prompt, pipeline compacto y agregados del descriptor del rol; un rol sin pipeline compacto usa `runToolLoop` (`guarded-loop.ts:155`). Los prompts de un workflow sin developer no incluyen la sección `## Developer summary` que `compact/prompt-inputs.ts` parsea: el parser debe tolerar su ausencia (test).
- Tests: `cli-executor.test.ts` (snapshot Claude intacto; `access: 'read'` con id de rol nuevo produce el modo de solo lectura del CLI), `openspec.test.ts` (matriz `artifacts` × operación), `openai-executor.test.ts`, `config.test.ts` (schema aditivo), `compact-runtime.test.ts`, `workflows/spec-refine.test.ts` *(propuesto)* con `question` + `resume --answer`.
- Contrato: `configSchemaVersion` sigue 1 (aditivo); capacidad `openRoles: 1` *(propuesto)*; Desktop re-vendoriza el schema byte a byte (D1b).
- Aceptación: `runtime run --workflow specrails-spec-refine` pausa con exit 2 y `pendingQuestion`, reanuda con `--answer` y produce `proposal/design/specs/tasks` + `design-confidence.json`.
- Dependencias: C2.

### C4 — Steering por buzón: `runtime signal`

Objetivo: que un operador (o la misión) pueda inyectar una instrucción que el siguiente turno de rol lea, sin stdin ni cambiar el request congelado.

- Crear `src/agent-runtime/steering.ts` *(propuesto)*: fichero `steering-inbox.jsonl` *(propuesto)* junto al checkpoint, registros `{kind: 'message', id, at, from, text}` y `{kind: 'consumed', id, attemptId, at}`. El run activo posee el lease, así que `signal` no lo toma: escribe con `O_APPEND` a ese fichero separado. El consumo se registra **en el propio buzón** (no en el `output` del intento, que `--invalidate` borra), de modo que una invalidación o un viaje al checkpoint anterior no relee mensajes ya aplicados.
- `graph/roles.ts:93-94`: anexar una sección `## Operator steering` con los mensajes no consumidos; `compact/prompt-inputs.ts:59-80` debe tolerar la sección (test).
- `cli.ts`: verbo `signal --context --stdin` (texto ≤ 20.000 caracteres, mismo límite que `answer`), añadido a la cadena de `:88-143` y al `help`.
- Tests: `role-state.test.ts`/`roles` (consumo idempotente tras `--invalidate`), `cli.test.ts` (`signal` sin run activo falla), `compact-runtime.test.ts` (sección tolerada).
- Contrato: `cliOperations` += `signal`; capacidad `steeringInbox: 1` *(propuesto)*.
- Aceptación: durante un run largo, `runtime signal` seguido del siguiente intento del developer muestra la instrucción en el prompt exactamente una vez.
- Dependencias: C1 (opcional C3).

### C5 — Evaluación por workflow

Objetivo: que `runtime evaluate` (`cli.ts:96-101`, interno) acepte `--workflow` y añada casos al corpus (`evaluation-corpus.ts:13-19`) para `specrails-review` y `specrails-spec-refine`, de forma que un cambio de prompts o de política se mida por workflow. Tests en `efficiency.test.ts`/evaluación; aceptación: `runtime evaluate --workflow specrails-review` offline devuelve 0 con las variantes defectuosas rechazadas. Dependencias: C2.

## 8. Bloques de trabajo Desktop (D0..D6)

### D0 — Compatibilidad y validadores derivados del catálogo

- `server/modules/agent-runtime/runtime/agent-runtime-loader.ts:78-117`: parsear `workflows[]` y `capabilities.workflowCatalog`; exponer `RuntimeApi.workflows`; `workflowVersions` deja de validarse solo por forma.
- `agent-runtime-controls.ts:23, 82`: `STEP_IDS` derivado de `workflows[].steps` del run (leído de `runtime status`), con la lista actual como fallback.
- `agent-runtime-metrics.ts:25, 43, 49, 76, 91`: `PHASES` y el límite de tres roles pasan a validar contra el catálogo; sin catálogo, comportamiento actual.
- `server/core-compat.ts` (constante esperada del contrato) y `scripts/check-core-compat.ts`: aceptar 5.1 sin cambiar `DESKTOP_KNOWN_COMMANDS`; el bloque `workflows` es informativo. `setup-manager.ts:679-693` no cambia.
- Actualizar `agent-runtime-package.test.ts:67` (`workflowVersions: ['6']`) y `docs/internals/programmatic-agent-runtime.md:110, 112, 118` (fixer en fases, caché por digest, pin 6.x).
- Tests: `agent-runtime-loader.test.ts`, `agent-runtime-controls.test.ts`, `agent-runtime-metrics.test.ts`, `agent-runtime-package.test.ts`, `server/core-compat.test.ts`.
- Aceptación: `npm run check-core-compat` con Core 6.1.0; `npm run typecheck`; un `runtime status` con `steps` distintos a los seis no es rechazado por el resumen de controles.
- Dependencias: C0 publicado.

### D1 — Nodo `core-workflow` en loops y gate de completion por workflow

- `server/modules/loops/runtime/loop-graph.ts:27-34`: `operation?: 'core-implementation' | 'core-workflow'`, `workflowId?: string`, `change?: 'implement-step' | 'run' | string` *(propuesto)*; `validateLoopGraph` exige `workflowId` con `core-workflow`, restringe el id del nodo a `^[a-z0-9][a-z0-9-]{0,63}$`, y `assertLoopFailureRecovery` (`loop-graph.ts:101`) admite `failureRecovery` hacia un nodo `core-workflow` como reintento simple (`maxRetries: 1`, implementado como `resume`) y prohíbe `artifactOnly` hacia él hasta D1b. La misma guarda pasa a cubrir los pasos implement detectados por prompt (`loop-run-manager.ts:1628-1629`), hoy fuera de ella. Espejo en `client/src/features/loops/lib/loops-api.ts` y `loop-validate.ts`.
- `loopNeedsTicket` (`loop-graph.ts:347`) no cambia: un loop sin ticket recibe el `goal` del run como spec (`core-execution.ts:71-73`), suficiente para el preflight de Core. `classifyLoopEffect` (`loop-effect.ts:15-18`) sigue tratando el paso como mutante: un worktree de más es inocuo y el workflow de review necesita el worktree donde se implementó.
- `server/core-execution.ts:10-20, 56-105`: `CoreRunInput.workflowId`, `coreRunId`, `change`; `prepareCoreExecution` congela `desktop-context.json` bajo `pipeline/<coreRunId>/` con `runId: coreRunId`. Un paso `core-workflow` fuerza `ownership.git: 'host'` (`:89`) con independencia de `SPECRAILS_RAIL_DELIVER_PR`.
- Helper `parseCoreRunId` *(propuesto)* en `agent-runtime-paths.ts`, usado por `readCoreCompletion` (`loop-run-manager.ts:2250`), `agent-runtime-controls-router.ts:16-19` y la búsqueda del loop padre en `agent-runtime-controls.ts:250-283`; `AgentRuntimeControls.list` etiqueta cada run con `workflow` y loop padre.
- `agent-runtime-bridge.ts:41-62, 81-111`: opciones `workflowId` ⇒ `--workflow` y `change` explícito (deja de derivarlo siempre de `runtimeChangeName(runId)`); rechazo con mensaje de actualización si falta `workflowCatalog`; `AiStepResult` gana `completion?: { ok, reasons }` *(propuesto)*.
- `loop-executors.ts:258-280`: despacho de `core-workflow` antes de la rama determinista de verificación (`:275-277`); `planInteractiveAiStep` (`:465-469`) devuelve `null` también para `core-workflow`; nuevo gate `checkCoreWorkflowCompletion` *(propuesto)* en `core-execution.ts` que exige `state.status === 'succeeded'` de `runtime status --compact` y proyecta `completion` al resultado del paso; **nunca** aplica `checkCoreCompletion` a un workflow distinto de implement.
- `loop-run-manager.ts:1628-1629, 1684` (`coreRun` lleva `workflowId`, `coreRunId` y `change` resuelto; `requiresCoreCompletion` solo para implement; validación previa al spawn del `change` cuando `requiresChange: 'existing'`) y `:1807-1818` (el gate post-paso despacha por `workflowId`). Un `completion.ok: false` es un paso `ok` con veredicto negativo en el historial, no un `failed`, así no cuenta para `AI_FAILFAST_THRESHOLD` (`:481`). Documentar que un loop compuesto solo de pasos de lectura no cambia el árbol y termina por decider `stop`, `maxIterations` o el guard de no-progreso (`:1320, 2105-2120`), que se mantiene.
- Builder: select de workflow en el inspector (`client/src/features/loops/pages/LoopBuilderPage.tsx`) alimentado por `/api/projects/:id/agent-runtime/capabilities`; campo `change`; claves i18n en los ocho locales de `client/src/i18n/*`; plantilla `review-after-fix` *(propuesto)* en `loop-templates.ts` (`{{cmd:fix}}` → `core-workflow: specrails-review` → decider).
- `delivery-evidence.ts:102-112`: `EvidenceHarvestUnit` admite `runtimeDirs` adicionales *(propuesto)* con el `stepId` del reviewer para que el veredicto del workflow review, cuando corre en un run distinto del implement, alimente `evidence.confidence` por la misma vía de `:436-446`.
- Tests: `loop-graph.test.ts`, `loop-run-manager.test.ts` (ejecutor falso recibe `workflowId` y `change`; el gate implement no se aplica; `ok: false` no dispara fail-fast), `loop-executors.test.ts`, `agent-runtime-bridge.test.ts`, `server/core-execution.test.ts` (segundo contexto `coreRunId` no dispara "context changed during an active run"; `ownership.git` siempre `host` para `core-workflow`), `loop-templates.test.ts`, `delivery-evidence.test.ts`, paridad i18n, tests de `loop-validate` en cliente; test **de invariante**: un workflow review con `ok: true` no puede por sí solo mover una fila de `rail_pr_deliveries` a `on_review` (`rail-isolated-launch.test.ts`).
- Aceptación: loop personalizado `fix → core-workflow:review → decider` lanzado desde un rail termina con el veredicto de Core en el review packet; loops de fábrica sin cambios de comportamiento (`loop-factory.test.ts`); `npm run audit:architecture` y `npm run docs:source-map` limpios.
- Dependencias: D0, C2 publicado.

**D1b** (tras C3): re-vendorizar `server/schemas/agent-runtime.schema.json` byte a byte (paridad en `agent-runtime-settings.test.ts:192-194`); `agent-runtime-settings.ts:139, 320` y `client/src/features/settings/lib/agent-runtime.ts:4-7` renderizan roles desde el catálogo; los chequeos espejo de `config.ts` (`agent-runtime-settings.ts:168-212`) aceptan `roles`; `AgentRuntimeSettingsSection.tsx` gana filas para `roles` declarados; `assertLoopFailureRecovery` admite `artifactOnly` hacia un `core-workflow` cuyo manifiesto declare un rol con `artifacts: 'all'`, implementado como `resume --invalidate <primer paso>`. Tests: `agent-runtime-settings.test.ts`, paridad de schema, i18n, `loop-graph.test.ts`.

### D2 — Fases internas como pasos hijos y contabilidad por rol

- `loop-run-manager.ts:1227-1260` (`onRawLine`): traducir los `workflow-event` `step_started/step_succeeded/step_failed` a `loop_step`/`loop_step_end` hijos con `nodeId = <loopNode>/<stepId>` y `parentNodeId` *(propuesto)* en `LoopStepEventPayload` (`loop-run-manager.ts:397-466`), con el mismo `takeSeq`.
- Migración **64** *(propuesta)*: tabla `ai_invocation_roles` *(propuesta)* con `invocation_id` (fila padre en `ai_invocations`), `role`, `attempt`, `provider`, `model`, `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_create`, `total_cost_usd`, `estimated`, `duration_ms`. La fila agregada `agent-runtime`/`per-role` de `ai_invocations` sigue siendo la única que ven `spending.ts` (`bySurface`), `programmaticUsageAvailability` (`loop-run-manager.ts:582-588`) y el resto de consultas: sin doble conteo por construcción. Las filas hijas se escriben en la misma transacción que `completeLoopStepRecovery` (`loop-run-manager.ts:1407-1418`), con reparto por `server/util/distribute-int.ts` (sustituyendo el `splitInt` local de `:600-605`) y `NULL` para desconocido.
- `parseProgrammaticUsage` (`agent-runtime-accounting.ts:23-69`) sigue siendo el fallback tras crash; test de paridad: suma de hijas == `invocationUsage` cuando todos los intentos han asentado.
- Cliente: `LoopStepExplorer.tsx` (chips anidados), `AgentRuntimeRuns.tsx`/`useRuntimeRuns.ts` (desglose por rol), `LogViewer.tsx` y el parseo de fases de `PipelineProgress` toleran ids de paso fuera de los seis; `docs/internals/loop-step-log-explorer.md` actualizado (`stalled`, `parentNodeId`).
- Tests: `loop-run-manager.test.ts` (seq monótono con frames hijos), `agent-runtime-accounting.test.ts`, `loop-runs-store.test.ts` (sin doble conteo tras reinicio), `server/db.test.ts` (migración append-only), tests del explorer en cliente.
- Aceptación: en un run implement, el explorer muestra architect/developer/verify/reviewer (y fixer cuando hay corrección) como pasos; el desglose por rol suma el agregado; `spending` no cambia.
- Dependencias: D1 (solo Desktop; Core 6.2 basta).

### D3 — Pausa unificada

- `loop-run-manager.ts:1496-1554`: un paso Core que termina con exit 2 y `pendingQuestion` entra en `awaitHumanDecision` (`loop_runs.status = 'paused'` vía `pauseLoopRun`, `job.interactive` con `acceptingTurns: true`); la respuesta por `POST /:projectId/jobs/:id/messages` (`project-router-jobs.ts:364-384` → `LoopRunManager.sendInteractiveTurn`, `:941-946`) hace que **el propio paso** vuelva a invocar `runAiStep` con `coreRun.resume = true` y `answer` (el bridge ya acepta `resume` + `answer`, `agent-runtime-bridge.ts:41-62`). `AgentRuntimeControls` no interviene mientras el loop está vivo (un solo escritor). `pendingApproval` sigue en Agent Runtime settings (es una decisión de entrega).
- El bridge (`agent-runtime-bridge.ts:197-211`) devuelve `paused: true` *(propuesto)* con la pregunta en `AiStepResult` en lugar de "failed con errorText"; `loop_step_end.status` (`loop-run-manager.ts:440`) gana `'paused'`; los clientes antiguos lo pliegan a `ok`.
- Tests: `loop-run-manager.test.ts` (pausa → respuesta → reanudación en el mismo nodo; cancelación durante la pausa), `agent-runtime-bridge.test.ts`, `project-router-jobs.test.ts`.
- Aceptación: implement con `architect.onLowConfidence: ask` (o SDD Quick con `specrails-spec-refine` en la etapa 4) se responde desde el chat del job y el loop continúa sin crear un run nuevo.
- Dependencias: D1.

### D4 — Cursor durable del recorrido del loop

- Migración **65** *(propuesta)*: en `loop_runs` (`migrations.ts:711-731` más columnas posteriores) las columnas `cursor_node_id`, `cursor_iteration`, `cursor_history_json`, `cursor_session_id` y `run_request_json` *(propuestas)*. `run_request_json` congela en el lanzamiento el `LoopRunRequest` sin callbacks (grafo, constants, `followUp`, `addenda`, `deciderEngine`, `executionManifest`, `cwd`/`repoDir` del worktree, `railIndex`, `ticketCompletionStatus`), porque hoy `loop_runs` no guarda el grafo; el cursor se escribe en cada frontera de nodo dentro de la transacción de `completeLoopStepRecovery` (`loop-run-manager.ts:1407-1418`).
- `reconcileOrphanLoopRuns` (`loop-runs-store.ts:553-609`, que hoy barre `running` y `paused` a `status='completed', final_outcome='failed'` y falla la fila `jobs`): con cursor y `run_request_json` ⇒ `paused` con motivo `restart`, sin tocar la fila `jobs` ni encolar recuperación terminal; sin cursor ⇒ comportamiento actual.
- Nueva acción `resume` de loop en `project-router-loop-runs.ts` que reconstruye `LoopRunRequest` desde `run_request_json` y reanuda desde el cursor. La liquidación aislada (`launchIsolatedRail` → `onLoopRunFinished`, cosecha de evidencia, `building → on_review`) es hoy una clausura en memoria: la reanudación la re-adjunta a partir de la fila durable de `rail_pr_deliveries` (`worktree_ids`, `run_ids`, `spec_snapshot`) por un camino `reattachIsolatedSettlement` *(propuesto)* en `rail-isolated-launch.ts`; `rail-isolated-launch.ts:1242-1250` deja de aparcar `settlement_interrupted` cuando el run está `paused` por reinicio. La fila `jobs` mantenida no entra en `orphan_job_recovery` (el sweep de QueueManager no toca `owner = 'loop'`).
- Este es el bloque de mayor riesgo del plan: se entrega solo, con kill switch (`SPECRAILS_LOOP_RESUME` *(propuesto)*, por defecto activo) y sin tocar los pasos Core, que ya son reanudables por sí mismos.
- Tests: `loop-runs-store.test.ts`, `loop-run-manager.test.ts` (crash simulado entre nodos; crash durante un paso Core ⇒ el paso se reanuda con `resume`), `rail-isolated-launch.test.ts` (re-adjunto de liquidación), `server/db.test.ts` (migración append-only).
- Aceptación: matar Desktop en mitad de un loop de tres nodos y reiniciar deja el run `paused`; reanudar continúa en el nodo siguiente sin repetir el anterior ni duplicar `ai_invocations`; la entrega termina en `on_review`.
- Dependencias: D2 (solo Desktop).

### D5 — Steering desde misiones

- `agent-runtime-controls-router.ts:24-80`: `POST /:projectId/agent-runtime/runs/:runId/steer` junto a `resume` (`:61-64`) → `runtime signal` ejecutado con el runtime **retenido** del run (`resolveRetainedAgentRuntime`, `agent-runtime-package.ts`), nunca con el bundle activo; `server/mcp/tools/jobs.ts:43-55`: acción `runtime_steer`; tarjeta de misión (`docs/internals/mission-rail-cards.md`) para proponerlo.
- Tests: `agent-runtime-controls.test.ts`, tests de MCP tools, `agent-live-steering.test.ts`.
- Aceptación: una misión envía "prioriza los tests de integración" y el siguiente turno del developer lo refleja una sola vez.
- Dependencias: C4 publicado.

### D6 — Retiro de caminos legacy, perfiles y limpieza

Solo tras telemetría: dos releases consecutivas en las que el contador *(propuesto)* de lanzamientos por QueueManager slash (`rail.job_started` con comando `/specrails:` o `$implement`) y de invocaciones de `runMergeBack` sea cero, registrado en analytics.

- Retirar `rails-router.ts:1257-1260` (QueueManager `/specrails:implement`), `rail-isolated-launch.ts:1897-1952` (`runMergeBack`), la rama `pipeline.mjs status` en `core-execution.ts:139` y `core-completion.ts:60`. El enqueue genérico de `project-router-jobs.ts:194/203` queda fuera de este retiro.
- Re-basar la página Agents: `custom-*.md` (`profiles-router.ts:456-536`) se mapea a `roles.<id>` + `rolePrompts` del schema de Core; retirar `SPECRAILS_PROFILE_PATH` de `queue-manager.ts:2475-2577` y `loop-executors.ts:189-201`; `docs/internals/profiles.md` reescrito.
- Recolección de basura: `.specrails/runtime-packages/<digest>` y `pipeline/<coreRunId>` de runs asentados/descartados, con retención configurable, en `agent-runtime-package.ts`.
- Contrato 6.0 con Core (eliminación de `defaultImplementationEngine`, `workflows` obligatorio). Actualizar `openspec/specs/loop-execution/spec.md:158-166` ("Zero Specrails-Core Coupling") y `rail-loop-execution/spec.md:101-113`, que hoy contradicen el código.
- Tests: `rails-router.test.ts`, `rail-isolated-launch.test.ts`, `profiles-router.test.ts`, `agent-runtime-package.test.ts`.

## 9. Orden de trabajo

| Etapa | Bloques | Par de releases | Entregable y comprobación para avanzar |
|---|---|---|---|
| 1. Higiene y compatibilidad | C0 + D0 | Core 6.1.0 (contrato 5.1) / Desktop 2.58.0 | Contrato sin deriva y test que lo mantiene, fingerprint de implement congelado por test, validadores de Desktop derivados del catálogo con fallback; `check-core-compat`, `check:package` y fixture v4 en verde |
| 2. Catálogo y primer workflow | C1 + C2 + D1 | Core 6.2.0 / Desktop 2.59.0 | Loop personalizado con `core-workflow: specrails-review` funcionando en los cuatro CLIs y openai-compatible; implement byte-idéntico; test de invariante "review no cambia entrega"; rechazo visible para el decider |
| 3. Observabilidad, contabilidad y pausa | D2 + D3 | solo Desktop (Core 6.2) | Pasos hijos en el explorer, desglose por rol con paridad de suma y sin doble conteo, pausa por pregunta desde el chat del job con un solo escritor |
| 4. Roles abiertos y spec-refine | C3 + C5 + D1b | Core 6.3.0 / Desktop 2.6x | Variante de SDD Quick *(propuesta)* donde `specrails-spec-refine` sustituye el paso `ff` de `opsxLifecycleGraph` (`loop-templates.ts:228-255`) con checkpoint y `artifactOnly` como `resume --invalidate`; settings renderizan roles del catálogo; snapshot argv de Claude intacto |
| 5. Durabilidad del loop | D4 | solo Desktop | Reinicio ⇒ `paused`, reanudación sin duplicar coste, liquidación re-adjuntada; `rail-isolated-launch` no aparca runs reanudables |
| 6. Steering | C4 + D5 | Core 6.4.0 / Desktop 2.6x | `runtime signal` + ruta + MCP + tarjeta de misión; consumo idempotente demostrado con `--invalidate` |
| 7. Retiro de legacy | D6 (+ Core 7.0 / contrato 6.0) | emparejado obligatorio | Un solo camino de implementación y de entrega; perfiles re-basados; GC de directorios |

Cada etapa se puede entregar sola; 3 y 5 no requieren release de Core. Core y Desktop pueden avanzar en paralelo cuando el contrato de la etapa esté fijado. Cada bloque termina con sus pruebas focalizadas; la batería completa (`npm run typecheck`, `npx vitest run server/modules`, `npm run test --prefix client`, `npm run audit:architecture`, `npm run docs:source-map`, `npm run check-core-compat`; en Core `npm run ci`) se ejecuta sobre el resultado integrado de cada etapa.

Estimación orientativa de esfuerzo para un solo maintainer, sin contar releases: etapa 1, una semana; etapa 2, tres a cuatro semanas (C2 es el bloque con más diseño nuevo en Core); etapa 3, dos semanas; etapa 4, tres semanas (C3 toca diez sitios cableados y el snapshot de argv); etapa 5, dos a tres semanas (bloque de mayor riesgo); etapa 6, una semana; etapa 7, dos semanas más el periodo de telemetría.

## 10. Riesgos y trampas con mitigación

- **Paridad de proveedores.** El workflow de la etapa 2 es de solo lectura, así que Claude/Codex/Gemini/Kimi se comportan igual por construcción. Los workflows con escritura (etapa 4+) heredan el sandbox del developer de cada CLI (`cli-executor.ts:44-72`); Kimi sin uso ⇒ `estimated`; Gemini `unknown` se mantiene gateado. El snapshot `__fixtures__/claude-architect-invocation.snapshot.json` es el guardián de C3.
- **Dos semánticas de permiso.** `access` (sandbox del CLI y herramientas de workspace) y `artifacts` (alcance OpenSpec) son ortogonales; colapsarlas reabriría el hueco por el que un arquitecto de solo lectura escribe `proposal.md`. C3 las mantiene separadas y las testea en matriz.
- **Ownership de git.** `SPECRAILS_GIT_AUTO=false` es condicional (`loop-executors.ts:131`); D1 fuerza `host` para `core-workflow` y documenta el hueco actual en `docs/internals/programmatic-agent-runtime.md`.
- **Veredicto negativo confundido con fallo.** Sin la decisión de "rechazo = `succeeded` con `ok: false`", `AI_FAILFAST_THRESHOLD` abortaría un loop `fix → review` al segundo rechazo. Test explícito en D1.
- **Change equivocado.** Sin la regla de `change`, un paso review certificaría un change vacío distinto del implementado. La validación previa al spawn de D1 lo impide.
- **Recovery con dos ledgers.** Regla fija: el ledger de Core dice *qué corrió*; las filas de Desktop son proyecciones por `attemptId`, reconstruibles desde `events` (`loop-run-manager.ts:696-863`). Nunca sincronizar después de cada nodo. Los `coreRunId` por paso multiplican entradas en `AgentRuntimeControls.list` (`agent-runtime-controls.ts:239-248`): etiquetar con `workflow` y loop padre, y hacer GC en D6.
- **Contabilidad.** El desglose por rol vive en `ai_invocation_roles`, no como filas adicionales de `ai_invocations`; D2 exige el test de paridad y conserva `NULL` para desconocido. Riesgo de doble conteo tras crash: las filas hijas solo se completan dentro de la transacción de `completeLoopStepRecovery`.
- **Pausa con dos escritores.** D3 hace que el paso reanude a Core por sí mismo; `AgentRuntimeControls.resume` sigue reservado a continuaciones post-terminales.
- **Reanudación del loop.** D4 depende de re-adjuntar una clausura en memoria a partir de filas durables; se entrega aislado, con kill switch, después de que los pasos Core ya sean reanudables por sí mismos.
- **Missions/steering.** El buzón se lee en fronteras de intento: un mensaje enviado en mitad de un turno largo tarda en aplicarse. Se documenta; no se introduce stdin.
- **Companion.** Sin tipos WS nuevos: `loop.run_*` y el topic `rails` (`mobile-ws.ts:70-73`) no cambian; los pasos hijos son frames `event` adicionales. Actualizar `docs/internals/companion-rails-as-loops-contract.md`, ya desfasado.
- **Acoplamiento de releases.** Todo gateado por `runtime api`; `SUPPORTED_CORE_MAJORS` no cambia hasta la etapa 7. La sección 5 fija la lista de pasos de emparejamiento.
- **Superficie de tests.** `loop-run-manager.test.ts` (~2.900 líneas), `rail-isolated-launch.test.ts` (~4.100) y `workflow.test.ts` no se reescriben: D1/D2/D4 añaden casos con ejecutores falsos. Ningún test se borra hasta D6.
- **Windows.** No se toca `cli-process.ts` ni el bootstrap de Kimi por stdin; `signal` escribe ficheros con `O_APPEND` (sin symlinks, sin locks POSIX). `pipeline-state.ts` no cambia, así que no hay rematerialización del framework instalado.
- **Journal.** `ledger-only` deja `state.json` con fases pendientes; cualquier lector que confunda "pendiente" con "fallido" (por ejemplo `inspectPipeline` desde Desktop) debe consultar primero `workflow.id`. El test de invariante de D1 lo cubre.

## 11. Qué NO hacer

- No construir un DSL JSON de grafos con registro de tipos de nodo ni un compilador `LoopGraph → WorkflowDefinition` antes de que existan ≥ 4 workflows TypeScript y usuarios que pidan fan-out (`workflow-types.ts:35-36` no lo soporta y `Send` sería una reescritura del motor).
- No subir `CORE_WORKFLOW_VERSION` ni cambiar el `id`, `ends`, `maxTransitions` u orden de declaración de `specrails-implementation`: `core-host.ts:79` y `workflow.ts:174-176` dejarían huérfano cada run guardado.
- No añadir un digest de definición redundante al `input`: `workflowFingerprint` y `packageIntegrity` ya cubren ese caso.
- No anidar `runWorkflow` en el mismo directorio de run: `acquireWorkflowLease` hace `mkdir` atómico de `.lease` y consideraría vivo al propio proceso padre.
- No mover el Decider, `maxIterations` ni el tope de coste a Core: las decisiones de `openspec/changes/archive/2026-06-28-loop-builder/design.md` siguen vigentes; el loop coordina, Core ejecuta.
- No cambiar `pipeline-state.ts` (fases por tipo de journal): se copia compilado en cada proyecto y obliga a rematerializar el framework.
- No importar Core como ESM en proceso: `agent-runtime-loader.ts:67-73` lo evita a propósito y la retención de paquete por run depende del aislamiento por subproceso.
- No dar un salto mayor del contrato (6.0) antes de la etapa 7 ni introducir `Team`/`Recipe` como sustantivo de producto: el término es **workflow**, que ya existe en el código y en `runtime api` (`workflowVersions`).
- No generalizar `AgentRole` ni los campos `access`/`artifacts` antes de C3 (primer rol fuera del trío).
- No aplicar `checkCoreCompletion` a un workflow no-implement ni permitir que un workflow de solo lectura mueva `rail_pr_deliveries`.
- No dejar que Core escriba `ai_invocations` ni que Desktop planifique fases dentro de un run de Core.
- No convertir un rechazo del reviewer en `exit 1`.
- No retirar QueueManager slash ni merge-back antes de tener telemetría (etapa 7).

## 12. Ideas adicionales

1. Workflows versionados en el repo bajo `.specrails/workflows/*.json` *(propuesto, ruta reservada de Desktop)* que referencien ids del catálogo con overrides de roles; habilitada por la etapa 4.
2. Capacidad MCP por run para agentes de Core (`mintAgentCapability`, `agent-mcp-config.ts:311-360`) con tier observe, para que un workflow lea specs y addenda en vez de solo el contexto congelado; etapa 6.
3. El Decider lee el bloque `completion` estructurado del paso Core previo en lugar del historial recortado (`loop-run-manager.ts:468`); etapa 3.
4. Implementar `condition` como nodo determinista sobre `{{run.*}}` y códigos de salida shell (`loop-run-manager.ts:2152-2162`); independiente, cabe en la etapa 3.
5. Persistir `loopId` en el rail para que un rail inactivo muestre y relance el mismo pipeline (limitación documentada en el contrato del companion); etapa 5.
6. Tarjeta de misión `workflow-launch` con paridad `rail-launch-parser.ts` ⇄ `rail-launch-draft.ts`, que proponga spec + workflow + engine; etapa 6.

## 13. Preguntas abiertas para el maintainer

1. ¿El primer workflow no-implement debe ser `specrails-review` (solo lectura, valor inmediato en revisiones y review packet, sin roles nuevos) o `specrails-spec-refine` (valor en SDD Quick, pero exige C3)? *Suposición: review primero.*
2. ¿Los workflows de solo lectura deben poder ejecutarse sobre el change del paso implement del mismo run (`change: 'implement-step'`, por defecto) o siempre sobre un change indicado explícitamente? *Suposición: por defecto el del implement del mismo run; `run` y literal como alternativas.*
3. ¿Se acepta que `pendingApproval` (archivo) siga en Agent Runtime settings mientras `pendingQuestion` pasa al chat del job? *Suposición: sí; el archivo es una decisión de entrega.*
4. ¿La página Agents/perfiles se retira o se re-basa sobre `roles`/`rolePrompts` en D6? *Suposición: re-basar `custom-*.md`; retirar orquestador/routing.*
5. ¿Debe seguir soportándose `SPECRAILS_LOOPS_SECTION=false` y el caso `SPECRAILS_RAIL_DELIVER_PR=0` sin manifiesto (que hoy Core rechaza)? *Suposición: solo hasta la etapa 7; el segundo se corrige en D1.*

## 14. Cómo retomar este plan más adelante

1. Verificar contra `main` de ambos repos: `CORE_WORKFLOW_VERSION` (`core-host.ts:24`), `ROLE_INSTRUCTIONS_VERSION` (`prompts.ts:7`), `integration-contract.json` (`schemaVersion` en la línea 2, `agentRuntime.workflows`, `cliOperations`, `phases`, `workflowVersion`/`instructionsVersion`), `SUPPORTED_CORE_MAJORS` (`server/core-package.ts:5`), `CORE_BUNDLE_VERSION` en `desktop-release.yml`, y la última migración en `server/db/migrations.ts` (63 al escribir esto; las migraciones 64 y 65 propuestas se renumeran si `main` avanzó).
2. Saber qué bloques están hechos: C0 ⇔ existe `src/agent-runtime/__fixtures__/implementation-workflow-fingerprint.json` y el contrato dice `workflowVersion: "6"`; C1 ⇔ `runtime api` emite `capabilities.workflowCatalog`; C2 ⇔ existe `src/agent-runtime/workflows/review.ts`; C3 ⇔ `AgentRequest` tiene `access`; C4 ⇔ `cli.ts` acepta `signal`; D0 ⇔ `STEP_IDS` ya no es constante en `agent-runtime-controls.ts`; D1 ⇔ `loop-graph.ts` admite `'core-workflow'`; D2 ⇔ existe la tabla `ai_invocation_roles`; D3 ⇔ `AiStepResult` distingue `paused`; D4 ⇔ `loop_runs` tiene `cursor_node_id` y `run_request_json`; D5 ⇔ ruta `/steer`; D6 ⇔ `rails-router.ts` sin `queueManager.enqueue('/specrails:implement…')`.
3. Leer antes de tocar: `docs/internals/programmatic-agent-runtime.md`, `docs/internals/agent-runtime-framework-evaluation.md` (condiciones de un solo motor), `docs/internals/loop-step-log-explorer.md`, `docs/internals/safe-pr-review-flow.md`, `docs/internals/interactive-jobs.md`, `specrails-core/docs/agent-runtime.md` y este documento.
4. Tests que deben estar en verde antes de empezar cualquier bloque: Core `workflow.test.ts`, `core-host.test.ts`, `cli.test.ts`, `legacy-runtime.test.ts`, `compact-runtime.test.ts`, `install-config.test.ts`; Desktop `loop-run-manager.test.ts`, `loop-graph.test.ts`, `agent-runtime-bridge.test.ts`, `agent-runtime-controls.test.ts`, `server/core-execution.test.ts`, `rail-isolated-launch.test.ts`, `delivery-evidence.test.ts`, `server/modules/architecture.test.ts`.
5. Si `main` ya introdujo un selector de workflow, un campo `access` o un cursor de loop con otro nombre, adoptar el nombre real y actualizar este documento; no duplicar mecanismos.
6. Instrucción para iniciar la siguiente fase: crear los cambios OpenSpec `core-agent-engine` emparejados en ambos repos (propuesta, diseño, specs, tareas C0..C5 / D0..D6 y, en Core, un `contracts.md` compartido como en `implementation-efficiency`), validarlos con `openspec validate --strict --json`, y empezar por **C0 + D0** sin marcar tareas hasta comprobarlas.
