# Implementación de agentes: eficiencia y calidad

Estado: **plan preparado; implementación pendiente**. Fecha: 13 de septiembre de 2026.

La siguiente fase se realizará con **GPT-6 Astra y esfuerzo de razonamiento medium**. Esa elección corresponde al asistente que implementará estos cambios. No asigna Astra a los roles que ejecutan los usuarios dentro de Specrails.

## Objetivo y medida de éxito

Reducir el coste total y el tiempo necesarios para obtener una implementación que cumpla sus criterios de aceptación, conservando o mejorando la detección de defectos. Contarán también los intentos fallidos, reparaciones, reanudaciones y rescates; optimizar únicamente una llamada ocultaría el coste real del trabajo.

No hay ahorro de IA demostrado todavía. La validación local comprobará la mecánica y las regresiones. Un experimento posterior, con modelos y presupuesto explícitos, medirá el ahorro real.

## Documentos que guían la implementación

| Documento | Uso |
|---|---|
| [Core: propuesta](../../../specrails-core/openspec/changes/implementation-efficiency/proposal.md) | Alcance y motivación |
| [Core: diseño](../../../specrails-core/openspec/changes/implementation-efficiency/design.md) | Decisiones del runtime, reanudación, evidencias y evaluación |
| [Core: contrato compartido](../../../specrails-core/openspec/changes/implementation-efficiency/contracts.md) | Fuente única de campos, versiones, herramientas y semántica entre repositorios |
| [Core: tareas](../../../specrails-core/openspec/changes/implementation-efficiency/tasks.md) | Bloques C0–C7 y pruebas de aceptación |
| [Desktop: propuesta](../../openspec/changes/implementation-efficiency/proposal.md) | Alcance del producto |
| [Desktop: diseño](../../openspec/changes/implementation-efficiency/design.md) | Configuración, logs, historial y compatibilidad |
| [Desktop: tareas](../../openspec/changes/implementation-efficiency/tasks.md) | Bloques D0–D5 y pruebas de aceptación |

Los requisitos verificables viven en los directorios `specs/` de ambos cambios OpenSpec. Las tareas permanecen sin marcar hasta implementar y comprobar su resultado. Este documento orienta el trabajo; no sustituye ni duplica el contrato de Core.

Base preparada desde `main` después de hacer pull:

- Core: `2427141b`.
- Desktop: `d8d8597a`.
- Rama de ambos: `codex/implementation-efficiency`.

Antes de implementar se revisará si main ha avanzado, conservando estos documentos y cualquier trabajo local. No se reinicia desde cero ni se vuelven a implementar correcciones que ya están en main.

## Decisiones de producto y arquitectura

El flujo seguirá siendo **arquitecto → developer → verificación automática → reviewer → archivo**. La verificación ejecuta código y comandos; el reviewer interpreta si el cambio satisface el ticket y detecta problemas de diseño. Un test fallido vuelve al developer antes de gastar otra llamada del reviewer. No se añade un agente verifier.

El arquitecto seguirá utilizando el procedimiento oficial de OpenSpec para preparar el cambio, y el developer ejecutará OpenSpec apply. Se conservan los procedimientos y herramientas oficiales para cada proveedor. La optimización no reemplaza OpenSpec por plantillas simuladas ni permite eliminar sus obligaciones desde prompts personalizados.

| Cambio | Cómo contribuye | Condición que protege la calidad |
|---|---|---|
| Contexto compartido por repositorio | Evita reenviar datos sin cambios en continuaciones reales | Primera llamada y proveedores sin continuidad reciben contexto completo; fuentes eliminadas se revocan explícitamente |
| Revisión incremental | Orienta al reviewer a las correcciones desde su revisión anterior | Debe recertificar todos los criterios; cambios transversales fuerzan contexto completo |
| Plan proporcional | Reduce explicación redundante en cambios locales claros | Mismos artefactos oficiales; contratos públicos, seguridad, migraciones y varios repos exigen planificación completa |
| Escalado configurado | Permite reservar un modelo superior para intentos que lo necesitan | Un solo tier, mismo proveedor, sin intentos adicionales ni selección automática por precio |
| Checks propuestos por developer | Convierte pruebas útiles en evidencias reproducibles | Se añaden al mínimo obligatorio; no pueden rebajarlo ni autodeclararse aprobados |
| Harness persistente | Permite revisar y repetir pruebas incluso sin package.json | Core guarda fuente, ejecución y hashes fuera de la entrega; agentes leen por herramientas acotadas |
| Reutilización de verificaciones | Evita ejecutar de nuevo pruebas cuyo resultado sigue siendo aplicable | Desactivada por defecto; requiere garantías explícitas del host e identidad completa |
| Paralelismo de checks | Reduce tiempo en repositorios independientes | Concurrencia 1 por defecto, máximo 4, grupos declarados y barreras sin reordenar el plan |
| Evidencias y rutas visibles | Permite entender qué se hizo, por qué y cuánto costó | Misma vista en misión/board; desconocido no se convierte en cero ni en éxito |

