# Auditoría UX del Project Builder y propuesta de revisión

Fecha: 11 de noviembre de 2026. Estado: diagnóstico y propuesta **pendientes de revisión del usuario**. No se implementa BUG-02 ni se cambia el auto-avance.

## 1. Alcance y método

Inspección local del checkout: creación, entrevista/blueprint, generación, lanzamiento, seguimiento, revisión y aceptación. Se siguen condiciones de UI, HTTP, composición y guardas; se leen pruebas con fixtures sintéticos. No se modifican proyectos, entregas ni preferencias y no se ejecutan proveedores ni pipelines de pago.

Certeza: **C** = conclusión de código con ruta y símbolo; **D** = evidencia documental; **H** = hipótesis o garantía pendiente de prueba integrada; **R** = reproducción ejecutada en esta auditoría. No hay observaciones R de interfaz ni reproducción visual. Una prueba existente citada es evidencia de su alcance por lectura, no un resultado de ejecución en esta sesión. Severidad: alta si impide avanzar por la vía inspeccionada o arriesga trabajo; media si dificulta avanzar o genera expectativas inconsistentes; baja para fricción menor. Los números de línea remiten a este checkout y los símbolos permiten localizar cambios futuros.

## 2. BUG-02: recorrido de lanzamiento

Referencias desde la raíz del repositorio:

| Ref. | Ruta, símbolo y líneas | Comportamiento comprobable (C) |
| --- | --- | --- |
| B1 | `client/src/features/builder/components/project-builder/BuilderSidebarEntry.tsx`, `handleLaunchM1` 124–152, `launchControls` 211 y `actions` 283 | El handler pasa literalmente 1 a `launchMilestone`; sólo `row.n === 1` recibe acciones iniciales. No prueba que sea imposible ejecutar M2+ manualmente por rails. |
| B2 | `client/src/features/builder/lib/milestone-progress.ts`, `isMilestoneLaunchable` 236–238 | Requiere todo > 0, sin cadena live, paused ni checkpoint. No consulta conflicto con rails manuales. |
| B3 | `client/src/features/builder/lib/milestone-launch.ts`, `launchMilestone` | POST `/api/projects/:id/blueprint/milestones/:n/launch` con autoAdvance; devuelve errores discriminados de red/servidor. El padre muestra toast y libera launching en finally. |
| B4 | `server/project-router.ts` 284–313, POST launch | parseInt y rango 1..999, mode compatible sequential/parallel, autoAdvance boolean, manager disponible; llama start y retransmite rechazo; excepción → 500. parseInt no valida estrictamente todo el segmento. El resultado es sequential. |
| B5 | `server/modules/builder/runtime/milestone-chain.ts`, `start` 268–293, `todoTicketIds` 176, `launchChunk` 185 | Rechaza cadena no terminal del mismo milestone, blueprint/milestone inexistente o ausencia de todo. Captura chunks y lanza sólo el primero. |
| B6 | `server/project-registry.ts` 1542–1607, IO de MilestoneChainManager | createInternalApi llama POST rails, PUT tickets, POST launch; integra mediante pr-decision. No ejecuta un segundo plan cliente. |
| B7 | `server/modules/delivery/runtime/rails-router.ts` 735–841, ruta launch | Admission de recuperación, presupuesto, review WIP, alcance de repositorios y solapamiento de ticket IDs en railJobs/railLoopRuns. No equivale a exclusión global de rails manuales. |
| B8 | `client/src/features/builder/components/project-builder/MilestoneProgressCard.tsx`, `MilestoneChainRow` 213–290, `MilestoneCard` 344–390 | El padre proporciona inicio; la cadena existente ofrece resume/cancel/PATCH y revisión por entrega. Continuar no crea otra cadena. |

### 2.1 Matriz actual / esperada para revisión

«Sin entregas» y «parcial» presuponen specs detalladas ya comprometidas, no sólo un outline generado. Las columnas actuales describen el popover, no todas las vías manuales. Cada fila tiene límites propios; todas son C, sin reproducción UI.

| Estado | M1 actual | M2+ actual | Esperado propuesto para ambos | Evidencia y límite |
| --- | --- | --- | --- | --- |
| Sin entregas, todo > 0, sin cadena | Inicio M1 + auto-avance | Sin inicio automático | Lanzar milestone con n real + toggle | B1–B5; generar contenido no equivale a ejecutar. |
| Parcial done/on_review + todo > 0, sin cadena | Inicio M1 si B2 lo permite | Sin inicio automático | Lanzar restantes + toggle; conservar entregado | B1–B5; done aceptado y on_review pendiente se cuentan separados; la base manual se analiza en §3. |
| Parcial + rail manual activo | B2 no consulta ese conflicto; rechazo puede llegar al POST | Sin inicio automático | Cuando realmente impida lanzar: botón visible disabled + motivo accesible; coexistencia no conflictiva según guardas | B2/B7; no se deduce bloqueo por mismo milestone o repositorio. |
| Cadena running/waiting | Sin nuevo inicio; fila de seguimiento | Igual si existe cadena | Seguir/cancelar cadena existente | B2/B8; waiting puede esperar integración, no es invitación a start. |
| Cadena paused | Resume/Cancel y motivo | Igual si existe cadena | Reintentar misma cadena/spec, sin reselección | B8 y manager resume 500–515; fallo no es checkpoint saludable. |
| Cadena awaiting_approval | Launch next, toggle, Cancel | Igual si existe cadena | Continuar existente; explicar que activar ON lanza siguiente rail | B8, manager setAutoAdvance 524–528; no es aprobación de entrega. |
| Sin todo, sin entrega revisable | Sin inicio | Sin inicio | Explicar estado y próxima acción pertinente, cero POST vacío | B2/B5; no inferir que todo está aceptado si hay inProgress/fallo. |
| Sin todo, on_review > 0 | Entregado / pendiente de revisión, Review | Igual | Abrir revisión y aceptar por su contrato; nunca equiparar entrega a aceptación | B8, milestone-progress `reviewableDelivery`; no lanzar ya entregadas. |
| Planned sin specs | No es el caso normal tras commit M1 | Generar siguiente milestone cuando corresponde | Generar/revisar/comprometer primero | B1 `nextPlanned`, `MilestoneGenerateShell`; no ofrecer ejecución de un outline. |

