# Design

## Context

Ver `proposal.md` para la motivación. La entrega es una auditoría y una propuesta pendiente de revisión, no la implementación de BUG-02. El material existente describe el sistema construido; no se encontró un informe equivalente de auditoría UX completa del Builder. Se crea un único informe especializado y se enlaza desde la guía vigente, conservando su descripción del comportamiento actual.

### Clarificaciones antes de planificar

Ninguna ambigüedad requiere respuesta para diseñar esta entrega documental. El comportamiento deseado de auto-avance y la política definitiva ante rails manuales son decisiones de la futura revisión, no permisos para cambiar ahora el producto. Las preguntas del ticket se investigan y se registran con evidencia o como no resueltas; no se sustituyen por supuestos.

## Goals / Non-Goals

Producir un informe navegable, trazable a código y pruebas, cuya propuesta permita decidir cambios sin confundir análisis estático, reproducción y aprobación. La primera sección trabajada será BUG-02: prueba la zona de mayor riesgo antes de extender el informe a todo el recorrido.

## Non-Goals

No implementar controles, bloqueos, nuevas APIs, políticas de integración o cambios de auto-avance. No rediseñar componentes ni corregir problemas adyacentes. No cambiar datos, entregas, esquemas, migraciones, dependencias, locales ni límites de ejecución. No iniciar proveedores, aceptar entregas reales ni demostrar la hipótesis con usuarios en esta entrega.

## Local reference patterns

- Guía más cercana: `docs/internals/project-builder.md`, apartados Entry + builder mode, Day-0 chat, Snapshot hardening, Orchestrated commit, Milestone lifecycle e Incremental spec integration. `docs/internals/review-packet.md` ofrece el patrón de distinguir evidencia app-verified, ai-reported y ausencia de evidencia; aplicar esa honestidad al informe, sin reutilizar sus tipos como nuevo contrato runtime.
- Entrada real: `client/src/features/projects/components/AddProjectDialog.tsx`, `AddProjectDialog`, selector Existing/New; `client/src/components/__tests__/ProjectBuilder.test.tsx` y `client/src/features/projects/components/__tests__/AddProjectDialog.test.tsx`. Hosts: `client/src/features/missions/components/AgentModeSurface.tsx`, `AgentChatPanel.tsx` y `AgentWorkspaceSidebar.tsx`, que montan `BuilderConversation` y `BlueprintPanel`.
- `client/src/features/builder/hooks/useBuilderSession.ts`, `useBuilderSession`, fases chat/commit/progress/done, snapshots válidos, errores, conversaciones reanudables y lanzamiento M1. Patrón de pruebas: `client/src/features/builder/hooks/__tests__/useBuilderSession.test.tsx`; las superficies usan `client/src/components/__tests__/ProjectBuilder.test.tsx`, fixtures rich-spec y mocks de sesión/WS.
- `client/src/features/builder/components/project-builder/BuilderSidebarEntry.tsx`, `BuilderSidebarEntry`, `handleLaunchM1`, `launchControls` y asignación de acciones por `row.n === 1`; `client/src/components/__tests__/BuilderSidebarEntry.test.tsx` tiene fixtures mutables de progreso, mock de `launchMilestone`, limpieza de localStorage, userEvent y waitFor. Es el patrón más cercano para los escenarios futuros BUG-02.
- `client/src/features/builder/components/project-builder/MilestoneProgressCard.tsx`, `MilestoneCard`, `MilestoneChainRow`, `MilestoneAutoAdvanceToggle`; `client/src/components/__tests__/MilestoneProgressCard.test.tsx`. El padre suministra acciones de inicio; la fila de cadena ofrece continuación, reanudación, cancelación y PATCH de auto-avance. No confundir inicio con continuación.
- `client/src/features/builder/hooks/useMilestoneProgress.ts`, `useMilestoneProgress`, usa caché por proyecto, GET y WS filtrado por ref del proyecto actual; resetea la capa live al cambiar proyecto y conserva el modelo cacheado. `client/src/features/builder/hooks/__tests__/useMilestoneProgress.test.tsx` cubre ese seam. Esperar actualizaciones con waitFor/act, no sleeps; reapertura e hidratación no prueban por sí solas recuperación del servidor.
- `client/src/features/builder/lib/milestone-launch.ts`, `launchMilestone`, devuelve resultados discriminados incluso para fallo de red; los padres consumen reason/detail y muestran toast/notifyError, con busy liberado en finally. `client/src/features/builder/lib/__tests__/milestone-launch.test.ts` es el patrón HTTP fake. No introducir un segundo plan de ejecución en el navegador.
- `server/modules/builder/runtime/milestone-chain.ts`, `MilestoneChainManager.start`, `orderChainTickets`, `railFree`, `integrateChunk`; `server/modules/builder/runtime/milestone-chain.test.ts` cubre orden, rechazo inicial, checkpoints, fallos, integración y replay; `milestone-chain-store.test.ts` cubre persistencia. Sus fixtures IO e SQLite aislado son el patrón para probar sin procesos de pago; el ensayo Git existente prueba acumulación de specs de una cadena, no toda combinación de entregas manuales anteriores.
- `server/project-router.ts`, POST milestone launch y controles de cadena; `server/blueprint-progress-route.test.ts` usa Express/Supertest y manager fake. `server/project-registry.ts` enlaza IO a las rutas rails por `createInternalApi`; `server/modules/delivery/runtime/rails-router.ts` y `rails-router.test.ts` son autoridad de los guardas y decisiones. La composición no debe duplicarse para futuras recomendaciones.
- Revisión: `client/src/features/delivery/pages/ReviewPacketPage.tsx`, `ReviewPacketPage`, manejo de acceptCapability y stale_decision; `client/src/features/delivery/pages/__tests__/ReviewPacketPage.test.tsx`; alternativa `client/src/features/delivery/components/RailPrDecisionStrip.tsx` y su test en `components/__tests__`. El informe debe distinguir revisión pendiente y aceptación, no equiparar on_review con done.
- Versiones verificadas: cliente instalado React 19.3.0 y Vitest 5.0.3 (sus package.json en client/node_modules); `client/package.json` declara Testing Library React ^16.3.2 y user-event ^14.6.1. `client/vitest.config.ts` establece jsdom y `src/test-setup.ts`. La regla client que menciona React 18 está desactualizada: prevalece el paquete actual. Falta node_modules raíz; Express ^5.3.0 y Vitest se consultan como declaraciones, no instalación comprobada. No añadir paquetes para la auditoría.

