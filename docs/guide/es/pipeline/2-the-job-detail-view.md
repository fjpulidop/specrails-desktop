# La vista de detalle del trabajo

Pulsa cualquier tarjeta de trabajo en la página **Trabajos** y aterrizas aquí: la cabina de mando de una ejecución de rail concreta. Está construida en torno a una promesa — **los números en vivo que ves son reales, nunca estimaciones.** En esta página recorremos las fases, las métricas en vivo, las tarjetas de spec — y el compositor que te permite **hablar con el trabajo en marcha**.

## La distribución

La cabecera compacta conserva estado, duración, fase, acciones y chips del pipeline. Justo debajo, **una única fila de navegación** reúne todo lo que puedes consultar:

- **Motivos del fallo** — presente en una ejecución fallida o cancelada con diagnóstico, y seleccionada primero. Una pregunta pendiente que admita respuesta también la habilita: pulsa el botón de pregunta de la cabecera para ir allí y responder, incluso sin diagnóstico.
- **Grafo de ejecución** y **Detalle del registro** — en las ejecuciones de loop, el grafo del workflow y el registro paso a paso.
- **Registro** — en los trabajos normales, el log en streaming.

Junto a las pestañas solo aparecen los chips que la ejecución se ha ganado: **Verificación** (con el número de comprobaciones, en el color de su estado) cuando la ejecución registró evidencia de verificación — púlsalo para ver las comprobaciones y su salida — y un botón **Detalles** (icono de gráfico de barras) cuando hay cifras reales que mostrar. Ambos se abren como ventanas emergentes, así que el registro conserva siempre toda la altura. La última sección del registro que elegiste se recuerda por separado para la página y para la ventana de la misión; la pestaña seleccionada se restablece en cada visita.

### Instrucciones de ejecución

Mientras la ejecución pueda leerlas, un compositor de una línea queda anclado al pie del registro: escribe lo que el agente debe tener en cuenta y pulsa el botón de enviar o **⌘↵** (**Ctrl+Intro**). **Intro** añade una línea. La **ⓘ** explica la regla: las instrucciones se aplican en el siguiente turno compatible del agente; no responden preguntas ni conceden aprobaciones. Lo que enviaste aparece como un chip junto al compositor — *1 en cola*, *2 aplicadas* — que lista cada mensaje y su estado. Cuando la ejecución termina, el compositor desaparece; una ejecución pasada que recibió instrucciones conserva el chip, de solo lectura, junto a las pestañas.

En la app de escritorio, un trabajo abierto desde una misión se muestra en **su propia ventana**, una ventana por trabajo. Pulsa **Escape** o cierra la ventana para volver; la versión de navegador muestra el mismo contenido en un modal.

## Fases del pipeline

Para los trabajos `Implement`, la ejecución avanza por las fases que define el slash command — por defecto:

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

Qué agente se encarga de cada fase lo decide el **perfil de agentes** del proyecto. El trío base (`sr-architect`, `sr-developer`, `sr-reviewer`) está siempre presente; las reglas de enrutamiento de un perfil pueden añadir agentes o cambiar cuál ejecuta una fase. La barra de progreso de fases solo aparece cuando el comando define realmente fases — los trabajos que se saltan el pipeline (como un loop Freestyle de la galería) no mostrarán ninguna.

## Métricas en vivo — honestas por diseño

La cabecera compacta muestra estado, duración, actividad, pasos y acciones. Las cifras reales y las notas de continuación se abren desde el botón **Detalles** junto a las pestañas:

| Métrica | Cuándo ves el valor real |
|--------|------------------------------|
| **Duración** | **En vivo.** Un contador de 1 segundo va sumando mientras el trabajo se ejecuta — este es el único número genuinamente en vivo. |
| **Turnos** | Se deriva de forma incremental a partir de los eventos de assistant en streaming según van llegando. |
| **Tokens** | Se agrega de forma incremental desde el mismo stream (tolerante con eventos a los que les faltan los campos de uso). |
| **Coste** | Se muestra como `—` hasta que el trabajo termina, y entonces se revela como el `total_cost_usd` autoritativo. |