## Escalado concreto

Los modelos base continúan siendo los configurados por el usuario. El escalado es opcional y queda vacío por defecto.

- Arquitecto: el único deepen permitido puede utilizar el modelo superior.
- Developer: tras dos candidatos fallidos, contando el inicial, el siguiente intento ya autorizado utiliza el superior. Con tres intentos, puede escalar en el tercero. Con dos, termina sin inventar un tercero.
- Reviewer: rechazar una implementación no escala el modelo. El tier superior puede sustituir su única reparación de respuesta inválida.
- Autenticación, falta de permisos/capacidad, cancelación, integridad o presupuesto agotado no provocan escalado.

Cambiar modelo o esfuerzo abre una sesión compatible con contexto completo. La decisión queda persistida antes de invocar al proveedor y se conserva al reanudar. Los límites lógicos de una reparación y un deepen no dependen de que el proveedor permita continuar una sesión; una llamada sin sesión recibe también el resultado anterior y su diagnóstico, acotados.

## Responsabilidad por repositorio

Core implementa la política de ejecución, capacidades del transporte, contexto, sesiones, rutas, checks, evidencias y validez. Desktop configura, presenta y conserva proyecciones; no decide por su cuenta que una prueba sigue siendo válida.

Se corregirá la precedencia actual de selección: una asignación explícita por rol prevalece sobre defaults incidentales del lanzamiento. Aclaración del usuario (2026-09-13): el proveedor seleccionado para un lanzamiento afecta a arquitecto, developer y reviewer, con procedencia registrada; un modelo o esfuerzo explícito del lanzamiento se aplica igualmente a los tres. Reanudar siempre usa la configuración congelada de esa ejecución.

Desktop ampliará las filas de roles existentes con esfuerzo compatible y escalado opcional. También conservará todos los campos de los checks al editarlos, incluidos cwd, entorno, timeout y política. No se duplicarán secciones por proveedor ni se trasladarán de nuevo las conexiones globales o los prompts que ya tienen su ubicación.

## Orden de trabajo

| Etapa | Bloques | Entregable y comprobación para avanzar |
|---|---|---|
| 1. Compatibilidad y contratos | C0 + D0 | Schema y capacidades probados, runtime original retenido, fixture real v4 que continúa sin reescribir checkpoints |
| 2. Contexto y configuración | C1 + D1 | Menos contexto repetido con continuidad real, aceptación íntegra y configuración por rol preservada en todos los lanzamientos |
| 3. Rutas y controles | C2 + D2 | Escalado determinista, esfuerzo soportado, límites y sesión correctos; controles claros |
| 4. Evidencia reproducible | C3 | Plan aditivo y harness persistente; reviewer API/MCP puede leer fuentes y páginas de logs |
| 5. Verificación eficiente | C4 | Reutilización conservadora, grupos paralelos declarados y cancelación que espera a los procesos |
| 6. Observabilidad e interfaz | C5 + D3 | Métricas sin duplicación y mismo panel desplazable en misión/board, también tras limpieza |
| 7. Evaluación e integración | C6 + C7 + D4 | Corpus offline, defectos sembrados detectados, pruebas del paquete real y del par Desktop/Core |
| 8. Preparación de release | D5, tras paquete Core disponible | Pins exactos coherentes, bundle de producción validado, reanudaciones antiguas preservadas |

Se puede trabajar en paralelo en Core y Desktop cuando el contrato correspondiente esté fijado. No se delegarán cambios simultáneos en los mismos archivos. Cada bloque terminará con pruebas focalizadas; la batería completa se ejecutará sobre el resultado integrado, evitando repeticiones costosas sin cambios que las justifiquen.

## Casos que tienen que quedar demostrados

