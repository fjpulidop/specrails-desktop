# Perfiles y el equilibrado por defecto

Un **perfil** es una receta guardada para una ejecución del pipeline. Responde a tres preguntas en un solo sitio:

1. **Qué agentes** participan (el trío base, más cualquier especialista o agente personalizado).
2. **Con qué modelo** corre cada agente.
3. **Cómo se enrutan las tareas** hacia esos agentes.

Encontrarás los perfiles en la sección **Agentes** de cualquier proyecto (barra lateral derecha → **Agentes** → la pestaña **Perfiles**).

## El equilibrado por defecto

Desde el primer momento, un proyecto resuelve hacia un perfil **default** sensato. Incluye el trío base — `sr-architect`, `sr-developer`, `sr-reviewer` — y enruta cada tarea al developer mediante una única regla comodín. Los modelos están equilibrados para el trabajo del día a día: un modelo capaz donde importa, sin tirar de la opción más cara en cada paso.

Si tu proyecto ya tenía los modelos de los agentes configurados a la antigua usanza (en el frontmatter de los archivos de agente), el botón **Migrar** los lee y construye un perfil `default` que replica el comportamiento actual exactamente — sin pérdidas, nada cambia hasta que tú decidas ajustarlo.

El titular: **no necesitas crear un perfil para usar Specrails.** El default simplemente funciona. Los perfiles son la forma de llegar más lejos.

## Cómo se elige un perfil para una ejecución

Cuando lanzas un rail, Specrails elige un perfil en este orden:

1. **Tu elección explícita** en la cabecera del rail (ver abajo).
2. Tu **preferencia por desarrollador** — un perfil que has marcado como tu default personal para este proyecto (es local a ti y no se commitea).
3. El perfil **`default`** del proyecto.

El perfil se *toma como snapshot en el lanzamiento*, así que cada rail de un lote puede correr un perfil distinto, y cambiar un perfil más tarde nunca reescribe los jobs que ya empezaron.

## Seleccionar un perfil por rail

La selección de perfil ocurre justo donde lanzas — en la **cabecera del rail**, mediante el selector de perfil.

- Elige un perfil del desplegable para usarlo en **este lanzamiento solamente**.
- Usa la opción de persistir para convertir un perfil en la elección permanente del rail de ahí en adelante.

Ese es todo el flujo: elige un perfil, lanza, listo. Los rails concurrentes de un mismo lote pueden llevar cada uno su propio perfil, así que un arreglo rápido y una feature pesada pueden correr en paralelo con configuraciones distintas.

## Cuando la sección Agentes está en silencio

Los perfiles son una capacidad de Claude. En un proyecto que incluye un proveedor que no es Claude (Codex o Gemini), la sección Agentes se oculta y los rails corren sin perfiles — eso es lo esperado, no un fallo. Los perfiles también requieren un `specrails-core` lo bastante reciente en el proyecto; si es más antiguo, verás un banner amarillo. Los perfiles que crees igualmente se **guardan** — simplemente no afectan al pipeline hasta que se actualice core. Actualiza con el comando que muestra el banner para desbloquearlos.

## A dónde ir después

- [Personalizar los modelos por agente](customizing-models-per-agent) — crea perfiles `fast` y `max`.
- [Agentes personalizados y el catálogo](custom-agents-catalog) — conoce y amplía el equipo.
