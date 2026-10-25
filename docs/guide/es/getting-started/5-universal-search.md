# Búsqueda universal (⌘K)

Pulsa **⌘K** (**Ctrl+K** en Windows y Linux) para buscar casi todo en Specrails desde un solo sitio: misiones, specs, registros de jobs, archivos, ajustes y esta guía. Escribe una consulta normal para buscar misiones, proyectos, specs y jobs recientes como siempre, o empieza con un **prefijo** para buscar solo en una fuente.

## Prefijos

| Escribe | Busca | Intro abre |
| --- | --- | --- |
| `#` | Specs: título, resumen, descripción, etiquetas, notas de fuera de alcance, adendas y comentarios. `#12` encuentra la spec 12. | La spec |
| `@` | Misiones: título y contenido de la conversación. | La misión |
| `/` | Ajustes (de Desktop y del proyecto) por nombre o por cómo los llamarías. | La ventana de ajustes en ese bloque, visible y con el foco |
| `f:` | Archivos del proyecto, por nombre o ruta. | El archivo en el explorador de código |
| `log:` | Registros de jobs: comandos, nombres de loops, títulos de fases y diagnósticos de fallo. | El job |
| `?` | Esta guía: títulos de páginas y encabezados. | La guía en ese encabezado |

Al escribir un prefijo se convierte en una **etiqueta** dentro de la caja de búsqueda y la caja conserva solo tu consulta. Pulsa **Retroceso** con la caja vacía (o haz clic en la × de la etiqueta) para quitar el ámbito. Con la caja vacía, la paleta lista los prefijos bajo la caja; haz clic en uno para empezar. `>` sigue listando acciones, como antes.

## Resaltado

Los resultados muestran un fragmento corto alrededor de la primera coincidencia, con el texto coincidente resaltado. La búsqueda ignora mayúsculas y acentos, así que `revision` encuentra «Revisión».

## Ajustes

`/` conoce los bloques principales de ajustes, en tu idioma: tema, idioma, editor, presupuestos, notificaciones, webhooks, actualizaciones, rama, entorno, telemetría, reglas y más. Los ajustes del proyecto se ofrecen cuando hay un proyecto abierto. Elige uno y se abre la ventana correcta en ese bloque. Sin prefijo, una coincidencia fuerte (tres o más caracteres) añade hasta tres ajustes a los resultados normales.

## Registros de jobs

`log:` busca en un índice compacto, no en la salida cruda de una ejecución: el comando, el nombre del loop, los títulos de las fases y el diagnóstico breve de una ejecución fallida, bloqueada o atascada. Nunca guarda flujos de tokens ni la salida de herramientas, así que se mantiene pequeño y rápido. Se guarda por proyecto y contiene las ejecuciones más recientes.

## Conviene saber

- `#`, `f:` y `log:` buscan en el proyecto activo; abre un proyecto primero.
- El ámbito de archivos respeta las reglas de exclusión del explorador de código.
- Cada grupo muestra solo sus mejores resultados; afina la consulta para acotar.