1. Codex/Claude/Gemini con continuidad comprobada reciben el seguimiento adecuado; API y Kimi ACP sin continuidad reciben contexto completo. Un transporte que ignora resume no puede ejecutar un prompt incompleto.
2. Varios repositorios mantienen identidad y contexto legible. La eliminación de un AGENTS.md no deja sus instrucciones presentadas como vigentes.
3. Corregir una parte del cambio no hereda aprobaciones antiguas. Alterar scope congelado bloquea aunque se envíe contexto completo.
4. Un proyecto estático sin manifiesto puede producir un harness que el reviewer inspecciona y Core conserva. Una declaración inválida no escribe fuentes ni lanza comandos.
5. Cambiar pruebas, entorno, fuente o dependencias invalida la evidencia aplicable. Un éxito anterior no oculta un fallo posterior. Cambiar node_modules con el mismo lockfile tampoco permite reutilización.
6. Reanudar un workflow no terminado no evita la política de checks: antes de reviewer/archive se repiten los no reutilizables y se recertifica la autorización. Leer un resultado ya archivado no ejecuta nada de nuevo.
7. Un check paralelo fallido detiene la cola y espera la terminación de los procesos activos. El timeout respeta el tiempo restante del workflow.
8. Un job que falla y luego termina muestra el resultado actual y conserva el fallo histórico sin duplicar coste. Una continuación posterior sin métricas no hereda el éxito antiguo como actual.
9. La limpieza del worktree conserva el resumen histórico. Si las evidencias detalladas desaparecen, la UI lo explica sin inventarlas ni permitir una continuación incompatible.
10. El paquete publicado y el bundle soportan lo mismo que se validó en desarrollo. Los tests no dependen de tener un checkout hermano para no ser omitidos.

## Evaluación del ahorro

Habrá cinco casos congelados: lógica estática tipo Tetris, mejora local con tests existentes, cambio entre repositorios, verificación que falla y corrección tras rechazo del reviewer. Cada caso tendrá aceptación independiente y variantes defectuosas que el evaluador debe rechazar.

La prueba offline exigirá reducir al menos un 40% el prompt de corrección de un caso fijo con contexto largo, sin añadir invocaciones ni perder requisitos. Eso demuestra una reducción de payload en ese caso, no un 40% de ahorro real de IA.

El experimento con proveedores reales separará dos comparaciones: mismos modelos para medir la orquestación, y modelos configurados con escalado para medir la política. Se parte de tres réplicas emparejadas por caso, con orden aleatorio, sesiones/workspaces nuevos y estado de caché registrado.

Objetivo experimental: al menos un 20% menos de coste agregado por implementación aceptada independientemente, menor mediana de tiempo activo, sin caída observada de aceptación ni nuevos defectos altos/críticos. Si faltan costes, no hay resultados aceptados o la muestra no permite concluir, se declara inconcluso. No se cambia el criterio de aceptación para conseguir una cifra favorable.

Implementar el runner offline y el modo opt-in forma parte del alcance. **Ejecutar el experimento de pago requiere elegir los modelos y aportar un presupuesto explícito**; no se lanzará durante esta preparación ni por defecto en CI.

## Instrucción para iniciar la siguiente fase

Configurar el asistente de implementación como **GPT-6 Astra / medium** y continuar con esta instrucción:

> Implementa los cambios OpenSpec `implementation-efficiency` en specrails-core y specrails-desktop siguiendo el plan de `docs/plans/implementation-efficiency.md`. Empieza por C0 + D0 y respeta el contrato compartido de Core. Usa OpenSpec apply, conserva los cambios locales y la rama preparada, implementa por bloques verificables y marca tareas solo tras comprobarlas. Mantén OpenSpec oficial y los cinco pasos actuales; no añadas otro agente verifier, no debilites aceptación ni inventes soporte de proveedores. Completa código, pruebas offline e integración local. Conserva la compatibilidad de las ejecuciones guardadas y separa el paquete publicado/bundle de las pruebas con fuente local. No ejecutes benchmarks con proveedores de pago sin modelos y presupuesto explícitos. Reporta cualquier gate de release que dependa de publicar primero Core; no lo marques como probado con un bundle de desarrollo.

El cambio de modelo se realiza al iniciar esa fase; escribir esta instrucción no modifica el modelo de la conversación ni el de los roles de Specrails.

## Comprobación de esta preparación

Ambos cambios pasan `openspec validate implementation-efficiency --strict --json`, sin incidencias. OpenSpec reconoce propuesta, diseño, specs y tareas completos. Hay 44 tareas pendientes en Core y 30 en Desktop; no se han marcado como implementadas.

Se revisaron por separado ejecución por roles, verificación y Desktop, y se incorporaron las correcciones al contrato y a los escenarios. Los enlaces locales y el formato de los 15 archivos de planificación están comprobados. Los cambios de esta preparación son únicamente documentación; las pruebas de producto y el benchmark pertenecen a la siguiente fase.