## Decisions

### Forma del informe y certeza

Crear `docs/internals/project-builder-ux-audit.md` en español. Orden: alcance/método y fecha; mapa de recorridos; registro de hallazgos; BUG-02 y matriz; antecedentes y auto-avance; propuesta priorizada; validación y decisiones pendientes. Cada fila del mapa enumera superficie y símbolo, estado/acción, navegación, evidencia disponible y comprobación no realizada. Cada hallazgo contiene ID, escenario, evidencia con ruta/símbolo y líneas del checkout, impacto, severidad (alta impide avanzar o arriesga trabajo; media dificulta avanzar; baja fricción menor), esperado y certeza (reproducido / código / hipótesis). Registrar también controles que ya funcionan y zonas sin hallazgos; no fabricar defectos para cubrir categorías.

No hay reproducción visual realizada en esta planificación. La revisión de estilos/ARIA no demuestra contraste, geometría, overflow ni recorrido real de foco. Usar los fixtures existentes para fundamentar los escenarios y dejar explícito lo que sólo un entorno aislado renderizado puede confirmar. No exigir una reproducción que necesite datos reales o un proveedor de pago.

### BUG-02: evidencia ya localizada y límites

1. `BuilderSidebarEntry` calcula launchControls a partir de M1 y los entrega sólo a `row.n === 1`; `handleLaunchM1` pasa 1. M2+ no obtiene inicio aunque `isMilestoneLaunchable` permitiría todo > 0 sin cadena live, pausada ni checkpoint. Esto es análisis de código, no observación de sesión real. El contrato actual `openspec/specs/milestone-lifecycle/spec.md` exige explícitamente Launch M1 en sidebar; la revisión futura ampliaría ese requisito, no debe presentarse como incumplimiento oculto del spec actual.
2. `launchMilestone(projectId,n,{autoAdvance})` hace POST `/api/projects/:id/blueprint/milestones/:n/launch`. `server/project-router.ts` valida rango parseado 1..999, mode y boolean autoAdvance, disponibilidad del manager y retransmite rechazos; captura excepciones como 500. No inferir validación estricta del segmento completo a partir de parseInt.
3. `MilestoneChainManager.start` rechaza cadena no terminal del MISMO milestone; comprueba blueprint y milestone; selecciona sólo `todo` con etiqueta M<n>. `orderChainTickets` ordena dependencias dentro del conjunto; ignora dependencias externas y rompe ciclos por orden estable. Esto NO demuestra que todos los prerrequisitos externos estén integrados. Las specs on_review y done quedan fuera de una cadena nueva si su estado es correcto; una cadena ya creada conserva chunks: el informe debe distinguir esa instantánea de una selección nueva y documentar el riesgo de cambios manuales posteriores.
4. IO en `server/project-registry.ts` crea/asigna/lanza mediante rutas rails; la ruta de lanzamiento rechaza `tickets_in_flight` por IDs presentes en railJobs/railLoopRuns del proyecto. El alcance demostrado es solapamiento de specs dentro del proyecto, no cualquier rail del mismo milestone, repositorio o proyecto. `railFree` evita reutilizar una rail ocupada o con entrega indecisa; capacidad de rails, presupuesto, recuperación y review WIP pueden impedir otras ejecuciones por razones propias. No convertir todos esos motivos en «rail manual activo».
5. `start` pasa base inicial null a launchChunk aunque almacena integrationBranch; el camino ordinario decide la base. Los chunks posteriores integran su entrega mediante merge-local/acknowledge-no-changes antes de continuar cuando el adapter está enlazado; retienen entrega durante fallo/replay. Esto prueba integración incremental de ESA cadena, no incorporación de cualquier entrega manual anterior o de todos sus repositorios. Documentar pendiente la relación entre entrega manual aceptada, on_review aún no integrada, base efectiva y manifiesto multi-repo; citar `resolveRepositoryDeliveryBases` si aplica, sin atribuirlo automáticamente al primer chunk, que no suministra IDs de entregas manuales.
6. Riesgos a analizar expresamente: solapamiento tras seleccionar chunks pero antes de lanzar; dos starts concurrentes durante el await de base antes de insertar la fila; el índice único protege persistencia pero no implica respuesta idempotente amigable; comprobación in-flight seguida de awaits tampoco prueba exclusión durante toda la reserva. Examinar las pruebas/guardas existentes sin afirmar que falta una protección posterior por no haberla reproducido. Fallo del primer chunk cancela la cadena y retransmite error; fallo posterior pausa sin saltarse la spec.

