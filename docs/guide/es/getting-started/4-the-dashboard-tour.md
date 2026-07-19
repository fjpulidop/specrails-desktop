# El recorrido por el dashboard

Con un proyecto ya añadido, estás viendo el **dashboard de tu proyecto**: tu base de operaciones para convertir specs en código publicado. Vamos a ver cómo orientarte.

## El panorama general

La ventana tiene tres zonas:

- **Barra lateral izquierda** — tu lista de proyectos. Haz clic en cualquier proyecto para cambiar a él al instante; todo lo demás en la ventana se actualiza para reflejarlo. El botón **Añadir proyecto** también vive aquí.
- **Área principal** — el dashboard del proyecto activo: tus specs y el pipeline que las ejecuta.
- **Barra lateral derecha** — la navegación entre las secciones del proyecto actual.

## El dashboard principal

Aquí es donde ocurre el trabajo. El dashboard muestra:

- **Tus specs** — los tickets que has creado, organizados por estado (de Backlog/Por hacer hasta Hecho). Puedes verlos como lista, como cuadrícula o como tarjetas tipo nota adhesiva, lo que prefieras.
- **Una forma de añadir una spec** — empieza un nuevo trabajo. Puedes escribir una spec rápida directamente, o abrir un chat guiado de **Explore** que te ayuda a darle forma a través de la conversación y redacta el ticket por ti.
- **Rails** — son los carriles donde se construyen las specs. Suelta una spec en un rail y lánzala para enviarla a través del pipeline Architect → Developer → Reviewer → Ship. Pueden ejecutarse varios rails a la vez, así que puedes trabajar en varias cosas en paralelo.

Cuando una spec está en ejecución, verás el progreso de su pipeline y sus logs en directo: la salida en tiempo real de la IA mientras diseña, programa y revisa tu cambio.

## La barra lateral derecha: las secciones del proyecto

La barra lateral derecha es tu cuadro de mandos para el proyecto actual. Pasa el ratón por encima para expandirla, o ánclala abierta. Las secciones que verás:

- **Dashboard** — el tablero de specs y los rails (donde acabas de estar).
- **Jobs** — todas las ejecuciones de pipeline de este proyecto, pasadas y presentes, con su estado, su duración y la posibilidad de profundizar en el detalle y los logs de cualquier ejecución.
- **Analíticas** — invocaciones por día, actividad, modelo y ticket. Claude informa coste facturado, Codex/Gemini usan estimaciones y Kimi deja vacíos los tokens/costes USD no disponibles.
- **Agentes** — perfiles y catálogos de roles separados por proveedor para Claude y Kimi. Con Kimi puedes crear y editar roles manualmente; Generate, Test y AI Refine no están disponibles.
- **Código** — un explorador de archivos de solo lectura y chips que muestran qué archivos ha tocado la IA. Los resúmenes en lenguaje sencillo solo aparecen con proveedores compatibles; no están disponibles con Kimi.
- **Integraciones** — complementos opcionales, como conectar tus specs a un tablero de **Jira** o habilitar herramientas adicionales para la IA.
- **Ajustes** — opciones por proyecto (telemetría, presupuestos, configuración de providers y más).

> Las secciones y acciones aparecen según las capacidades del proveedor efectivo. Por ejemplo, los perfiles funcionan con Claude y Kimi, pero las acciones de IA de Agent Studio fallan de forma cerrada con Kimi.

## La barra de estado

Una fina franja recorre la parte inferior de la ventana. Es pequeña, pero útil:

- **Indicador de conexión** (izquierda) — un punto de color y una etiqueta que muestran que la app está activa: verde para *conectado*, ámbar mientras *reconecta*, azul mientras *sincroniza* justo después de una reconexión. Rara vez lo necesitarás, pero tranquiliza tenerlo.
- **Gasto total** (derecha) — un total acumulado de lo que has gastado, para que el coste esté siempre a un solo vistazo.
- **Botón de terminal** (extremo derecho) — abre el panel de terminal integrado. Pulsa **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) para alternarlo en cualquier momento. Es una shell completa, abierta directamente en la carpeta de tu proyecto.

## Algunos atajos prácticos

- **Cmd/Ctrl+B** — ancla o contrae las barras laterales.
- **Cmd/Ctrl+J** — alterna el panel de terminal.
- **Cmd/Ctrl+K** — abre la búsqueda.

## A dónde ir después

Ya conoces el terreno. Desde aquí, el primer paso natural es **añadir una spec** y lanzarla en un rail: observa cómo el pipeline se ejecuta de principio a fin y luego revisa las **Analíticas** para ver cuánto costó. Bienvenido a bordo.
