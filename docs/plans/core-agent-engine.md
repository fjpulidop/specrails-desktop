# Motor de agentes en Core: los loops de Desktop como editor visual de workflows LangGraph

Estado: **plan preparado (v3); implementación pendiente**. Fecha: 26 de septiembre de 2026 (v1: 25 de septiembre de 2026).

Base sobre la que se escribió: specrails-core **6.0.0** (`integration-contract.json` `schemaVersion: "5.0"`, `RUNTIME_API_VERSION = 1`, `CORE_WORKFLOW_VERSION = '6'` en `src/agent-runtime/core-host.ts:24`, `ROLE_INSTRUCTIONS_VERSION = '9'` en `src/agent-runtime/prompts.ts:7`); specrails-desktop **2.57.0** (`CORE_BUNDLE_VERSION: "6.0.0"` en `.github/workflows/desktop-release.yml:48`, `SUPPORTED_CORE_MAJORS = [4, 5, 6]` y `CORE_PACKAGE_SPEC = 'specrails-core@^6.0.0'` en `server/core-package.ts:5, 12`, última migración de base de datos: **63** en `server/db/migrations.ts`).

Este documento sigue las convenciones de [`implementation-efficiency.md`](implementation-efficiency.md): bloques Core `C0..Cn`, bloques Desktop `D0..Dn`, tabla de etapas y responsabilidad explícita por repositorio. Los identificadores marcados como *(propuesto)* no existen todavía en el código; el resto son reales y se han contrastado con el código fuente. Los números de línea corresponden a la base indicada arriba; al retomar el plan hay que revalidarlos (sección 14).

**Cómo llegó el plan hasta aquí.** v1 (análisis con nueve lectores de código, cuatro propuestas independientes, tres jueces y verificación adversarial de doce afirmaciones) proponía un catálogo de workflows escritos en TypeScript dentro de Core y un nodo de loop que los invocara por id. El maintainer aclaró la visión de producto en dos pasos: primero, que los grafos los cree y guarde el usuario en Desktop y Core solo exponga las piezas y el motor; después, que **los loops de Desktop sean literalmente el editor visual de workflows de Core, que admitan pasos de Desktop (prompts nativos al proveedor, shell) para componer grafos híbridos, y que implement, batch-implement y el resto de grafos que hoy viven en Core pasen a vivir en Desktop**. v3 es ese diseño. Conserva las protecciones verificadas en v1: un solo motor por ejecución, fingerprint y reanudación de los runs guardados intactos, Desktop dueño de la entrega y la contabilidad, ninguna ejecución de código del usuario dentro de Core.

## 1. Objetivo y medida de éxito

Objetivo final: **un loop es un workflow de Core.** El usuario lo compone en el Loop Builder con piezas ejecutadas por Core (turno de rol, decisor, verificación, comprobación, condición, aprobación, pregunta, archivo OpenSpec, las seis fases de implement) y con pasos ejecutados por Desktop (prompt nativo al proveedor con los `{{cmd:*}}` de hoy, shell), lo guarda, publica, forkea y exporta como hoy, y al lanzarlo desde un rail **Core dirige el grafo completo como un único run durable**: ejecuta sus piezas, y cuando llega a un paso de Desktop se pausa, Desktop lo ejecuta con su maquinaria actual (sesiones interactivas, watchdogs, sentinels, contabilidad) y reanuda a Core con el resultado. Los grafos de fábrica (Implement, Batch, Freestyle, SDD Quick) pasan a ser definiciones guardadas en Desktop, construidas con esas piezas; Core conserva el motor, las piezas, los ejecutores de proveedor y el conocimiento de cada fase. Desktop sigue siendo la autoridad sobre specs, rails, worktrees, PRs, presupuesto aceptado y contabilidad.

Señales medibles al terminar la etapa 4:

1. Un loop híbrido compuesto en el builder (por ejemplo `host:prompt(/opsx:ff) → core:check(openspec validate) → host:prompt(/opsx:apply) → core:verify → core:decider ↺ → core:openspec-archive → end`) se publica, se valida en Core, se lanza desde un rail y se ejecuta como **un solo run de Core** con `checkpoint.json`, receipts y `completion`, en los cuatro CLIs y en openai-compatible.
2. Matar Desktop a mitad de ese run y reiniciar deja el loop `paused`; reanudar continúa desde el checkpoint de Core sin repetir pasos terminados ni duplicar contabilidad.
3. El grafo de fábrica **Implement vive en Desktop** como definición construida con las piezas `implementation.*`; sin cambios produce los mismos receipts y la misma aceptación que el built-in de Core 6.0; forkearlo e insertar un `role-turn` de revisión de seguridad entre `reviewer` y `archive` funciona y el veredicto llega al review packet.
4. El built-in en código `specrails-implementation` de Core sigue byte-idéntico (fingerprint fijado por test) hasta Core 7, y los runs guardados reanudan con su paquete retenido.
5. Cada nodo del grafo se ve como paso en `LoopStepExplorer`, distinguiendo ejecución por Core y por Desktop; el uso por rol suma exactamente `invocationUsage`, sin filas duplicadas en `ai_invocations`.
6. Los loops guardados antes de este cambio siguen ejecutándose sin cambios de comportamiento por el motor actual de Desktop hasta la etapa 7, y desde entonces por el mismo camino que los nuevos, con paridad demostrada por tests.
7. Ninguna etapa anterior a la 7 exige un salto mayor del contrato de integración.

## 2. Diagnóstico verificado

### 2.1 Lo que existe hoy

**Core ya tiene el motor y acepta cualquier grafo.** `runWorkflow(options)` (`specrails-core/src/agent-runtime/workflow.ts:150`) construye un `StateGraph` con un `addNode` por nodo de la `WorkflowDefinition` (`workflow.ts:489-492`), una única arista estática `START → entry` (`:491`) y enrutado dinámico por `Command({goto})` que exige que el sucesor esté en `ends` (`:459-477`). Los ciclos están permitidos y los acota `maxTransitions` (1..10.000, por defecto 100, `workflow.ts:63-65`; "maximum visits across conditional loops", `workflow-types.ts:92`). Aporta interrupciones `approval`/`question` (`workflow-types.ts:22-25`) que pausan el proceso con exit 2 y se responden con `resume --approve|--answer`, ledger autoritativo y checkpoint de LangGraph en un mismo sobre atómico (`durable-store.ts`), lease por directorio (`durable-store.ts:140-172`), presupuesto por run comprobado antes de cada nodo (`WorkflowBudget`, `budgetError`), reintentos por nodo (`maxAttempts`, `retrySafe`), invalidación selectiva y recuperación explícita de escrituras interrumpidas. Rechaza reanudar si cambia el fingerprint de la definición (id, versión, `maxTransitions`, `entry`, forma de cada nodo) o de la entrada (`workflow.ts:67-70, 174-176`). Los ids de nodo deben cumplir `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$`, no ser `START`/`END`/`next` y no colisionar con canales del estado (`workflow.ts:28-29, 52, 58-60`).

**Pero solo hay un grafo en producción, y está en código.** `runCoreWorkflow` (`core-host.ts:75-149`) construye `coreNodes(deps)` (`:108`) y declara `{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, entry: 'architect', nodes en CORE_NODE_ORDER }` (`:140-147`; `graph/state.ts:74-76`). El recorrido lo deciden los `ends` de cada nodo (`graph/nodes.ts:103, 237, 252, 265, 375, 425`). El CLI solo ejecuta ese grafo (`cli.ts:182`); el request congelado `agent-runtime-request.json` guarda `{change, config, runtimeIdentity}` (`cli.ts:158-177`).

**Las piezas ya existen como funciones.** `coreNodes(deps)` devuelve las seis fases de implement por separado, exportadas "for hosts that want to reuse a phase inside another graph" (`docs/agent-runtime.md:268`, `src/agent-runtime/index.ts`); `createRoleInvoker(deps)` (`graph/roles.ts:58-192`) es el turno de rol reutilizable (presupuesto, continuidad de sesión, escalado, salida estructurada con una reparación, uso y eficiencia); `verifyPipeline(context, request, log, signal, options)` (`pipeline/pipeline-state.ts:886`) ejecuta comandos con receipts y aislamiento de entorno; `validateVerificationRequest` (`:984`) los valida contra el alcance congelado; `archive` (`graph/artifacts.ts`) archiva OpenSpec de forma determinista; `OpenSpecTools` (`openspec.ts`) da a los roles las herramientas oficiales con alcance de escritura por rol (`openspec.ts:212-223`). Falta un formato declarativo para componerlas y un compilador.

**La reanudación ya sobrevive a versiones de Core.** Cada run retiene su paquete de runtime (`retainAgentRuntime`, `agent-runtime-package.ts`) y `resume` usa el retenido (`resolveRetainedAgentRuntime`, `agent-runtime-bridge.ts:74`); `sameRuntimeIdentity` (`cli.ts`, `runtime-identity.ts`) prohíbe reanudar un run con un paquete distinto. Por eso un Core futuro puede dejar de contener el grafo implement en código sin dejar huérfanos los runs antiguos.

**Desktop nunca importa Core en proceso** (`agent-runtime-loader.ts:67-73`) y habla con él por subproceso: `api`, `capabilities --stdin`, `prompts`, `validate --stdin` (`agent-runtime-loader.ts:78-105`), `run|resume` (`agent-runtime-bridge.ts:81`), `status` (`server/core-execution.ts:137-144`) y `recovery`. El patrón "pausa con exit 2, Desktop actúa, `resume` con flags" existe ya para preguntas y aprobaciones (`agent-runtime-controls.ts:285-386`, `docs/internals/programmatic-agent-runtime.md`).

**Desktop ya tiene el editor, el almacén y la maquinaria de pasos.** `LoopRunManager.run()` (`server/modules/loops/runtime/loop-run-manager.ts:1038`) recorre un `LoopGraph` de tipos `start | ai-step | shell | decider | condition | end` (`loop-graph.ts:12`), un sucesor por nodo con ciclos vía decider (`loop-graph.ts:234-255`). Los loops son una biblioteca **global** (`desktop.sqlite`, tabla `loops`) con draft/published, duplicado, fork de built-ins, export/import JSON (`loops-router.ts`; `client/src/features/loops/lib/loop-export.ts`) y canvas React Flow con ids UUID (`loop-graph-rf.ts:41-47`). La ejecución de un paso de IA de Desktop tiene maquinaria valiosa que no conviene reescribir: spawn compartido `runAiCliInvocation` (`execution/runtime/spawn-lifecycle.ts`), sesión interactiva de Claude con composer (`planInteractiveAiStep`, `loop-executors.ts:465-511`; `_runInteractiveAiStep`, `loop-run-manager.ts:1685-1707`), watchdog de inactividad con un reintento por sesión (`loop-step-idle.ts`), pausa humana (`awaitHumanDecision`, `loop-run-manager.ts:1496-1554`), expansión por proveedor de `{{cmd:*}}` (`loop-command-catalog.ts`), sentinel `VERIFICATION: PASS|FAIL` (`execution/runtime/verification-sentinel`), captura de `{{run.*}}` (`resolveRunVars`) y contabilidad por paso (`insertLoopInvocation`, `loop-run-manager.ts:590-675`). El único nodo que hoy llega a Core es `operation: 'core-implementation'` (`loop-graph.ts:33`), despachado por `loop-executors.ts:263-273`.