El contrato vigente `openspec/specs/milestone-lifecycle/spec.md` describe Launch M1 en sidebar. BUG-02 amplía esa capacidad en una revisión posterior; no se presenta como infracción oculta de ese contrato.

## 3. Elegibilidad, bases, bloqueos y conservación

### 3.1 Selección nueva frente a instantánea de cadena

C: `milestone-chain.ts:176–181` selecciona exclusivamente status `todo` y etiqueta literal `M<n>`. Excluye `on_review` (implementación entregada, pendiente de aceptación) y `done` (aceptada), si el estado almacenado es correcto. `orderChainTickets:51–76` ordena prerrequisitos **dentro del conjunto seleccionado**, desempata por executionOrder/id, ignora externos y rompe ciclos con orden estable. No comprueba que un prerrequisito excluido esté integrado ni resuelve ciclos como error.

`start:277–283` persiste chunks una vez. `advance:315–367` usa esa instantánea; no repite todoTicketIds para cada chunk. Que una selección nueva excluya entregadas no garantiza que un chunk pendiente siga siendo todo tras una ejecución manual posterior. H: hay que ensayar cambio a on_review/done entre captura y lanzamiento/retry; no basta el contador de UI para evitar duplicados.

### 3.2 Base efectiva e integración

C: el IO de `project-registry.ts:1565–1568` integra la entrega **de la cadena** mediante `acknowledge-no-changes` o `merge-local`, con expectedDecision. `integrateChunk` (`milestone-chain.ts:408–433`) espera confirmación; conserva el identificador y pausa si falla. `advance` enlaza chunks posteriores al head acumulado; sólo cuando no está enlazado integrateDelivery y hay executionManifest en entregas anteriores usa baseDeliveryIds de esa cadena (`multiRepositoryHistory:348`). La composición inspeccionada sí enlaza integrateDelivery; no atribuirle automáticamente ese camino alternativo multi-repo. Esto evita confundir entrega con integración confirmada.

El primer `launchChunk(..., null, null, undefined, row)` (`start:283`) no recibe head ni IDs manuales aunque se guarde integrationBranch. El camino ordinario de `rails-router.ts` pasa al lanzamiento aislado; `rail-isolated-launch.ts:1035–1064` hace fetch y llama `resolveIntegrationBranch` y `resolveWorktreeBaseRef`. `server/integration-branch.ts`, símbolos homónimos (126–175): prioridad explicit → ajuste de integración (por repositorio cuando aplica) → origin/HEAD → rama actual/HEAD; para fuente no explícita prefiere origin/<rama> si fetch tiene éxito y existe esa ref, con fallback local y aviso. **Una aceptación merge-local no implica que origin contenga ese commit**. Hay que verificar SHA/ancestría efectiva, no inferirla por el nombre de rama ni por done.

`rails-router.ts:805–816` llama `resolveRepositoryDeliveryBases` sólo al recibir baseDeliveryIds (o conserva manifiesto en relaunch). `server/modules/delivery/runtime/multi-repo-bases.ts`, `resolveRepositoryDeliveryBases`, valida entregas y bases por repositorio; su suite `multi-repo-bases.test.ts` contempla manifiestos, bases faltantes/cambiadas e integración. No se invoca automáticamente con todas las entregas manuales previas al primer chunk. Tramo no demostrado: que cada repositorio del primer lanzamiento contenga cada dependencia manual necesaria; no existe evidencia integrada aquí para prometerlo. Tampoco una entrega on_review es base aceptada por definición.

### 3.3 Alcance de guardas y carreras

| Control | Alcance comprobado (C) | Límite / evidencia de pruebas por lectura |
| --- | --- | --- |
| chain_active, start | Mismo milestone dentro de la DB del proyecto | `milestone-chain.test.ts:170` cubre segundo start secuencial. Dos starts durante await safeIntegrationBranch no quedan probados por ese test; el índice `idx_milestone_chains_active` (`server/db/migrations.ts:1578–1579`) protege persistencia, no una respuesta idempotente amigable ante concurrencia. |
| tickets_in_flight | IDs compartidos con railJobs/railLoopRuns del proyecto (`rails-router.ts:831–841`) | No todo el milestone/repositorio/proyecto. `rails-router.test.ts:2524–2533` cubre solapamiento con loop activo; no acredita por sí solo la carrera manual/start completa. Hay awaits entre guardas, resolución y reserva posterior; no se declara ausente toda protección posterior. |
| railFree | Rail concreta: entrega activa/indecisa, ejecución o ownership de otra cadena (`milestone-chain.ts:229–232`) | No reutilizar rail ocupada; puede asignar otra libre. Tests 556–596 cubren reuse, rail ocupado y límite. No es un bloqueo global por rail manual. |
| Capacidad | Crear rail puede rechazar rail_limit_reached | Tests 586/596: rechazo inicial y pausa posterior; decidir entrega puede liberar capacidad. No recomendar aceptar trabajo para liberar hueco sin revisión. |
| Recovery / presupuesto / WIP | Admission del proyecto; presupuesto diario proyecto/app; slot de revisión según gate | `rails-router.ts:735–766`; motivos distintos de conflicto manual. La reserva WIP se libera al finish/close. No demostrar todos esos gates con tests unitarios de cadena que usan IO fake. |
| Captura y ownership | Chunks capturados antes del primer await; launch pasa por guardas comunes | Riesgos H: cambio de estado manual, start/start y start/manual entre comprobación y adquisición. Necesitan barreras deterministas en tests de integración, no doble click UI como única protección. |