El principio de diseño: **ningún número aproximado o estimado a media ejecución.** La duración es real porque es simplemente un reloj. Los turnos y los tokens se acumulan a partir de actividad real en streaming. El coste, deliberadamente, *no* se estima mientras se ejecuta — se muestra como pendiente y solo se resuelve a su cifra final y autoritativa cuando el proveedor la reporta al terminar el trabajo. Si un número parece estar esperando, es intencionado — te estamos mostrando la verdad, no una proyección.

La etiqueta y el icono de la cabecera se corresponden con el estado del trabajo, y el panel se renderiza igual para los trabajos `running`, `completed` y `failed` — así, la vista de detalle de un trabajo terminado muestra las mismas métricas congeladas en sus valores finales.

## Las tarjetas de spec

La **cabecera de specs** se sitúa entre la cabecera de estado y el log. Es una tarjeta de identidad premium que muestra un chip por cada spec que tocó el trabajo — extraídas del comando lanzado, así que reflejan exactamente qué specs abarcó esta ejecución.

- **2–3 specs** — se muestran como una lista de chips.
- **4 o más** — se colapsan en un modo compacto `+ N más` con un chevron para expandir, así la cabecera se mantiene ordenada.

Pulsar un chip abre el detalle de esa spec **sobre la página del trabajo** — no pierdes tu sitio ni cambias de ruta. Es una forma rápida de releer qué se supone que tiene que entregar un trabajo mientras lo ves trabajar. (En pantallas de ancho de tablet incluso puedes arrastrar a un lado un modal de spec para comparar dos specs lado a lado.)

## El log en streaming

Abre **Registro** (trabajos normales) o **Detalle del registro** (ejecuciones de loop) para ver el log en streaming, o elige Story si la narración está habilitada. La salida llega en tiempo real por WebSocket:

- **Auto-scroll** mantiene a la vista la salida más reciente (sube el scroll y se pausa para que puedas leer).
- **Búsqueda** para saltar a una frase.
- **Copiar** para llevarte el log entero.

Esta es la verdad en bruto de lo que está haciendo la IA — cada llamada a una herramienta, cada edición de archivo, cada ejecución de tests.

## Ejecuciones de loop: el grafo y el registro por pasos

En una **ejecución de loop** (ver [El Loop Builder](the-loop-builder)), dos pestañas muestran la evidencia.

**Grafo de ejecución** es el workflow tal como se ejecutó. Siempre está expandido y sigue el paso en ejecución, o el que falló:

- **El camino recorrido es continuo.** Los pasos por los que pasó la ejecución se dibujan con trazo continuo; los que nunca alcanzó, discontinuos y atenuados. Activa **Solo el camino recorrido** para ocultar el resto. Una leyenda aparece en línea.
- **Inspecciona un paso.** Selecciona un nodo para listar sus intentos con su estado y su duración. Pulsa un intento para abrir su log en Detalle del registro. **Repetir desde aquí** está en la fila de cada intento terminado, así que una ejecución enlazada arranca exactamente desde el intento que elegiste. Los ids técnicos están en **Traza**.

**Detalle del registro** reúne el recorrido de pasos y el log, y se abre en el paso que falló:

- **La franja de pasos** de arriba lista solo los pasos que alcanzó la ejecución, en orden, con un contador de iteraciones (`Iteración 3/10`) a la derecha. Los chips están atenuados mientras esperan, laten mientras corren y después muestran un check o una cruz; el chip de un Decider muestra además el veredicto por el que enrutó. Pulsa un chip para saltar a ese paso.
- **Una caja plegable por paso.** Cada pasada sobre un nodo se convierte en su propia sección, con el número de paso, su nombre, una insignia de iteración, su duración al terminar — y su propio botón de copiar, para que te lleves exactamente la salida de un paso. (El copiar de la barra superior sigue llevándose el log entero.) Todo lo impreso antes del primer paso — el banner de arranque, el aviso de worktree — queda recogido en una sección de **Preparación**.
- **El modo seguimiento** viene activado por defecto: el paso en ejecución permanece abierto y con auto-scroll mientras los anteriores se pliegan para no estorbar. En cuanto subes el scroll o abres un paso antiguo, el seguimiento se pausa para que puedas leer — una píldora flotante **Reanudar seguimiento** te devuelve al directo. **Expandir todo / Contraer todo** viven en la barra superior, y escribir en el buscador busca en todos los pasos a la vez.
- **Los pasos interrumpidos también son honestos.** Un paso que nunca llegó a reportar su resultado — la ejecución se canceló o la app se cerró a mitad de paso — se marca como **Interrumpido** con un borde discontinuo, en lugar de fingir que terminó.

