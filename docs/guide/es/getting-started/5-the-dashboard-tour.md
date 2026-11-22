# El recorrido por el tablero

Con un proyecto ya añadido, estás viendo el **tablero de tu proyecto**: tu base de operaciones para convertir specs en código publicado. Vamos a ver cómo orientarte.

## El panorama general

La ventana tiene tres zonas:

- **Barra lateral izquierda** — tu lista de proyectos. Haz clic en cualquier proyecto para cambiar a él al instante; todo lo demás en la ventana se actualiza para reflejarlo. El botón **Añadir proyecto** también vive aquí.
- **Área principal** — el tablero del proyecto activo: tus specs y el pipeline que las ejecuta.
- **Barra lateral derecha** — la navegación entre las secciones del proyecto actual.

## El tablero principal

Aquí es donde ocurre el trabajo. El tablero muestra:

- **Tus specs** — las specs que has creado, organizadas por estado (de Backlog/Por hacer hasta Hecho). Puedes verlas como lista, como cuadrícula o como tarjetas tipo nota adhesiva, lo que prefieras.
- **Una forma de añadir una spec** — empieza un nuevo trabajo. Puedes escribir una spec rápida directamente, o abrir un chat guiado de **Explore** que te ayuda a darle forma a través de la conversación y redacta la spec por ti.
- **Rails** — son los carriles donde se construyen las specs. Suelta una spec en un rail y lánzala para enviarla a través del pipeline Architect → Developer → Reviewer → Ship. Pueden ejecutarse varios rails a la vez, así que puedes trabajar en varias cosas en paralelo.

Cuando una spec está en ejecución, verás el progreso de su pipeline y sus logs en directo: la salida en tiempo real de la IA mientras diseña, programa y revisa tu cambio.

## La barra lateral derecha: las secciones del proyecto

La barra lateral derecha es tu cuadro de mandos para el proyecto actual. Pasa el ratón por encima para expandirla, o ánclala abierta. Las secciones que verás:

- **Tablero** — el tablero de specs y los rails (donde acabas de estar).
- **Trabajos** — todas las ejecuciones de pipeline de este proyecto, pasadas y presentes, con su estado, su duración y la posibilidad de profundizar en el detalle y los logs de cualquier ejecución.
- **Integraciones** — complementos opcionales, como conectar tus specs a un tablero de **Jira** o habilitar herramientas adicionales para la IA.
- **Ajustes** — opciones por proyecto (telemetría, presupuestos, configuración de providers y más).

## La barra de estado

Una fina franja recorre la parte inferior de la ventana. Es igual en el modo Misión y en el Tablero, y es discreta: cuando no hay nada que decir, ese hueco simplemente queda vacío.

- **Conexión** (izquierda) — vacía mientras todo va bien. Muestra *Reconectando…* (ámbar) o *Sin conexión* (rojo) solo cuando la app pierde su servidor local, y *Sincronizando…* durante un momento después de reconectar.
- **Actualizar** (derecha) — aparece cuando hay una versión nueva lista y la app lleva inactiva cerca de medio minuto. Haz clic para ver la tarjeta de actualización (consulta [Actualizaciones](../settings/6-updates.md)).
- **Uso del plan** (derecha) — un único medidor para el proveedor más cerca de su límite. Se mantiene neutro hasta el 80 %, se vuelve ámbar con el nombre del proveedor a partir del 80 % y rojo a partir del 90 %, y muestra *límite · se restablece 15:00* cuando el proveedor rechaza peticiones. Pasa el cursor por encima o haz clic para ver las ventanas de cada proveedor y el gasto de hoy en este proyecto.
- **Recursos de la app** (derecha) — un icono y el número de procesos, solo mientras hay trabajo en marcha. Haz clic para ver la CPU y la memoria, una tendencia de la memoria y el reparto por origen: misiones y chats, rails, loops y trabajos, procesos en segundo plano, terminales, CLIs de agentes, MCP y runners, Git y el propio servidor de Specrails. Despliega un origen para ver sus procesos. Bajo los orígenes, **Puertos de los worktrees de ejecución** muestra los puertos que sirve el servidor de desarrollo o de pruebas de cada rail (rail, spec, proyecto y proceso) y avisa cuando otro proceso ocupa los puertos asignados a un rail. En la app de escritorio, aquí también está **Mantener el ordenador despierto**; mientras está activado, un icono de taza en la barra de estado lo indica (haz clic en él para volver a permitir la suspensión).
- **Botón de terminal** (extremo derecho) — abre el panel de terminal integrado. Pulsa **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) para alternarlo en cualquier momento. Es una shell completa, abierta directamente en la carpeta de tu proyecto.

## Ventanas propias