### 3.4 Escenarios sintéticos para juzgar garantías

| Fixture sin datos reales | Comprobado por código/pruebas existentes | Lo que falta probar / resultado requerido |
| --- | --- | --- |
| A done aceptada por merge-local, B todo depende de A | A queda fuera de selección nueva; B ordenado entre pendientes | Comparar base SHA de B con commit de A, incluido origin atrasado. Sólo permitir promesa de continuidad si B contiene A en cada repo afectado. H, no garantía actual completa. |
| A on_review sin aceptar, B todo depende de A | A no se relanza; orden ignora prerrequisito externo | No asumir que B contiene A. Definir si esperar integración/revisión o usar una base explícita verificada; decisión pendiente, nunca aceptar A automáticamente desde la UI propuesta. |
| Rail manual ejecuta B que sigue todo en snapshot | Intersección de IDs activos rechaza tickets_in_flight al llegar al guarda | Ensayar carrera antes/después de captura y reserva; cero segunda ejecución. |
| Rail manual ejecuta C ajena, B todo | No hay intersección; rail ocupada no se reutiliza | Puede coexistir si hay capacidad y gates permiten. No imponer bloqueo por mera coincidencia de proyecto/repositorio. |
| Primer launch rechazado (p. ej. capacidad) | `start:284–289` cancela fila y retransmite motivo; test 322/586 | No queda cadena activa; no implica rollback de rail ya creada/asignada. Reintento debe preservar todo entregado. |
| Falla un chunk posterior o su integración | Pausa sin saltar spec; test 331 y 688 | Resume reintenta el mismo chunk o integración pendiente, sin reimplementar entrega integrada. Ensayar cambios manuales de estado mientras está pausado. |
| Reinicio durante entrega/integración | Tests 501, 623, 669, 704 comprueban replay/checkpoint con IO; 729 usa Git real para tres specs de una cadena | Ese fixture no cubre una entrega manual previa, todas las combinaciones multi-repo ni concurrencia manual. Añadirlos antes de afirmar exactamente una vez en esos escenarios. |

Estas referencias describen pruebas existentes leídas; no son recibos de ejecución de esta auditoría.

## 4. Mapa del recorrido y límites de cobertura

Las rutas abreviadas `builder/…` en esta sección parten de `client/src/features/builder/`; `PB/…` significa `builder/components/project-builder/…`. Las suites de componente principales están en `client/src/components/__tests__/`. Se inspeccionan ramas de código y fixtures; no se ejecuta el recorrido contra un proyecto real. «Sin hallazgo» significa sin defecto adicional sustentado en esta inspección, no certificación de ausencia de problemas.