### Matriz base que debe completar el informe

Cada fila tendrá M1 actual / M2+ actual / esperado propuesto / evidencia y límite. «Sin entregas» y «parcial» presuponen specs detalladas comprometidas; un milestone planned sin specs pertenece a generación, no lanzamiento.

| Estado | M1 actual (código) | M2+ actual (código) | Propuesta para revisión |
| --- | --- | --- | --- |
| Sin entregas, todo > 0, sin cadena | CTA + auto-avance | Sin CTA inicial | Lanzar milestone identificado y toggle |
| Parcial done/on_review + todo > 0 | CTA M1 si no hay cadena bloqueante | Sin CTA inicial | Lanzar restantes + toggle; conservar entregado y separar aceptación |
| Parcial + rail manual activo | Helper no consulta ese bloqueo; guardas se evalúan al lanzar | Sin CTA inicial | Si impide lanzar, acción visible deshabilitada y motivo preciso; diferenciar specs compartidas, capacidad y coexistencia sin conflicto |
| Cadena running/waiting | Sin nuevo inicio, fila de cadena | Fila de cadena existente | Seguimiento y controles de la cadena, sin crear otra |
| Cadena paused | Resume/Cancel y motivo | Igual si existe cadena | Reintentar/continuar la existente, no seleccionar de nuevo el milestone |
| Cadena awaiting_approval | Launch next/auto-avance/Cancel | Igual si existe cadena | Checkpoint saludable; indicar que activar auto-avance inicia siguiente rail |
| Sin todo | Sin inicio | Sin inicio | Estado explicativo y siguiente acción pertinente, sin POST vacío |
| Todo = 0, on_review > 0 | Entregado, acción Review | Entregado, acción Review | Revisar/aceptar; nunca «aceptado» por mera entrega |
| Planned sin specs | No es caso normal tras commit M1 | Generar siguiente milestone | Generar primero, no lanzar |

### Cobertura restante y hallazgos candidatos

Mapear Existing/New → entrevista y snapshots → readiness/commit → progreso/done → sidebar/popover → generación M2+ → ejecución/checkpoint/fallo → ReviewPacket/decision strip → aceptación → reapertura. Usar BlueprintCommitForm, BlueprintReadiness, BuilderRecentBlueprints, BuilderGenerationProgress, MilestoneGenerateShell y BlueprintSpecModal dentro del directorio project-builder ya localizado. Incluir variantes floating/inline y sidebar de board/Agent Mode. Documentar por superficie vacío/carga/error, controles ausentes frente a deshabilitados, estado generado frente a committed, contadores entregado/aceptado, navegación y regreso.