**Rails.** Con Loops activos (`feature-flags.ts:51-53`) todo lanzamiento pasa por `LoopRunManager` (`rails-router.ts:564-566, :758, :1136-1137`); el camino QueueManager con `/specrails:implement` (`rails-router.ts:1257-1260`) solo sobrevive con `SPECRAILS_LOOPS_SECTION=false`. La entrega (worktrees, `rail_pr_deliveries`, review packet) es de Desktop. Core exige `ownership.git === 'host'` (`core-host.ts:53`); Desktop lo garantiza con `SPECRAILS_GIT_AUTO=false` solo si hay manifiesto o `isRailPrDeliveryEnabled()` (`loop-executors.ts:131`; residual en `core-execution.ts:89`).

**Roles y permisos.** Configurable por datos (`.specrails/agent-runtime.json`, schema v1): proveedor/modelo/esfuerzo/thinking/escalado por rol, límites, comandos de verificación, umbrales de review, `rolePrompts` (editables desde Settings, `~/.specrails/runtime-role-prompts.json`, `docs/agent-runtime.md:341-348`), guardrails, eficiencia. Cableado: `AgentRole = 'architect' | 'developer' | 'reviewer'` (`executor-types.ts:8`), `validateAgentRequest` (`:135-136`), `ROLES` en `config.ts:6, 85, 108`, `additionalProperties: false` en el schema (`:38-40`), `ROLE_SKILLS` (`openspec.ts:12`), `roleInstructions` (`prompts.ts:398-410`), `openai-executor.ts:87`, `role-routing.ts:18-21`, `core-host.ts:91-95`, `efficiency.ts:8`, `efficiency-summary.ts:105, 126`; pseudo-rol `fixer`. Permisos con dos semánticas: lectura/escritura (`cli-executor.ts:30, 236, 243`, `kimi-acp.ts:15-16`, `workspace-tools.ts:55-56`, `openspec.ts:64`) y alcance de artefactos OpenSpec (`openspec.ts:212-223`). Los `custom-*.md` de la página Agents y los perfiles son de Desktop y Core 5+ no los lee (`SPECRAILS_PROFILE_PATH` solo en un comentario de `installer/util/registry.ts:63`).

**Journal.** `state.json` tiene fases fijas con orden obligatorio (`pipeline-state.ts:110, 575-586`); `pipeline-state.ts` se compila y copia a cada proyecto (`scaffold.ts:1645-1650`, `src/architecture.test.ts:48-51`): cambiarlo obliga a rematerializar el framework.

### 2.2 Qué está duplicado y qué desaparece con v3

- Dos motores de grafo con la misma forma (un sucesor, ciclos, tope de iteraciones, presupuesto): `LoopRunManager` y `runWorkflow`. **Desaparece**: Core dirige; `LoopRunManager` pasa a ser lanzador, ejecutor de pasos de Desktop y proyector de eventos.
- Dos almacenes de estado de ejecución. **Desaparece**: el checkpoint de Core es la única verdad del recorrido; `loop_runs`/`events` son proyecciones.
- Dos planos de control humano (`jobs/:id/messages` y `agent-runtime/runs/:runId/resume`). **Converge** en el driver (D3).
- Dos capas de agentes (roles de Core frente a `custom-*.md`/perfiles). **Converge** en la biblioteca de roles (D6).
- Dos verificaciones (sentinel de texto frente a receipt). **Conviven**: el sentinel sigue siendo el resultado de un paso de Desktop; la verificación con receipt es una pieza de Core; la entrega exige receipt.
- Validación de configuración reimplementada en Desktop sobre schema vendorizado (`agent-runtime-settings.ts:146-216`, paridad en `agent-runtime-settings.test.ts:192-194`). **Se mantiene** el patrón para el nuevo schema de definiciones, pero la validación de piezas la hace solo Core.

### 2.3 Deriva del contrato

`integration-contract.json` declara `workflowVersion: "3"` e `instructionsVersion: "3"` (líneas 280-281) frente a `'6'`/`'9'`; `phases` omite `fixer` (260-266); `cliOperations` (227-233) omite `prompts, capabilities, evidence, recovery`. El `schemaVersion: "5.0"` lo fija `src/installer/phases/install-config.test.ts:380`. Nada de esto se consume en runtime (Desktop toma `workflowVersions` de `runtime api`, `agent-runtime-loader.ts:78-86`), pero debe corregirse antes de anunciar piezas y protocolo. Pins desfasados: `agent-runtime-package.test.ts:67` (`['5']`); `docs/internals/programmatic-agent-runtime.md:118` (Core 5.1.1).

## 3. Qué aporta LangGraph de verdad y dónde no aporta nada

Superficie de LangGraph usada (`workflow.ts`): checkpointer propio (`FileCheckpointSaver`, compilado en `:492`), `interrupt()` (`:353-359`), `getStateHistory` para bifurcar al checkpoint anterior al nodo objetivo (`:509-511`), `graph.getState` para reconciliar con el ledger (`:500`), `Command({resume})` (`:502`), replay con `Command({goto})` (`:327`), `graph.invoke` con `durability: 'sync'` y `recursionLimit` calculado (`:526`), `Annotation` para el schema. Lo que **no** hay: `Send` (fan-out), subgrafos, `addConditionalEdges` ni streaming; `nextStep` es `string | null`; `InterruptRequest` solo admite `approval` y `question`. Es **un ejecutor durable de pasos con un solo sucesor, ciclos acotados e interrupciones**: la misma forma que `validateLoopGraph` impone al loop de Desktop. Un loop se traduce **uno a uno** a una `WorkflowDefinition`.

Lo que LangGraph sí da y el loop de Desktop no tiene: reanudación durable a través de reinicios con invalidación selectiva, presupuesto por run con receipts atados al candidato, ledger con intento, visita y uso por paso. Lo que no da por sí solo: fan-out, steering en mitad de un turno (el hijo arranca con stdin `ignore`, `agent-runtime-bridge.ts:133-136`), paridad de proveedores (Kimi sin uso, `kimi-acp.ts:145`; Gemini `unknown`, `capabilities.ts:17`; solo Claude acepta tope en USD, `cli-executor.ts:205-208`) ni un formato declarativo.

Conclusión v3: **el motor de Core dirige todos los grafos**; las piezas de Core se ejecutan dentro del proceso de Core; los pasos de Desktop se ejecutan en Desktop mediante una interrupción nueva que sigue el patrón de `question`. El precio es un arranque del proceso de Core por cada paso de Desktop (hoy cada paso de IA ya lanza un CLI completo, así que el coste relativo es pequeño) y un reloj de pared del loop vigilado por Desktop mientras Core está pausado. A cambio desaparece la duplicación de motores y la durabilidad es uniforme.

## 4. Decisiones de producto y arquitectura

Alternativas evaluadas en v1 (media de tres jueces sobre 10): core-first 4,3; two-plane-contract 6,0; skeptic 7,2; incremental-adapter 7,7. v3 toma la secuencia de incremental-adapter, la higiene y la protección de fingerprint de skeptic, el contrato descriptivo y el buzón de steering de two-plane, y la ejecución de grafos definidos fuera de Core que proponía core-first, con dos correcciones: ningún código del usuario ejecuta dentro de Core y el grafo implement en código no cambia de identidad mientras existan runs que lo necesiten.

Para los grafos híbridos se compararon dos modelos y se elige el primero:

| Modelo | Quién recorre el grafo | Ventajas | Coste |
|---|---|---|---|
| **Core dirige, Desktop ejecuta sus pasos por interrupción `host-step`** *(elegido)* | Core | Un solo motor y un solo checkpoint para todo el loop; "un loop es un workflow de Core" es literal; presupuesto, iteraciones y reanudación uniformes; el motor de Desktop se retira al final | Nueva interrupción y `resume --host-result` en Core; un arranque de proceso de Core por paso de Desktop; el reloj de pared del loop lo vigila Desktop |
| Desktop dirige, cada pieza de Core es un run de Core de un nodo | Desktop | Sin cambios de protocolo en Core | Dos motores para siempre; durabilidad del recorrido en Desktop (cursor); dos decisores; un directorio de run por pieza |

Decisiones:

