# La vista de detalle del job

Pulsa cualquier tarjeta de job en la página **Jobs** y aterrizas aquí: la cabina de mando de una ejecución de rail concreta. Está construida en torno a una promesa — **los números en vivo que ves son reales, nunca estimaciones.** En esta página recorremos las fases, las métricas en vivo y las tarjetas de ticket.

## La distribución

Dos paneles se sitúan encima del log completo en streaming:

```
┌─────────────────────────────────────────────┐
│  Cabecera de estado  (icono · duración en vivo · …)  │
├─────────────────────────────────────────────┤
│  Cabecera de tickets  ( #12  #14  #15 )     │
├─────────────────────────────────────────────┤
│                                             │
│  Log en streaming  (auto-scroll · búsqueda · …)  │
│                                             │
└─────────────────────────────────────────────┘
```

## Fases del pipeline

Para los jobs `Implement` y `Batch`, la ejecución avanza por las fases que define el slash command — por defecto:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Cada fase es un agente especializado que el motor del rail invoca en el directorio de tu proyecto:

| Fase | Agente | Qué hace |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Planifica la implementación. |
| **Developer** | `sr-developer` | Escribe el código. |
| **Reviewer** | `sr-reviewer` | Revisa el resultado. |
| **Ship** | (varía) | Cierre final: tests, commit, borrador de PR. |

Qué agente se encarga de cada fase lo decide el **perfil de agentes** del proyecto. El trío base (`sr-architect`, `sr-developer`, `sr-reviewer`) está siempre presente; las reglas de enrutamiento de un perfil pueden añadir agentes o cambiar cuál ejecuta una fase. La barra de progreso de fases solo aparece cuando el comando define realmente fases — los jobs de Freestyle (que se saltan el pipeline) no mostrarán ninguna.

## Métricas en vivo — honestas por diseño

La cabecera de estado es el titular. Muestra un icono de estado, una línea de actividad que describe qué está haciendo el job *ahora mismo*, un recuento de pasos dados y una fila de métricas:

| Métrica | Cuándo ves el valor real |
|--------|------------------------------|
| **Duración** | **En vivo.** Un contador de 1 segundo va sumando mientras el job se ejecuta — este es el único número genuinamente en vivo. |
| **Turnos** | Se deriva de forma incremental a partir de los eventos de assistant en streaming según van llegando. |
| **Tokens** | Se agrega de forma incremental desde el mismo stream (tolerante con eventos a los que les faltan los campos de uso). |
| **Coste** | Se muestra como `—` hasta que el job termina, y entonces se revela como el `total_cost_usd` autoritativo. |

El principio de diseño: **ningún número aproximado o estimado a media ejecución.** La duración es real porque es simplemente un reloj. Los turnos y los tokens se acumulan a partir de actividad real en streaming. El coste, deliberadamente, *no* se estima mientras se ejecuta — se muestra como pendiente y solo se resuelve a su cifra final y autoritativa cuando el proveedor la reporta al terminar el job. Si un número parece estar esperando, es intencionado — te estamos mostrando la verdad, no una proyección.

La etiqueta y el icono de la cabecera se corresponden con el estado del job, y el panel se renderiza igual para los jobs `running`, `completed` y `failed` — así, la vista de detalle de un job terminado muestra las mismas métricas congeladas en sus valores finales.

## Las tarjetas de ticket

La **cabecera de tickets** se sitúa entre la cabecera de estado y el log. Es una tarjeta de identidad premium que muestra un chip por cada spec que tocó el job — extraídos del comando lanzado, así que reflejan exactamente qué tickets abarcó esta ejecución.

- **2–3 tickets** — se muestran como una lista de chips.
- **4 o más** — se colapsan en un modo compacto `+ N más` con un chevron para expandir, así la cabecera se mantiene ordenada.

Pulsar un chip abre el detalle de esa spec **sobre la página del job** — no pierdes tu sitio ni cambias de ruta. Es una forma rápida de releer qué se supone que tiene que entregar un job mientras lo ves trabajar. (En pantallas de ancho de tablet incluso puedes arrastrar a un lado un modal de ticket para comparar dos specs lado a lado.)

## El log en streaming

Bajo los paneles está el log completo de la ejecución, transmitido en tiempo real por el WebSocket:

- **Auto-scroll** mantiene a la vista la salida más reciente (sube el scroll y se pausa para que puedas leer).
- **Búsqueda** para saltar a una frase.
- **Copiar** para llevarte el log entero.

Esta es la verdad en bruto de lo que está haciendo la IA — cada llamada a una herramienta, cada edición de archivo, cada ejecución de tests.

## Exportar diagnóstico

Si la [telemetría](../settings/customizing) estaba activada para el job, aparece un botón **Exportar diagnóstico** en la cabecera. Descarga un ZIP que contiene:

- `job-metadata.json` — comando, estado, perfil, plugins.
- `telemetry.ndjson` — señales OTLP/JSON sin comprimir.
- `logs.txt` — el log completo en streaming.
- `summary.md` — lo más destacado en formato legible.
- `profile.json`, `plugins.json` — instantáneas exactas de lo que se ejecutó (cuando existen).

Práctico para compartir una ejecución con un compañero o para abrir un informe de bug preciso.

## A dónde ir después

- [Rails y jobs](rails-and-jobs) — lanzamiento y encolado.
- [Batch implement y multifuncionalidad](batch-implement-and-multi-feature) — muchas specs, oleadas por dependencias.
- [Seguimiento de costes](../analytics/tracking-cost) — convierte los costes por job en analíticas de proyecto.