Hallazgos iniciales: BUG-02 (código, severidad alta por bloquear esta vía de lanzamiento M2+, sin afirmar imposibilidad de ejecución manual); discrepancia de auto-avance histórico (certeza documental, media por expectativas, no defecto actual confirmado); incertidumbre de continuidad tras entrega manual (riesgo alto, no bug reproducido). El popover ya mueve foco al abrir, restaura con Escape, se porta a body y recalcula anclaje: evaluar estas protecciones antes de alegar fallos de foco o clipping. El ancho fijo 320 y top acotado son puntos para ensayar viewport estrecho, no evidencia suficiente de overflow. Cualquier otro hallazgo requiere el mismo esquema de evidencia.

### Antecedentes y auto-avance

Búsqueda inicial en docs/ y openspec/: `BUG-02`, `revisión UX`, `UX review`, `1 de noviembre`, `November 1`, `1 November`, `2026-11-01`, y referencias auto/off. No se localizó revisión UX del Builder del 1 de noviembre; coincidencias de fecha pertenecen a intent-mode, proveedores u otros cambios y no la acreditan. Registrar corpus y términos; no afirmar búsqueda en sistemas externos o backlog no accesibles.

Sí hay antecedente: `openspec/changes/archive/2026-09-05-premium-milestone-progress/{proposal.md,design.md,tasks.md,specs/milestone-launch-chain/spec.md}` dice UI OFF, API true. `openspec/changes/archive/2026-10-21-remove-batch-and-sequential-builder/specs/milestone-launch-chain/spec.md` y spec principal actual dicen ON. `readMilestoneAutoAdvance` devuelve false sólo para cadena literal 'false'; ausente o fallo de storage devuelve true. `saveMilestoneAutoAdvance` guarda true/false bajo `specrails-desktop:milestone-auto-advance`, preferencia de navegador compartida, no por proyecto. Servidor `opts.autoAdvance !== false` da true si omitido. BuilderConversation y sidebar leen esa preferencia en estado local; no presumir sincronización reactiva entre superficies abiertas. PATCH ON en checkpoint reanuda inmediatamente; fallo siempre pausa. Mantener todos esos valores en la auditoría; decisión futura pendiente del usuario.

### Propuesta posterior, sin autorización de ejecución

P0 seguridad y reglas de disponibilidad: criterio observable de no relanzar on_review/done ni solapar una spec activa; definir cómo comprobar base manual/dependencias antes de habilitar restantes. Dependencia para ampliar BUG-02, no creación ahora de un endpoint de disponibilidad.
P1 BUG-02: extender la acción del padre de MilestoneCard a cualquier milestone listo con todo; usar n real y Lanzar restantes en parcial, toggle consistente, razón visible/accesible al bloquear. Mantener controles de cadena existentes como camino de continuación. Criterios: M2+ sin entregas lanza su n; parcial selecciona sólo pendientes; conflicto muestra disabled + motivo y cero llamadas; rail no conflictivo no se bloquea sin regla demostrada. Requiere acordar si la regla de seguridad debe ampliarse más allá del solapamiento actual y qué información necesita el cliente. No fijar una API nueva sin esa evidencia.
P2 claridad y accesibilidad: sólo cambios sustentados por hallazgos del mapa; contadores honestos, errores accionables, retorno a revisión y continuidad. Prioridad ajustable según impacto comprobado, no paquete genérico de rediseño.
Cada propuesta tendrá ID de hallazgo, archivos candidatos de futura implementación (separados del blast radius autorizado), límite, dependencia, riesgo, criterio y escenario de validación. Antes de implementar se acuerda esa lista y se crea el cambio correspondiente, incluyendo locales/contratos que entonces resulten afectados.

### Plan de validación que debe entregar el informe

