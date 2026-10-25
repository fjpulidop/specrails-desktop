<!-- guide-revision: mission-first-v1 -->

# Revisa una entrega en la app {#review-a-delivery}

Una entrega lista para revisar tiene dos vistas: **Resumen** (el veredicto, la evidencia y los botones de decisión) y **Cambios** (lo que la entrega cambió de verdad). Abre la revisión desde el botón **Revisar** de la entrega y elige **Cambios**.

## Lee los cambios

La lista de archivos de la izquierda muestra cada archivo cambiado con su estado (añadido, modificado, eliminado, renombrado), sus recuentos de líneas `+` y `−` y una marca cuando lo das por visto. El diff de la derecha carga un archivo cada vez, así que un cambio grande sigue siendo ágil. Alterna entre las disposiciones **Unificado** y **Dividido**; Specrails recuerda tu elección. Un archivo muy grande muestra sus primeras líneas con **Cargar el diff completo del archivo**; un archivo binario se indica como binario.

Los cambios se miden desde el punto en que la entrega se separó de su rama base, así que lo que llegó a la base después no aparece. Si la entrega aún no tiene una rama combinada, puedes elegir la rama de qué spec leer.

## Notas del revisor sobre el código

Los hallazgos del revisor, los riesgos que señaló y los comentarios de revisión que la ejecución debía resolver aparecen bajo la línea a la que se refieren. Las notas que no nombran archivo ni línea se listan encima de la lista de archivos, así que nada se oculta. Las entregas antiguas, y los revisores que no indicaron un lugar, muestran sus hallazgos en esa lista.

## Pide al agente que cambie algo

Selecciona líneas pulsando sus números (Mayús-clic amplía el rango), elige **Pedir un cambio al agente** y describe el cambio. Specrails lo guarda como feedback de revisión en la spec, con el archivo, el rango de líneas y el código seleccionado, y muestra un mensaje con un enlace a la spec. La próxima ejecución sobre esa spec lo recibirá. Para lanzarla ya, usa **Pedir cambios** en el Resumen. Aquí no hay hilos de comentarios entre personas; habla con tu equipo en GitHub.

## Ábrelo en tu editor

**Abrir en el editor** abre el archivo, en la línea seleccionada, en VS Code, Cursor o un IDE de JetBrains. Elige el editor en **Ajustes → Código → Editor**. El archivo se abre desde tu propia copia del proyecto, donde puede que la rama de la revisión no esté activa.

## Teclado

| Tecla | Acción |
| --- | --- |
| `j` / `k` | Archivo cambiado siguiente / anterior |
| `n` / `p` | Nota del revisor siguiente / anterior |
| `v` | Marcar el archivo como visto |

Las teclas se ignoran mientras escribes en un campo. Marcar un archivo como visto es privado: si el archivo cambia en una revisión posterior, muestra **Cambió desde que lo viste** y vuelve a contar como no visto.
