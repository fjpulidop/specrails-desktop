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

Una fina franja recorre la parte inferior de la ventana. Es pequeña, pero útil:

- **Indicador de conexión** (izquierda) — un punto de color y una etiqueta que muestran que la app está activa: verde para *conectado*, ámbar mientras *reconecta*, azul mientras *sincroniza* justo después de una reconexión. Rara vez lo necesitarás, pero tranquiliza tenerlo.
- **Gasto total** (derecha) — un total acumulado de lo que has gastado, para que el coste esté siempre a un solo vistazo.
- **Botón de terminal** (extremo derecho) — abre el panel de terminal integrado. Pulsa **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) para alternarlo en cualquier momento. Es una shell completa, abierta directamente en la carpeta de tu proyecto.

## Algunos atajos prácticos {#shortcuts}

- **Cmd/Ctrl+B** — ancla o contrae la barra lateral izquierda; **Option+Cmd+B** (**Ctrl+Alt+B**) hace lo mismo con la derecha.
- **Cmd/Ctrl+J** — alterna el panel de terminal.
- **Cmd/Ctrl+K** — la paleta de comandos: busca misiones, proyectos y trabajos, y **ejecuta acciones**. Escribe un verbo («nueva», «lanzar», «mover», «cambiar») o empieza con **>** para listar acciones: Nueva spec (también en Explorar), Lanzar o Mover una spec, Abrir su revisión, Entregar o Pausar un Flow, Nueva misión, Cambiar tema, Cambiar entre modo Misión y Tablero, Abrir los ajustes de la app o del proyecto en una sección, Ejecutar un loop, alternar las barras laterales, Ir atrás o adelante, Deshacer el último cambio y Eliminados recientemente. Las acciones que necesitan una elección (un rail, un estado, un tema, una sección) abren una segunda página; **Retroceso** con la búsqueda vacía vuelve. Cada acción muestra su atajo de teclado, así que la paleta te enseña las teclas. Solo ofrece lo que funciona donde estás y respeta las mismas reglas que los botones (una spec que no se puede lanzar no se ofrece). Con la búsqueda vacía lista tus **Acciones recientes** y **Lugares recientes**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** en Windows/Linux), los botones **←  →** de la barra de título o los botones atrás/adelante del ratón — vuelven o avanzan por los lugares donde has estado: specs, misiones, trabajos, proyectos y paneles a pantalla completa. Clic derecho (o pulsación larga) en un botón muestra los últimos lugares.
- **Cmd+Shift+I** (**Ctrl+Alt+I** en Windows y Linux) o el botón **Pendientes** de la barra de título — la lista **Pendientes**: todo lo que espera por ti en todos tus proyectos, en una sola lista agrupada por proyecto. Reúne revisiones listas para decidir, preguntas que un agente está esperando, ejecuciones que fallaron o quedaron bloqueadas, ejecuciones pausadas por el presupuesto diario y actualizaciones de Jira que no pudieron sincronizarse. Cada fila tiene su acción principal a mano (**Abrir revisión**, **Responder**, **Reanudar**, **Reintentar**) más **Posponer** (1 hora o hasta mañana) y **Hecho**. Un elemento pospuesto o hecho vuelve solo si cambia su estado. El botón muestra cuántos elementos esperan y una notificación de límite del proveedor abre la lista. La lista también es un enlace (`?inbox=1`) y una acción de la paleta de comandos.
- **M** — con una tarjeta de spec enfocada en el tablero, abre un selector para moverla a un estado o a un rail; es el equivalente de arrastrar y soltar con el teclado. Funciona también con una selección múltiple, y la paleta lo ofrece como **Mover la spec enfocada…**.
- **?** — la hoja de atajos. Escribe en su cuadro de búsqueda para filtrar los atajos y encontrar páginas y secciones de esta guía, que se abren en la guía sin salir de tu pantalla. Los pequeños iconos **ⓘ** y los enlaces **Más información** junto a los ajustes, los rails, Flow, el control deslizante de contexto y los presupuestos abren la guía en la sección correspondiente del mismo modo.

## A dónde ir después

Ya conoces el terreno. Desde aquí, el primer paso natural es **añadir una spec** y lanzarla en un rail: observa cómo el pipeline se ejecuta de principio a fin y luego revisa las **Analíticas** para ver cuánto costó. Bienvenido a bordo.
