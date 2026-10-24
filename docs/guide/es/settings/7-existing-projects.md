# Trabajar en un proyecto existente {#existing-projects}

Estas funciones ayudan a que los runs respeten un proyecto que ya existe: lo que una spec deja fuera, las preguntas del arquitecto antes de planificar, qué requisitos demuestra de verdad un test, cómo describir el código antiguo antes de cambiarlo y las reglas que tu equipo ya tiene escritas. Cada una necesita una versión de specrails-core que la soporte; mientras tanto su interruptor aparece desactivado con una nota para actualizar Core.

## Fuera de alcance

Cada spec puede listar lo que deliberadamente **no** cambia. Quick y Explore lo rellenan por ti; en la ventana de la spec aparece como **Fuera de alcance** bajo la descripción, un elemento por línea, y puedes editarlo como cualquier otro campo. Los agentes lo reciben con la spec en cada lanzamiento.

## Preguntas del arquitecto en Jira

En **Ajustes ▸ Anclaje en proyectos existentes**, activa **Publicar las aclaraciones del arquitecto en Jira**. Cuando un run se detiene porque el arquitecto necesita una respuesta, o continúa con supuestos, Specrails los publica como un comentario en la issue de Jira enlazada. Responde a ese comentario en Jira: la respuesta se añade a la spec como aclaración y el siguiente run de la spec la lee. Puedes seguir respondiendo a un run pausado desde la app.

## Requisitos demostrados

Cuando un test nombra el requisito que demuestra (`[spec:<capacidad>/<requisito>]` en su título), la página de revisión muestra **Requisitos demostrados X/Y**: qué requisitos demuestra un test que pasa, cuáles aún no tienen uno y cuáles tocó el propio cambio. Analítica muestra lo mismo por loop. Para que CI falle cuando un requisito cambiado no tiene test, añade `specrails-core pipeline trace --check --tests-passed` después de tus tests.

La biblioteca de loops también ofrece **Barrido de drift**, un loop de solo lectura que compara lo que dice cada spec con lo que hace el código y lista cada contradicción. No cambia nada.

## Baseline al tocar

Activa **Baseline al tocar** para que un cambio que llega a código que ninguna spec describe empiece describiéndolo: tests de cómo se comporta hoy, demostrados sobre el código sin cambios, y una spec breve de lo que existe. La página de revisión muestra **Spec creada por donde pasa el trabajo** con el módulo, los requisitos y los tests, y su coste aparece aparte del cambio. Si esos tests fallan sobre el código sin cambios, el run se detiene antes de editar el módulo y lo indica.

## Reglas del proyecto {#project-rules}

**Ajustes ▸ Reglas del proyecto** lista los checks que tu proyecto ya ejecuta (lint, tipos, tests, CI) y cada regla escrita en ficheros como `CLAUDE.md` o `AGENTS.md`, clasificadas en:

- **Aplicada**: un check ya la garantiza.
- **Automatizable**: un check podría. **Crear spec** la convierte en spec con un clic.
- **Solo humana**: alguien tiene que mirarla. Aparecen en cada página de revisión bajo **Requiere ojo humano**.

Las reglas que Core aún no pudo clasificar (por ejemplo, justo después de añadir el proyecto, cuando el inventario se hace sin conexión) aparecen como **Sin clasificar**; **Volver a inventariar** con un proveedor configurado las clasifica.

**Volver a inventariar** actualiza la lista. Cuando un proyecto aún no tiene comandos de verificación, los ajustes del agent runtime ofrecen primero estos checks.