| Etapa / superficie real y símbolos | Estados, acciones y navegación de ida/vuelta | Evidencia disponible y continuidad / límite |
| --- | --- | --- |
| Entrada: `client/src/features/projects/components/AddProjectDialog.tsx`, AddProjectDialog | Con feature y callback: Existing/New; Existing → registro y New → builderMode.enter; cancelar cierra. Validación/errores del registro separados de creación nueva. | `ProjectBuilder.test.tsx:113–138`, `features/projects/components/__tests__/AddProjectDialog.test.tsx`. Sin hallazgo adicional; no se registra un proyecto para reproducir. |
| Hosts: `features/missions/components/AgentChatPanel.tsx:120`, AgentModeSurface:137 y AgentWorkspaceSidebar:175 | Board: conversación floating y blueprint adjunto; Agent Mode: inline y sidebar expandido con BlueprintPanel/readiness. Salir vuelve al agente, no a un shell retirado. | Código de hosts y fixtures ProjectBuilder. No probado resizing real ni cambio de modo durante turno. No afirmar que desmontan toda la sesión del agente: su chrome se oculta. |
| Entrevista: PB/BuilderConversation.tsx, BuilderComposer, BuilderDecisionCard | Vacío hero y recientes; proveedor/modelo/esfuerzo, enviar/Enter, Shift+Enter; stream ocupado; decisión surprise/approve al terminar turno; error notificado; Escape sale con confirmación si dirty. | `ProjectBuilder.test.tsx:328–413,490–498,830–962`; `builder/hooks/useBuilderSession.ts:460–538` filtra por conversationId/commitId no nulos. Resume rehidrata conversación/snapshot, no equivale a recuperar una ejecución. |
| Blueprint: PB/BlueprintPanel.tsx y BlueprintSpecModal.tsx | Dimensiones pending, assumptions, outline futuro, specs escritas frente a aún no escritas; click spec → preview sólo lectura → cerrar/Escape/backdrop retorna al panel. No son tickets antes de commit. | `ProjectBuilder.test.tsx:146–164,743–782` con rich-spec. Mismo panel en M2+. Sin hallazgo adicional; no se inspecciona una colección persistida inexistente de detalles M2+. |
| Readiness: PB/BlueprintReadiness.tsx, BuilderGenerationProgress.tsx | Pasos blueprint/specs/ready, primer bloqueo localizado; generating/outline/details/audit/repair; snapshot rechazado con razón/diagnóstico y repair; progreso parcial conserva posibilidad de continuar. | `ProjectBuilder.test.tsx:527–624,669–712,761`. No confundir completion del modelo con calidad aceptada por la aplicación. Sin hallazgo adicional. |
| Commit: PB/BlueprintCommitForm.tsx + useBuilderSession.commit | Nombre/localización/proveedores/GitHub; loading capacidad gh, checkbox ausente o deshabilitado con motivo; submit trim, error nombrado; Back/Escape → chat salvo submitting. | `ProjectBuilder.test.tsx:202–271,431–436`; hook 673–700. Bloqueo mientras petición pendiente preservado; sin probar permisos/FS reales ni GitHub. |
| Progreso/done: PB/BuilderConversation.tsx:215–275 | Pasos de bootstrap; warning GitHub distinguido de fallo; error vuelve al formulario; done ofrece Launch M1 + toggle y Open project; abrir vuelve al proyecto creado. | `ProjectBuilder.test.tsx:446–475`, hook `launchM1:707`; no confundir fin de creación con fin de implementación M1. Reapertura tras cierre total del proceso durante commit no ensayada aquí. |
| Reentrada: PB/BuilderRecentBlueprints.tsx y useBuilderSession.resume/abortAndReset | Sin conversaciones no hay lista; recientes reanudables, descarte con confirmación en dos pasos; bootstrap/resume tiene errores notificados. Exit aborta turno y resetea estado local. | `ProjectBuilder.test.tsx:637–655,830`; hook 357,583–622,746. Resume persistido es distinto de caché local y de recuperación de chains del servidor. No se promete rehidratar cada borrador no enviado. |
| Sidebar/popover: PB/BuilderSidebarEntry.tsx | Sin blueprint no renderiza; carga/modelo por proyecto; abrir lista milestones, cerrar fuera/Escape; Launch M1, generar siguiente, Review → packet o abrir rail; generación comprometida refresca. | `BuilderSidebarEntry.test.tsx:91–207`, `useMilestoneProgress`. BUG-02, sin otro defecto confirmado. El hook no expone detalle de error en su resultado: no se concluye cómo cada fallo de red aparece al usuario sin ensayar cache/host. |
| Generación M2+: PB/MilestoneGenerateShell.tsx | Planned → conversación grounded → preview/Readiness → commit-milestone; busy/stream/snapshot rechazado y reparación; error notifyError; onCommitted refresca padre; cerrar vuelve al sidebar con el popover cerrado. Proveedor sin política requerida muestra indisponibilidad. | Código `MilestoneGenerateShell` (bootstrap 109, WS 151 y commit); patrón snapshot de ProjectBuilder y prueba sidebar commit M2:207. No se ejecutó generación ni se demostró reanudación de cada conversación M2+ al reabrir shell; pendiente fixture específico. |
| Ejecución/seguimiento: PB/MilestoneProgressCard.tsx, MilestoneCard/ChainRow/RailRow | Segmentos no cero, contadores, intentos fallidos, rail con/sin delivery; running/waiting, checkpoint, paused con motivo, terminal; resume/cancel/PATCH y Review. | `MilestoneProgressCard.test.tsx:23–158`; chain tests §3. Cancelar cadena deja rail en vuelo, no es cancelar esa ejecución (`milestone-chain.test.ts:359`). Sin hallazgo adicional en esos controles. |
| Revisión: `features/delivery/pages/ReviewPacketPage.tsx`, ReviewPacketPage | Loading/404/error con retry; Overview/Changes, selección repo, volver via onClose o navigate('/'); revisión desde entrega específica. Cambiar proyecto/entrega invalida respuestas de otro scope. | `features/delivery/pages/__tests__/ReviewPacketPage.test.tsx`; código 140–245. No se garantiza retorno exacto al popover abierto: depende del host/onClose; validarlo antes de proponer navegación nueva. |
| Decisión/aceptación: `features/delivery/components/RailPrDecisionStrip.tsx` y ReviewPacketPage.runVerb | Capability determina verbo y significado; confirmación cuando aplica; busy evita acciones simultáneas; stale_decision refresca y comunica resolución ajena. Fallo conserva decisión; aceptar no equivale a iniciar siguiente cadena. | `pages/__tests__/ReviewPacketPage.test.tsx`, `components/__tests__/RailPrDecisionStrip.test.tsx:1104–1150` (merge-local/confirm/error). No se acepta entrega real. Diferenciar no_changes/completed, merged y on_review; no usar sólo porcentaje entregado como aceptado. |

### 4.1 Presentación, accesibilidad y límites por superficie

La lectura de clases/ARIA y jsdom no miden contraste, legibilidad física, geometría ni overflow. Para **cada fila** de esta tabla quedan sin verificar visualmente jerarquía, legibilidad y desbordamiento con zoom/textos largos; las indicaciones específicas precisan qué ensayar. Teclado/foco/nombre sólo se consideran C o cobertura de fixture leída, nunca R.

| Superficie | Jerarquía / legibilidad / overflow a contrastar | Teclado, foco y nombres: evidencia y límite |
| --- | --- | --- |
| AddProjectDialog | Dos tarjetas de entrada, formulario siguiente; ensayar nombres largos y viewport estrecho | Pruebas Existing/New por rol/testid; no recorrido real de Tab ni retorno del diálogo al trigger ejecutado. |
| Hosts floating/inline | Dos columnas frente a sidebar; ensayar ancho, scroll anidado y composer docked | Mismos controles; foco al cambiar modo/sidebar pendiente de prueba renderizada. No asumir equivalencia geométrica. |
| Conversación/composer/decisiones | Hero → thread/dock, progreso en stream; ensayar mensajes extensos | Tests Enter/Shift+Enter y Escape/confirm; etiquetas de selectores e iconos deben comprobarse con nombres accesibles y lector en ambos hosts. |
| BlueprintPanel/SpecModal | Resumen/prioridad/criterios frente a descripción completa; ensayar texto largo | Portal de preview con cierre/Escape; comprobar trap/retorno real y nombre anunciado, sin inferir conformidad del modal sólo por usar portal. |
| Readiness/generación | Primer bloqueo y diagnóstico separados de pasos de progreso; ensayar diagnóstico largo | Botón bloqueado/repair y motivo visibles por fixture; asociación anunciada del motivo/foco tras reparación pendiente. |
| CommitForm | Campos/proveedores/GitHub/error; ensayar paths largos y traducciones | Botones con estado disabled; checkbox proveedores role/aria-checked (`BlueprintCommitForm:137`); validar lectura de errores y orden Tab renderizado. Escape protegido mientras submitting. |
| Progreso/done | Lista por pasos y CTAs separados; warning no debe parecer éxito total | Busy/deshabilitado por código, toggle M1; foco al pasar a done y anuncio de warning pendiente de prueba real. |
| Recientes | Resumen y tiempo, descarte secundario en dos pasos; ensayar títulos largos | Fixture resume/discard; foco tras borrar o cargar conversación pendiente. |
| Popover Blueprint | Ancho 320 y top acotado son candidatos a ensayo estrecho, no overflow demostrado | `BuilderSidebarEntry:60–108,259–274`: portal a body, recalcula anclaje/resize, mueve foco al primer control, Escape restaura trigger; role dialog/nombre y aria-expanded. No alegar clipping por ancestro ignorando portal; trap completo/Tab y viewport móvil no probados. |
| MilestoneGenerateShell | Chat + preview/readiness; ensayar scroll y bloqueo por proveedor | Cierre y controles disabled en código; foco inicial/retorno y nombres de iconos quedan por comprobar con fixture aislado. |
| MilestoneCard/ChainRow | Segmentos, entregado vs aceptado, motivo y acciones; ensayar muchos rails | Toggle con semántica y controles textuales; confirmar motivo asociado al futuro botón bloqueado. No anunciar defecto de color por clases solamente. |
| ReviewPacket | Verdict/confianza/coste, pestañas y disclosures; ensayar diff y markdown largos | article aria-labelledby, tabs/tabpanel y flechas en test (`ReviewPacketPage.test.tsx:165`); foco tras aceptar/fallo y regreso al Builder pendiente. |
| DecisionStrip/aceptación | Acción primaria según estado y confirmación por consecuencias; ensayar razones largas | Tests confirman antes de POST y bloqueos; anuncio del error/confirmación y retorno de foco con lector pendiente. |