| Decisión | Por qué | Qué protege |
|---|---|---|
| Core publica una **librería cerrada de piezas** con parámetros validados por schema, un **compilador** de definiciones declarativas a `WorkflowDefinition` y un **protocolo de pasos delegados al host**; las definiciones las crea y guarda Desktop | Es la visión de producto; el rigor vive en las piezas, que son código de Core revisado y probado | Ningún código del usuario ejecuta dentro de Core; dirección `shared ← pipeline ← agent-runtime ← installer` (`src/architecture.test.ts:33-37`) |
| Los grafos de fábrica (Implement, Batch, Freestyle, SDD Quick) pasan a ser **definiciones de Desktop** construidas con piezas; el built-in en código `specrails-implementation` se mantiene intacto como **legado** hasta Core 7 | El conocimiento de cada fase (prompts, OpenSpec, guardrails, receipts) sigue en las piezas de Core; la composición pasa a Desktop; los runs guardados reanudan con su paquete retenido | `core-host.ts:79` y `workflow.ts:174-176` siguen protegiendo los runs antiguos; el fixture v4 (`legacy-runtime.test.ts`) sigue en verde |
| Los pasos de Desktop (`host:prompt`, `host:shell`) son **piezas de Core cuyo ejecutor es el host**: el nodo lanza `context.interrupt({ kind: 'host-step', … })`, el proceso sale con exit 2, Desktop ejecuta el paso con su maquinaria actual y reanuda con `resume --host-result <file>` | Sigue el patrón ya existente de `question`/`approval`; reutiliza sesiones interactivas, watchdogs, sentinels, `{{cmd:*}}` y contabilidad de Desktop sin reescribirlos | Un solo motor por ejecución; stdin de Core sigue `ignore`; request congelado e identidad intactos |
| Un loop se guarda en Desktop (tabla `loops`, `LoopGraph` con `kind` + `params` por nodo); la definición se compila al lanzar y se **congela por run** (`desktop-workflow-definition.json` *(propuesto)*, `wx`); `version` = sha256 del contenido | Editar un loop publicado nunca afecta a un run en curso; el hash entra en `workflowFingerprint` | `INCOMPATIBLE_RESUME` protege la reanudación; mismo patrón que `desktop-runtime-config.json` |
| La validación de piezas y parámetros la hace **Core** (`runtime workflows validate --stdin` *(propuesto)*) al publicar y al lanzar; Desktop valida solo estructura | Core es quien ejecuta; una validación espejo derivaría como la del schema de runtime | Errores por `nodeId` mostrables en el canvas |
| Roles definidos por el usuario en la configuración de runtime (`roles.<id>` con `access` y `artifacts`); la página Agents es la biblioteca de roles y `custom-*.md` se mapea a roles | Un `role-turn` necesita un rol con permisos declarados | Dos semánticas de permiso separadas; snapshot de argv de Claude (`compact-runtime.test.ts:464-473`) intacto para los tres roles built-in |
| Roles abiertos (C2) en la **etapa 2** | Prerrequisito de `role-turn` y de grafos propios | — |
| Un veredicto negativo (`reviewer` rechaza, `verify` falla, `end` con `outcome: 'failure'`) termina el run como `succeeded` con `completion.ok: false` y exit 0; `failed`/exit 1 solo para errores de ejecución | El bridge marca `failed` cualquier exit ≠ 0 (`agent-runtime-bridge.ts:197-211`) y el driver no debe confundir negocio con fallo | El resultado llega a Desktop como dato |
| Core reporta `completion: { ok, reasons, verified }`; Desktop exige `verified` para `on_review` cuando el grafo escribe | Generaliza la garantía de `checkCoreCompletion` (`core-execution.ts:137-181`) | Un grafo sin verificación no entrega a revisión por sí solo |
| Iteraciones, presupuesto de coste/tokens y ciclos: Core (`maxTransitions`, `WorkflowBudget`, `decider` de Core). Reloj de pared del loop, inactividad de un paso de Desktop y cancelación: Desktop (driver) | Core solo cuenta tiempo mientras su proceso corre; los pasos de Desktop transcurren con Core pausado | `timeoutMinutes` y `aiStepTimeoutMinutes` conservan su semántica actual |
| Desktop es el único escritor de `ai_invocations`; los pasos de Desktop se contabilizan como hoy; el uso de las piezas de Core va en una tabla hija bajo una fila agregada por run | Semántica desconocido ≠ 0, `estimated`, reparto entero compartido; `bySurface` y `programmaticUsageAvailability` sin filas duplicadas | `server/util/distribute-int.ts`, `parseProgrammaticUsage`, `spending.ts` |
| Pausa humana (`question`, `approval`, decisión de un paso de Desktop) con **un solo escritor**: el driver | `AgentRuntimeControls.resume` exige loop `completed` (`agent-runtime-controls.ts:287-288`); un loop pausado retiene `railLoopRuns`, la fila `jobs` y el `seq` | Sin dos escritores sobre el mismo run |
| Los loops guardados con el formato actual siguen en el motor de Desktop hasta la etapa 7; entonces se compilan al formato nuevo (mapeo 1:1 de tipos) y el motor antiguo se retira tras paridad por tests y telemetría | El motor actual tiene ~2.900 líneas de tests que codifican semántica (fail-fast, stall, no-progreso, historial, sesiones); no se reescribe de golpe | Ningún test se borra antes de demostrar paridad |
| Contrato **5.1 aditivo** y capacidades `workflowDefinitions`, `hostSteps`, `openRoles` (más `workflowCatalog` para el legado) | Mismo patrón que `configurableGuardrails` (`agent-runtime-bridge.ts:92-93`) | Acoplamiento de releases mínimo |
| Steering por buzón de fichero consumido en límites de intento | Sin stdin ni protocolo nuevo | Request congelado e identidad intactos |

Arquitectura objetivo:

1. **Specs** se diseñan en Desktop y se congelan por run en `desktop-context.json` (`core-execution.ts:85-101`).
2. **Roles** se definen en Desktop (página Agents) y viajan en la configuración de runtime congelada por run.
3. **Grafos** (loops) se componen en el Loop Builder con piezas de Core y pasos de Desktop; se guardan, publican, forkean y exportan como hoy; los de fábrica también son definiciones de Desktop.
4. **Rails** eligen loop, engine, worktree y presupuesto; entregan por `rail_pr_deliveries`.
5. **Core** valida la definición y la dirige como un run durable; ejecuta sus piezas; para cada paso de Desktop se pausa (`host-step`) y Desktop lo ejecuta y reanuda; al final devuelve `completion` y uso por paso por el protocolo JSONL de siempre.

## 5. Contrato Core ⇄ Desktop

### 5.1 Librería de piezas v1 *(propuesta)*

Cada pieza declara `kind`, JSON Schema de `params`, `effect` (`read`/`write`/`host`), los `ends` que admite y los canales de estado que lee y escribe.

**Ejecutadas por Core**

| Pieza | Parámetros | Efecto y salidas | Nota |
|---|---|---|---|
| `role-turn` | `roleId`, `prompt` (plantilla; `{{spec.*}}`/`{{const:*}}` los resuelve Desktop al compilar, `{{run.*}}` los resuelve Core desde `$vars`), `structuredOutput?`, `sessionContinuity: 'run' \| 'none'` | `effect` = `roles[roleId].access`; escribe `$outputs[nodeId]`, `$history`; `ends` libres con regla `next` opcional sobre la salida | Reutiliza `createRoleInvoker`; una reparación en sesión si la salida estructurada es inválida |
| `decider` | `roleId` (rol `access: 'read'`), `goal` | `{ verdict: 'continue' \| 'stop', reason }`; exactamente dos `ends` etiquetados | Prompt de sistema y parseo portados de `loop-decider.ts` |
| `verify` | `commands: 'configured' \| VerificationCommand[]`, `unverified?` | `effect: 'write'`; receipt `full`/`scoped`; `$verified = { receiptId, transition }`; `ends` `success`/`failure` | `verifyPipeline` + `validateVerificationRequest` |
| `check` | `repositoryId`, `command`, `args`, `cwd?`, `timeoutMs?`, `policy?` | Azúcar sobre `verify` con un comando; mismo receipt | Para comandos deterministas con evidencia (`openspec validate`, tests) |
| `condition` | `expr` sobre `$outputs`, `$vars`, `$verified`, códigos de salida | Determinista, `effect: 'read'`; `ends` etiquetados | Cierra la deuda del `condition` actual (`loop-run-manager.ts:2152-2162`) |
| `approval` / `question` | `reason` / `text` | Interrupciones existentes; exit 2 hasta `resume --approve`/`--answer` | — |
| `openspec-archive` | `change` | Determinista, `effect: 'write'`; reutiliza `archive` de `graph/artifacts.ts` | La preparación de artefactos la hace un `role-turn` con `artifacts: 'all'` y `openspecSkill`, como hoy el arquitecto |
| `end` | `outcome`, `requiresVerified?` | `next: null`; fija `completion.ok` y `completion.verified` | Obligatorio `requiresVerified: true` en `end(success)` de grafos con escritura para entregar a revisión |
| `implementation.architect`, `.developer`, `.fixer`, `.verify`, `.reviewer`, `.archive` (C4) | los de `CoreNodeDeps` que hoy fija `core-host.ts` (`attempts`, `policy`, `change`) | Los nodos de `coreNodes(deps)` con su `CoreState`; el compilador exige el orden relativo de `CORE_NODE_ORDER` y los predecesores obligatorios, permitiendo piezas intercaladas | Un grafo que las use corre con `journal: 'implementation'` |

**Ejecutadas por Desktop (host)**

| Pieza | Parámetros | Protocolo | Nota |
|---|---|---|---|
| `host:prompt` | `prompt` (con `{{cmd:*}}`, `{{spec.*}}`, `{{const:*}}` sin expandir; Desktop expande por proveedor al ejecutar, como hoy), `sentinel?: 'verification'`, `stopOnFailure?`, `sessionContinuity: 'run' \| 'none'`, `captureVars?: string[]` | El nodo interrumpe con `{ kind: 'host-step', stepId, piece: 'host:prompt', params, previous: { sessionId?, output? } }`; Desktop ejecuta el paso (una sola vez o sesión interactiva, watchdog, stall-retry) y devuelve `{ ok, text, sessionId?, vars?, usage, durationMs, verdict?, failed?, stalled? }`; Core escribe `$outputs`, `$vars`, `$history` y contabiliza `usage` | Es el `ai-step` de hoy; `{{cmd:implement}}`/`{{cmd:batch}}` dejan de ser válidos aquí: se sustituyen por las piezas `implementation.*` |
| `host:shell` | `command`, `repositoryId?`, `timeoutMs?`, `captureVars?`, `stopOnFailure?` | Misma interrupción con `piece: 'host:shell'`; Desktop ejecuta con `runShell` y devuelve `{ exitCode, stdout, stderr, vars?, durationMs }` | Es el `shell` de hoy; sin receipt de Core (para evidencia usar `check`) |

Estado genérico `CoreDefinitionState` *(propuesto)* en `src/agent-runtime/definitions/state.ts`: canales `$outputs` (por nodo, JSON acotado), `$vars` (`{{run.*}}` capturados), `$history` (acotado, para deciders), `$verified`, `$answers`; prefijo `$` para no colisionar con ids de nodo (`workflow.ts:58-60`). Un grafo con piezas `implementation.*` usa la unión con `CoreState`.

### 5.2 Formato de definición *(propuesto)*

`schemas/workflow-definition.schema.json` en Core, vendorizado byte a byte en `server/schemas/` de Desktop (paridad por test, como `agent-runtime.schema.json`):

```
{ schemaVersion: 1, id, version: '<sha256 del contenido sin version>', title,
  journal: 'ledger-only' | 'implementation', change: 'new' | 'existing' | 'none',
  entry, maxTransitions, budget?: { maxCostUsd?, maxTokens? },
  roles: string[],
  nodes: { [id]: { kind, params, ends: string[], maxAttempts?, retrySafe? } },
  delivery?: { requiresVerified: boolean } }
```

Ids de nodo: los UUID del builder (`loop-graph-rf.ts:41-47`) cumplen `NODE_ID`; el compilador rechaza `START`/`END`/`next` y colisiones con canales. `change: 'none'` sirve para grafos sin OpenSpec (vigilar CI, lint, auditoría): Core usa `runtime-<sha>` solo como nombre del directorio del run. `budget.maxDurationMs` no se usa en grafos dirigidos: el reloj de pared lo vigila Desktop.

### 5.3 Protocolo de ejecución dirigida *(propuesto)*