No añadir tests productivos en este cambio documental. Especificar los siguientes tests FUTUROS por propuesta usando los patrones anteriores:
- Componente sidebar parametrizado M1/M2+: sin entregas, click una vez con n y preferencia correcta; parcial con todo/on_review/done, texto restantes y counts honestos; parcial con rail manual que bloquea, botón visible disabled, motivo asociado accesible y cero POST. Contracaso rail manual no conflictivo para evitar bloqueo global inventado.
- Cadena activa sin inicio duplicado; paused usa resume; checkpoint usa resume/PATCH sin start; on_review sin todo abre Review; sin pendientes no hace POST; error de red/rechazo libera busy, conserva estado y comunica razón. Preference false y storage ausente/indisponible; reapertura y cambio de proyecto/WS ajeno no alteran otro proyecto.
- Servidor: selección nueva excluye on_review/done, todo con etiqueta correcta, orden de dependencias; fixtures de entrega manual aceptada frente a pendiente de aceptación con base demostrable; guardas de solapamiento y carrera start/manual, dos starts, primer rechazo sin cadena activa, pausa/retry posterior y replay exactamente una vez. No anunciar que tests de cadena existentes prueban ese nuevo fixture manual.
- Presentación: escenario aislado de viewport estrecho y textos largos, teclado hacia acciones, Escape/retorno de foco, nombres y motivo accesibles. Indicar qué pueden probar jsdom y código y qué queda sin comprobar visualmente. Sin instrucciones de manipular entregas reales.

## Blast radius

Archivos de entrega que el desarrollador puede crear/modificar, todos dentro de specrails-desktop:
- Crear `docs/internals/project-builder-ux-audit.md`: único informe con los cuatro entregables y validación por propuesta.
- Modificar `docs/internals/project-builder.md`: enlace corto a la auditoría, marcada pendiente de revisión; no reescribir comportamiento actual como si la propuesta estuviera implementada.

Artefactos de planificación de este cambio, escritos por la herramienta scoped: `openspec/changes/runtime-75111bf6d11009f75973/proposal.md`, `design.md`, `specs/project-builder-ux-review/spec.md`, `tasks.md`. No constituyen tareas de implementación ni autorización de edición de otros specs.
No se vuelven obsoletos contratos, locales (en/es/fr/de/zh/pt/it/ja), ejemplos de configuración, esquemas, manifest de boundaries, módulos o source-map: no cambia código ni comportamiento ni hay nuevos archivos fuente. No actualizar README de módulos que permanecen intactos. Las rutas de código citadas son exclusivamente fuentes de evidencia y candidatas de un cambio posterior, fuera del límite de escritura de esta entrega.

## Risks / Trade-offs

- [Código confundido con reproducción] → etiquetar certeza y limitaciones en cada fila; no afirmar auditoría visual completa sin render aislado.
- [Continuidad manual o multi-repo asumida] → mostrar el tramo probado y el no probado, y condicionar la recomendación a sus escenarios de base/dependencias.
- [Ejecución duplicada por snapshot/carrera] → describir momentos de selección, ownership y lanzamiento; no proponer sólo deshabilitar un botón como garantía servidor.
- [Revisión ampliada accidentalmente a implementación] → sólo dos archivos documentales; propuesta explícitamente pendiente de aprobación.
- [Regresión de contratos históricos al archivar] → nueva capacidad documental ADDED; no reemplazar requisitos runtime existentes.
- [Coste de investigación sin límite] → consultar sólo recorridos y guardas que cambien conclusiones; sin benchmarks ni optimizaciones. No se toca ningún hot path; la documentación no añade coste runtime.
- [Datos personales/secrets en evidencia] → citar símbolos y fixtures sintéticos, omitir IDs/rutas de proyectos reales y credenciales; sin llamadas externas ni cambios de autorización.

## Alternatives rejected

- Implementar BUG-02 ahora: incumple auditar y acordar antes de cambiar comportamiento.
- Rediseño general o nuevo servicio de elegibilidad: añade alcance y contrato antes del diagnóstico.
- Bloquear cualquier rail del proyecto: el guarda encontrado es por spec; una política mayor requiere evidencia y decisión explícita.
- Tomar el archivo de septiembre como default actual: contradice código, pruebas y contrato vigente.
- Reemplazar specs runtime por la propuesta: presentaría una revisión no aprobada como comportamiento requerido ahora.

## Migration Plan

Sin migración ni despliegue runtime. El informe y su enlace son reversibles eliminando el nuevo documento y el enlace; no se altera trabajo entregado ni preferencias persistidas. Las suites actuales no prueban la corrección de una auditoría documental: no se propone comando automatizado como sustituto de sus criterios. Los comandos existentes de componentes/servidor se documentan para la futura revisión, no son tareas de este cambio.

## Open Questions

Para decisión posterior, sin bloquear esta auditoría: ¿se mantiene ON como default de auto-avance? ¿qué entregas manuales no integradas deben impedir lanzar dependientes y en qué repositorios? ¿qué hallazgos y secuencia acepta el usuario? Si aparece la revisión del 1 de noviembre fuera del corpus local, incorporarla como evidencia adicional sin presumir su contenido ni aprobación.
