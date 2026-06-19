# Conoce a los agentes

Cuando lanzas un rail de **Implement**, Specrails no le entrega tu spec a una sola IA con la esperanza de que salga bien. En su lugar, pone a trabajar a un pequeño equipo de *agentes* especializados, cada uno con una única tarea, en un orden deliberado. Esta página te presenta a quiénes forman ese equipo y qué hace cada uno.

## El trío base

Cada ejecución del pipeline usa estos tres agentes — son la columna vertebral, y un proyecto no puede lanzar un rail sin ellos.

| Agente | Rol | Qué hace |
|-------|------|--------------|
| **sr-architect** | El que planifica | Lee tu spec, inspecciona el código y produce un plan de implementación concreto: qué archivos tocar, qué forma tendrá el cambio y a qué prestar atención. Piensa antes de que nadie escriba código. |
| **sr-developer** | El que construye | Toma el plan del architect y escribe el código de verdad: archivos nuevos, ediciones, tests. Aquí es donde tu spec se convierte en un diff real. |
| **sr-reviewer** | El crítico | Valida el trabajo del developer contra la spec y el plan, detecta regresiones y pone reparos cuando algo no encaja. Es el control de calidad antes de dar el cambio por terminado. |

Piénsalo como **diseñar → construir → revisar**, el mismo ciclo que seguiría un equipo humano cuidadoso. Cada agente le pasa su resultado al siguiente, así que el developer nunca trabaja a ciegas y el reviewer siempre tiene la intención original con la que contrastar.

## Agentes especialistas

Más allá del trío, un proyecto puede incluir **agentes especialistas** opcionales que se encargan de tipos de trabajo específicos. El más común que verás es:

- **sr-merge-resolver** — un agente de utilidad que ayuda a desenredar conflictos de merge y a reconciliar cambios que se solapan. Es opcional: los perfiles lo incluyen solo cuando lo quieres, y nunca bloquea el pipeline si no está presente.

Los especialistas son opcionales y de adhesión voluntaria. Un proyecto recién creado funciona solo con el trío; añades especialistas (y tus propios **agentes personalizados** — consulta [Agentes personalizados y el catálogo](custom-agents-catalog)) cuando el flujo de trabajo del proyecto lo pide.

## Cómo llega cada tarea al agente adecuado

Dentro de una ejecución, el trabajo se *enruta*. Cada tarea lleva etiquetas, y las reglas de enrutado de un perfil envían las tareas etiquetadas al agente que mejor encaja con ellas — con una regla final que sirve de comodín y manda todo lo demás al developer. No tienes que pensar en esto para el uso normal; la configuración por defecto enruta todo con sentido desde el primer momento. Cuando estés listo para dirigir ciertos tipos de trabajo a ciertos agentes, consulta [Personalizar los modelos por agente](customizing-models-per-agent).

## Una idea importante, de entrada

La *definición* de cada agente — sus instrucciones, su personalidad, lo que tiene permitido hacer — es **compartida**. Vive en archivos (`.claude/agents/<id>.md`) que viajan con tu repositorio, así que todo tu equipo ejecuta el mismo architect, el mismo reviewer.

Lo que es **por proyecto** es la *configuración* que se monta encima: con qué modelo corre cada agente y qué combinación de agentes eliges para un rail concreto. Para eso están los perfiles — y de eso trata la siguiente página.

## A dónde ir después

- [Perfiles y el equilibrado por defecto](profiles-and-the-balanced-default) — cómo se empaqueta y se selecciona la configuración del equipo.
- [Personalizar los modelos por agente](customizing-models-per-agent) — ajusta coste y calidad.