1. Desktop compila el loop, congela `desktop-workflow-definition.json` y lanza `runtime run --context … --config … --change … --definition <file>`.
2. Core valida, crea el request congelado (`workflow: { source: 'definition', definitionHash }`) y ejecuta piezas hasta terminar o interrumpirse.
3. Interrupción `host-step`: Core emite `runtime-result { status: 'paused', pendingHostStep: { stepId, piece, params, previous, attempt } }` y sale con **exit 2**. Desktop ejecuta el paso con sus ejecutores (`runAiStep`/plan interactivo, `runShell`), aplica sus reglas actuales (idle watchdog con un reintento por sesión, `awaitHumanDecision`, sentinel, captura de `{{run.*}}`), registra la invocación en `ai_invocations` y escribe `host-result-<attempt>.json` (`wx`).
4. Desktop lanza `runtime resume --context … --host-result <file>`; Core valida que el resultado corresponde al `stepId`/`attempt` pendiente, lo aplica al estado (`$outputs`, `$vars`, `$history`, `context.reportUsage`), decide el sucesor (`ok`/`failed`/`verdict`) y continúa.
5. `question`/`approval`: igual que hoy (exit 2), pero atendidas por el driver desde el chat del job (D3). `blocked`/`failed`/`succeeded`: `runtime-result` terminal con `completion`.
6. Cancelación: Desktop mata el paso de Desktop en curso o envía SIGTERM al proceso de Core (aborto cooperativo, `cli.ts` ya lo maneja); el checkpoint queda reanudable.
7. Reinicio de Desktop a mitad de un paso de Desktop: el checkpoint de Core sigue pausado en `host-step`; al reanudar, un paso `host:shell` o `host:prompt` marcado como escritura interrumpida exige `--recover <stepId>` explícito (misma regla que los nodos de escritura de Core); un `host:prompt` de lectura se repite.

Coste del modelo: un arranque de proceso de Core por paso de Desktop más la lectura del checkpoint. Hoy cada paso de IA ya lanza un CLI de proveedor completo; el sobrecoste es pequeño y medible en la etapa 2 (señal: sobrecoste medio por transición por debajo de un segundo en el fixture de `smoke-agent-runtime-pair.mjs`). Optimización posible fuera de este plan: mantener el proceso de Core vivo con un canal de resultados; no se hace ahora porque rompería la regla de stdin `ignore` y la retención de paquete por run.

### 5.4 CLI, request, eventos, evidencia

- `runtime workflows` → `{ nodeKinds: [{kind, executor: 'core' | 'host', paramsSchema, effect, ends}], nodeKindsVersion, builtins: [{ id: 'specrails-implementation', version: '6', deprecated: true }] }`; `runtime workflows validate --stdin` → `{ ok, errors: [{nodeId?, path, message}] }`; `runtime run … --definition <file>` (excluyente con `--workflow`, que se mantiene solo para el legado); `resume --host-result <file>` (excluyente con `--answer`/`--approve` en la misma invocación); `status` añade `workflow`, `completion`, `pendingHostStep`; `runtime api` añade `nodeKinds`, `nodeKindsVersion` y `capabilities.workflowDefinitions: 1`, `hostSteps: 1`, `openRoles: 1`, `workflowCatalog: 1`; `runtime signal --context --stdin` (C6).
- `agent-runtime-request.json` gana `workflow: { id, version, source: 'builtin' | 'definition', definitionHash }`; Core copia la definición a `agent-workflow/<runId>/definition.json` en el primer `run`; `resume` recompila desde esa copia y `workflowFingerprint` garantiza la identidad.
- Eventos JSONL sin tipos nuevos: `workflow-event` (`step_started/step_succeeded/step_failed/step_interrupted`, con `stepId` = id de nodo del usuario y `usage` por intento), `agent-event`, `verification-output`, `span`, `runtime-efficiency-event`, `runtime-result` (+ `workflow`, `completion`, `pendingHostStep`). Exit 0/2/1 intactos; salidas acotadas (una línea > 2.000.000 caracteres invalida el protocolo, `agent-runtime-bridge.ts:144-146`).
- Evidencia: `pipeline/<runId>/` con `state.json` (sin transiciones de fase en `ledger-only`), `verification/evidence/*.json`, `agent-workflow/<runId>/checkpoint.json`, `host-result-*.json`. `implementation.reviewer` y un `role-turn` con `REVIEW_OUTPUT_SCHEMA` producen un `output` con forma de `ReviewRecord`, que `readRuntimeEvidence` (`delivery-evidence.ts:497-557`) y la proyección a `evidence.confidence` (`:436-446`) ya leen cuando el paso se llama `reviewer`; D2 añade `reviewerStepId` al `EvidenceHarvestUnit` para otros ids.
- Nombre del change: `change: 'new'` ⇒ Desktop pasa `--change runtimeChangeName(runId)` (`agent-runtime-bridge.ts:17-19`); `'existing'` ⇒ `{{run.changeId}}` capturado por un paso anterior (`$vars`) o literal; `'none'` ⇒ sin OpenSpec.

### 5.5 Versionado y compatibilidad

`integration-contract.json` 5.0 → **5.1** en C0 (aditivo: `agentRuntime.nodeKinds`, `agentRuntime.hostStepProtocol`, corrección de `workflowVersion`/`instructionsVersion`/`phases`/`cliOperations`; `install-config.test.ts:380` y `CLAUDE.md:27` en el mismo commit). `RUNTIME_API_VERSION` sigue en 1; `CORE_WORKFLOW_VERSION` sigue en `'6'` (solo describe el built-in legado). Cada definición lleva su hash como versión; un cambio de comportamiento de una pieza sube `nodeKindsVersion` y los runs congelados siguen con su paquete retenido. Desktop nuevo + Core sin `workflowDefinitions`/`hostSteps`: los loops nuevos no se pueden lanzar (mensaje de actualización); los loops en formato antiguo y el built-in siguen igual. Desktop viejo + Core nuevo: no envía `--definition`; Core ejecuta el built-in legado. Core 7 (etapa 7) retira el built-in en código y sube el contrato a 6.0; los runs antiguos reanudan con su paquete retenido.

### 5.6 Emparejamiento de releases (cada etapa con release de Core)

1. Core: release-please publica la versión; `npm run ci` incluye `check:package`.
2. Desktop: subir `CORE_BUNDLE_VERSION` (`.github/workflows/desktop-release.yml:48`); regenerar `scripts/assemble-bundled-core.lock.json` con `node scripts/assemble-bundled-core.mjs <version>`; actualizar la constante esperada del contrato que compara `checkCoreCompat` (`server/core-compat.ts`, invocado por `scripts/check-core-compat.ts:60-70`, que solo tolera como aviso el schema 3); `npm run check-core-compat`, `npm run check:package`; actualizar `docs/internals/programmatic-agent-runtime.md:118`.
3. Nunca marcar probado un gate de release con un bundle de desarrollo (`source-bundle.json`).

## 6. Responsabilidad por repositorio

**Core** implementa la librería de piezas (Core y host), el compilador y validador, el estado genérico, el protocolo `host-step`, la política de completion (`ok`, `verified`), los roles abiertos, el buzón de steering, las capacidades anunciadas y una definición de referencia de implement **solo para tests de paridad**. Core no contiene grafos de producto nuevos, nunca decide entrega, coste aceptado ni pausa de loop, y nunca ejecuta código del usuario.

**Desktop** implementa el builder (paleta de piezas Core y host, roles, validación por Core al publicar), el compilador `LoopGraph → definición`, el driver (`run --definition`, ejecución de pasos host, `resume --host-result`, pausas humanas, reloj de pared, cancelación), las definiciones de fábrica, el gate de entrega por `completion.verified`, la proyección de pasos, la contabilidad, la reanudación tras reinicio, las rutas/MCP de steering, la biblioteca de roles y la limpieza de directorios. Desktop nunca planifica dentro de un run de Core ni ejecuta un grafo nuevo nodo a nodo por su cuenta. Todo bloque Desktop que toque `server/modules/**` termina con `npm run audit:architecture` (manifiesto `server/modules/boundaries.json`) y `npm run docs:source-map`.

## 7. Bloques de trabajo Core (C0..C7)

### C0 — Higiene de contrato y fingerprint congelado del built-in legado

- Modificar `integration-contract.json:227-233, 260-266, 280-281`: `cliOperations` += `prompts, capabilities, evidence, recovery` (no `evaluate`, interno); `phases` += `fixer`; `workflowVersion: "6"`, `instructionsVersion: "9"`; `schemaVersion: "5.1"` (línea 2, con `src/installer/phases/install-config.test.ts:380` y `CLAUDE.md:27`); bloques `agentRuntime.nodeKinds: []` y `agentRuntime.hostStepProtocol: null` (se rellenan en C3) y `agentRuntime.builtins: [{ id: 'specrails-implementation', version: '6', deprecated: false }]`.
- Crear `src/agent-runtime/integration-contract.test.ts` *(propuesto)*: compara esos campos con `CORE_WORKFLOW_VERSION`, `ROLE_INSTRUCTIONS_VERSION`, `CORE_NODE_ORDER`, los verbos de `cli.ts` y, desde C3, la lista de piezas.
- Extraer de `core-host.ts:140-147` una función pura `implementationWorkflowDefinition(deps)` *(propuesto)*; crear `src/agent-runtime/__fixtures__/implementation-workflow-fingerprint.json` *(propuesto)* con el fingerprint de `validateWorkflow` (`workflow.ts:67-70`) y un test en `core-host.test.ts` que lo compare.
- Corregir el docstring de `core-host.ts:69-74`, usar `RUNTIME_API_VERSION` en `core-host.ts:27`, y la referencia inexistente a `schemas/profile.v1.json` en `scaffold.ts:32` y `docs/agent-runtime.md:73`.
- Tests: `core-host.test.ts`, `cli.test.ts` (`:198` ya asserta `'6'`/`'9'`), `legacy-runtime.test.ts`, `install-config.test.ts`, el nuevo test de contrato.
- Aceptación: `npm run ci` en Core; fixture v4 reanuda; Desktop (D0) pasa `check-core-compat` contra el tarball 6.1.0.
- Dependencias: ninguna.

### C1 — `WorkflowHost` interno y `completion` del built-in

