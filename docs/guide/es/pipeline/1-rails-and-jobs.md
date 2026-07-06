# Rails y jobs

Ya tienes specs en el tablero. Aquí es donde se convierten en código. Un **rail** es el carril que lleva una spec a través de todo el pipeline — Architect → Developer → Reviewer → Ship — ejecutando agentes de IA reales para tu proyecto. En esta página verás cómo lanzar un rail, la ejecución en paralelo y cómo seguir el trabajo en vivo.

## Qué es un rail

Imagina la pantalla dividida en dos:

```
SpecsBoard (izquierda)      Rails (derecha)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  arrastra hacia
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Un rail es un **carril de ejecución**. Arrastras una tarjeta de spec desde el SpecsBoard hasta un rail y luego pulsas **▶ Play**. En repositorios git, el rail lanza el pipeline en un git worktree aislado para que la IA pueda editar archivos y ejecutar tests sin tocar tu árbol de trabajo activo. Si el proyecto todavía no es un repo git, Specrails degrada claramente a ejecución en la carpeta compartida y te avisa de que no habrá rama ni tarjeta de PR.

Puedes tener varios rails para organizar el trabajo en carriles con nombre (uno para la funcionalidad en la que estás centrado, otro en cola detrás). Los rails son **dinámicos**: el botón **+ Añadir** de la cabecera de Rails crea un carril nuevo (hasta 12 por proyecto) y los carriles vacíos e inactivos se pueden borrar. Cada rail está respaldado por el servidor, así que tu conjunto de carriles sobrevive a las recargas y es visible para el companion móvil y el agente integrado — el agente incluso puede crear un rail por sí mismo cuando todos los carriles están ocupados. Tienes más sobre multi-rail y procesamiento por lotes en [Batch implement y multifuncionalidad](batch-implement-and-multi-feature).

## Lanzar un rail sobre una spec

1. **Arrastra una tarjeta de spec** desde el SpecsBoard hasta un rail. El ID de la spec aparece en la lista de specs del rail. (¿Prefieres no arrastrar? Usa el popover **Mover a rail** en la tarjeta de la spec — muestra un punto de estado por cada rail para que no dejes trabajo en un carril ocupado.)
2. **Elige un Loop** en la cabecera del rail. Un rail ejecuta un **Loop** — eso es el trabajo que realiza. El predeterminado es el loop `Implement` integrado; también puedes elegir `Batch`, `Freestyle` o un loop personalizado que hayas construido tú mismo. Mira [El Loop Builder](the-loop-builder).
3. **Pulsa ▶ Play.**

Eso es todo. El rail arranca un proceso de la CLI de IA en el contexto de ejecución correcto y empieza el pipeline.

### Qué hay en la cabecera de un rail

| Control | Qué hace |
|---------|--------------|
| **Pastilla de estado** | `idle`, `running` o `failed`. No hay un estado "completed" aparte — un rail vuelve a `idle` cuando su job termina limpiamente. |
| **Lista de specs** | Los IDs asignados a este rail. Arrastra más para añadirlas, o sácalas para desvincularlas. |
| **Selector de Loop** | El Loop que ejecuta este rail — uno integrado (`Implement` / `Batch` / `Freestyle`) o un loop personalizado. Mira la tabla de más abajo. Se recuerda por rail. |
| **Selector de perfil** | Qué perfil de agentes se ejecuta (solo en rails de Claude). Solo aparece cuando el proyecto tiene al menos un perfil. |
| **Selector de motor** | Qué proveedor instalado ejecuta este rail — Claude, Codex o Gemini. Solo se muestra cuando el proyecto tiene más de un proveedor. Mira [Elegir un motor por rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Iniciar o cancelar. |

### Qué ejecuta un rail: Loops

Un rail ejecuta un **Loop** — la receta del trabajo. Tres loops están **integrados** y cubren los casos comunes:

| Loop integrado | Comando | Qué hace |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Un job que cubre todas las specs del rail. Ejecuta el pipeline completo Architect → Developer → Reviewer → Ship. El predeterminado del día a día. |
| **Batch** | `/specrails:batch-implement` | Un job que recorre las specs del rail de forma secuencial, en oleadas según sus dependencias. Lo mejor para varias specs relacionadas. |
| **Freestyle** | Freestyle | Claude implementa cada spec de forma autónoma, **saltándose** el pipeline. Un job independiente por spec. Solo Claude. |

Freestyle es el caso especial: se salta la cadena de agentes y le entrega a Claude la spec en bruto para que la trabaje con sus herramientas nativas. Es de final abierto, así que al pulsar Play primero se abre una confirmación, y un selector de modelo por rail te deja elegir Haiku / Sonnet / Opus. Solo aparece cuando el motor del rail es Claude. Una ejecución Freestyle es además el único job que **se queda abierto esperándote**: chatea con él desde el compositor del detalle del job y pulsa **Finalize** cuando estés satisfecho (todos los demás jobs terminan solos).

Más allá de los integrados, puedes **construir tus propios loops** — repetir un ciclo verify → fix → verify hasta cumplir un objetivo, encadenar comandos de shell entre pasos de IA y más. Esos loops personalizados aparecen en el mismo selector de Loop. Esa es la siguiente gran idea: [El Loop Builder](the-loop-builder).

## La cola de jobs

Cada vez que pulsas Play, la ejecución del rail se convierte en un **job**. La regla más importante que debes interiorizar:

> **Los rails se ejecutan en paralelo.** Cada lanzamiento respaldado por git aísla su trabajo en un worktree de git por spec, así que varios rails pueden ejecutarse a la vez dentro del mismo proyecto sin pisarse. El trabajo nuevo termina en una tarjeta de decisión **En revisión**, donde puedes crear una draft PR o descartarlo; el trabajo de seguimiento para una spec que ya tiene una PR abierta continúa esa rama de PR en lugar de empezar otra vez desde la rama de integración.

¿Quieres que todo arranque a la vez? El botón **Lanzar todos** de la cabecera de Rails inicia todos los carriles listos de una tacada, tras una única confirmación que enmarca el coste total (N rails × gasto de IA). Los rails vacíos, ya en ejecución o a la espera de una decisión de PR se omiten y se informan en un toast resumen compacto. El agente integrado tiene el mismo poder mediante `specrails_rails(launch_all)` — y creará un rail nuevo cuando no quede ningún carril libre.

Los proyectos sin git no tienen aislamiento por worktree ni continuación de PR. Siguen pudiendo ejecutarse, pero el rail escribe directamente en la carpeta compartida del proyecto y el resultado se acepta o se revierte manualmente desde el tablero de specs.

No hay ninguna palanca global de concurrencia que ajustar. El único freno automático se basa en el presupuesto: si has fijado un presupuesto diario (de proyecto o de toda la app), la cola se pausa sola en cuanto el gasto de ese día llega al tope.

## Verlo en marcha

Encuentra todos los jobs en **Jobs**, en la barra lateral derecha del proyecto — una lista de tarjetas, la más reciente primero. Cada tarjeta muestra una insignia de estado, la insignia de perfil, una insignia de prioridad, la duración, el coste y el comando lanzado. Encima de la lista:

- **Chips de filtro por estado** — muestra solo los jobs en un estado concreto.
- **Filtro por rango de fechas** — acota a una ventana temporal.
- **Comparar** — elige dos jobs y velos lado a lado.

Pulsa cualquier tarjeta para abrir la **vista de detalle del job**, donde están el log en streaming en vivo y las métricas en vivo — y donde, en los jobs de Claude, un compositor de chat te permite **hacerle preguntas al agente en marcha o dirigirlo a mitad de ejecución** sin detener nada. Eso es la página siguiente: [La vista de detalle del job](the-job-detail-view).

## Cancelar un job

Pulsa **■ Stop** en la cabecera del rail. La app envía `SIGTERM` al subproceso, espera **5 segundos** a que salga limpiamente y luego le aplica `SIGKILL`. No queda nada a medio arrancar.

## Si un rail no se lanza

Si eliges un motor cuya CLI no está instalada en tu máquina, el lanzamiento **falla rápido** en vez de iniciar un job roto — no se arranca nada. Instala la CLI del proveedor que falte ([Usar Codex](../integrations/using-codex), [Usar Gemini](../integrations/using-gemini)) y vuelve a lanzar. Si falta Claude o Codex, verás un mensaje preciso de "*&lt;provider&gt; CLI not found*"; si falta Gemini, hoy aparece un error de lanzamiento genérico, pero el resultado es el mismo.

## Detenerlo todo

Si algo parece ir mal:

- **Un rail** — pulsa **■ Stop** en su cabecera.
- **Pausa automática por presupuesto** — fija un presupuesto diario y la cola se pausará sola cuando el gasto de ese día llegue al tope.
- **Todo** — cierra la app de escritorio o ejecuta `specrails-desktop stop`.

## A dónde ir después

- [El Loop Builder](the-loop-builder) — qué ejecuta un rail y cómo construir tus propios loops.
- [La vista de detalle del job](the-job-detail-view) — fases, métricas en vivo, tarjetas de ticket.
- [Batch implement y multifuncionalidad](batch-implement-and-multi-feature) — ejecuta varias specs a la vez.
- [Elegir un motor por rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
