# Rails y jobs

Ya tienes specs en el tablero. Aquí es donde se convierten en código. Un **rail** es el carril que lleva una spec a través de todo el pipeline — Architect → Developer → Reviewer → Ship — ejecutando agentes de IA reales dentro del directorio de tu proyecto. En esta página verás cómo lanzar un rail, la cola de jobs y cómo seguir el trabajo en vivo.

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

Un rail es un **carril de ejecución**. Arrastras una tarjeta de spec desde el SpecsBoard hasta un rail y luego pulsas **▶ Play**. El rail lanza el pipeline y trabaja la spec de principio a fin, directamente en el directorio de trabajo de tu proyecto — editando archivos, ejecutando tests, todo lo necesario.

Puedes tener varios rails para organizar el trabajo en carriles con nombre (uno para la funcionalidad en la que estás centrado, otro en cola detrás). Tienes más sobre multi-rail y procesamiento por lotes en [Batch implement y multifuncionalidad](batch-implement-and-multi-feature).

## Lanzar un rail sobre una spec

1. **Arrastra una tarjeta de spec** desde el SpecsBoard hasta un rail. El ID de la spec aparece en la lista de specs del rail. (¿Prefieres no arrastrar? Usa el popover **Mover a rail** en la tarjeta de la spec — muestra un punto de estado por cada rail para que no dejes trabajo en un carril ocupado.)
2. **Elige un Loop** en la cabecera del rail. Un rail ejecuta un **Loop** — eso es el trabajo que realiza. El predeterminado es el loop `Implement` integrado; también puedes elegir `Batch`, `Ultracode` o un loop personalizado que hayas construido tú mismo. Mira [El Loop Builder](the-loop-builder).
3. **Pulsa ▶ Play.**

Eso es todo. El rail arranca un proceso de la CLI de IA en tu proyecto y empieza el pipeline.

### Qué hay en la cabecera de un rail

| Control | Qué hace |
|---------|--------------|
| **Pastilla de estado** | `idle`, `running` o `failed`. No hay un estado "completed" aparte — un rail vuelve a `idle` cuando su job termina limpiamente. |
| **Lista de specs** | Los IDs asignados a este rail. Arrastra más para añadirlas, o sácalas para desvincularlas. |
| **Selector de Loop** | El Loop que ejecuta este rail — uno integrado (`Implement` / `Batch` / `Ultracode`) o un loop personalizado. Mira la tabla de más abajo. Se recuerda por rail. |
| **Selector de perfil** | Qué perfil de agentes se ejecuta (solo en rails de Claude). Solo aparece cuando el proyecto tiene al menos un perfil. |
| **Selector de motor** | Qué proveedor instalado ejecuta este rail — Claude, Codex o Gemini. Solo se muestra cuando el proyecto tiene más de un proveedor. Mira [Elegir un motor por rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Iniciar o cancelar. |

### Qué ejecuta un rail: Loops

Un rail ejecuta un **Loop** — la receta del trabajo. Tres loops están **integrados** y cubren los casos comunes:

| Loop integrado | Comando | Qué hace |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Un job que cubre todas las specs del rail. Ejecuta el pipeline completo Architect → Developer → Reviewer → Ship. El predeterminado del día a día. |
| **Batch** | `/specrails:batch-implement` | Un job que recorre las specs del rail de forma secuencial, en oleadas según sus dependencias. Lo mejor para varias specs relacionadas. |
| **Ultracode** | Ultracode | Claude implementa cada spec de forma autónoma, **saltándose** el pipeline. Un job independiente por spec. Solo Claude. |

Ultracode es el caso especial: se salta la cadena de agentes y le entrega a Claude la spec en bruto para que la trabaje con sus herramientas nativas. Es de final abierto, así que al pulsar Play primero se abre una confirmación, y un selector de modelo por rail te deja elegir Haiku / Sonnet / Opus. Solo aparece cuando el motor del rail es Claude.

Más allá de los integrados, puedes **construir tus propios loops** — repetir un ciclo verify → fix → verify hasta cumplir un objetivo, encadenar comandos de shell entre pasos de IA y más. Esos loops personalizados aparecen en el mismo selector de Loop. Esa es la siguiente gran idea: [El Loop Builder](the-loop-builder).

## La cola de jobs

Cada vez que pulsas Play, la ejecución del rail se convierte en un **job**. La regla más importante que debes interiorizar:

> **Un job a la vez, por proyecto.** Cada proyecto tiene una única cola. Dentro de un mismo proyecto solo se ejecuta un job de rail a la vez — el resto esperan en cola detrás y arrancan automáticamente a medida que se liberan huecos.

Esto sorprende a quien añade tres rails esperando que se ejecuten en paralelo. No lo harán — no dentro del mismo proyecto. Añadir rails *organiza* tu trabajo en carriles; no hace que esos carriles se ejecuten a la vez.

**El paralelismo real es entre proyectos.** Cada proyecto tiene su propia cola independiente, así que un rail en el Proyecto A y un rail en el Proyecto B se ejecutan al mismo tiempo sin competir. ¿Quieres más rendimiento? Abre más proyectos.

No hay ninguna palanca global de concurrencia que ajustar. El único freno automático se basa en el presupuesto: si has fijado un presupuesto diario (de proyecto o de toda la app), la cola se pausa sola en cuanto el gasto de ese día llega al tope.

## Verlo en marcha

Encuentra todos los jobs en **Jobs**, en la barra lateral derecha del proyecto — una lista de tarjetas, la más reciente primero. Cada tarjeta muestra una insignia de estado, la insignia de perfil, una insignia de prioridad, la duración, el coste y el comando lanzado. Encima de la lista:

- **Chips de filtro por estado** — muestra solo los jobs en un estado concreto.
- **Filtro por rango de fechas** — acota a una ventana temporal.
- **Comparar** — elige dos jobs y velos lado a lado.

Pulsa cualquier tarjeta para abrir la **vista de detalle del job**, donde están el log en streaming en vivo y las métricas en vivo. Eso es la página siguiente: [La vista de detalle del job](the-job-detail-view).

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