- Crear `src/agent-runtime/workflows/host.ts` *(propuesto)* (tipo `WorkflowHost` con `id, version, journal, change, roles, steps, build(deps), completion(state, context)`) y `workflows/implementation.ts` *(propuesto)* con la definición movida de `core-host.ts` y su `validateCompleted` (`core-host.ts:115-139`) tal cual; `completion` reproduce la inspección de `checkCoreCompletion` (fases `done`, receipt `full` válido, aceptación) para que Desktop deje de calcularla.
- `core-host.ts`: `runCoreWorkflow` (`:75-149`) delega en `runWorkflowHost(host, options)` *(propuesto)*; `preflightCoreWorkflow` (`:50`) aplica `change` (`'new'` mantiene la guarda de `:81-83`; `'existing'` exige que `openspec/changes/<change>` exista; `'none'` no exige `context.specs`). La guarda `ownership.git === 'host'` (`:53`) no cambia.
- `cli.ts:143-195`: `status` (`:151-156`) y `runtime-result` emiten `workflow` y `completion`; `--workflow <id>` aceptado solo con `specrails-implementation` (compatibilidad); `api` (`:119`) emite `builtins` y `capabilities.workflowCatalog: 1`.
- Tests: `cli.test.ts`, `core-host.test.ts` (fingerprint intacto tras el movimiento), `workflow.test.ts`, `legacy-runtime.test.ts`.
- Aceptación: `runtime run` con y sin `--workflow specrails-implementation` produce el mismo fingerprint de `checkpoint.json`.
- Dependencias: C0.

### C2 — Roles abiertos: `access`, `artifacts` y `roles`

- `executor-types.ts:8, 85-111, 135-136`: `AgentRequest.access: 'read' | 'write'` y `AgentRequest.artifacts: 'none' | 'tasks-checkboxes' | 'all'` *(propuestos)*; `validateAgentRequest` valida ambos y acepta ids declarados en `config.roles`; `AgentRole` pasa a `string` con los tres built-ins como constantes; `fixer` sigue siendo `stance`.
- Sustituir la derivación binaria por `access`: `cli-executor.ts:30, 236, 243`, `kimi-acp.ts:15-16`, `workspace-tools.ts:55-56`, `openspec.ts:64`; sustituir el alcance por rol de `openspec.ts:212-223` por `artifacts`. Los tres roles conservan sus valores implícitos (architect: `read` + `all`; developer: `write` + `tasks-checkboxes`; reviewer: `read` + `none`).
- `config.ts:6, 85, 108, 196` y `schemas/agent-runtime.schema.json:38-40`: clave aditiva `roles: { [id]: RuntimeAgentConfig & { access, artifacts, prompt?, openspecSkill? } }` *(propuesto)* junto a `agents` (obligatoria con el trío); `graph/roles.ts:83` resuelve desde `roles`; `rolePrompts` acepta ids declarados.
- `openspec.ts:12`, `prompts.ts:398-410`, `openai-executor.ts:87`, `role-routing.ts:18-21`, `core-host.ts:91-95`, `efficiency.ts:8`, `efficiency-summary.ts:105, 126`: leer skill, prompt, pipeline compacto y agregados del descriptor; un rol sin pipeline compacto usa `runToolLoop` (`guarded-loop.ts:155`); `compact/prompt-inputs.ts` tolera prompts sin `## Developer summary` (test).
- Tests: `cli-executor.test.ts` (snapshot Claude intacto; `access: 'read'` con id nuevo produce el modo de solo lectura), `openspec.test.ts` (matriz `artifacts` × operación), `openai-executor.test.ts`, `config.test.ts`, `compact-runtime.test.ts`, `kimi-acp.test.ts`.
- Contrato: `configSchemaVersion` sigue 1; capacidad `openRoles: 1`; Desktop re-vendoriza el schema (D1b).
- Aceptación: `roles.security-reviewer` (`access: 'read'`) valida y su turno en Claude produce el argv de solo lectura; el argv de los tres roles built-in es byte-idéntico al snapshot.
- Dependencias: C1.

### C3 — Piezas v1, compilador, protocolo `host-step` y `--definition`

Objetivo: que Core dirija un grafo declarativo compuesto por Desktop, incluidos sus pasos de Desktop.

- Crear `src/agent-runtime/definitions/` *(propuesto)*: `schema.ts` (Ajv sobre `schemas/workflow-definition.schema.json`), `state.ts` (`CoreDefinitionState`), `node-kinds/` (`role-turn.ts`, `decider.ts`, `verify.ts`, `check.ts`, `condition.ts`, `interrupts.ts`, `openspec-archive.ts`, `end.ts`, `host-prompt.ts`, `host-shell.ts`; cada uno con `paramsSchema`, `effect`, `executor`, `build(params, deps) => WorkflowNode`), `compile.ts` (`compileDefinition(definition, deps) => { workflow, host }`: schema, ids, `ends`, colisiones de canal, roles existentes, `requiresVerified`, `maxTransitions`, hash) y `registry.ts` (`nodeKindsVersion`).
- Protocolo host: `workflow-types.ts:22-25` gana `InterruptRequest = … | { kind: 'host-step'; stepId; piece; params; previous; attempt }` e `InterruptResume = … | { hostResult: HostStepResult }` *(propuestos)*; `workflow.ts` expone `pendingHostStep` en el estado como hace con `pendingQuestion`; `cli.ts`: `resume --host-result <file>` (valida `stepId`/`attempt`, tamaño acotado, `wx` ya escrito por el host) y `runtime-result.pendingHostStep`. El nodo host aplica el resultado: `ok/failed`, `text` → `$outputs`/`$history`, `vars` → `$vars`, `verdict` (sentinel) → sucesor, `usage` → `context.reportUsage`, `sessionId` → `previous` del siguiente intento. Un `host:prompt` con `stopOnFailure` y `failed` ⇒ `status: 'failed'` del nodo (reintento según `maxAttempts`).
- `decider`: portar prompt y parseo de `loop-decider.ts` de Desktop. `verify`/`check`: envolver `verifyPipeline`/`validateVerificationRequest`; `completion.verified` = existe `$verified` sin escritura posterior. Interpolación de `{{run.*}}` en `params` desde `$vars` antes de ejecutar cada pieza.
- `cli.ts`: `runtime workflows`, `runtime workflows validate --stdin`, `run --definition <file>`; el request congela `workflow: { source: 'definition', definitionHash }`; `resume` recompila desde `agent-workflow/<runId>/definition.json`.
- `runtime api`: `nodeKinds`, `nodeKindsVersion`, `capabilities.workflowDefinitions: 1`, `hostSteps: 1`.
- Definición de referencia para tests: `src/agent-runtime/definitions/__fixtures__/review.json` *(propuesto)* = `verify → reviewer(role-turn con REVIEW_OUTPUT_SCHEMA) → end`.
- Tests: `definitions/compile.test.ts` (cada pieza; ciclo con `decider` acotado por `maxTransitions`; ids inválidos; `end(success)` sin `requiresVerified` en grafo con escritura rechazado; mismo JSON ⇒ mismo hash), `definitions/run.test.ts` (grafo `host:prompt → check → role-turn(write) → verify → decider ↺ / end` con un host simulado que responde a `host-step`; SIGTERM durante `verify` + `resume --recover`; reinicio a mitad de `host:shell` ⇒ `--recover` exigido; `question` + `resume --answer`; rechazo ⇒ exit 0 + `ok: false`; `host-result` con `stepId` equivocado rechazado), `cli.test.ts`, `workflow.test.ts`, `openspec.test.ts`.
- Contrato: `agentRuntime.nodeKinds` y `agentRuntime.hostStepProtocol: 1` reflejan el registro.
- Aceptación: el grafo de referencia termina 0 con `completion.ok`; un grafo con ciclo termina en `maxTransitions` con `blocked` y motivo legible; reanudar tras matar el proceso continúa en el mismo nodo; un paso host pausa con exit 2 y `pendingHostStep` completo.
- Dependencias: C2.

### C4 — Piezas de implement y definición de referencia

- `node-kinds/implementation.ts` *(propuesto)*: seis piezas que envuelven `coreNodes(deps)` (`graph/nodes.ts:441-443`) con los parámetros que hoy fija `core-host.ts`; un grafo que las contiene usa `journal: 'implementation'`, `CoreState ∪ CoreDefinitionState`, y el compilador exige el orden relativo de `CORE_NODE_ORDER` y los predecesores obligatorios (`verify` tras `developer`/`fixer`, `reviewer` tras `verify`, `archive` tras `reviewer`), permitiendo piezas intercaladas.
- `definitions/__fixtures__/implementation.json` *(propuesto)*: la definición equivalente al built-in, usada solo por tests de paridad y por `runtime evaluate`; el grafo de producto lo publica Desktop (D6).
- Tests: `definitions/implementation.test.ts` (definición de referencia ⇒ mismos receipts y aceptación que el built-in sobre el fixture de `evaluation.ts:31-69`; `role-turn` extra entre `reviewer` y `archive`; orden inválido rechazado).
- Aceptación: paridad demostrada; el built-in sigue byte-idéntico.
- Dependencias: C3.

### C5 — Evaluación por definición

`runtime evaluate` (`cli.ts:96-101`, interno) acepta `--definition` y añade al corpus (`evaluation-corpus.ts:13-19`) la definición de referencia de implement, la de review y un grafo híbrido con host simulado. Aceptación: `runtime evaluate --definition …` offline devuelve 0 con las variantes defectuosas rechazadas. Dependencias: C4.

### C6 — Steering por buzón: `runtime signal`

- Crear `src/agent-runtime/steering.ts` *(propuesto)*: `steering-inbox.jsonl` junto al checkpoint con registros `{kind: 'message', id, at, from, text}` y `{kind: 'consumed', id, attemptId, at}`; `signal` escribe con `O_APPEND` sin tomar el lease; el consumo se registra en el propio buzón (no en el `output` del intento, que `--invalidate` borra).
- `graph/roles.ts:93-94`: sección `## Operator steering` con los mensajes no consumidos; `compact/prompt-inputs.ts:59-80` la tolera. Los pasos `host:prompt` reciben los mensajes pendientes en `params` del `host-step` para que Desktop los inyecte por su vía nativa de steering.
- `cli.ts`: verbo `signal --context --stdin` (≤ 20.000 caracteres).
- Tests: consumo idempotente tras `--invalidate`; `signal` sin run activo falla; sección tolerada.
- Contrato: `cliOperations` += `signal`; capacidad `steeringInbox: 1`.
- Dependencias: C3.

### C7 — Core 7: retiro del built-in en código (etapa 7)

Eliminar `workflows/implementation.ts`, `core-host.ts` como grafo, `--workflow` y `defaultImplementationEngine` del contrato; `workflows`/`nodeKinds` obligatorios; contrato 6.0; los runs antiguos reanudan con su paquete retenido (`sameRuntimeIdentity` ya lo exige). Dependencias: telemetría de la etapa 7 y D7.

## 8. Bloques de trabajo Desktop (D0..D7)

### D0 — Compatibilidad y validadores derivados del catálogo