### 4.2 Reabrir y cambiar proyecto

`builder/hooks/useMilestoneProgress.ts:50–101` usa useProjectCache por namespace/projectId, conserva modelo cacheado al refrescar y separa overlay WS; al cambiar proyecto resetea live y compara mensajes con projectIdRef actual. `hooks/__tests__/useMilestoneProgress.test.tsx:58` ensaya mensaje del mismo/otro proyecto y cambio; `:73` refresh. Esto **no** prueba rehidratación tras reinicio ni implica que el servidor haya recuperado una ejecución: son capas distintas. `useBuilderSession.resume` carga transcript/snapshot de conversación persistida; cadenas SQLite y replay tienen la cobertura separada de §3.4. La auditoría no altera caché ni filtros WS.

## 5. Registro de hallazgos

No se han reproducido defectos en una sesión gráfica (R vacío). Los siguientes separan conclusiones de código, discrepancias documentales y riesgos pendientes; no son una lista de cambios aprobados.

| ID / certeza | Escenario y evidencia localizable | Impacto / severidad | Resultado esperado y límite |
| --- | --- | --- | --- |
| BUG-02 / C alta | Milestone M2+ comprometido con todo, sin cadena: B1, `BuilderSidebarEntry.tsx:124,283`; matriz §2.1 | Alta: no puede iniciar cadena desde este popover, fuerza buscar otra vía manual | P1: acción con n correcto y auto-avance, «Lanzar restantes» si parcial; conservar separado inicio/continuación. No afirmar que todo lanzamiento M2+ sea imposible. |
| HIST-01 / D+C alta | Expectativa de UI OFF del archivo de septiembre frente a ON vigente; referencias §6 | Media: anticipar checkpoints cuando la configuración efectiva continúa automáticamente puede causar sorpresa | P2: comunicar efecto y preferencia con claridad y decidir default explícitamente; la auditoría no cambia ON ni declara bug en el default actual. |
| SAFE-01 / H, riesgo sustentado en C | A manual entregada/aceptada y B pendiente dependiente; instantánea cambia durante cadena; trazas §3.1–3.4 | Alta potencial: base sin cambios necesarios o ejecución repetida; **no defecto integrado reproducido** | P0: probar exclusión, base/ancestría y carreras antes de prometer continuidad segura; preservar on_review/done y nunca aceptar entregas pendientes para facilitar lanzar. |
| A11Y-01 / H, sin defecto demostrado | Popover 320px, textos largos/zoom y retorno de foco entre superficies; §4.1 | Impacto/severidad pendientes de reproducción, no asignar severidad de bug por ancho fijo | P3: ensayo aislado y corregir sólo fricción demostrada; conservar portal, anclaje y Escape ya existentes. |

Sin hallazgos adicionales sustentados: entrada Existing/New, readiness y bloqueo explicativo, preview de specs, commit protegido, recientes, segmentación entregado/aceptado, controles de cadena existente y decisión mediante capabilities. Las limitaciones de cada superficie están en §4; esto no certifica usabilidad, contraste o accesibilidad total. No se inventa un defecto para cada categoría auditada.

## 6. Antecedentes y auto-avance efectivo

### 6.1 Búsqueda de revisión del 1 de noviembre

Corpus: archivos de `docs/` y `openspec/`, incluyendo cambios archivados; se excluyen este informe y la planificación del propio cambio para no usarlos como prueba circular. Comando local: `rg -n -i 'BUG-02|revisión UX|revision UX|UX review|1 de noviembre|November 1|1 November|2026-11-01' docs openspec -g '!**/runtime-75111bf6d11009f75973/**' -g '!project-builder-ux-audit.md'`.

Resultado: **no se localiza la revisión UX del Project Builder del 1 de noviembre**. Las coincidencias de fecha son `docs/codex.md:69`, `docs/internals/adding-a-provider.md:435`, `docs/internals/intent-mode.md:20`, `openspec/changes/intent-mode/design.md:12` y un fixture de fecha de reinicio de uso (`archive/2026-10-03-claude-enterprise-on-demand-usage/verification.md:10`). «revision UX» en delivery-revisions trata revisiones de entregas, y UX review en select-model-in-add-spec no es una auditoría del Builder. No prueban la existencia del antecedente buscado. No se consultaron servicios externos ni se verificó de nuevo el backlog citado por el ticket. Si el documento está fuera de este corpus, queda pendiente incorporarlo sin presumir aprobación.

