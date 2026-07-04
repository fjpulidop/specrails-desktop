# Maneja Specrails conversando (Agent Chat)

El **Agent Chat** es un copiloto que vive *dentro* de Specrails y puede manejar toda la app por ti. En lugar de ir haciendo clic por proyectos, specs, raíles y analítica, basta con que preguntes: *«¿cuántos trabajos salieron bien esta semana?»*, *«crea una spec para el inicio de sesión social en el proyecto de la API»*, *«lanza los tres tickets de mayor prioridad y avísame cuando terminen»*. Lleva a cabo el trabajo llamando a las propias herramientas de Specrails —las mismas que expone el [servidor MCP](./5-mcp-server.md)— mientras ves el panel actualizarse en directo detrás de él.

> **No lo confundas con los agentes del pipeline.** La sección *Agentes* (Architect → Developer → Reviewer) trata de *cómo un raíl implementa una spec*. El **Agent Chat** es un único asistente que *maneja la propia app*. Cosas distintas, misma palabra.

## Cómo abrirlo

Hay una **burbuja** flotante en la parte inferior de la ventana: haz clic en ella para abrir el panel, o pulsa **⌘⇧A** (**Ctrl+Shift+A** en Windows/Linux) desde cualquier sitio. El panel es una ventana de verdad que puedes mover, redimensionar, maximizar y devolver a la burbuja; recuerda dónde lo dejaste.

Es **no modal a propósito**: el panel de detrás sigue vivo, así que cuando el agente lanza un raíl o crea una spec lo ves aparecer en tiempo real; no estás mirando una pantalla congelada.

## Requisito previo: el servidor MCP

El Agent Chat maneja la app a través del **servidor MCP de Specrails** integrado, así que tiene que estar activo. Si no lo está, el panel se abre con un banner de **Activar Specrails MCP** de un solo clic: púlsalo y ya está listo (sin reiniciar). Consulta [Controla Specrails desde cualquier IA](./5-mcp-server.md) para los detalles; no se instala nada, todo es local en tu máquina.

## Elegir sobre qué trabaja

La cabecera tiene un **selector de proyecto** (como el de Cursor). Elige un proyecto y todo lo que pidas queda acotado a él: *«lanza los de alta prioridad»* se resuelve contra ese proyecto. Déjalo en **Inicio** y el agente trabaja sobre todo tu conjunto: puede listar o crear proyectos y responder preguntas que abarquen todo. Si pides algo específico de un proyecto estando en Inicio, te preguntará cuál (o se ofrecerá a crear uno) en lugar de adivinar.

Elegir un proyecto aquí **no** mueve tu panel: el objetivo del agente y lo que estás mirando son independientes.

## Proveedor y modelo

Justo encima del cuadro de mensaje eliges el **proveedor** (Claude, Codex o Gemini) y su **modelo**. Cada proveedor tiene su propia lista de modelos, y cambiar de proveedor inicia una sesión nueva con el modelo por defecto de ese proveedor, así que puedes, por ejemplo, manejar la app con Claude y pasar a Codex para otra conversación sin que se mezcle nada.

## Niveles de permiso: tú llevas las riendas

El agente puede tocar toda la app, así que tú decides cuánta libertad tiene con un **nivel** que cambias en vivo pulsando **Shift+Tab** (el mismo ciclo que usa Claude Code). Cada nivel incluye todo lo que hay por debajo:

| Nivel | Qué puede hacer |
|---|---|
| 👀 **Observa** | Solo lectura: listar e inspeccionar proyectos, specs, trabajos, analítica. No cambia nada. |
| ✍️ **Edita** | Lo anterior **+** crear y editar (specs, ajustes, configuración de raíles): cambios reversibles. |
| ⚡ **Opera** | Lo anterior **+** lanzar trabajo de IA que **cuesta dinero** (raíles, generación de specs). |
| 🔥 **Autónomo** | Lo anterior **+** borrar y detener cosas: acciones irreversibles. |

Empieza en **Observa** y sube el nivel solo cuando quieras que el agente actúe. Si intenta algo por encima del nivel actual, se detiene y te dice exactamente qué nivel activar; nunca sortea el límite. Esto es independiente de los niveles de Ajustes ▸ MCP, que rigen a los asistentes *externos*; el nivel de aquí es solo para este agente interno de la app.