- `agent-runtime-loader.ts:78-117`: parsear `nodeKinds`, `nodeKindsVersion`, `builtins` y las capacidades `workflowDefinitions`/`hostSteps`/`openRoles`/`workflowCatalog`; método `validateWorkflowDefinition(input)` (`workflows validate --stdin`, mismo `invoke` con stdin que `validateRuntimeConfig`).
- `agent-runtime-controls.ts:23, 82`: `STEP_IDS` derivado de los `steps` del run (`runtime status`), con la lista actual como fallback; `agent-runtime-metrics.ts:25, 43, 49, 76, 91`: `PHASES` y el límite de tres roles pasan a validar contra el catálogo.
- `server/core-compat.ts` y `scripts/check-core-compat.ts`: aceptar 5.1; `agent-runtime-package.test.ts:67` → `['6']`; `docs/internals/programmatic-agent-runtime.md:110, 112, 118`.
- Tests: `agent-runtime-loader.test.ts`, `agent-runtime-controls.test.ts`, `agent-runtime-metrics.test.ts`, `agent-runtime-package.test.ts`, `server/core-compat.test.ts`.
- Aceptación: `npm run check-core-compat` con Core 6.1.0; un `runtime status` con `steps` distintos a los seis no es rechazado.
- Dependencias: C0 publicado.

### D1 — Builder de grafos, compilador y driver

- **Modelo.** `loop-graph.ts:27-34`: nodos con `kind` *(propuesto: `'core:role-turn' | 'core:decider' | 'core:verify' | 'core:check' | 'core:condition' | 'core:approval' | 'core:question' | 'core:openspec-archive' | 'core:implementation.<fase>' | 'host:prompt' | 'host:shell'`)* y `params`; los tipos actuales se conservan para los loops guardados; `isDefinitionGraph(graph)` *(propuesto)* ⇔ algún nodo lleva `kind`. `validateLoopGraph` exige `params` conformes al schema vendorizado y delega la validación de piezas a Core al publicar. Espejo en `client/src/features/loops/lib/loops-api.ts` y `loop-validate.ts`.
- **Compilador.** `server/modules/loops/runtime/loop-definition.ts` *(propuesto)*: `compileLoopToDefinition(graph, launch)`: interpola `{{spec.*}}` y `{{const:*}}` (no `{{cmd:*}}` ni `{{run.*}}`), mapea `maxIterations → maxTransitions`, `maxCostUsd → budget`, `decider` branches → `ends` etiquetados, `stopOnFailure`/`failureRecovery` → `maxAttempts`/`retrySafe`/`ends`, `requireVerificationPass` → `sentinel: 'verification'`, `requireRunVars` → validación de `$vars` en `condition`, `end.outcome`, `delivery.requiresVerified` según `classifyLoopEffect` extendido (escribe ⇔ algún `role-turn` con rol `access: 'write'`, `verify`/`check`, `openspec-archive`, `host:prompt` o `host:shell`), y calcula el hash. Test de propiedad: mismo loop ⇒ misma definición ⇒ mismo hash.
- **Driver.** `server/modules/loops/runtime/loop-driver.ts` *(propuesto)*, invocado por `LoopRunManager.run()` (`loop-run-manager.ts:1038`) cuando `isDefinitionGraph`: congela `desktop-workflow-definition.json` (`wx`, junto a `desktop-context.json`, `core-execution.ts:56-105`; fuerza `ownership.git: 'host'` en `:89`), lanza el bridge con `definitionPath`, y en cada `runtime-result` pausado con `pendingHostStep` ejecuta el paso con los ejecutores actuales (`runAiStep`/`planInteractiveAiStep`/`_runInteractiveAiStep` para `host:prompt`, `runShell` para `host:shell`), aplicando idle watchdog con un reintento por sesión, `awaitHumanDecision`, sentinel y `captureVars` con la lógica de `resolveRunVars`, contabiliza la invocación como hoy, escribe `host-result-<attempt>.json` y reanuda con `--host-result`. Vigila `timeoutMinutes` con reloj de pared propio y cancela matando el paso host o el proceso de Core. Los loops sin `kind` siguen por el recorrido actual sin cambios.
- **Bridge.** `agent-runtime-bridge.ts:41-62, 81-111`: opciones `definitionPath`, `hostResultPath`; parseo de `pendingHostStep`; `AiStepResult` gana `completion?` y `pendingHostStep?` *(propuestos)*; rechazo con mensaje de actualización si faltan capacidades.
- **Gate de entrega.** `checkCoreWorkflowCompletion` *(propuesto)* en `core-execution.ts` exige `state.status === 'succeeded'` y proyecta `completion`; `rail-isolated-launch.ts` mueve a `on_review` solo con `completion.ok && (completion.verified || !escribe)`; `checkCoreCompletion` queda exclusivo del built-in legado. `completion.ok: false` es un run correcto con veredicto negativo.
- **Publicación.** `loops-router.ts` `/loops/:id/publish` valida grafos con `kind` en Core (`validateWorkflowDefinition`) y devuelve errores por `nodeId`; el builder los pinta en el canvas.
- **Builder.** `LoopBuilderPage.tsx`, `loop-graph-rf.ts`: paleta leída de `/api/projects/:id/agent-runtime/capabilities` (`nodeKinds`) con dos grupos ("Core" y "Desktop"); inspector por pieza (`role-turn`: rol de la biblioteca, prompt, salida estructurada; `decider`: rol de lectura y goal; `verify`/`check`; `condition`; `approval`/`question`; `host:prompt` con los `{{cmd:*}}` actuales; `host:shell`; `end`); cada nodo muestra quién lo ejecuta; plantillas `review-after-fix` y `audit-read-only` *(propuestas)* en `loop-templates.ts`; claves i18n en los ocho locales; `docs/running-pipelines.md` y `docs/guide/en/pipeline/5-the-loop-builder.md`.
- Tests: `loop-graph.test.ts`, `loop-definition.test.ts` *(propuesto)*, `loop-driver.test.ts` *(propuesto)* (secuencia pausa → paso host → `resume`; `ok: false` no dispara fail-fast; cancelación en cada estado; reloj de pared; `host-result` `wx`), `loop-run-manager.test.ts` (los grafos sin `kind` no cambian), `loop-executors.test.ts`, `agent-runtime-bridge.test.ts`, `server/core-execution.test.ts`, `loops-router.test.ts` (publicación con errores por nodo), `loop-templates.test.ts`, `rail-isolated-launch.test.ts` (invariante: sin `verified` no hay `on_review` en grafos con escritura), paridad i18n, tests de `loop-validate`.
- Aceptación: el loop híbrido de la señal 1 publicado se lanza desde un rail y termina en `on_review`; loops de fábrica y loops guardados sin cambios de comportamiento (`loop-factory.test.ts`); sobrecoste medio por transición host medido en el smoke; `npm run audit:architecture` y `npm run docs:source-map` limpios.
- Dependencias: D0, C3 publicado.

**D1b — Biblioteca de roles mínima.** Re-vendorizar `server/schemas/agent-runtime.schema.json` (paridad `agent-runtime-settings.test.ts:192-194`); `agent-runtime-settings.ts:139, 320` y `client/src/features/settings/lib/agent-runtime.ts:4-7` renderizan `roles`; los chequeos espejo (`agent-runtime-settings.ts:168-212`) aceptan `roles`; `AgentRuntimeSettingsSection.tsx` gana filas de rol con `access`, `artifacts`, prompt y engine. Tests: `agent-runtime-settings.test.ts`, paridad de schema, i18n. Dependencias: C2.

### D2 — Pasos y contabilidad

- `loop-driver.ts`: traducir `workflow-event` `step_started/step_succeeded/step_failed/step_interrupted` a `loop_step`/`loop_step_end` con `nodeId` = id de nodo del usuario, `executor: 'core' | 'host'` y `parentNodeId` para las piezas `implementation.*` *(propuestos)* en `LoopStepEventPayload` (`loop-run-manager.ts:397-466`), con el mismo `takeSeq`; `loop_step_end.status` (`:440`) gana `'paused'`. `loop.run_progress` deriva `iteration` de las visitas del `decider` o del nodo de entrada del ciclo.
- Migración **64** *(propuesta)*: tabla `ai_invocation_roles` *(propuesta)* con `invocation_id`, `step_id`, `role`, `attempt`, `provider`, `model`, `tokens_in/out/cache_read/cache_create`, `total_cost_usd`, `estimated`, `duration_ms`. Una fila agregada `agent-runtime`/`per-role` por run en `ai_invocations` cubre las piezas de Core y sigue siendo la única que ven `spending.ts` (`bySurface`) y `programmaticUsageAvailability` (`loop-run-manager.ts:582-588`); los pasos host se contabilizan como hoy con su proveedor real. Las hijas se escriben en la transacción de `completeLoopStepRecovery` (`:1407-1418`) con `server/util/distribute-int.ts` (sustituye a `splitInt`, `:600-605`) y `NULL` para desconocido.
- `parseProgrammaticUsage` (`agent-runtime-accounting.ts:23-69`) sigue como fallback tras crash; test de paridad: hijas + pasos host == uso total del run.
- `delivery-evidence.ts:102-112`: `EvidenceHarvestUnit.reviewerStepId` *(propuesto)*.
- Cliente: `LoopStepExplorer.tsx` (pasos con `kind` y ejecutor), `AgentRuntimeRuns.tsx`/`useRuntimeRuns.ts` (desglose por rol), `LogViewer.tsx` y `PipelineProgress` toleran ids arbitrarios; `docs/internals/loop-step-log-explorer.md`.
- Tests: `loop-driver.test.ts`, `agent-runtime-accounting.test.ts`, `loop-runs-store.test.ts`, `server/db.test.ts`, `delivery-evidence.test.ts`, tests del explorer.
- Dependencias: D1 (solo Desktop).

### D3 — Pausas humanas en el driver

- `loop-driver.ts`: `pendingQuestion`, `pendingApproval` de un nodo `approval` del usuario y la decisión humana de un paso host entran en `awaitHumanDecision` (`loop_runs.status = 'paused'`, `job.interactive` con `acceptingTurns: true`); la respuesta por `POST /:projectId/jobs/:id/messages` (`project-router-jobs.ts:364-384` → `sendInteractiveTurn`, `loop-run-manager.ts:941-946`) reanuda a Core con `--answer`/`--approve` desde el propio driver. `AgentRuntimeControls` no interviene mientras el loop está vivo. La aprobación de archivo del built-in legado sigue en Agent Runtime settings.
- Tests: `loop-driver.test.ts` (pausa → respuesta → reanudación; cancelación durante la pausa), `project-router-jobs.test.ts`.
- Dependencias: D1.

### D4 — Reanudación tras reinicio de Desktop