### 6.2 Cronología y preferencia

D: `openspec/changes/archive/2026-09-05-premium-milestone-progress/design.md`, decisión D9; `tasks.md:66` (8.4) y `specs/milestone-launch-chain/spec.md`, requisito de wave checkpoints, describen UI OFF y API true. D: `openspec/changes/archive/2026-10-21-remove-batch-and-sequential-builder/specs/milestone-launch-chain/spec.md` y `openspec/specs/milestone-launch-chain/spec.md:39–59` indican ON. El antecedente de septiembre no es la autoridad del comportamiento actual.

C: `client/src/features/builder/lib/milestone-launch.ts:23–40`, `MILESTONE_AUTO_ADVANCE_KEY`, `readMilestoneAutoAdvance`, `saveMilestoneAutoAdvance`:

| Entrada | Resultado actual |
| --- | --- |
| Clave ausente | true, ON |
| Literal `'false'` | false, OFF |
| Literal `'true'` | true, ON |
| Otro texto almacenado | true (sólo false literal desactiva) |
| getItem lanza | true; fallback ON |
| setItem lanza | Se ignora fallo de persistencia; no se promete duración tras reabrir |
| Servidor sin autoAdvance | `start:269`: opts.autoAdvance !== false → ON; endpoint rechaza tipo no boolean si se aporta |

Clave `specrails-desktop:milestone-auto-advance`: preferencia del navegador/origen, compartida entre proyectos, no plan de ejecución ni setting por proyecto. `BuilderSidebarEntry:51,128,219–220` captura valor local al montar y guarda al cambiar; `BuilderConversation:44,264` tiene su estado doneAutoAdvance y guarda el mismo valor. `useBuilderSession.launchM1:715–716` vuelve a leer storage al lanzar; el sidebar pasa su estado local. No hay evidencia de sincronización reactiva entre dos superficies ya abiertas: posible expectativa a contrastar, no fallo reproducido. Storage inaccesible puede hacer que lo mostrado y lo releído en done difieran; incluir ese caso en el plan futuro, sin cambiar ahora el fallback.

`MilestoneChainRow` usa estado de cadena servidor, no sólo la preferencia para nuevas cadenas. `setChainAutoAdvance` en milestone-launch PATCHea la cadena; `MilestoneChainManager.setAutoAdvance:524–528` al activar ON en awaiting_approval llama resume inmediatamente. OFF mantiene checkpoint al siguiente éxito; un fallo siempre pausa. Activar auto-avance en checkpoint es una acción ejecutable, no simplemente guardar una preferencia inocua. `milestone-chain.test.ts:415,451,477,520` y `BuilderSidebarEntry.test.tsx:129–149` tienen escenarios de estos contratos (leídos, no ejecutados aquí).

Decisión pendiente: mantener ON o modificarlo en otro cambio tras revisión del usuario. Esta entrega conserva valor actual, persistencia y contratos.

## 7. Propuesta priorizada y secuencia revisable

**Ningún cambio de esta sección está aprobado ni implementado.** La secuencia para revisión es P0 → P1 → P2; P3 sólo convierte hipótesis en hallazgos y vuelve al usuario antes de añadir correcciones. Los archivos candidatos son para un cambio futuro, no el permiso de edición de esta entrega.

| Propuesta / hallazgo | Cambio y límite | Dependencias y riesgos | Criterios observables | Validación propia futura |
| --- | --- | --- | --- | --- |
| P0, seguridad / SAFE-01 | Acordar reglas de elegibilidad y base de dependencias manuales antes de ampliar lanzamiento. Conservar guardas de servidor; no basta disabled cliente. Candidatos: milestone-chain.ts, project-registry.ts, rails-router.ts y helpers de base ya citados. No crear ahora un endpoint de disponibilidad ni decidir bloqueo global. | Determinar qué repositorios y entregas pendientes requieren esperar o base verificada. Riesgo de snapshot obsoleto, origin atrasado y concurrencia. Depende de fixtures §3.4. | Una cadena nueva excluye on_review/done; pendiente dependiente contiene commit necesario en todos sus repositorios o informa bloqueo preciso; jamás dos escritores de la misma spec; rechazo y retry no pierden ni reimplementan entregas. Rail no conflictiva no bloquea por mera coincidencia de proyecto. | §7.2: fixtures IO/SQLite, Git y barreras de carrera; comparar SHA/ancestría y efectos, no sólo respuesta HTTP. Contrastar gates comunes sin duplicar política. |
| P1, BUG-02 | Dar acciones iniciales desde BuilderSidebarEntry a cualquier milestone listo con todo, usando n real. Texto Lanzar restantes en parcial y control de auto-avance incluso con entregas previas. Acción visible disabled y motivo accesible cuando un rail **impida** lanzar. Continuar existente mediante resume/PATCH, no start. Candidatos: BuilderSidebarEntry, milestone-progress/launch y MilestoneProgressCard sólo si el contrato de acciones lo exige. | P0 y decisión de cómo conoce el cliente el bloqueo vigente. No inventar bloqueo por milestone/repositorio ni garantizar seguridad con caché cliente. Mantener generación distinta de ejecución, preservación y busy/finally. | M2+ manda su n y preferencia una vez; parcial sólo ejecuta pendientes; entregado y aceptado separados; conflicto → botón presente disabled, razón asociada/legible sin hover, cero llamadas; contracaso no conflictivo habilita si demás gates permiten. Cadena activa no tiene inicio duplicado. | §7.1: M1/M2+ × sin entregas/parcial/parcial conflictiva, contracaso, errores y controles; §7.2 para garantía servidor, §7.3 para motivo/teclado. |
| P2, expectativas / HIST-01 | Acordar default y texto de efecto de auto-avance, coherente entre done M1 y popover, incluido ON que ejecuta en checkpoint. Candidatos: BuilderConversation, BuilderSidebarEntry, milestone-launch, hooks y locales de Builder. Conservar ON durante esta auditoría; no cambiar silenciosamente preferencias guardadas. | Decisión del usuario sobre ON/OFF y alcance compartido de preferencia; fallo storage y dos superficies abiertas pueden separar valor mostrado/enviado. Riesgo de presentar un cambio de default como corrección ya autorizada. | Texto permite anticipar siguiente ejecución; ausencia/false/true y storage inaccesible tienen comportamiento acordado y comprobable; no divergen valor anunciado y enviado bajo ese contrato. Checkpoint deja clara consecuencia inmediata. | Tests milestone-launch y ProjectBuilder/Sidebar con storage fake que lanza y dos superficies; PATCH en checkpoint con manager fake. Revisión de copy y paridad de todos los locales si se modifica después; §7.3. |
| P3, ensayo de presentación / A11Y-01 | Validar las hipótesis de §4.1 y proponer sólo correcciones demostradas. No rediseño general ni lista asumida de defectos; cualquier corrección vuelve con evidencia/prioridad al usuario. | Entorno aislado renderizado con fixtures, sin proveedores. Riesgo de confundir clase CSS con medición, o de perder portal/anclaje al corregir. Archivos candidatos sólo las superficies que el ensayo identifique. | Informe de ensayo registra viewport/zoom/locale, pasos y resultado; sin acciones cortadas, foco alcanzable y motivo perceptible bajo escenarios acordados. No declarar conformidad total con un único viewport. | §7.3: teclado y viewport estrecho/largo en ambos hosts, modal/retorno a revisión y estado bloqueado. Si no se reproduce, conservar como hipótesis sin parche. |