## Algunas cosas que puedes pedir

Cuando estés en **Opera**, prueba con:

> *«Lista todas las specs pendientes del proyecto de la API y luego lanza las tres de mayor prioridad en raíles separados y vigílalas.»*
>
> *«¿Cuánto he gastado esta semana, desglosado por proyecto?»*
>
> *«Crea una spec para un interruptor de modo oscuro en el proyecto web, con Contract Layer.»*
>
> *«Algo ha fallado en el último lote: encuentra los trabajos fallidos y resume por qué.»*

Las respuestas llegan fluidas y ya formateadas (encabezados, tablas, listas), cada una con un pequeño botón de **copiar**. Una etiqueta de estado abajo muestra lo que el agente está haciendo ahora mismo —*Pensando…*, *MCP · jobs*, *Terminal*— para que siempre sepas en qué estado está.

## Detalles prácticos

- **Súper specs desde una conversación.** Pide al agente *dar forma* a una spec contigo en vez de generarla de una sola vez: primero lee el código real, te entrevista brevemente y muestra el borrador en evolución como una tarjeta en vivo dentro de la conversación. Cuando dices que sí, crea la spec y — por defecto — la enriquece en segundo plano con una **Contract Layer** (rutas de archivo exactas, formas de datos, invariantes) para que los agentes que implementan no improvisen. Di «sin contract layer» para omitir el enriquecimiento.
- **Haz clic en lo que menciona.** En una misión fijada a un proyecto, los números de spec (`#12`) y los ids de job/ejecución en las respuestas del agente son chips clicables: una spec abre el modal de detalle del tablero y un id de job abre la vista del job en directo. Si la referencia ya no existe, verás un aviso discreto de «no encontrado».
- **La tarjeta de implementación, siempre a la vista.** Cuando el agente implementa specs, una tarjeta en vivo sigue el trabajo — y mientras necesite algo de ti (crear la PR, publicarla, reintentar, descartar) permanece **fijada justo encima del cuadro de mensaje**, por mucho que se desplace la conversación; en su lugar del historial aparece un marcador discreto de «fijada arriba». Varias tarjetas activas se apilan como pequeños chips (haz clic en uno para traerla al frente), y un chevrón minimiza la tarjeta a una barra fina. Una vez publicada la PR — o cuando el trabajo se fusiona o se descarta — la tarjeta vuelve a su sitio en el historial de la conversación.
- **Historial de prompts.** Con el cuadro vacío, pulsa **↑**/**↓** para recorrer lo que preguntaste antes (se muestra atenuado mientras te desplazas); empieza a escribir para editarlo, o pulsa Intro para enviarlo.
- **Edita la cola.** ¿Enviaste más mientras el agente estaba ocupado? Mientras haya mensajes en cola, **↑**/**↓** recorre *esos* mensajes: el cuadro muestra el seleccionado, lo editas en el sitio y **Intro lo guarda de vuelta en la cola** (Esc cancela; tu borrador sin enviar vuelve tal cual).
- **Minimiza sin perder nada.** Haz clic en la ✕ para devolver el panel a la burbuja: la conversación sigue en marcha. Vuelve a abrirlo y aterrizas en el último mensaje; no hay que reescribir nada.
- **Nueva conversación.** El botón **+** inicia un hilo limpio; el historial vive a nivel de app, por encima de cualquier proyecto concreto.
- **Cambia de misión.** El selector de misiones junto al selector de proyecto lista tus conversaciones de más reciente a más antigua — un punto pulsante marca aquellas donde el agente sigue trabajando, y una pequeña insignia cuenta los mensajes en cola. La búsqueda aparece cuando la lista supera las ocho, y el icono de papelera de cada fila elimina una misión tras una confirmación rápida en línea — incluso una en marcha (avisa primero y luego detiene al agente).

## Algunas cosas que conviene saber

- **Opera y Autónomo cuestan dinero** porque ejecutan IA. El agente saca a la luz las acciones que generan coste antes de hacerlas; mantén el nivel en Observa o Edita si solo quieres mirar y ordenar.
- **El agente es de toda la app**, no está ligado al proyecto que tengas abierto; por eso tiene su propio selector y su historial no es por proyecto.
- **Es tan capaz como le permita el MCP.** Si toda un área parece vetada, comprueba que el servidor MCP esté activado.