- Migración **65** *(propuesta)*: `run_request_json` en `loop_runs` (`migrations.ts:711-731` más columnas posteriores): el `LoopRunRequest` sin callbacks (grafo compilado, constants, `followUp`, `addenda`, `deciderEngine`, `executionManifest`, `cwd`/`repoDir`, `railIndex`, `ticketCompletionStatus`). No hace falta cursor: el recorrido vive en el checkpoint de Core.
- `reconcileOrphanLoopRuns` (`loop-runs-store.ts:553-609`): un run dirigido por Core con `run_request_json` y checkpoint reanudable ⇒ `paused` con motivo `restart`, sin tocar la fila `jobs`; el resto, comportamiento actual.
- Acción `resume` en `project-router-loop-runs.ts` que reconstruye el driver desde `run_request_json` y re-adjunta la liquidación aislada desde la fila durable de `rail_pr_deliveries` (`reattachIsolatedSettlement` *(propuesto)* en `rail-isolated-launch.ts`; `:1242-1250` deja de aparcar `settlement_interrupted`). Si el checkpoint espera un `host-step` de escritura interrumpido, la UI pide `recover` explícito.
- Tests: `loop-runs-store.test.ts`, `loop-driver.test.ts` (reinicio simulado en cada estado), `rail-isolated-launch.test.ts`, `server/db.test.ts`.
- Aceptación: señal 2.
- Dependencias: D2.

### D5 — Steering desde misiones

- `agent-runtime-controls-router.ts:24-80`: `POST /:projectId/agent-runtime/runs/:runId/steer` → `runtime signal` con el runtime **retenido** del run (`resolveRetainedAgentRuntime`); para un paso host en curso, el driver entrega el mensaje por la vía nativa actual (`docs/agent-live-steering.md`); `server/mcp/tools/jobs.ts:43-55`: acción `runtime_steer`; tarjeta de misión (`docs/internals/mission-rail-cards.md`).
- Tests: `agent-runtime-controls.test.ts`, MCP tools, `agent-live-steering.test.ts`.
- Dependencias: C6 publicado.

### D6 — Grafos de fábrica en Desktop y biblioteca de roles

- `loop-factory.ts`: `factory:implement` y `factory:batch` pasan a definiciones con `implementation.*` (`architect → developer → verify → reviewer → archive → end(requiresVerified)`, con `fixer` en las correcciones, como `CORE_NODE_ORDER`); batch = implement con todos los tickets del rail en `desktop-context.json` (hoy ya es así: `dominantTicketScope` 'all'); `factory:freestyle` = `role-turn(rol freestyle, write) → verify → decider ↺ host:prompt({{cmd:fix}})`; `factory:sdd-quick-openspec` = el híbrido de la señal 1. Cuando el Core activo no anuncia `workflowDefinitions`, los de fábrica caen al `core-implementation` actual. `loop-templates.ts` re-expresa `ship-and-green`, `verify-pass`, `ci-watch` y el resto con piezas (`fixLoopGraph(['{{cmd:implement}}'])` pasa a componer `implementation.*` seguido de `verify → decider → host:prompt(fix)`).
- `profiles-router.ts:456-536` y Agent Studio (`client/src/features/agents/components/AgentStudio.tsx`): cada `custom-*.md` se proyecta a `roles.<id>` (prompt = cuerpo; `access`, `artifacts`, engine, `openspecSkill` en frontmatter); los `sr-*` se muestran como los tres roles built-in; orquestador y `routing` de perfiles quedan obsoletos (retiro en D7). El selector de rol del builder lee esta biblioteca.
- Tests: `loop-factory.test.ts` (paridad de receipts y aceptación entre `factory:implement` como definición y el built-in, sobre el fixture de C4), `loop-templates.test.ts`, `profiles-router.test.ts`, tests del Agent Studio, `loops-router.test.ts` (fork).
- Aceptación: señal 3; un agente creado en Agent Studio con `access: 'read'` aparece como rol en el builder y su turno corre en Core con el argv de solo lectura.
- Dependencias: D1b, C4 publicado.

### D7 — Migración de loops antiguos y retiro del motor de Desktop (etapa 7)

Solo tras dos releases consecutivas con contador *(propuesto)* en analytics igual a cero de lanzamientos QueueManager slash (`rail.job_started` con `/specrails:` o `$implement`) y de `runMergeBack`, y con paridad demostrada entre el recorrido actual y el driver sobre los grafos guardados.

- Compilador de compatibilidad: `ai-step → host:prompt` (o `implementation.*` cuando el prompt es `{{cmd:implement|batch}}`), `shell → host:shell`, `decider → core:decider`, `condition → core:condition`; migración de la tabla `loops` que añade `kind` sin borrar los tipos antiguos; los loops publicados se revalidan en Core.
- Retirar el recorrido nodo a nodo de `loop-run-manager.ts`, `rails-router.ts:1257-1260`, `rail-isolated-launch.ts:1897-1952` (`runMergeBack`), la rama `pipeline.mjs status` en `core-execution.ts:139` y `core-completion.ts:60`, `operation: 'core-implementation'`, `SPECRAILS_PROFILE_PATH` (`queue-manager.ts:2475-2577`, `loop-executors.ts:189-201`), perfiles/orquestador (`docs/internals/profiles.md` reescrito).
- Recolección de basura de `.specrails/runtime-packages/<digest>` y `pipeline/<runId>` asentados, con retención configurable (`agent-runtime-package.ts`).
- Contrato 6.0 con Core 7 (C7). Actualizar `openspec/specs/loop-execution/spec.md:158-166` ("Zero Specrails-Core Coupling"), `rail-loop-execution/spec.md:101-113` y `docs/internals/companion-rails-as-loops-contract.md`.
- Tests: paridad del compilador de compatibilidad sobre todos los grafos de `loop-templates.ts` y `loop-factory.ts`; `rails-router.test.ts`, `rail-isolated-launch.test.ts`, `profiles-router.test.ts`, `agent-runtime-package.test.ts`.

## 9. Orden de trabajo

| Etapa | Bloques | Par de releases | Entregable y comprobación para avanzar |
|---|---|---|---|
| 1. Higiene y compatibilidad | C0 + C1 + D0 | Core 6.1.0 (contrato 5.1) / Desktop 2.58.0 | Contrato sin deriva con test que lo mantiene; fingerprint del built-in congelado; `completion` emitida por Core; validadores de Desktop derivados del catálogo; `check-core-compat`, `check:package` y fixture v4 en verde |
| 2. Roles abiertos, piezas, protocolo host y builder | C2 + C3 + D1 + D1b | Core 6.2.0 / Desktop 2.59.0 | Un loop híbrido compuesto en el builder se valida en Core al publicar, se lanza desde un rail y Core lo dirige como un run durable con pasos de Desktop; loops guardados sin cambios; invariante "sin `verified` no hay `on_review`"; sobrecoste por transición host medido |
| 3. Observabilidad, contabilidad, pausas y reanudación | D2 + D3 + D4 | solo Desktop (Core 6.2) | Cada nodo como paso en el explorer con su ejecutor; desglose por rol con paridad y sin doble conteo; pausas desde el chat del job; reinicio ⇒ `paused` y reanudación sin duplicar coste |
| 4. Implement en Desktop y biblioteca de roles | C4 + C5 + D6 | Core 6.3.0 / Desktop 2.6x | Grafos de fábrica como definiciones de Desktop con paridad de receipts frente al built-in; plantillas re-expresadas; Agent Studio define roles usables por `role-turn`; evaluación offline por definición |
| 5. Steering | C6 + D5 | Core 6.4.0 / Desktop 2.6x | `runtime signal` + ruta + MCP + tarjeta de misión; consumo idempotente con `--invalidate`; entrega nativa en pasos host |
| 6. Telemetría y paridad | — | — | Dos releases de datos: lanzamientos legacy a cero; compilador de compatibilidad con paridad sobre todos los grafos guardados y plantillas |
| 7. Retiro del motor de Desktop y Core 7 | D7 + C7 (contrato 6.0) | emparejado obligatorio | Un solo motor y un solo camino de entrega; built-in en código retirado de Core; perfiles retirados; GC de directorios |

Cada etapa se puede entregar sola; la 3 no requiere release de Core. Dentro de la etapa 2, Core (C2 + C3) puede publicarse antes que Desktop (D1) y probarse con el CLI y un host simulado; el emparejamiento se cierra cuando llega D1. Cada bloque termina con sus pruebas focalizadas; la batería completa (`npm run typecheck`, `npx vitest run server/modules`, `npm run test --prefix client`, `npm run audit:architecture`, `npm run docs:source-map`, `npm run check-core-compat`; en Core `npm run ci`) se ejecuta sobre el resultado integrado de cada etapa.

Estimación orientativa para un solo maintainer, sin contar releases: etapa 1, una a dos semanas; etapa 2, ocho a diez semanas (C2 toca diez sitios cableados y el snapshot de argv; C3 añade el protocolo host y el compilador; D1 es el driver y el mayor cambio de UI); etapa 3, tres semanas; etapa 4, tres a cuatro semanas; etapa 5, una semana; etapa 6, sin desarrollo; etapa 7, tres a cuatro semanas. La etapa 2 concentra el riesgo; a cambio, desde ella el usuario compone grafos híbridos propios dirigidos por Core.

## 10. Riesgos y trampas con mitigación