### 7.1 Tests de componente para BUG-02 (a añadir después de revisión)

Patrón: `client/src/components/__tests__/BuilderSidebarEntry.test.tsx`, fixtures mutables de progreso, mock launchMilestone/resumeChain/setChainAutoAdvance, localStorage limpio por caso, userEvent y waitFor. No sleeps ni proveedor. Fixtures rich-spec y sesión de `ProjectBuilder.test.tsx`; estado de tarjeta de `MilestoneProgressCard.test.tsx`; GET/WS de `features/builder/hooks/__tests__/useMilestoneProgress.test.tsx`; HTTP fake de `features/builder/lib/__tests__/milestone-launch.test.ts`.

| Fixture parametrizada M1 / M2+ | Assert de comportamiento (cada test futuro con una intención) |
| --- | --- |
| Sin entregas: todo 3, done/onReview 0, cadena null, committed | Acción de ejecución y toggle presentes; click único llama launchMilestone(projectId, n, {autoAdvance}) con n real, nunca literal 1 para M2+. Separar test ON ausente y false guardado. No convertir planned en committed en el mock para obtener el resultado. |
| Parcial: done 1, onReview 1, todo 2, sin cadena | Texto Lanzar restantes y toggle; contadores de entregado/aceptado distintos; pasa n y preferencia; no cambia entregas al pulsar. La selección real de sólo todo se prueba en servidor, no se promete desde el mock. |
| Parcial con rail manual conflictiva | Suministrar disponibilidad según contrato que se acuerde en P0, no un booleano arbitrario «cualquier rail». Botón visible disabled con motivo asociado por descripción accesible y visible; click/teclado no llama launchMilestone ni fetch (cero POST). |
| Contracaso rail manual no conflictiva | Otro ticket activo, capacidad libre y gates admiten: no bloqueo global; n y preferencia correctos al lanzar. Añadir caso distinto de capacidad/WIP para no etiquetarlo falsamente como solapamiento. |
| Cadena running/waiting | Sólo seguimiento/controles pertinentes; no segundo start. |
| Paused | Resume usa chainId existente; fallo comunica motivo y conserva datos; no launchMilestone. |
| Checkpoint | Launch next usa resume; toggle ON usa PATCH y refleja ejecución inmediata; no start ni nueva selección. |
| Sin todo; onReview presente | Cero POST launch; Review abre ID de entrega y no la marca done. Separar sin pendientes sin entrega revisable: mensaje de estado pertinente. |
| Rechazo HTTP / red | Mensaje con razón/detail según utilidad existente; busy se libera en finally, se puede reintentar y no se borran contadores/entregas. Una petición pendiente mantiene disabled, sin duplicado por doble interacción. |
| Reabrir / proyecto / WS | Recupera preferencia acordada y progreso por proyecto; WS ajeno no pinta en actual. Test aparte para cache/rehidratación; no usar WS ajeno como sustituto de restart. |

Añadir pruebas de ausencia/true/false, lectura/escritura storage que lanza y consistencia de valor mostrado/enviado en done M1 y sidebar. No introducir plan secuencial en navegador para resolver BUG-02.

### 7.2 Validación servidor futura de P0/P1

Usar `server/modules/builder/runtime/milestone-chain.test.ts` (IO inyectado/DB aislada y fixture Git acumulativo), `milestone-chain-store.test.ts`, `server/blueprint-progress-route.test.ts` (Express/Supertest con manager fake), `server/modules/delivery/runtime/rails-router.test.ts` y `multi-repo-bases.test.ts`. Nada requiere datos reales, entrega pagada ni credenciales.