En la app de escritorio, algunas pantallas se abren como ventanas reales en lugar de paneles dentro de la ventana principal: **Ajustes**, el detalle de un trabajo abierto desde una misión, y **Loops** y **Plugins** en el modo Misión. Puedes moverlas a otra pantalla y seguir trabajando en la ventana principal. Cada una usa los controles de ventana del propio sistema; los Ajustes y la ventana del trabajo también se cierran con **Escape**. Los cambios que hagas ahí, como el tema o el idioma, se aplican a la ventana principal al momento. En la versión de navegador estas pantallas se abren como paneles.

## Notificaciones de lo que te necesita {#attention}

Specrails te avisa cuando algo te necesita: una pregunta o una respuesta de una misión, una revisión lista para decidir, una ejecución que falló, se bloqueó o dejó de avanzar, un límite de gasto y un trabajo terminado. Cómo te avisa depende de dónde estés:

- **Fuera de la app**: una notificación del sistema con el proyecto y la causa. En la app de escritorio no se puede pulsar, así que al volver un aviso lo resume y te ofrece el camino de vuelta: un solo elemento aparece con su nombre y su acción (**Alpha · #6 espera tu respuesta** → **Responder**); varios se cuentan (**3 avisos pendientes**, o **2 preguntas y 1 revisión pendientes**) y abren la bandeja **Pendientes**. Los avisos que llegan mientras **Retoma donde lo dejaste** o el tour de la plataforma están abiertos esperan a que lo cierres y luego llegan como uno solo.
- **En otra parte de la app**: un aviso pequeño con **Abrir**.
- **Ya lo estás viendo**: nada. Una misión que estás mirando no avisa de sus propias respuestas; una ejecución atascada es la excepción y siempre avisa.

Cada estado nuevo de un elemento de la bandeja se anuncia una sola vez; tras reiniciar no se vuelve a anunciar nada antiguo. En la bandeja, los elementos que aún no has visto llevan un punto; **Marcar como no leído** y **Marcar como leído** lo cambian. En la app de escritorio, el icono del Dock (el lanzador en Linux) muestra cuántos elementos no has visto.

Elige de qué te avisa en **Ajustes ▸ Notificaciones**: desactívalo todo, elige las categorías (preguntas y respuestas, revisiones, fallos, límites de gasto, trabajos terminados), añade un sonido, oculta la insignia del Dock o desactiva un proyecto. La campana junto al nombre de un proyecto en la bandeja (**Silenciar las notificaciones de …**) también lo silencia, igual que **Silenciar las notificaciones de …** en el menú **Más acciones** de una fila; sus elementos siguen en la bandeja.

Un elemento se lee igual en todas partes: la fila de la bandeja, su tarjeta del tablero en vivo y su notificación usan el mismo título y las mismas palabras para decir por qué espera (por ejemplo **Límite diario del proyecto alcanzado** · **Trabajo en pausa** · **5,12 US$ de 5,00 US$ gastados**).

## El tablero en vivo {#live-board}

El **tablero en vivo** muestra en un solo sitio todas las ejecuciones de todos tus proyectos: rails, loops, sesiones de Intent y trabajos. Ábrelo desde **Tablero en vivo** en la barra lateral izquierda, con **Cmd+Shift+B** (**Ctrl+Shift+B** en Windows y Linux) o con **Abrir tablero en vivo** en la paleta de comandos. También es un enlace (`?live=1`), así que **Atrás** lo cierra.

Elige cómo leerlo con el selector de su cabecera (se recuerda tu elección):

- **Por estado**: tres columnas. **Requiere atención** es exactamente lo que lista la bandeja (revisiones listas para decidir, preguntas, fallos, ejecuciones bloqueadas, límites de gasto, actualizaciones de Jira), con lo más antiguo arriba, y su número es el de la bandeja; cada tarjeta conserva el piloto de su estado, así que una revisión y una pregunta se distinguen fácilmente. **Abrir Pendientes**, en lo alto de la columna, abre la lista completa. **En curso** reúne lo que se está ejecutando, después lo que espera en la cola y después lo que está en pausa (con el piloto de pausa). **Terminado hoy** reúne lo que acabó, se fusionó o se detuvo hoy, y se vacía a medianoche. Una ejecución está siempre en una sola columna.
- **Por misión**: una fila por misión con todas las ejecuciones que lanzó, su proyecto, motor, número de ejecuciones y lo que gastó hoy. Primero van las misiones que te necesitan; las ejecuciones que no lanzó ninguna misión cierran la lista en **Fuera de una misión**.

Cada tarjeta muestra el estado de la ejecución, el rail o el tipo (y el proyecto cuando el tablero abarca varios), el título, lo que está haciendo ahora, sus pasos cuando los tiene, el motor, cuánto lleva en marcha o esperando y su coste cuando se conoce. Una pregunta muestra su texto una sola vez. Una entrega que entraría en conflicto muestra un chip corto (**2 conflictos**); pasa el puntero por encima o dale el foco para leer la frase completa. El botón de la tarjeta es la misma acción que en el resto de la app: **Responder**, **Abrir revisión**, **Reanudar**, **Reintentar**, **Subir límite** o **Abrir**, que abre la misión que lanzó la ejecución o la propia ejecución. Filtra por proyecto, por tipo (Rails, Loops, Intent, Trabajos) o por motor; la cabecera resume cuántas te necesitan y cuántas están en curso (los recuentos de las columnas que ves) y lo que gastaste hoy.

En la app de escritorio el tablero se abre siempre en una ventana propia, para que puedas tenerlo en una segunda pantalla: cualquier forma de abrirlo trae esa ventana al frente, y **Cmd+Shift+B** la muestra u oculta. Sus botones, **Abrir Pendientes** incluido, actúan en la ventana principal, que pasa al frente.

## Algunos atajos prácticos {#shortcuts}

- **Cmd/Ctrl+B** — ancla o contrae la barra lateral izquierda; **Option+Cmd+B** (**Ctrl+Alt+B**) hace lo mismo con la derecha.
- **Cmd/Ctrl+J** — alterna el panel de terminal.
- **Cmd/Ctrl+K** — la paleta de comandos: busca misiones, proyectos y trabajos, y **ejecuta acciones**. Escribe un verbo («nueva», «lanzar», «mover», «cambiar») o empieza con **>** para listar acciones: Nueva spec (también en Explorar), Lanzar o Mover una spec, Abrir su revisión, Entregar o Pausar un Intent, Nueva misión, Cambiar tema, Cambiar entre modo Misión y Tablero, Abrir los ajustes de la app o del proyecto en una sección, Ejecutar un loop, alternar las barras laterales, Ir atrás o adelante, Deshacer el último cambio y Eliminados recientemente. Las acciones que necesitan una elección (un rail, un estado, un tema, una sección) abren una segunda página; **Retroceso** con la búsqueda vacía vuelve. Cada acción muestra su atajo de teclado, así que la paleta te enseña las teclas. Solo ofrece lo que funciona donde estás y respeta las mismas reglas que los botones (una spec que no se puede lanzar no se ofrece). Con la búsqueda vacía lista tus **Acciones recientes** y **Lugares recientes**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** en Windows/Linux), los botones **←  →** de la barra de título o los botones atrás/adelante del ratón — vuelven o avanzan por los lugares donde has estado: specs, misiones, trabajos, proyectos y paneles a pantalla completa. Clic derecho (o pulsación larga) en un botón muestra los últimos lugares.
- **Cmd+Shift+I** (**Ctrl+Alt+I** en Windows y Linux) o el botón **Pendientes** de la barra de título — la lista **Pendientes**: todo lo que espera por ti en todos tus proyectos, en una sola lista agrupada por proyecto. Reúne revisiones listas para decidir, preguntas que un agente está esperando, ejecuciones que fallaron o quedaron bloqueadas, ejecuciones pausadas por el presupuesto diario y actualizaciones de Jira que no pudieron sincronizarse. Cada fila tiene un botón para su acción principal (**Abrir revisión**, **Responder**, **Reanudar**, **Reintentar**, **Subir límite**); el resto está en su menú **Más acciones** (**⋯**): **Posponer 1 hora**, **Posponer hasta mañana**, **Hecho**, **Marcar como leído** o **Marcar como no leído**, y **Silenciar las notificaciones de** su proyecto. Las flechas recorren los botones principales de las filas; **Tab** llega a **⋯**, las flechas se mueven dentro del menú y **Esc** cierra solo el menú. Un elemento pospuesto o hecho vuelve solo si cambia su estado. El botón muestra cuántos elementos esperan; ese mismo número es el que muestran el tablero en vivo y la paleta de comandos. Una notificación de límite del proveedor abre la lista. La lista también es un enlace (`?inbox=1`) y una acción de la paleta de comandos. También muestra los hitos que se pausaron o esperan en un punto de control (**Reanudar** / **Continuar**) y las tarjetas de misión que esperan tu decisión: una propuesta de lanzamiento, una oferta de Intent o una oferta para arreglar la CI (**Abrir misión**).
- **M** — con una tarjeta de spec enfocada en el tablero, abre un selector para moverla a un estado o a un rail; es el equivalente de arrastrar y soltar con el teclado. Funciona también con una selección múltiple, y la paleta lo ofrece como **Mover la spec enfocada…**.
- **?** — la hoja de atajos. Escribe en su cuadro de búsqueda para filtrar los atajos y encontrar páginas y secciones de esta guía, que se abren en la guía sin salir de tu pantalla. Los pequeños iconos **ⓘ** y los enlaces **Más información** junto a los ajustes, los rails, Intent, el control deslizante de contexto y los presupuestos abren la guía en la sección correspondiente del mismo modo.

## A dónde ir después

Ya conoces el terreno. Desde aquí, el primer paso natural es **añadir una spec** y lanzarla en un rail: observa cómo el pipeline se ejecuta de principio a fin y luego revisa las **Analíticas** para ver cuánto costó. Bienvenido a bordo.