Story, si la narración está habilitada, se ofrece dentro de Detalle del registro. La exploración del grafo y el desplazamiento pausado del log se conservan al cambiar de pestaña.

## Habla con el trabajo en marcha

Todo trabajo de Claude se ejecuta por defecto como una **sesión en vivo**, así que un compositor de chat se sitúa al pie de esta página — y del modal de trabajo en modo misión. Úsalo para preguntarle algo al agente en marcha («¿por qué falló ese test?») o para dirigirlo a mitad de ejecución («salta el refactor, céntrate en el fix»).

Algunas cosas que conviene saber:

- **Los mensajes se encolan, no interrumpen.** Envía mientras el agente está transmitiendo y tu mensaje espera su turno — se ejecuta como el siguiente prompt, y el trabajo sigue con su plan. Un pequeño contador muestra cuántos mensajes hay en cola.
- **La línea de totales es real.** El compositor muestra un resumen en vivo `N turnos · $X`, sumado a partir del uso real de cada turno completado — coherente con la promesa de esta página de no adivinar nada.
- **Dos formas de terminar una sesión.** La mayoría de los trabajos **terminan solos**: en cuanto un turno acaba sin mensajes en cola, la sesión se asienta y el trabajo se completa — tus mensajes son dirección opcional, nunca una obligación. Una acción discreta **Terminar ahora** la cierra antes con todo lo producido hasta el momento. Los trabajos **Freestyle** antiguos (de antes de que Freestyle pasara a ser un loop de la galería) son la excepción: quedan a la espera entre turnos hasta que tú pulsas **Finalize** — ese es su diseño, una sesión de ida y vuelta que cierras cuando terminas.
- **En un loop, los mensajes van al paso activo.** En un loop propio o integrado, tu mensaje llega al **paso de IA que está corriendo en ese momento**. Entre pasos (mientras el Loop Decider piensa, o corre un comando de shell) el compositor muestra un breve estado *«Esperando el siguiente paso…»* — tu texto redactado se conserva, y el envío se reactiva cuando arranca el siguiente paso de IA. **Asentar este paso** cierra el paso actual antes de tiempo y deja que el loop avance con lo que produjo.

## Exportar diagnóstico

Si la [telemetría](../settings/pipeline-telemetry-and-diagnostics) estaba activada para el trabajo, aparece un botón **Exportar diagnóstico** en la cabecera. Descarga un ZIP que contiene:

- `job-metadata.json` — comando, estado, perfil, plugins.
- `telemetry.ndjson` — señales OTLP/JSON sin comprimir.
- `logs.txt` — el log completo en streaming.
- `summary.md` — lo más destacado en formato legible.
- `profile.json`, `plugins.json` — instantáneas exactas de lo que se ejecutó (cuando existen).

Práctico para compartir una ejecución con un compañero o para abrir un informe de bug preciso.

## Cuando una ejecución falla

En trabajos fallidos o cancelados con diagnóstico, **Motivos del fallo** abre con la **tarjeta de diagnóstico**, que explica la causa y, cuando se conoce, por qué ocurrió. Cuando la ejecución registró qué paso falló, la tarjeta lo indica: el paso, el intento, la iteración y la hora. Las causas:

- **Pruebas fallidas**: las comprobaciones siguen fallando tras las rondas de correcciones.
- **Límite del proveedor** — se alcanzó el límite de uso del proveedor de IA. La tarjeta dice cuándo se restablece, en tu hora local cuando el proveedor indicó la hora exacta y si no con las palabras del proveedor. Una ejecución que sigue en pausa en el límite muestra su propia tarjeta: cuándo se reanuda sola, **Reanudar ahora** y **Continuar ahora con** otro proveedor. Consulta [Límites de uso](1-rails-and-jobs.md#usage-limits).
- **Entorno**: la máquina no puede ejecutar las comprobaciones (credenciales, una herramienta que falta, un comando de preparación que falla). *Arreglar el entorno* muestra exactamente qué ejecutar o cambiar.
- **Puerto en uso**: la comprobación o el servidor de la propia ejecución no pudo arrancar porque otro proceso ya ocupaba su puerto (`EADDRINUSE`). No cuenta como tests fallidos. Cada worktree de ejecución recibe sus propios puertos mediante `PORT` y `SPECRAILS_RUN_PORT_RANGE_START`/`_END`; un proyecto que lee `PORT` nunca choca. Detén el otro proceso, o haz que el proyecto lea `PORT`, y luego **Ejecutar de nuevo**.
- **Bloqueada**, **sin tiempo**, **en silencio** y **detenida inesperadamente** nombran el límite o el proceso que paró la ejecución.
- **Tareas sin terminar**: la ejecución hizo el trabajo pero dejó tareas aprobadas sin marcar, por ejemplo una comprobación visual. La tarjeta las lista. **Continuar** conserva el trabajo y reinicia al desarrollador con la herramienta de navegador y la regla de instalar lo que falte, para exactamente esas tareas; cuando todo lo que queda son comprobaciones que solo puede hacer una persona, **Continuar a revisión** la envía a revisión con ellas como *comprobaciones a mano* en el paquete de revisión.
- **Spec rechazada**: OpenSpec rechazó el plan o la spec y la planificación no pudo repararlo. **Editar la spec y relanzar**.
- **Causa desconocida**: los registros de la ejecución no indican la causa y la app no adivina. La tarjeta muestra primero el análisis con IA, identificado como tal, u ofrece **Analizar con IA** como primera acción; el final del registro queda a un clic.

Bajo el diagnóstico hay hasta tres remedios ordenados, y solo los que pueden funcionar aquí, cada uno con una línea debajo que dice qué hace con tu trabajo: **Continuar**, **Continuar a revisión**, **Editar spec y relanzar** (los anexos de la spec llevan tu cambio a la siguiente ejecución), **Arreglar el entorno** y **Abrir los logs en el fallo**. **Empezar de nuevo** espera en el menú **⋯**: inicia una ejecución nueva desde la base y el trabajo de este intento no se arrastra (se queda en el worktree anterior). La misma causa aparece como una línea en la [bandeja](../getting-started/the-dashboard-tour), y la tarjeta de ejecución de la misión muestra la misma tarjeta.

Las ejecuciones de Implement comprueban por sí mismas la interfaz y el comportamiento visual: cada ejecución tiene una herramienta de navegador sin interfaz (`$SPECRAILS_BROWSE`) que abre la app en el puerto propio de la ejecución, o una página del repositorio, a tamaño de escritorio y de móvil, y devuelve capturas que el agente lee. Una comprobación que solo puede hacer una persona (gusto, un dispositivo real, credenciales reales) se planifica como *comprobación manual*: la ejecución nunca falla por ella y te llega en el paquete de revisión.

### Continuar una ejecución {#continue}

**Continuar** es la única forma de seguir con una ejecución fallida o detenida. Conserva todo lo que hizo y sigue en el mismo worktree: una ejecución en pausa se reanuda en el sitio; una fallida o detenida sigue como su siguiente *intento*, desde el paso que falló o donde la detuviste. Además le dice al agente qué salió mal: para tareas sin terminar, las tareas exactas con la herramienta de navegador y la regla de instalar lo que falte; para un problema del equipo, qué faltaba y cómo instalarlo; tras un error pasajero del proveedor, nada (el mismo paso vuelve a ejecutarse).

Una ejecución que detuviste lo dice (**Detuviste esta ejecución**) y ofrece el mismo **Continuar**, nunca un relanzamiento desde cero.

Los intentos de un mismo trabajo son una unidad. La ventana de la ejecución muestra en cuál estás, por ejemplo *Intento 3 de 4 · continuado desde el paso Desarrollador del intento 2*; pulsa para ver cada intento, abrir cualquiera y qué cambió entre ellos (quién continuó, desde qué paso, la guía enviada). La bandeja, el tablero en vivo, la lista de jobs y **⌘K** muestran solo el último intento, con su número: un intento fallido anterior que otro tomó no cuenta ya como algo que te necesita.

Cuando la causa se conoce y más trabajo puede arreglarla (tareas sin terminar, una herramienta que falta, un error pasajero del proveedor, un intento atascado), Specrails continúa **una vez** por sí mismo y escribe *Specrails continuó automáticamente* en el historial de la ejecución. Nunca lo hace por credenciales o secretos, denegaciones de políticas, límites de gasto, límites de uso, una parada que elegiste o el mismo fallo dos veces. Desactívalo en **Ajustes → Agentes de Specrails → Continuar ejecuciones fallidas**.

Cuando el análisis de IA de abajo sugiere un paso que es uno de estos remedios, aparece como un botón junto al paso.

### Análisis de IA {#ai-failure-analysis}

Bajo la tarjeta, un **Análisis de IA** lee el registro y explica por qué se detuvo la ejecución: la causa, **Qué hacer** y las líneas **Del registro** en las que se basó, citadas palabra por palabra. Se ejecuta con el mismo proveedor y modelo que ejecutaron el trabajo, así que tu cuenta siempre puede ejecutarlo. Arranca solo, salvo cuando la causa fue el límite del proveedor; en ese caso pulsa **Analizar con IA**. El análisis se guarda con el trabajo. Si después cambia el registro, lo indica y ofrece **Analizar de nuevo**.

El análisis se etiqueta como una lectura de la IA y nunca sustituye a la tarjeta: el diagnóstico, su causa y sus remedios siguen siendo lo que registró la app. Revisa las líneas que cita antes de actuar. Su coste cuenta en **Soporte** dentro de [Analíticas](../insights/analytics-and-cost-tracking).

## A dónde ir después

- [Rails y trabajos](rails-and-jobs) — lanzamiento y encolado.
- [Seguimiento de costes](../insights/analytics-and-cost-tracking) — convierte los costes por trabajo en analíticas de proyecto.

## Después de reiniciar un workflow

Tras una caída, reanuda el workflow guardado con su configuración y repositorios originales. Una escritura interrumpida exige seleccionar el intento exacto después de revisar el diff del worktree. Los pasos completados se conservan. Una llamada al proveedor cuya respuesta se perdió sigue contabilizada como interrumpida y con consumo desconocido; nunca se presenta como gratuita. Si los registros guardados no permiten demostrar la entrega original, la recuperación muestra un error y conserva el worktree.

Cuando un paso de decisión se detiene para preguntar, la reanudación reutiliza la decisión guardada y transmite la respuesta humana al siguiente paso. No vuelve a llamar al modelo para esa misma decisión. Un prompt pausado sí puede necesitar otro turno del modelo para aplicar tu respuesta.

## Conservación del historial

Las ejecuciones guardadas se conservan indefinidamente por defecto. En **Ejecuciones guardadas → Conservación del historial**, un proyecto puede conservarlas entre 1 y 3650 días. Nada se borra en segundo plano: guarda la política, elige **Previsualizar limpieza** y revisa cada ejecución y su motivo antes de **Eliminar historial caducado**. Una ejecución sigue protegida mientras está activa, espera tu respuesta o aprobación, tiene una escritura interrumpida, una entrega abierta o un fork que aún depende de ella. Solo se elimina el historial de ejecución dentro del almacenamiento de Specrails del proyecto; tu repositorio, los worktrees, el log del trabajo y los registros de coste se conservan. Una ejecución caducada aparece como **Caducado** y ya no se puede reanudar ni bifurcar. Las versiones de Core que aún usa una ejecución conservada nunca se eliminan.