1. Selección nueva: todo/M<n>, excluir otra etiqueta, on_review y done; ordenar prerequisitos internos y documentar externos/ciclo según decisión. Assert ticket IDs asignados, no sólo count. Endpoint preserva autoAdvance boolean/default, rango y errores del manager.
2. Manual aceptada: fixture Git de A integrada localmente con origin desactualizado y B dependiente; demostrar base efectiva de B por ancestro/SHA. Repetir por repositorio en manifiesto multi-repo. **Evidencia adicional necesaria**: no lo prueba el fixture actual de tres specs de una misma cadena.
3. Manual pendiente de aceptación: A on_review, B todo dependiente. A nunca se relanza ni se acepta por mera acción «restantes»; validar política de bloqueo/base que el usuario acuerde. Incluir sin dependencia y sin conflicto para evitar sobrerrestricción.
4. Ownership y concurrencia: barreras deterministas durante safeIntegrationBranch y lanzamiento, dos starts simultáneos y start frente a rail manual sobre misma spec; comprobar una ejecución, persistencia consistente y rechazo contextual, sin inferir idempotencia sólo del índice. Contracaso IDs distintos/capacidad libre. Cambiar status de chunk a on_review/done después de snapshot y antes de advance/retry para comprobar conservación. **Cobertura adicional necesaria**, el test de segundo start secuencial no basta.
5. Guardas: capacidad/rail ocupada, presupuesto, WIP y recovery conservan sus razones y cero spawn al rechazar; la spec compartida tiene tickets_in_flight. Mantener esperas de integración diferenciadas de ejecución y revisión.
6. Primer rechazo: cadena terminal sin ownership activo; relanzar permitido sin pérdida de entregas ni asumir rollback de rail asignada. Fallo posterior: pausa, resume mismo chunk; fallo de integración reintenta integración, no implementación. Reinicio: replay una vez, checkpoint preservado y sin salto de spec. Extender ensayos existentes con estado manual/multi-repo antes de proclamar esa garantía más amplia.

### 7.3 Ensayo futuro de presentación e interacción

Con fixtures aislados existentes en el runner del proyecto, probar ambos hosts y popover/preview/review: ancho estrecho (p. ej. 320px), zoom 200%, textos y rutas largas y traducciones extensas; registrar viewport exacto y capturas. Comprobar jerarquía de CTA, legibilidad y scroll sin pérdida de acción. Tab/Shift+Tab alcanzan acciones, Escape cierra la superficie correcta/restaura foco, nombres accesibles no dependen de iconos, razón de disabled se lee sin hover y está asociada a la acción. Regresar desde ReviewPacket/decision strip conserva contexto bajo el host que corresponda. jsdom puede comprobar roles, nombres, handlers y foco DOM; no certifica contraste/overflow real ni lector de pantalla. Si el entorno aislado no está disponible, registrar pendiente en vez de usar datos reales o un runner alternativo.

### 7.4 Comandos de la fase futura y comprobación de esta entrega

Los siguientes son comandos existentes para el futuro cambio funcional, **no ejecutados en esta auditoría**:

```sh
npm run test --prefix client -- src/components/__tests__/BuilderSidebarEntry.test.tsx src/components/__tests__/MilestoneProgressCard.test.tsx src/components/__tests__/ProjectBuilder.test.tsx src/features/builder
npx vitest run server/modules/builder server/blueprint-progress-route.test.ts server/modules/delivery/runtime/rails-router.test.ts
npm run typecheck
```

La planificación registró instalación raíz faltante; es evidencia histórica de entorno, no bloqueo actual: durante esta auditoría se comprobó que `node_modules/` raíz existe y Core informa dependencias instaladas. No se instalan paquetes ni se afirma que esas suites hayan pasado. En una futura ejecución, confirmar herramientas con el comando documentado y conservar stdout/stderr completo y exit code original. No usar configuración temporal ni un runner alternativo para eludir fallos.

Esta entrega documental no añade tests productivos según su alcance. Su comprobación consiste en cotejar cada fila con símbolos y fixtures, revisar el diff limitado a informe/enlace y comprobar enlaces/rutas locales. Core posee la ejecución de la verificación completa.

## 8. Trazabilidad y decisiones pendientes

| Criterio del ticket | Evidencia entregada |
| --- | --- |
| Cobertura creación → aceptación con límites | [Mapa §4](#4-mapa-del-recorrido-y-límites-de-cobertura), [presentación §4.1](#41-presentación-accesibilidad-y-límites-por-superficie) y continuidad §4.2 |
| Hallazgos con escenario, evidencia, impacto, severidad, esperado y certeza | [Registro §5](#5-registro-de-hallazgos) y leyenda §1; R explícitamente vacío |
| Restricción M1 y flujo hasta validaciones | [Traza §2](#2-bug-02-recorrido-de-lanzamiento), B1–B8 |
| Matriz M1/M2+ y estados mínimos | [Matriz §2.1](#21-matriz-actual--esperada-para-revisión), nueve filas |
| Restantes, auto-avance, bloqueo visible/deshabilitado con motivo | P1 en [propuesta §7](#7-propuesta-priorizada-y-secuencia-revisable), fixtures §7.1 |
| Preservación de entregadas, dependencias y bases manuales | [Seguridad §3](#3-elegibilidad-bases-bloqueos-y-conservación), escenarios §3.4 y P0/§7.2 |
| Auto-avance actual/persistido y discrepancia histórica sin cambio | [Antecedentes §6](#6-antecedentes-y-auto-avance-efectivo), HIST-01 y P2 |
| Prioridades/límites/dependencias/aceptación/validación por cambio | P0–P3, [tests §7.1](#71-tests-de-componente-para-bug-02-a-añadir-después-de-revisión), §7.2–7.4 |
| Búsqueda previa y propuesta sin aprobación presumida | §6.1 y este cierre de decisiones |

Pendiente de decisión del usuario: default ON/OFF; política ante dependencias manuales aún no integradas y alcance por repositorio; fuente de disponibilidad para motivo de bloqueo en cliente; selección de propuestas y secuencia aceptada. Pendiente de evidencia: carreras y bases manuales/multi-repo, render/lector/contraste y continuidad real de las superficies señaladas. No bloquean la entrega de diagnóstico: sí limitan lo que puede prometer la posterior implementación. Si aparece una revisión externa del 1 de noviembre, contrastarla antes de usarla como requisito. Este informe está listo para esa revisión; no declara revisión realizada, cambios aprobados ni implementación funcional entregada.
