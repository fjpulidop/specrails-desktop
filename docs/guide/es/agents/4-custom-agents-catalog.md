# Agentes personalizados y el catálogo

Los perfiles deciden *qué agentes corren y con qué modelos*. Pero ¿de dónde salen los agentes en sí? De ahí: el **catálogo de Agentes**.

Abre **Agentes → Catálogo** en cualquier proyecto. Es un visor de solo lectura de todos los agentes disponibles para ese proyecto, en dos grupos:

- **Agentes upstream** — los agentes que vienen con `specrails-core`: el trío base (`sr-architect`, `sr-developer`, `sr-reviewer`) y cualquier especialista como `sr-merge-resolver`.
- **Agentes personalizados** — agentes que has añadido tú, con el nombre `custom-*`.

Cada entrada del catálogo muestra para qué sirve el agente y su modelo por defecto, así que puedes ver la plantilla completa antes de conectar agentes a la cadena de un perfil.

## Añadir un agente personalizado

Como viven en tu repo, los agentes personalizados son **activos de equipo commiteables**: commitea el archivo y todo tu equipo recibe el agente. Esto refleja la idea central de toda la sección Agentes —

> **Las definiciones de los agentes son compartidas (viven en el repo y viajan con `git`). La configuración de modelos es por proyecto (vive en los perfiles).**

## Poner a trabajar un agente personalizado

El flujo típico:

## Vigilar cómo rinden los perfiles

La sección Agentes también tiene una pestaña **Uso** — un desglose por perfil de cuántos jobs corrieron bajo cada perfil en una ventana seleccionada. Es una forma rápida de confirmar que tu reparto `fast`/`max` se está usando realmente como pretendías, y de detectar hacia qué perfil gravita tu equipo.

## Resumen de toda la sección

- **Los agentes** son los miembros especializados del equipo — el trío compartido más los especialistas y tus agentes personalizados. ([Conoce a los agentes](meet-the-agents))
- **Los perfiles** empaquetan qué agentes corren, con qué modelos y cómo se enrutan las tareas — se seleccionan por rail en el lanzamiento. El perfil default es la elección equilibrada del día a día. ([Perfiles y el equilibrado por defecto](profiles-and-the-balanced-default))
- **Los modelos** se ajustan por agente, por proyecto, dentro de los perfiles — crea `fast` y `max` para que encajen con el trabajo. ([Personalizar los modelos por agente](customizing-models-per-agent))
- **El catálogo** muestra todos los agentes, y el espacio de nombres `custom-*` te deja hacer crecer el equipo — definiciones compartidas, configuración por proyecto.