- **Permisos definidos por el usuario.** Un rol con `access: 'write'` ejecuta código en el repositorio con el sandbox del developer de cada CLI (`cli-executor.ts:44-72`). Mitigación: `access` y `artifacts` los aplica Core en ejecutores y herramientas, nunca el prompt; los guardrails siguen siendo de Core; Desktop marca visualmente los roles con escritura; los grafos con escritura exigen `verified` para entregar.
- **Paridad de proveedores.** Las piezas de lectura se comportan igual por construcción; las de escritura heredan el sandbox de cada CLI; los pasos host usan la maquinaria de Desktop de hoy (idéntica por proveedor); Kimi sin uso ⇒ `estimated`; Gemini `unknown` gateado. El snapshot `__fixtures__/claude-architect-invocation.snapshot.json` es el guardián de C2.
- **Sobrecoste del protocolo host.** Un arranque de Core por paso de Desktop. Mitigación: medirlo en la etapa 2 con `smoke-agent-runtime-pair.mjs`; si supera el segundo por transición, optimizar la carga del checkpoint antes de considerar un proceso residente.
- **Escrituras interrumpidas en pasos host.** Un `host:shell` o `host:prompt` con escritura cortado por un reinicio no es idempotente. Mitigación: misma regla que los nodos de escritura de Core (`--recover` explícito), con la UI de recuperación existente.
- **Dos semánticas de permiso.** `access` y `artifacts` son ortogonales; colapsarlas reabriría el hueco por el que un arquitecto de solo lectura escribe `proposal.md`. Matriz de tests en C2.
- **Evolución de las piezas.** Cambiar una pieza cambia el resultado de grafos guardados. Mitigación: `nodeKindsVersion`, runs congelados con paquete retenido, cambios de comportamiento solo con subida de versión y nota en el contrato.
- **Validación en el lugar equivocado.** Desktop valida solo estructura; Core valida piezas y parámetros al publicar y al lanzar.
- **Ciclos sin salida y grafos de solo lectura.** `maxTransitions` obligatorio, presupuesto por run, `end` obligatorio (`NO_END` ya existe).
- **Veredicto negativo confundido con fallo.** "Rechazo = `succeeded` + `ok: false`"; test explícito en D1.
- **Change equivocado.** `change: 'existing'` sin change resoluble falla en preflight.
- **Ownership de git.** `SPECRAILS_GIT_AUTO=false` es condicional (`loop-executors.ts:131`); D1 fuerza `host` en todo run dirigido.
- **Un solo ledger.** El checkpoint de Core dice qué corrió; `loop_runs`/`events` son proyecciones por `attemptId`, reconstruibles desde `events` (`loop-run-manager.ts:696-863`). El driver nunca decide el sucesor.
- **Contabilidad.** Piezas de Core en `ai_invocation_roles` bajo una fila agregada por run; pasos host como hoy; paridad de suma; `NULL` para desconocido.
- **Pausa con dos escritores.** Solo el driver reanuda un run vivo; `AgentRuntimeControls.resume` queda para continuaciones post-terminales.
- **Tamaño del estado.** `$outputs`, `$history` y `host-result` acotados para que `checkpoint.json` y las líneas JSONL sigan por debajo del límite del bridge.
- **Migración de loops antiguos.** El motor actual codifica semántica en ~2.900 líneas de tests. Mitigación: los loops antiguos no cambian de motor hasta la etapa 7, y solo tras paridad del compilador de compatibilidad sobre todas las plantillas y factorías.
- **Companion.** Sin tipos WS nuevos: `loop.run_*` y frames `event`; actualizar `docs/internals/companion-rails-as-loops-contract.md`.
- **Acoplamiento de releases.** Todo gateado por `runtime api`; `SUPPORTED_CORE_MAJORS` no cambia hasta la etapa 7; sección 5.6.
- **Superficie de tests.** `loop-run-manager.test.ts`, `rail-isolated-launch.test.ts` (~4.100 líneas) y `workflow.test.ts` no se reescriben antes de la etapa 7; los bloques añaden casos con ejecutores y hosts simulados.
- **Windows.** No se toca `cli-process.ts` ni el bootstrap de Kimi por stdin; `signal` y `host-result` escriben ficheros (`O_APPEND`/`wx`); `pipeline-state.ts` no cambia.
- **Journal.** `ledger-only` deja `state.json` con fases pendientes; cualquier lector consulta `workflow.journal` antes de interpretar fases. Test de invariante en D1.

## 11. Qué NO hacer

- No permitir código del usuario dentro de Core ni tipos de nodo definidos por el usuario: solo la librería cerrada de piezas, con parámetros validados por schema.
- No dejar que Desktop decida el sucesor de un nodo en un run dirigido por Core ni que sincronice ledgers nodo a nodo: el driver ejecuta pasos host y reanuda, nada más.
- No abrir stdin de Core ni un proceso residente en esta iniciativa: el protocolo host usa ficheros `wx` y `resume`, como `question`.
- No subir `CORE_WORKFLOW_VERSION` ni cambiar `id`, `ends`, `maxTransitions` u orden de `specrails-implementation` mientras exista en Core: `core-host.ts:79` y `workflow.ts:174-176` dejarían huérfano cada run guardado. El grafo de fábrica de Desktop es una definición distinta.
- No retirar el built-in en código de Core antes de Core 7 ni sin comprobar que la reanudación de runs antiguos usa el paquete retenido.
- No anidar `runWorkflow` en el mismo directorio de run: `acquireWorkflowLease` hace `mkdir` atómico de `.lease`.
- No cambiar `pipeline-state.ts` (fases por tipo de journal): se copia compilado en cada proyecto.
- No importar Core como ESM en proceso: `agent-runtime-loader.ts:67-73` lo evita a propósito.
- No añadir fan-out (`Send`) ni subgrafos en esta iniciativa.
- No introducir `Team`/`Recipe` como sustantivo de producto: el término es **workflow**/**grafo**, la unidad es **pieza**, y el nombre de la sección sigue siendo **Loops**.
- No aplicar `checkCoreCompletion` a un grafo que no sea el built-in legado, ni entregar a revisión un grafo con escritura sin `verified`.
- No dejar que Core escriba `ai_invocations`.
- No convertir un veredicto negativo en exit 1.
- No migrar los loops antiguos al driver ni retirar el motor de Desktop, QueueManager slash, merge-back o perfiles antes de la etapa 7.

## 12. Ideas adicionales

1. Exportar loops al repositorio del proyecto como `.specrails/workflows/<id>.json` *(propuesto, ruta reservada de Desktop)*, versionados con el código y compartibles; etapa 2.
2. Capacidad MCP por run para `role-turn` (`mintAgentCapability`, `agent-mcp-config.ts:311-360`) con tier observe, para que un rol lea specs y addenda en vez de solo el contexto congelado; etapa 5.
3. Pieza `repeat-for` *(propuesta)* que ejecuta un subconjunto de nodos por repositorio o por ticket de forma secuencial y agrega salidas, sin `Send`; devolvería a Batch las "oleadas" del antiguo slash command; etapa 4.
4. Persistir `loopId` en el rail para que un rail inactivo muestre y relance el mismo grafo; etapa 3.
5. Tarjeta de misión `workflow-launch` con paridad `rail-launch-parser.ts` ⇄ `rail-launch-draft.ts`, que proponga spec + grafo + engine; etapa 5.
6. Proceso de Core residente con canal de resultados para eliminar el arranque por paso host; solo si la medición de la etapa 2 lo justifica y con una revisión del modelo de retención de paquete.

## 13. Preguntas abiertas para el maintainer

1. ¿Se acepta el coste de un arranque de Core por paso de Desktop a cambio de un solo motor, o se prefiere que Desktop dirija los grafos híbridos (segundo modelo de la sección 4)? *Suposición: se acepta; medición en la etapa 2 con umbral de un segundo por transición.*
2. ¿Los roles se definen por proyecto (`agent-runtime.json`) o globalmente (página Agents, como los loops)? *Suposición: definición global con override por proyecto; la configuración congelada por run resuelve la mezcla.*
3. ¿`host:shell` y `check` conviven (uno sin receipt, otro con receipt) o solo debe existir `check`? *Suposición: conviven; `check` es la vía para evidencia de entrega.*
4. ¿La aprobación de archivo del built-in legado pasa al chat del job en la etapa 3 o sigue en Agent Runtime settings hasta su retiro? *Suposición: sigue en settings; las `approval` de grafos nuevos van al chat.*
5. ¿Debe seguir soportándose `SPECRAILS_LOOPS_SECTION=false` y el caso `SPECRAILS_RAIL_DELIVER_PR=0` sin manifiesto (que hoy Core rechaza)? *Suposición: solo hasta la etapa 7; el segundo se corrige en D1.*

## 14. Cómo retomar este plan más adelante

1. Verificar contra `main` de ambos repos: `CORE_WORKFLOW_VERSION` (`core-host.ts:24`), `ROLE_INSTRUCTIONS_VERSION` (`prompts.ts:7`), `integration-contract.json` (`schemaVersion`, `agentRuntime.nodeKinds`, `agentRuntime.hostStepProtocol`, `cliOperations`, `phases`), `SUPPORTED_CORE_MAJORS` (`server/core-package.ts:5`), `CORE_BUNDLE_VERSION` en `desktop-release.yml`, y la última migración en `server/db/migrations.ts` (63 al escribir esto; 64 y 65 propuestas se renumeran si `main` avanzó).
2. Saber qué bloques están hechos: C0 ⇔ existe `src/agent-runtime/__fixtures__/implementation-workflow-fingerprint.json`; C1 ⇔ `runtime-result` emite `completion`; C2 ⇔ `AgentRequest` tiene `access`; C3 ⇔ existe `src/agent-runtime/definitions/compile.ts` e `InterruptRequest` admite `host-step`; C4 ⇔ existe `definitions/__fixtures__/implementation.json`; C6 ⇔ `cli.ts` acepta `signal`; D0 ⇔ `STEP_IDS` ya no es constante; D1 ⇔ existen `loop-definition.ts` y `loop-driver.ts`; D1b ⇔ `AgentRuntimeSettingsSection.tsx` renderiza `roles`; D2 ⇔ existe la tabla `ai_invocation_roles`; D3 ⇔ el driver atiende `pendingQuestion`; D4 ⇔ `loop_runs` tiene `run_request_json`; D5 ⇔ ruta `/steer`; D6 ⇔ `factory:implement` es una definición con `implementation.*`; D7 ⇔ `loop-run-manager.ts` sin recorrido nodo a nodo.
3. Leer antes de tocar: `docs/internals/programmatic-agent-runtime.md`, `docs/internals/agent-runtime-framework-evaluation.md` (condición de un solo motor), `docs/internals/loop-step-log-explorer.md`, `docs/internals/interactive-jobs.md`, `docs/internals/safe-pr-review-flow.md`, `docs/agent-live-steering.md`, `specrails-core/docs/agent-runtime.md` ("Embed and extend") y este documento.
4. Tests que deben estar en verde antes de empezar cualquier bloque: Core `workflow.test.ts`, `core-host.test.ts`, `cli.test.ts`, `legacy-runtime.test.ts`, `compact-runtime.test.ts`, `install-config.test.ts`; Desktop `loop-run-manager.test.ts`, `loop-graph.test.ts`, `loop-executors.test.ts`, `agent-runtime-bridge.test.ts`, `agent-runtime-controls.test.ts`, `server/core-execution.test.ts`, `rail-isolated-launch.test.ts`, `delivery-evidence.test.ts`, `server/modules/architecture.test.ts`.
5. Si `main` ya introdujo un formato de definición, una interrupción de host, un campo `access` o un driver con otro nombre, adoptar el nombre real y actualizar este documento; no duplicar mecanismos.
6. Instrucción para iniciar la siguiente fase: crear los cambios OpenSpec `core-agent-engine` emparejados en ambos repos (propuesta, diseño, specs, tareas C0..C7 / D0..D7 y, en Core, un `contracts.md` compartido con el formato de definición, la librería de piezas y el protocolo `host-step`, como en `implementation-efficiency`), validarlos con `openspec validate --strict --json`, y empezar por **C0 + C1 + D0** sin marcar tareas hasta comprobarlas.
