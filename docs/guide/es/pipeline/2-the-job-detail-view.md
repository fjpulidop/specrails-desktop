# La vista de detalle del job

Pulsa cualquier tarjeta de job en la página **Jobs** y aterrizas aquí: la cabina de mando de una ejecución de rail concreta. Está construida en torno a una promesa — **los números en vivo que ves son reales, nunca estimaciones.** En esta página recorremos las fases, las métricas en vivo, las tarjetas de ticket — y el compositor que te permite **hablar con el job en marcha**.

## La distribución

Dos paneles se sitúan encima del log completo en streaming; en un job de Claude en ejecución, un compositor de chat se sitúa debajo:

```
┌─────────────────────────────────────────────┐
│  Cabecera de estado  (icono · duración en vivo · …)  │
├─────────────────────────────────────────────┤
│  Cabecera de tickets  ( #12  #14  #15 )     │
├─────────────────────────────────────────────┤
│                                             │
│  Log en streaming  (auto-scroll · búsqueda · …)  │
│                                             │
├─────────────────────────────────────────────┤
│  Compositor  (envía un mensaje al job · …)  │
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

## Ejecuciones de loop: el explorador de pasos

Cuando el job es una **ejecución de loop** (ver [El Loop Builder](the-loop-builder)), el log plano deja paso a un **explorador de pasos** que refleja la forma real del loop:

- **La franja de resumen** de arriba es el mapa en vivo del loop — un chip por nodo (Paso de IA, Shell, Loop Decider…), en el orden en que fluye el grafo. Los chips se van encendiendo según avanza la ejecución: atenuados mientras esperan, con pulso mientras corren, y después un check o una cruz. El chip de un Decider muestra además el veredicto por el que enrutó — volver atrás o seguir adelante — y un contador de iteraciones (`Iteración 3/10`) lleva la cuenta a la derecha. Pulsa cualquier chip para saltar directo al último paso de ese nodo.
- **Una caja plegable por paso.** Cada pasada sobre un nodo se convierte en su propia sección, con el número de paso, su nombre, una insignia de iteración, su duración al terminar — y su propio botón de copiar, para que te lleves exactamente la salida de un paso. (El copiar de la barra superior sigue llevándose el log entero.) Todo lo impreso antes del primer paso — el banner de arranque, el aviso de worktree — queda recogido en una sección de **Preparación**.
- **El modo seguimiento** viene activado por defecto: el paso en ejecución permanece abierto y con auto-scroll mientras los anteriores se pliegan para no estorbar. En cuanto subes el scroll o abres un paso antiguo, el seguimiento se pausa para que puedas leer — una píldora flotante **Reanudar seguimiento** te devuelve al directo. **Expandir todo / Contraer todo** viven en la barra superior, y escribir en el buscador busca en todos los pasos a la vez.
- **Los pasos interrumpidos también son honestos.** Un paso que nunca llegó a reportar su resultado — la ejecución se canceló o la app se cerró a mitad de paso — se marca como **Interrumpido** con un borde discontinuo, en lugar de fingir que terminó.

Todo lo demás de esta página funciona exactamente igual en las ejecuciones de loop — las métricas en vivo, las tarjetas de ticket, el compositor. Los jobs que no son de loop conservan el log en streaming clásico de arriba.

## Habla con el job en marcha

Todo job de Claude se ejecuta por defecto como una **sesión en vivo**, así que un compositor de chat se sitúa al pie de esta página — y del modal de job en modo misión. Úsalo para preguntarle algo al agente en marcha («¿por qué falló ese test?») o para dirigirlo a mitad de ejecución («salta el refactor, céntrate en el fix»).

Algunas cosas que conviene saber:

- **Los mensajes se encolan, no interrumpen.** Envía mientras el agente está transmitiendo y tu mensaje espera su turno — se ejecuta como el siguiente prompt, y el job sigue con su plan. Un pequeño contador muestra cuántos mensajes hay en cola.
- **La línea de totales es real.** El compositor muestra un resumen en vivo `N turnos · $X`, sumado a partir del uso real de cada turno completado — coherente con la promesa de esta página de no adivinar nada.
- **Dos formas de terminar una sesión.** La mayoría de los jobs **terminan solos**: en cuanto un turno acaba sin mensajes en cola, la sesión se asienta y el job se completa — tus mensajes son dirección opcional, nunca una obligación. Una acción discreta **Terminar ahora** la cierra antes con todo lo producido hasta el momento. Los jobs **Freestyle** son la excepción: quedan a la espera entre turnos hasta que tú pulsas **Finalize** — ese es su diseño, una sesión de ida y vuelta que cierras cuando terminas.
- **En un loop, los mensajes van al paso activo.** En un loop propio o integrado, tu mensaje llega al **paso de IA que está corriendo en ese momento**. Entre pasos (mientras el Loop Decider piensa, o corre un comando de shell) el compositor muestra un breve estado *«Esperando el siguiente paso…»* — tu texto redactado se conserva, y el envío se reactiva cuando arranca el siguiente paso de IA. **Asentar este paso** cierra el paso actual antes de tiempo y deja que el loop avance con lo que produjo.
- **Solo Claude, por ahora.** Los jobs de Codex y Gemini se ejecutan de una sola pasada exactamente como antes — no aparece compositor. (Los operadores del servidor pueden desactivar la función entera con `SPECRAILS_INTERACTIVE_JOBS=false`.)

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
